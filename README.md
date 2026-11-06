# Mastra 两层 Agent：L1 AgentController + L2 ACP Harness（真实，不模拟）

- **L1** = Mastra `AgentController`（`@mastra/core/agent-controller`，DeepSeek `deepseek/deepseek-chat`）。它常驻运行，马上回复用户，工具只负责入队或查询：`dispatch_to_sandbox` / `follow_up_job` / `job_status` / `cancel_job`。
- **L2** = 用户自己安装的 harness 应用，通过 **ACP**（stdio JSON-RPC）调用，使用的是 Mastra 原生的 `@mastra/acp` 中的 `AcpAgent`（`src/l2/acp-worker.ts`）：
  - 每个 job 都会 `new AcpAgent({command,args,cwd,onPermissionRequest})`，然后调用 `agent.connection.promptStream(prompt)`，依次走 initialize → session/new → session/prompt。
  - `session/update` 包括 `tool_call`、`tool_call_update`、`plan`、`agent_thought_chunk`、`agent_message_chunk`，会转成进度事件，经 SSE 以聊天气泡推到页面。
  - 补充要求（follow-up）作为**同一个 ACP session** 的下一轮 `session/prompt` 发送；取消对应 `connection.cancel()`（即 session/cancel）。
  - harness 发来权限请求（permission request）时，回调会选 allow 类选项，并在页面上显示为一行过程。
  - 完成后调用 `session.sendSignal({type:'notification', tagName:'sandbox-result'})` 唤醒 L1，由 L1 用自然语言汇报。
- `cloud` / `local` 只是标签，表示用哪一套 ACP 配置（命令 / cwd），执行一律走 ACP。

## 1. 安装 harness（DeepSeek Harness）
```bash
export PATH=~/.local/node22/bin:$PATH        # Node >= 22.13
npm install -g @deepseek-ai/dsh              # 本机已装：dsh 0.2.1-rc.5
dsh --profile acp --help                     # acp profile 首次使用时自动初始化（~/.dsh/profiles/acp）
```
登录：只要环境里有 `DEEPSEEK_API_KEY`（本项目 `.env` 已有），`dsh --profile acp` 就能直接用，不需要交互登录。也可以运行一次 `dsh web`，在 Web UI 里保存 key。
可选的社区适配器：`dsh plugin --profile acp add @openma/deepseek-harness-acp@latest`，或者独立运行 `npm i -g @openma/deepseek-harness-acp && dsh-acp login`（再设置 `ACP_COMMAND=dsh-acp ACP_ARGS=`）。

## 2. 选择 harness（环境变量）
| 变量 | 默认值 | 说明 |
|---|---|---|
| `ACP_COMMAND` / `ACP_ARGS` / `ACP_CWD` | `dsh` / `--profile acp` / `./workspace-l2/<runtime>` | 通用配置 |
| `ACP_LOCAL_*`、`ACP_CLOUD_*` | 继承上面 | 按路由分别覆盖 |
| `ACP_MODEL` | – | 通过 ACP `session/set_model` 选模型 |
| `ACP_CONCURRENCY` | 2 | 每个 runtime 的并发数 |
| `ACP_DRY_RUN=1` | 关 | **最后手段**：不启动进程，页面上标注 ⚠️DRY-RUN |

换其他 harness，示例如下：
```bash
ACP_COMMAND=npx ACP_ARGS="@agentclientprotocol/claude-agent-acp" npm start   # Claude Code
ACP_COMMAND=npx ACP_ARGS="@zed-industries/codex-acp" npm start               # Codex
ACP_COMMAND=opencode ACP_ARGS="acp" npm start                                 # OpenCode
```

## 3. 运行
```bash
npm start          # http://localhost:4120 （UI + API）
npm run acp:probe  # 单独测 ACP 握手和一次 prompt（不经过 L1）
npm run smoke      # HTTP+SSE 跑一遍：派发、闲聊、补充、查进度、本地任务
```

## 4. 页面
- **现行 L1 前端**：`apps/web`（Vite + React + TypeScript + Tailwind），软浅色产品风；CF 上打开站点根路径。构建经 `scripts/cf-postbuild.mjs` 进 Workers Static Assets。
- 只显示 L1（总管）；鉴权 / 房间群聊 / 主会话（人格与模型设置面板）走同一套 `/api/*`。
- 早期 demo：`public/index.html`（SSE 流式）。架构细节见 **ARCHITECTURE.md**。

## 目录
`src/server.ts`（HTTP/SSE/A2A callback/HITL）· `src/l1/controller.ts` · `src/l2/a2a-l2.ts`（A2A server + ACP run + AllowlistedPushSender）· `src/l2/acp-worker.ts`（queue 模式 worker）· `src/l2/queue.ts` · `apps/web/`（现行 SPA）· `public/index.html` · `scripts/cf-postbuild.mjs` · `legacy/`


## 运行模式（L1 / L2 拆分）
| 命令 | 说明 |
|---|---|
| `npm start` / `npm run start:all` | 同进程 L1+L2（:4120），一键预演 |
| `npm run start:l2` | 仅 L2：A2A + ACP harness（:4121，`L2_PORT`），`/api/a2a/l2-worker`、`/api/health` |
| `npm run start:l1` | 仅 L1+UI+callback（:4120），`L2_A2A_URL` 默认 `http://127.0.0.1:4121` |

本机跨进程：
```bash
export PATH=~/.local/node22/bin:$PATH && npm ci && cp .env.example .env
L2_PUSH_ALLOWLIST=http://127.0.0.1:4120/api/a2a-callback npm run start:l2 &
L2_A2A_URL=http://127.0.0.1:4121 npm run start:l1
```
- **当前验证路径**：同机两进程（✅，见 RESULTS.md）。
- **CF 目标路径**：L1 → Cloudflare Workers，L2 → 云电脑 + cloudflared tunnel；见 [DEPLOY-CF.md](DEPLOY-CF.md)（目前为最小 Worker 占位 `cf/worker.ts`）。

拆分模式限制：截图收集读 L1 本地 `workspace-l2/`（仅同机有效）；HITL 密码明文留在 L1 内存，不随任务跨进程下发。

> 以下 v0.2.x 章节为**远端开发线的历史记录**。本线（AGENTS.md 为准）已改造：保险库 = Cloudflare Secrets Store（弃自研 AES-GCM）、记忆 = Observational Memory + Vectorize（om-memory/om-memory-obs）、L2 专家 = `agent_defs` + `dispatch_to_expert`（执行位 = 用户电脑/云电脑）；Bot 模板、挂群（room_agents）、@提及、Agent Builder export 等未并入（非目标或待移植切片）。

## v0.2.2（2026-11-02）
- **真机 CUA**：`src/l2/cua-cli.ts` + `apps/l2-desktop` 走 trycua `cua` CLI（`cua do switch/screenshot/shell/click/type/key`）；`npm run start:l2-pull` 按 `runtime/kind` 路由 CUA vs ACP。
- L1 `dispatch_to_sandbox` runtime 枚举：`cloud | local | cua`；`/l2-claim` 返回 `kind: 'cua'|'acp'`。
- 证明见 `/workspace/shots/feat-cua-real-e2e.json` + `feat-cua-real.png`。

## v0.2.1（2026-11-02）
- **默认权限**：`execute` / `mcp:github` 默认 **allow**（异步独立干活，不做「始终询问」）。
- **真机 ACP**：`apps/l2-desktop` ACP runner 走真实 `runAcpPrompt`（`dsh --profile acp`）；`npm run start:l2-pull` 对 live L1 claim→callback。证明见 `/workspace/shots/feat-acp-real-e2e.json`。
- **产品定时任务**（非 Mastra Workflows EE）：D1 `schedules` / `schedule_runs`（`migrations/0006_schedules.sql`）；`GET/POST /api/schedules`、`PATCH/DELETE /api/schedules/:id`、`POST .../run`、`GET .../runs`；Workers Cron `* * * * *` → `scheduled` → `POST /cron-tick`（Bearer `PUSH_TOKEN`）。SPA 设置 → **定时任务**。
- 管家 compose：`<sandbox-result>` 强制汇报结果原文、`activeTools: []`，避免把回调结果再当新任务派发。

## v0.2.0 功能（2026-11-02）
- 权限 HITL：`GET/PUT /api/permissions`（D1 `user_permission_rules` / `user_settings.auto_review`）；deny 或 ask(自动审核关) 的工具从管家 `activeTools` 移除，房间派发受 execute 规则控制。
- 保险库：`/api/vault`（AES-GCM，密钥 = SHA-256('vault:'+VAULT_KEY||BETTER_AUTH_SECRET)），只回显掩码；连接可引用 `vault_id` 作为 Bearer。
- 用量：`usage_events`，`GET /api/usage`，SPA 导出 CSV。
- 更新：`GET /api/version`，SPA 版本 + 渠道（localStorage `update.channel`）。
- 连接应用：HTTP MCP（https）`tools/list` → 以 toolsets 注入管家；`?probe=1` 检测；stdio 只能在 L2。
- Agent Builder：`/api/agent-defs` CRUD + `/:id/export`；`ad-*` 自建 agent 挂到群后由 `dispatch_to_expert` 入队，L2 runner 用 `dynamicExpert()` 从 `agent_defs` 现建 Agent 运行。
- Bot 模板：`/api/templates`、`POST /api/templates/import`（3 个内置 + 文件导入）。
- 迁移：`migrations/0005_features.sql`。截图：`scripts/feat-verify-shots.mjs`。

## Memory (v0.2.4)

- **DM**: thread `dm_<userId>`, resourceId `user:<userId>`. Legacy `user:<id>` threads are migrated automatically on first DM access (`migrateDm`, idempotent).
- **Room**: thread `room_<roomId>`, resource = room thread; butler memory is read-only in rooms → no DM working-memory leak.
- **Working memory**: resource-scoped (`mastra_resources`), written via custom zod tool `save_working_memory` (DM only; Mastra's built-in tool uses Ajv codegen which Workers forbids).
- **Long DMs**: rolling summary in D1 table `memory_summaries` (every 20 msgs beyond the last 20). Observational Memory not supported by D1Store.
- **Semantic recall**: Workers AI `@cf/baai/bge-m3` (1024d) + Vectorize `mastra-l1-memory`, filtered by `resource_id` (DM) / `thread_id` (room), score ≥ 0.55. Done explicitly in `app-routes.ts`.
  Bindings (added by `scripts/cf-postbuild.mjs` to the generated wrangler.json): `AI`, `VECTORIZE` → `mastra-l1-memory`.
  ```
  npx wrangler vectorize create mastra-l1-memory --dimensions=1024 --metric=cosine
  npx wrangler vectorize create-metadata-index mastra-l1-memory --property-name=thread_id --type=string
  npx wrangler vectorize create-metadata-index mastra-l1-memory --property-name=resource_id --type=string
  ```
- **Room delete**: `memory.deleteThread(room_<id>)`, deletes `mastra_messages`, `l2_tasks`, summary, and vectors (`cleanup` in response).
- **`GET/DELETE /api/memory`** (`?q=` probe; `?what=working|history|all`): settings view/clear stub.
- **New member policy**: new room members see the full room history (default; no truncation).
