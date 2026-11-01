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
