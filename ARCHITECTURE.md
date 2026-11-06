# ARCHITECTURE：L1 常驻编排 + L2 ACP Harness（双层）

```
 浏览器 (public/index.html, 只看见 L1)
   │  POST /api/message (202)        ▲ SSE /api/events: hello | l1{text,images} | status{phase} | secret_request | error
   ▼                                 │
 L1  Mastra AgentController  (src/l1/controller.ts)   ← session.sendSignal(<sandbox-result>) 唤醒
   │ tool dispatch_to_sandbox                          ▲
   ▼ A2A v0.3 message/send {blocking:false, pushNotificationConfig{url,token}}
 A2A server  @mastra/server getAgentExecutionHandler + InMemoryTaskStore   (/api/a2a/l2-worker)
   │ L2 Agent(l2-worker) → tool run_harness           │ task completed|failed
   ▼                                                  │ AllowlistedPushSender / 官方 DefaultPushNotificationSender
 @mastra/acp AcpAgent → `dsh --profile acp` (stdio)   └──► POST /api/a2a-callback (X-A2A-Notification-Token, timingSafeEqual)
                                                           → 收 PNG → pendingImages[sid] → sendSignal → L1 主动回复（带 images）
```

## 硬约束对应
| 约束 | 实现 |
|---|---|
| UI 只显示 L1 | `/api/bots` 只有总管；SSE 不转发 L2 事件；`sanitizeUserFacing` 去掉路径/UUID/L2 术语/`sk-` 密钥 |
| L2 只跟 L1 通信 | 浏览器无任何 L2 端点；A2A 端点仅供 L1 |
| L2 完成主动通知 | A2A push → callback → `sendSignal`；`L2_MODE=queue` 时同进程 `sendSignal` |
| 截图进原型气泡 | `newScreenshots()` → `screenshots/task-<id>.png` → `l1.images`；宿主 Chrome 兜底 |
| localhost push | `AllowlistedPushSender`（精确 URL 白名单、失败不崩、5s 超时）；`PUBLIC_BASE_URL=https://…` 时自动用官方 sender |
| 密码 | `request_secret` tool → SSE `secret_request` 表单 → `POST /api/secret` → 服务端 vault（10min TTL），模型只拿 `secretRef` |
| 进度中询 | `job_status` 只读 L1 的 task registry，不发任何东西给 L2 |

## 运行
```bash
export PATH=~/.local/node22/bin:$PATH; cp .env.example .env  # 填 DEEPSEEK_API_KEY
npm start                        # http://localhost:4120
curl localhost:4120/api/health   # 模式、模型、harness/chrome 是否可用（无密钥）
```
验证截图：UI 里点 chip「在本地帮我做一个咖啡店落地页并截图」，L1 先回“我来处理”，数分钟后不需追问即收到带图气泡。
脚本化验证：参考 RESULTS.md 的 curl 流程（SSE 录到文件）。

## 降级
- 无 `dsh`：`/api/health.harness=false`，任务以 failed 推回 L1，L1 告知用户；`ACP_DRY_RUN=1` 明确标注非真实执行。
- 无 Chrome / cloud bwrap 起不了 Chrome：宿主 `CHROME_BIN` 渲染 `site/index.html`；都没有则只回文字。
- 无 DeepSeek key / 探测失败：L1 回退脚本模型（`USE_SCRIPTED=1` 强制）。
- ACP 超时 `ACP_TIMEOUT_MS`（默认 15 min）→ session/cancel → failed 推送。

## 生产接入（未实现，仅说明）
- **CF Tunnel**：`cloudflared tunnel --url http://localhost:4120` 或命名 tunnel，把域名设为 `PUBLIC_BASE_URL`；L2 远端部署时设 `L2_A2A_URL`。https 公网回调即可改用官方 sender（SSRF 防护保留）。建议给 `/api/a2a/*` 加 CF Access service token。
- **CF Secrets**：Workers/Containers 用 `wrangler secret put DEEPSEEK_API_KEY`、`A2A_PUSH_TOKEN`；本地仍走 `.env`。HITL vault 生产应换成 KV/Secrets Store + 加密，按 `secretRef` 注入 L2 env，不经模型。
- **持久化**：L1 侧 task registry 已存 `data/tasks.json`（原子写+过期 GC），push token 存 `data/push-token`(0600)；重启后 callback 会重建 session 唤醒 L1。L2 的 A2A TaskStore 仍在内存。
- **HITL suspend/resume（已实现）**：`request_secret` 调 `suspend()` → SSE `secret_request` → 表单 POST `/api/secret` 存 vault → `respondToToolSuspension({resumeData:{secretRef}})`。模型只看到句柄；dispatch 时绑定到单个 task，L2 以 env + 一次性 0600 文件注入，结束即销毁。


## 进程拆分
- `src/server.ts`：L1+UI+callback。设置 `L2_A2A_URL` 即进入 split 模式，不再挂内置 L2 路由。
- `src/l2-server.ts`：独立 L2（A2A handler + ACP harness），push 走 `L2_PUSH_ALLOWLIST` 或官方 DefaultPushNotificationSender。
- `cf/worker.ts` + `wrangler.toml`：CF Workers L1 占位（health/回调/手动派发），完整移植清单见 DEPLOY-CF.md。

## PC 桌面 App（2026-11-02）
- **路径**：`apps/l2-desktop` — Tauri 2 + TypeScript（软浅色壳）。
- **角色**：L2 执行位——本机 claim 循环（`src/main.ts`）→ `POST /l2-claim` → 专家（Mastra Agent）或 ACP（`runAcpPrompt`/`dsh`）或 CUA（`cua` CLI）→ `POST /a2a-callback`。
- **配对**：`~/.config/mastra-l2/device.json`（l1Url / token / intervalMs）。
- **开发**：`cd apps/l2-desktop && npm i && npm run tauri:dev`（需 Rust + Node；详见该目录 README）。
- **非目标**：不克隆 Grok Bot 品牌资源；不做 Mastra Workflows。

## L1 前端（2026-11-02）
- **现行**：`apps/web` — Vite + React + TypeScript + Tailwind，软浅色产品风。
- 构建产物经 `scripts/cf-postbuild.mjs` 写入 Workers Static Assets（站点根路径）。
- 仍调用同一套 `/api/*`（auth / rooms / settings）；Mastra L1 留在 Workers。
