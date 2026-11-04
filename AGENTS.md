# AGENTS.md — 两层 Agent 架构决定（L1 / L2）

> 本文件是产品/架构硬约束的唯一来源。与 README/ARCHITECTURE 冲突时以本文件为准。
> 背景：对标 Grok Bot 时已明确 **不做多 Bot 花名册**，只做两个 agent。

## 1. 核心决定：两个 agent，不是多个 bot

| | 运行位置 | 职责 |
|---|---|---|
| **L1 agent** | CF Worker（`src/mastra/index.ts`） | 统管（用户唯一对话面）、协调（派发/跟踪/汇报/调度）、**用户 memory** |
| **L2 agent** | 装了 PC app 的 PC（`apps/l2-desktop`） | 本机执行（ACP harness / CUA / expert）、本地上下文（文件/屏幕/登录态） |

- L2 是 **Mastra Agent**（prompt 驱动，如 `buildL2Agent()` / expert runner），不是裸 harness 调用。
- 多任务并行 = L1 协调多个后台 job，**不是**多个具名 bot。
- 多台 PC 时每台都是执行位；任务分配由 L1 协调。
- 用户可见面只有 L1：UI 不暴露 L2/harness/ACP/jobId/内部路径（`sanitizeUserFacing`）。

## 2. 存储：CF D1 是唯一存储中心

- L1 **不使用 LibSQL**（LibSQL 仅本地 Node 版 preflight 调试用，`src/l1/controller.ts`）。
- D1 承载：threads/messages、**Observational Memory 记录**、`l2_tasks`（L2 任务状态）、`agent_defs`（L2/专家 agent 定义，参考 `@mastra/agent-builder` 的 agent 定义模式）。
- 用户 memory 走 Mastra **Observational Memory（OM）**：Observer + Reflector 后台压缩历史为 observation log，跨会话持久。OM 存储支持由独立包实现：`~/Documents/mastra-cloudflare-d1-om`（`MemoryStorageD1OM` / `D1StoreOM`，测试跑 wrangler 本地 D1 binding；成熟后回推 `@mastra/cloudflare-d1`）。OM 后台周期在 Workers 上用 `waitUntil` / Queue / Cron Trigger 驱动，不用 DO。

## 3. 通信：HTTP 回调为主；房间实时推送用 DO（Hibernation）

- L2 完成 → `POST /a2a-callback`（`X-A2A-Notification-Token` timing-safe 校验）→ 结果写 D1 `l2_tasks` → `waitUntil(orchestrator.generate())` 生成汇报写 `reply` → 前端轮询 `/l2-results`。
- P3 主路径：L2 出站 PULL（`/l2-claim` 轮询取任务 → 执行 → `/a2a-callback` 回结果），适配本机出口 DNS 被劫持、cloudflared 不可用的场景。
- P4 兜底：Worker 侧 `tasks/get` 经隧道回拉终态（push 打不到 L2 时）。
- **DO 例外（2026-11-04，用户明确提出 WebSocket 实时推送需求，触发原文预留的评估条件）**：房间消息/忙状态走 `RoomDO`（每房间 `idFromName` 一实例）+ WebSocket **Hibernation API**（`ctx.acceptWebSocket`——连接在、实例可休眠、不计 duration，状态从 D1 恢复；**禁用** WebSocketPair 常驻方案）。写库后 notify 只作「闹钟」，推送内容一律读 D1。轮询保留为断线降级兜底（WS 健康 15s 安全网，断开 4s）。L2 任务链路（claim/callback/回拉）不动，仍走 HTTP。

## 4. 对用户不可见的内部细节

绝不向用户提及：L2、harness、ACP、沙箱、运行时、jobId、内部路径、A2A。只用自然语言说"我来处理/处理好了"。

## 5. 安全硬约束

- 密码/令牌：`request_secret` HITL → 服务端 vault（10min TTL）→ 模型只见 `secretRef` 句柄；派发时绑定为 L2 子进程 env + 一次性 0600 文件，任务结束销毁。明文永不进模型上下文/日志/SSE。
- Push 回调：精确 URL 白名单（`AllowlistedPushSender`）或公网时官方 sender（SSRF 防护）；token 用 `timingSafeEqual`。
- 出口脱敏：`sanitizeUserFacing`（路径/UUID/`sk-` 密钥/L2 术语）+ `redactKnownSecrets`。

## 6. 非目标（不要做）

- 多 Bot 花名册、Bot 间互发消息/群聊/任务交接（Grok Bot 形态，本项目明确不做）。
- 把 L2 执行默认搬到云电脑：L2 在用户 PC 上是刻意选择（隐私、本机工具、登录态）。云沙箱只是可插拔执行位，不是默认。
- 引入 Durable Objects / WebSocket 用于 L2 任务链路或通用消息总线：L2 链路保持 HTTP 回调/轮询。**例外**：房间实时推送已用 RoomDO + Hibernation（2026-11-04 用户明确要求，见 §3）；扩展 DO 用途需沿用「闹钟 + 读 D1」模式并走同样评估。

## 7. 待补差距（优先级）

1. **审批路由**：危险操作/外发草稿上报用户确认（当前 ACP `onPermissionRequest` 自动 allow 是安全债）。
2. **L1 调度/例程**：定时任务、多任务排队、多 PC 分配、失败重试。
3. **OM 管理界面**：记忆可检视/可导出（反超 Grok Bot 记忆黑盒的点）。
4. **L2 PC app 成熟度**：进度流、产物预览、离线积压/补跑。
