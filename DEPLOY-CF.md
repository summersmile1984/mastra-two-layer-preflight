# 部署：L1 在 Cloudflare Workers，L2 在本机/云电脑（cloudflared tunnel）

```
用户浏览器 ──► CF Worker (L1) ──A2A message/send──► cloudflared tunnel ──► 云电脑 L2 :4121 (A2A + ACP dsh)
                    ▲                                                          │
                    └──────────── A2A push (X-A2A-Notification-Token) ─────────┘
```

## 当前状态
| 路径 | 状态 |
|---|---|
| 同机一进程 `npm start` | ✅ 已验证 |
| 同机两进程 `start:l2` + `start:l1` (`L2_A2A_URL`) | ✅ 已验证（见 RESULTS.md「跨进程」） |
| CF Worker 占位 `cf/worker.ts`：health / 回调验 token / 手动派发 L2 / `/api/last-push` | ✅ 已部署 https://mastra-l1.summersmile1984.workers.dev （API token 非交互 deploy） |
| L2 → Worker A2A push（公网回调 + token 校验） | ✅ 已验证（2026-11-02） |
| Worker → L2 经 trycloudflare 快速隧道 | ❌ 本验证环境出网封锁 argotunnel 7844（QUIC/HTTP2 均失败，Error 1033）；需在可出网机器上重跑 |
| **P0：Mastra L1 官方 CloudflareDeployer + D1**（`src/mastra/index.ts`，agent `orchestrator`，DeepSeek） | ✅ 已部署 https://mastra-l1.summersmile1984.workers.dev/api/agents ；`/health-l1`（自定义路由不带 `/api` 前缀） |
| **P1：聊天 UI 由 Worker 提供**（Workers Static Assets `cf-public/index.html` → 流式 `POST /api/agents/orchestrator/stream`，Memory 存 D1，thread=前端 sid） | ✅ https://mastra-l1.summersmile1984.workers.dev/ |
| 完整 L1（AgentController + UI + SSE + A2A 回调）跑在 Workers | ⏳ P1+，见 [docs/MASTRA-CF-L1-PLAN.md](docs/MASTRA-CF-L1-PLAN.md) |

## 0. L1 部署（P0）
```bash
# 需要 Node >= 22；CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
npm run cf:deploy            # mastra build → scripts/cf-postbuild.mjs（补 assets）→ wrangler deploy
npx wrangler secret put DEEPSEEK_API_KEY --name mastra-l1
```
D1：`mastra-l1`（binding `DB`）。原占位 `cf/worker.ts` 与根 `wrangler.toml` 已被 Mastra 版取代，归档到 `legacy/`（cf-worker.placeholder.ts / wrangler.placeholder.toml）。

## 1. 云电脑起 L2 并用 tunnel 暴露
```bash
export PATH=~/.local/node22/bin:$PATH
cp .env.example .env   # 填 DEEPSEEK_API_KEY
# 回调是公网 https → 不设 allowlist 即用官方 DefaultPushNotificationSender（带 SSRF 防护）
# 或精确白名单：L2_PUSH_ALLOWLIST=https://mastra-l1.<you>.workers.dev/api/a2a-callback
npm run start:l2       # :4121

# 安装 cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://127.0.0.1:4121          # 快速隧道，得到 https://xxx.trycloudflare.com
# 生产：cloudflared tunnel login && cloudflared tunnel create l2 && 绑定 l2.yourdomain.com
```
> 建议在 tunnel 前加 Cloudflare Access（Service Token），Worker 请求时带 `CF-Access-Client-Id/Secret`，避免 L2 公网裸奔。

## 2. 部署 L1 占位 Worker
```bash
npm i -D wrangler
npx wrangler login   # 或非交互：export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...（勿入库）
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put PUSH_TOKEN        # openssl rand -hex 32 生成
npx wrangler secret put L2_A2A_URL        # https://xxx.trycloudflare.com
npm run cf:deploy
curl https://mastra-l1.<you>.workers.dev/api/health          # 应带回 L2 health
curl -XPOST https://mastra-l1.<you>.workers.dev/api/ping-l2 -d '回复 pong'   # wrangler tail 可见 push received
```

## 3. 完整 L1 上 CF 还差什么
- Mastra 官方 `@mastra/deployer-cloudflare`（`CloudflareDeployer`）要求标准 `new Mastra({...})` 入口 + `mastra build`；当前 L1 是自定义 Hono server（AgentController session、SSE、HITL）。
- 存储：`@mastra/libsql` 文件库 → Turso(libsql 远程) 或 D1；`data/tasks.json` → KV/D1。
- 会话常驻/SSE/`session.sendSignal` 唤醒 → Durable Object（每会话一个）。
- 截图：L2 产物需随 A2A artifact（FilePart/base64）回传或写 R2，L1 不能再读本地 `workspace-l2/`；Chrome 兜底移到 L2。
- HITL secretRef：明文目前在 L1 内存，跨机需加密随任务下发（如用 L2 公钥封装）。
- 账号：需要 Cloudflare 账号 + `wrangler login`（本仓库未部署）。

## P2：Worker 侧派发 + A2A 回调（2026-11-02）
- 状态：✅ 已部署（Worker 侧完整）；⏳ 端到端待 L2 公网入口（tunnel）。
- `src/mastra/index.ts`：orchestrator 加工具 `dispatch_to_sandbox`（A2A `message/send`，`blocking:false` + `pushNotificationConfig`）；指令与 Node L1 一致（慢任务派发/闲聊直回/不提内部细节）。
- 任务登记：D1 表 `l2_tasks`（taskId → thread/resource、state、result、reply、delivered；首次访问自动建表）。
- **回调真实 URL：`https://mastra-l1.summersmile1984.workers.dev/a2a-callback`**（registerApiRoute 自定义路由**不带 `/api` 前缀**，同 `/health-l1`）。校验 `X-A2A-Notification-Token` 与 secret `PUSH_TOKEN`（timing-safe），按 taskId 幂等。
- 回调后：D1 写 result → `ctx.waitUntil(orchestrator.generate(<sandbox-result>…, 同 thread memory))` 生成汇报，写入 D1 `reply` 并进入 thread 记忆；前端每 4s 轮询 `GET /l2-results?thread=<sid>` 显示（generate 失败 60s 后退化显示原始结果）。
- 配置：
  - Worker secret `L2_A2A_URL` = L2 公网根地址（如 `https://l2.xxx.trycloudflare.com`，自动补 `/api/a2a/l2-worker`）
  - Worker secret `PUSH_TOKEN` = 随机串（本机副本 `~/.config/cloudflare/mastra-l1-push-token`，不入 git）；L2 侧无需知道，它原样回传
  - Worker var `L1_PUBLIC_URL`（CloudflareDeployer vars，默认本 Worker 域名）决定回调地址
  - L2：`L2_PUSH_ALLOWLIST=https://mastra-l1.summersmile1984.workers.dev/a2a-callback`（必须与上面完全一致）
- 验证：L2(4122, ACP_DRY_RUN=1) → Worker `/a2a-callback` push 200；模拟已登记任务回调 → reply 生成并经 `/l2-results` 取回、重复回调 `duplicate`；错 token 401；Worker generate 触发工具，L2 不可达时返回 `ok:false` 并对用户优雅说明（不崩）。

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
