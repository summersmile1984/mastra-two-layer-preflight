# Auth & Rooms (Better Auth on Cloudflare Workers + D1)

> 本文件描述**本线（AGENTS.md 为准）**的鉴权与房间契约。远端 v0.2.x 线的 emailOTP / dev OTP sink / 房间邀请 / `room_agents` 等尚未并入，移植时参考 `origin/main` 历史。

- Better Auth 1.7 (`src/auth.ts`, `createAuth(env)`, `database: env.DB`)，**email+password**，无 organization/team 插件。会话 cookie 为 `__Secure-better-auth.session_token`（https）。
- 房间自建：`rooms`、`room_members`（成员含角色）；消息存 Mastra thread（`thread = roomId`，`resource = room:<roomId>`）。主会话 `is_main` 房间 = 与主人的一对一。
- 路由挂载：Mastra `auth` handler 在 `/auth/*`；房间 API 为自定义 apiRoutes（`/rooms/*`，不带 `/api` 前缀）。L2 路由（`/l2-claim`、`/a2a-callback`、`/l2-results`、`/health-l1`）不变。
- 测试账号（生产验证用）见项目记忆；`get-session` 用 `?disableRefresh=true` 避免并发滚动续期竞态。

## Setup
```
npm run cf:build
openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET -c .mastra/output/wrangler.json
npx wrangler deploy -c .mastra/output/wrangler.json
```

## API
| Route | Notes |
|---|---|
| `/auth/*` | Better Auth（sign-up/email、sign-in/email、sign-out、get-session） |
| `GET/POST /rooms` | 房间列表 / 建房（创建者自动成 owner） |
| `GET /rooms/:id` | 房间详情 + 成员 |
| `POST /rooms/:id/members` | 加成员（按邮箱） |
| `GET/POST /rooms/:id/messages` | 消息列表 / 发消息（POST 流式 SSE 回复） |
| `GET /rooms/:id/ws` | RoomDO WebSocket 推送 |

对用户不可见的内部细节（L2/harness/ACP/jobId 等）由 `sanitizeUserFacing` 一类脱敏规则兜底；密钥走 request_secret → CF Secrets Store vault，明文永不进模型上下文。
