---
feature: persona-main-session
status: designed
updated: 2026-11-05
source: persona-main-session
---

# 拟人人格 + 主会话——秘书的脸与专属对话

## Report

## [S1] Problem

L1 已有长期记忆（observational-memory），但它的「脸」仍是任务调度员（`src/mastra/index.ts` 的 `INSTRUCTIONS` 是总管口吻），且会话模型只有共享房间——愿景里的「拟人化的 24 小时 AI 秘书/管家/伴侣」和「一个主会话，和主人的主会话」都没有落地：主人没有一个天然说体己话的地方，房间里也不适合伴侣式口吻。

## [S2] Design

### S2.1 主会话（与秘书的一对一）——打标房间，复用全链路

- `rooms` 增加 `is_main INTEGER NOT NULL DEFAULT 0`（迁移 `migrations/0002_persona_main.sql` + 运行时幂等 `ALTER TABLE`，同 l2_tasks.prompt 先例）。
- `ensureMainRoom(db, userId)`：登录后首次 `GET /rooms` 时自动建主会话（名「我的秘书」，`is_main=1`，`created_by=owner`，仅本人入 membership）；幂等，二次登录不再新建。房间全链路（消息/SSE/RoomDO WS/OM 记忆/画像）原样复用。
- `listRooms` 返回 `is_main`；主会话不可被改名/删除（现有 API 本无删除）。
- 多用户共享房间保持 resource=room:<id> 官方模式不动；主会话天然单人。

### S2.2 拟人人格（秘书/管家/伴侣）

重写 `INSTRUCTIONS`：身份是常驻的秘书/管家/伴侣——温和、可靠、记得主人（自然引用画像与历史，不背诵）、「我来处理」式尽责 + 体己话的亲近感。**保留全部既有硬约束**：慢任务立刻 `dispatch_to_sandbox` 并简短回执；绝不提 L2/harness/ACP/沙箱/任务 id/内部路径；绝不复述密钥、不引导用户发密码；中文短句。

### S2.3 语调路由（主会话 vs 共享房间）

`chat.stream` 包装层（`src/mastra/index.ts`）按房间 `is_main` 注入一行语调指令：
- 主会话：亲密的管家伴侣口吻，可自然用主人的称呼与偏好（画像块 S2.3-OM 已注入）。
- 共享房间：得体、均衡、照顾在场成员，不对外人表现出对主人的私密了解（画像块只在主会话注入？——**不**：画像块保留全员注入但语调约束「不要对其他成员炫耀私密信息」，主会话语调放开）。
- 查 `is_main` 用单行 D1 查询（按 roomId，失败默认按房间语调）。

### S2.4 SPA：主会话置顶

- `Sidebar`：主会话固定第一行、单独分组「主会话」，头像用「秘」，名称「我的秘书」；其余房间分组「房间」不变。
- 选中态/未读样式沿用现有房间行。

## [S3] Out of Scope

- 主动问候/提醒/调度例程（另片：运筹 + 调度）；语音/形象头像；秘书改名/换人设配置化；HITL 审批（另片）；房间管理（删除/退出）。
- 不改多用户房间的 resource=room:<id> 记忆映射与 OM 结构。

## Tasks

- [ ] T1: 主会话供给（`is_main` 列 + `ensureMainRoom` + `listRooms` 返回字段） — acceptance: 新用户首次 GET /rooms 自动出现「我的秘书」；同用户再取不重复创建；rooms 列表含 is_main 标记（covers: S2.1）
- [ ] T2: 人格指令重写 + 主/房间语调路由 — acceptance: 生产实测主会话与共享房间各一轮对话，口吻差异明显（主=亲密管家伴侣、房=得体均衡），且自然引用主人偏好不背诵；既有硬约束不回退（派发纪律/内部术语/密钥）（covers: S2.2, S2.3, depends: T1）
- [ ] T3: SPA 侧栏置顶主会话 — acceptance: 截图可见「主会话」分组置顶、选中进入聊天正常（covers: S2.4, depends: T1）
- [ ] T4: 生产部署与端到端验证（真 D1/DeepSeek，无 mock） — acceptance: 部署 mastra-l1 后新账号走查：登录→主会话自动出现→两语境对话→截图/E2E 证据入 Report（covers: S2.1–S2.4, depends: T1–T3）

## Journey log
