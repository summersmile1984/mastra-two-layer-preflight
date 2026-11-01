# Mastra L1 上 Cloudflare Workers 计划（只做调研和计划，还没部署）

结论：Mastra **可以**作为 L1 跑在 CF Workers 上（官方 `@mastra/deployer-cloudflare`）。L2（ACP `dsh` 子进程）**不能**跑在 Workers 上，留在 Linux box 上，通过 cloudflared tunnel 暴露。

## 1. 官方路径
- 指南：https://mastra.ai/guides/deployment/cloudflare.md （也可看 https://mastra.ai/integrations/deploy/cloudflare.md 和 https://mastra.ai/docs/deployment/cloud-providers/cloudflare-deployer）
- Deployer 参考：https://mastra.ai/reference/deployer/cloudflare.md
- 存储：D1 https://mastra.ai/integrations/databases/cloudflare-d1.md ；KV https://mastra.ai/integrations/databases/cloudflare-kv.md
- 另一条路，server adapter：https://mastra.ai/docs/server/server-adapters.md ，`@mastra/hono` 里的 `MastraServer({app, mastra})`。文档说“用 adapter 时按该框架的常规方式部署”，也就是自己写 Hono Worker 再 `wrangler deploy`
- Durable agents（beta）：https://mastra.ai/docs/harness/durable-agents.md ，加上 PubSub
- 文档索引：https://mastra.ai/llms.txt
- 包版本（npm，2026-11-02 查的）：`@mastra/deployer-cloudflare@1.2.40`、`@mastra/cloudflare-d1@1.5.0`、`@mastra/cloudflare`(KV)`@1.8.0`

模式：
```ts
// src/mastra/index.ts
import { env } from 'cloudflare:workers'
import { Mastra } from '@mastra/core'
import { CloudflareDeployer } from '@mastra/deployer-cloudflare'
import { D1Store } from '@mastra/cloudflare-d1'
import { registerApiRoute } from '@mastra/core/server'
export const mastra = new Mastra({
  agents: { l1 },                       // 也可用 agentControllers
  storage: new D1Store({ binding: env.DB }),   // 必须内联写在 new Mastra() 里（构建时 Babel 会延迟求值）
  deployer: new CloudflareDeployer({ name: 'mastra-l1', vars: { NODE_ENV: 'production' },
    d1_databases: [{ binding: 'DB', database_name: 'mastra-l1', database_id: '<id>' }],
    kv_namespaces: [{ binding: 'KV', id: '<id>' }] }),
  server: { apiRoutes: [ registerApiRoute('/a2a-callback', { method: 'POST', handler }) /* ... */ ] },
})
```
构建和发布：`mastra build` 生成 `.mastra/output` 和 `wrangler.jsonc`，再 `wrangler deploy`，或者用 Git 连接 Workers 自动部署。Secrets 用 `npx wrangler secret bulk .env`。Mastra 自带的路由都在 `/api/*` 下（例如 `/api/agents`）。

## 2. Workers 上能跑的和不能跑的
| 项 | Workers |
|---|---|
| Agent / AgentController、调 DeepSeek 的 fetch、工具、Memory（外部存储） | ✅ |
| SSE（流式 Response） | ✅ 但只在单个请求的生命周期内有效。跨请求推送要靠 DO 或 PubSub |
| WebSocket | ✅ 要用 Durable Object（hibernation API） |
| `node:fs`、本地 LibSQL `file:` 库、`data/tasks.json`、`screenshots/` | ❌ 改用 D1 / Turso / KV / R2 |
| `node:child_process`（spawn `dsh --profile acp`、Chrome 截图兜底） | ❌ 留在 L2 box |
| 在内存里长期保存 Session Map、定时器 | ❌ isolate 随时会被回收。每次请求或回调都要 `createSession` 重建会话，状态从存储里恢复 |
| 请求结束后继续跑的 agent run | 用 `ctx.waitUntil`（有时长上限）。更长的任务放到 DO 或 Workflows 里 |
| `node:crypto.timingSafeEqual` | ✅（需要 nodejs_compat）。也可以用 `crypto.subtle` 自己实现 |
| Observability 写入 D1 | ❌ D1 不支持。另外 D1 单行上限 1 MiB，图片别以 base64 存进消息 |

## 3. 目标架构
```
浏览器 ──(Static Assets UI / client-js)──► CF Worker: Mastra L1 (CloudflareDeployer)
                                              │ storage: D1(或 Turso)  KV: tasks/token  R2: 截图
                                              │ tool dispatch_to_sandbox
                                              ▼ A2A message/send {blocking:false, push{url,token}}
                                 cloudflared 命名 tunnel + CF Access(Service Token)
                                              ▼
                         Linux box L2 :4121 (src/l2-server.ts) → @mastra/acp → dsh --profile acp
                                              │ task completed + artifact(PNG FilePart/base64)
            Worker /api/a2a-callback ◄────────┘ X-A2A-Notification-Token
              → 校验 → 截图写 R2 → createSession(sid) → waitUntil(session.sendSignal(...))
              → 结果写 D1/KV，或经 DO / PubSub 推给浏览器
```
跨 isolate 的信号：MVP 阶段在回调里重建会话，结果先落库，浏览器轮询或重连 SSE 拿。正式版每个会话用一个 Durable Object（持有 SSE/WS 连接和唤醒逻辑），或者用 RedisStreamsPubSub。

## 4. 包改动
- 新增：`@mastra/deployer-cloudflare`、`@mastra/cloudflare-d1`（或者走 Turso：`@mastra/libsql` 加 `libsql://` URL）、`@mastra/cloudflare`(KV，可选)、`mastra`(CLI，dev 依赖)、`@mastra/client-js`(UI，可选)
- 从 L1 构建里移除：`@hono/node-server`、`@mastra/acp`、node fs/child_process 相关代码（L2 的 `package.json` 和入口照常保留）
- scripts 增加 `"cf:build": "mastra build"`、`"cf:deploy": "mastra build && wrangler deploy -c .mastra/output/wrangler.jsonc"`（以 build 实际输出的路径为准）

## 5. 文件迁移
- 新建 `src/mastra/index.ts`：导出 `mastra`，里面包含 L1 agent/AgentController、D1Store、CloudflareDeployer 和 apiRoutes
- `src/l1/controller.ts`：去掉 `LibSQLStore(file:)`、`mkdirSync`、`resolve`，storage 改为由外部注入。L2 queue 模式只保留在 Node 版本里
- 新建 `src/l1/routes.ts`：把 `server.ts` 里的 handler 改写成 `registerApiRoute`
- `src/task-store.ts` 和 `secrets.ts`：抽象成接口，Node 版本用文件实现，CF 版本用 KV/D1 实现
- `src/server.ts` 和 `src/l2-server.ts` 保留，用于本地和 L2
- `cf/worker.ts` 和根目录 `wrangler.toml`：Mastra 版跑通之后删掉或归档到 `legacy/`。Worker 名沿用 `mastra-l1`，原地替换掉占位版本
- `public/index.html`：放进 Workers Static Assets（deployer 配置里的 assets，或 build 之后再补 `assets` 配置）

## 6. 路由映射（server.ts → Worker）
| 现在 | Worker |
|---|---|
| `GET /` | Static Assets `public/index.html` |
| `GET /screenshots/:f` | `registerApiRoute('/screenshots/:f')` 从 R2 读，或直接用 R2 公开/签名 URL |
| `GET /api/health` | 保留路由名，L2 健康检查经 tunnel 转发 |
| `POST /api/a2a-callback` | apiRoute：校验 token → artifact 写 R2 → 重建 session → `waitUntil(sendSignal)` |
| `POST /api/secret` | apiRoute：密文存 KV（10min TTL）→ `respondToToolSuspension` |
| `GET /api/bots`、`POST /api/session` | apiRoute。session 元数据存 D1/KV |
| `POST /api/message` | apiRoute：返回 202，同时 `waitUntil(run)`。MVP 也可以直接流式返回 |
| `GET /api/events`(SSE) | MVP：单请求流加重连时从 D1 补发。正式版：DO 或 client-js `session.subscribe` |
| `/api/a2a-log`、`/api/demo/push-image` | 只在开发环境开，或者不迁 |
| `/api/a2a/l2-worker` | 不迁，仍在 L2 box 上 |
注意：Mastra 自定义路由也在 `/api` 前缀之下，要确认 `registerApiRoute` 的路径会不会和内置路由冲突。

## 7. 存储选择
- 首选 **D1**（`D1Store`，binding `DB`）。和 CF 原生集成，免费额度够用
- 备选 **Turso**（libsql 远程库，代码改动最小，只换 URL 和 token）
- 其他：KV 存 tasks registry、push token 和 secret vault（TTL）；R2 存截图；observability 用 composite storage 另外接，或者先关掉

## 8. L2 tunnel 步骤（box 上）
1. `npm run start:l2`（:4121），在 `.env` 里填 `DEEPSEEK_API_KEY`，再设 `L2_PUSH_ALLOWLIST=https://mastra-l1.<sub>.workers.dev/api/a2a-callback`
2. 建命名 tunnel：`cloudflared tunnel login && cloudflared tunnel create l2 && cloudflared tunnel route dns l2 l2.<domain>`，然后 `cloudflared tunnel run --url http://127.0.0.1:4121 l2`。注意当前验证环境的 7844 端口出网被封，要换一台能出网的机器
3. 在 Cloudflare Access 里给 `l2.<domain>` 配 Service Token。Worker 发请求时带上 `CF-Access-Client-Id` 和 `CF-Access-Client-Secret`（都用 wrangler secret 存）
4. Worker secrets：`DEEPSEEK_API_KEY`、`PUSH_TOKEN`、`L2_A2A_URL`、`CF_ACCESS_*`
5. L2 改造：把截图作为 A2A artifact（FilePart）回传，不再依赖 L1 读本地 `workspace-l2/`。Chrome 兜底也挪到 L2

## 9. 分阶段实施
- **P0 骨架**：建 `src/mastra/index.ts`、CloudflareDeployer 和 D1。跑 `wrangler dev`，确认 `GET /api/agents` 能列出 L1
- **P1 MVP 聊天**：UI 用 Static Assets 托管，`/api/message` 流式调用 L1，Memory 存 D1。部署后替换掉 `mastra-l1` 占位版本
- **P2 A2A 唤醒**：`dispatch_to_sandbox` 经 tunnel 发 `message/send`，tasks 写 KV。`/api/a2a-callback` 收到后截图写 R2，重建 session，用 `waitUntil(sendSignal)` 唤醒 L1；回复先落库，浏览器轮询或重连拿
- **P3 实时推送**：每会话一个 Durable Object 持有 SSE/WS，或接 PubSub（RedisStreamsPubSub），或改成 client-js `session.subscribe`
- **P4 HITL**：`request_secret` suspend → 表单 → KV vault（加密、TTL）→ resume。下发给 L2 的 secret 用 L2 公钥封装，L1 不保留明文
- **P5 加固**：Access、限流、鉴权（Mastra auth）、observability、告警

## 10. 风险
- AgentController 的 live Session 只在内存里。官方建议 channels 场景用常驻 server，在 Workers 上要重建会话，有丢事件或时序问题的风险。缓解：从存储恢复会话，或用 DO 做单会话串行化
- `waitUntil` 有时长上限。L1 被唤醒后的回复要足够短，长任务交给 DO 或 Workflows
- `@mastra/core` 或其依赖可能偷偷引入 Node API（fs、worker_threads），`mastra build` 打包可能失败。P0 就要验证
- D1 单行 1 MiB，不支持 observability。图片不能 base64 存进消息
- Worker 的 CPU 时间、子请求数量和 bundle 大小（付费版 10 MB）都有限制
- tunnel 出网被封（7844），在当前环境里还没验证通
- 两套入口（Node 和 CF）要维护，注意别出现行为分叉

## 11. 样例和模板
- 官方没有单独的 CF starter 仓库。最接近的做法是 `npx create-mastra@latest`，再按上面的方式加 CloudflareDeployer
- Deployer 源码：https://github.com/mastra-ai/mastra/tree/main/deployers/cloudflare
- Hono adapter 示例：https://mastra.ai/integrations/frameworks/hono.md

## P2 进度（2026-11-02）
Worker 侧 dispatch_to_sandbox + `/a2a-callback`（无 /api 前缀）+ D1 `l2_tasks` + waitUntil 生成汇报 + 前端轮询 `/l2-results` 已部署并验证；L2 核心路径（A2A + @mastra/acp → dsh）未改。缺：L2 公网入口（tunnel）后更新 Worker secret `L2_A2A_URL` 即可端到端。详见 DEPLOY-CF.md「P2」。

## P3 — L2 outbound PULL (2026-11-02, Worker version d3612acf-eaa3-4b3c-9cd6-ce12454279a6)

Why: on this box, egress rewrites argotunnel DNS to 198.18.0.1 and TLS gets EOF, so cloudflared can't work. Outbound HTTPS to workers.dev does work.

- `dispatch_to_sandbox` generates `t-<uuid>` and inserts a D1 `l2_tasks` row with `state=queued` and `prompt` (the column is added with `ALTER TABLE` when missing). It needs only PUSH_TOKEN and a thread. When `L2_A2A_URL` is set, it also tries an A2A push (best-effort). If that push fails, it only logs, and the task waits in the queue for pull.
- `POST /l2-claim` (no /api prefix) takes `Authorization: Bearer <PUSH_TOKEN>` or `X-A2A-Notification-Token`. It atomically moves one task queued→working and returns `{task:{taskId,prompt,runtime,threadId}}` or `{task:null}`.
- When done, L2 POSTs an A2A Task to `/a2a-callback` (`id`, `status.state`, `artifacts[].parts[].text`). Compose and `/l2-results` are unchanged.
- `/health-l1` now reports `pullMode:true`, `claim`, and `queued`.
- Local L2: `npm run start:l2-pull` (`src/l2-pull-worker.ts`). Env (in `.env`, gitignored): `L1_PULL_URL`, `PUSH_TOKEN`, `L2_PULL_INTERVAL_MS` (default 2000), and optional `ACP_DRY_RUN=1`.

E2E on the box: generate → queued → claim → runAcpPrompt → callback → /l2-results.
- DRY-RUN: passed ("hello.txt 已经处理好了，里面写的是 hi。")
- Real dsh ACP (`echo pull-ok-42`): passed ("命令跑完了，输出是：pull-ok-42"), ~25s
