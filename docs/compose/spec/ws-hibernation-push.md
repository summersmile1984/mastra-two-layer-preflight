---
feature: ws-hibernation-push
status: in-progress
updated: 2026-11-04
source: ws-hibernation-push
---

# WebSocket Hibernation 实时推送

## Report

## [S1] Problem
房间聊天当前靠前端 4 秒轮询 `GET /api/rooms/:id/messages` 同步消息与忙状态。多人同房时对方发言最迟 4 秒才可见，实时感差；空转轮询持续消耗 D1 读与请求额度。需要服务端主动推送（消息 + 忙状态），断线时仍能降级回轮询。

## [S2] Design

### [S2.1] RoomDO：每房间一个 Durable Object（Hibernation）
- DO 类 `RoomDO`，`idFromName(roomId)` 取实例——每房间单例、天然分片。
- **必须用 WebSocket Hibernation API**（`ctx.acceptWebSocket(ws)` + `webSocketMessage/webSocketClose/webSocketError` 回调），这是本特性的核心诉求：连接挂在 DO 上、实例可休眠、休眠期间不占内存不计 duration，连接在边缘仍被认识。**禁止**用 `WebSocketPair` 在 fetch 里持连（那会让 DO 常驻内存，图示方案即失效）。
- DO 自身不持业务状态：推送内容一律从 D1 读（`messages` / `l2_tasks`），状态恢复天然成立。DO 的 fetch 只处理两类入站：客户端 WS 升级、Worker 的 notify 唤醒（见 S2.3）。notify 处理完广播即返回，DO 回到休眠。

### [S2.2] WS 协议与鉴权
- 端点：`GET /rooms/:id/ws`（`Upgrade: websocket`）。浏览器同源自动带 session cookie。**注意：Mastra 保留 `/api/*` 给内置路由（validateCustomRoutePaths 硬报错），自定义路由禁用 `/api` 前缀**；房间/鉴权路由相应为 `/rooms/*`、`/auth/*`（better-auth `basePath: '/auth'`），前端 api.ts 已同步。
- Worker 侧升级前完成鉴权：`getSessionUser`（better-auth cookie，DEV 旁路同现状）+ 房间成员校验（`room_members`）；无会话 401、非成员 403，均不升级。通过后把请求（含 Upgrade 头）转给 DO stub，由 DO `acceptWebSocket`。
- 事件（JSON 文本帧）：
  - `{type:'message', message:{id,room_id,user_id,role,content,created_at}}`
  - `{type:'busy', busy:boolean}`
  - 客户端心跳：每 25s 发 `{type:'ping'}`，服务端不必须回（浏览器协议层自动 pong）；任意入站视为存活。

### [S2.3] 唤醒/广播路径（谁在何时 notify DO）
写库成功后调 `env.ROOM_DO.getByName(roomId).fetch(notify)`，携带事件类型；DO 被唤醒后从 D1 读权威数据再广播（推送内容以 D1 为准，notify 只是闹钟）：
1. **用户消息**：`rooms.ts` `sendMessage` 写 `messages` 后 → `message` 事件（推用户这条）。
2. **助手回复**：`sendMessage` 流式结束持久化 assistant 行后 → `message` 事件。
3. **忙状态开**：`dispatch_to_sandbox` 插入 `l2_tasks` 后 → `busy:true`。
4. **忙状态关 + 后台结果**：`finalizeTask` 终态写入后 → `busy:false` + `message`（见 S2.5）。
- `rooms.ts` 以可选回调注入通知器（`RoomDeps.notifyRoom?`）：Worker 实现为 DO stub 调用；本地 Node demo 不注入（该环境无 DO，自动静默降级，前端回轮询）。通知失败只记日志，不影响主流程。

### [S2.4] 轮询降级梯度（兜底，不是双轨常开）
- WS 健康（收到过任意帧且未断）：轮询降为 15s（安全网，覆盖唤醒失败等极端丢事件）。
- WS 断开/未连上：轮询保持现有 4s（现状行为即降级态）。
- 前端 `useRoomSocket`：指数退避重连（1s 起，封顶 30s）；WS `message` 事件与轮询结果共用现有按 `id` 去重合并逻辑，重复投递无害。

### [S2.5] L2 后台结果落 messages（顺带补基线缺口）
现状缺口：L2 任务完成只写 `l2_tasks.reply`（旧 SPA 走 `/l2-results`），新 SPA 只读 `messages` 表，后台结果**永远不会出现在房间里**。本特性顺带补上：`finalizeTask` 终态后把 reply 落一条 assistant 行进 `messages`（`room_id = thread_id`），再触发 S2.3.4 的 notify。

### [S2.6] 配置与文档
- wrangler：`durable_objects.bindings`（`ROOM_DO`）+ `[[migrations]]`（`new_sqlite_classes` 或 `new_classes`，以 wrangler 版本实测为准）；构建产物 `.mastra/output/wrangler.json` 由 `cf-postbuild.mjs` 补齐（延续 assets 的做法）。
- AGENTS.md 修订：§3/§6 的「不引入 DO / WebSocket」非目标改为本例外（用户明确提出 WS 实时推送需求，触发原文预留的评估条件）；记录 Hibernation 而非常驻 DO 的约束。

### [S2.8] Mastra 构建/分发层集成约束（实现前勘察补充）
- **[S2.8.1] DO 导出缺口**：`CloudflareDeployer.getEntry()` 生成的 `index.mjs` 仅 `export default { fetch }`（内部动态 `import('#mastra')`）；`#mastra` 包装器的 `export * from userEntry` 不会升为 bundle 顶层导出，而 wrangler DO 绑定要求 `class_name` 从 `main` 模块导出。方案：RoomDO 放独立自包含文件 `src/mastra/room-do.js`（仅依赖 `cloudflare:workers` + 直接 D1 查询，不 import Mastra 链路，冷启动轻）；`cf-postbuild.mjs` 生成 `worker-entry.mjs`（`export { default } from './index.mjs'; export * from './index.mjs'; export { RoomDO } from './room-do.js';`）并把 `wrangler.json.main` 重指过去。不复制 Mastra 模板字符串，升级无耦合。
- **[S2.8.2] 返回值透传风险**：`registerApiRoute` 的 Hono 风格 handler 直接返回 Response（`c.json`）已被 P3/P4 生产路由证实透传；流式 Response（SSE）与 WS 101 升级此前只在本地 shim 验证。**T0 实测结论（wrangler dev）：SSE 流式 Response 与 WS 101 均原样透传**（`handleCustomRouteRequest` 直接 `return response`，sendResponse 只作用于数据型路由），Hono 风格 handler 正常——无需退回方案。
- **[S2.8.3] notifyRoom 注入**沿用 [S2.3]：Worker 入口以 `env.ROOM_DO` stub 实现回调；Node demo 不注入自动降级。

### [S2.7] 验证（真实环境，禁止 Mock）
- `wrangler dev` 本地起真实 DO + 真实 D1（`.wrangler/state`），D1 预置 `migrations/0001_auth_rooms.sql`，`.dev.vars` 提供真实 `DEEPSEEK_API_KEY` 等。
- 双浏览器会话（隔离 cookie）同房：A 发言 B **秒级**收到（不经轮询等待）；助手回复为真实 DeepSeek 输出；任务完成 busy→false 与结果消息均实时到达。
- 断网/杀 WS 后 4s 轮询兜底恢复同步。
- 回归：既有 auth（9 项）、rooms（14 项）、路由锁（6 项）套件对工作树重跑通过。

## [S3] Out of Scope
- 打字指示、已读回执、在线状态（presence）。
- 手机厂商推送（APNs/FCM）、页面隐藏时的系统级通知。
- L2 任务进度流（只暴露 busy 布尔；进度流属 AGENTS.md 差距 #4）。
- L1 侧 `l2_tasks` 的 Worker 回拉/claim 链路不动；`/l2-results` 旧端点保留不动。
- 多 PC 分配、OM 管理界面、HITL 密码表单（各自独立缺口）。
- 本地 Node demo server 的 WS 实现（无 DO 环境，前端自动降级轮询即可）。

## Tasks
- [x] T0: Mastra 分发层返回值透传实测（wrangler dev）— acceptance: SSE 流式 Response 与 DO WS 101 均原样到达客户端，或确认封装行为并落定退回方案（covers: S2.8.2）
- [x] T1: RoomDO（Hibernation API，独立 `src/mastra/room-do.js`）+ wrangler DO 配置 + worker-entry 导出 — acceptance: wrangler dev 启动后 `RoomDO` 绑定生效、DO 经 `/api/rooms/:id/ws` accept 连接并保活（covers: S2.1, S2.6, S2.8.1）
- [x] T2: WS 升级路由鉴权 — acceptance: 无 cookie 401、非成员 403、成员成功升级（covers: S2.2）
- [x] T3: notify 唤醒广播链路 — acceptance: 两客户端同房互发消息 <1s 对方收到；notify 只作闹钟、内容读 D1（covers: S2.3; depends: T0）
- [x] T4: L2 结果落 messages + busy 事件 — acceptance: 后台任务结果以 assistant 消息出现在房间，busy 开/关均实时推（covers: S2.5）
- [x] T5: 前端 useRoomSocket + 降级梯度 + 合并去重 — acceptance: WS 健康时 15s 轮询、断开 4s；切房间/重连无重复消息（covers: S2.4）
- [x] T6: AGENTS.md DO 例外修订 — acceptance: 非目标条款记录本例外与 Hibernation 约束（covers: S2.6）
- [x] T7: wrangler dev 双会话 E2E（真 DeepSeek）+ 回归套件 — acceptance: S2.7 全项通过并留存证据（covers: S2.7; depends: T1,T2,T3,T4,T5）

## Journey log
- T7 验证中抓到并发鉴权竞态（8 并发 6×401，`FAILED_TO_GET_SESSION`）：better-auth getSession 读路径的 `needsRefresh` 滚动续期（updateSession 写）并发时输家抛 401。修复：`getSessionUser` 传 `disableRefresh`——读接口无需续期。验证：8/24 并发全 200。教训：读接口不要带隐式写副作用。
- T7 抓到第二个 bug：新成员进房后发言，旧成员列表查不到发送者 → 归属退化成「成员」。修复：mergeMessages 发现未知发送者即触发 onMembersChanged 刷新名单。验证：陈旧列表场景下正确显示「小张」。另发现测试脚本 ROOM 变量为空的假阳性（8×200 打的空路径）——空结果必须复核测试本身的有效性。
- 实施前勘察（Mastra 集成）：`mastra build` 入口模板只导出 `export default { fetch }`，DO 类必须走 worker-entry 重导出（S2.8.1）；`sendResponse` 的 json 包装分支使 SSE/101 透传存疑，前置 T0 实测（S2.8.2）。教训：shim 上验证通过 ≠ Mastra 分发层通过，涉及 Response 形态的都要过一次真 server。
- T0 实测（wrangler dev 8790）：SSE 3 块增量完整到达；WebSocketPair 101 升级 + echo 正常；`/health-l1` JSON 正常、`/rooms` 无 cookie 401。重大发现：`validateCustomRoutePaths` 禁止自定义路由用 `/api` 前缀（每请求 500）——rooms/auth 路径改为 `/rooms/*`、`/auth/*`（better-auth `basePath:'/auth'`），前端 api.ts 同步；WS 端点定为 `/rooms/:id/ws`。
