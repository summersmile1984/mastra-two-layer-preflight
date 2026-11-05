---
feature: prompt-config
status: in-progress
updated: 2026-11-05
source: prompt-config
---

# 提示词零写死 + Mastra Memory 对齐

## Report

## [S1] Problem

persona-main-session 把人设四项做成了配置，但仍有写死在代码里的提示词文案：固定基座 `INSTRUCTIONS`、两条语调行、OM 观察/反思指令；且注入方式是 `chat.stream` 手拼 system 消息——绕开了 Mastra 的官方注入管道，`dispatch_to_sandbox` 后台汇报路径还不受这套规则约束。用户要求：①不许有写死的提示词；②与 Mastra Memory 体系对齐、配合好。

## [S2] Design

### S2.1 对齐审计结论（依据 @mastra/core 与 @mastra/memory 实际接口）

- **官方注入口子**：`Agent.instructions: DynamicArgument<AgentInstructions, TRequestContext>`——`T | (({ requestContext, mastra }) => Promise<T> | T)`，每轮求值，`requestContext` 经 `MASTRA_THREAD_ID_KEY`/`MASTRA_RESOURCE_ID_KEY` 可取 thread/resource。聊天与后台汇报（compose 的 generate）天然同一套规则。
- **每轮系统装配**：`Memory.getContext` 的顺序为 观测（OM）→ `getSystemMessage()`（工作记忆）→ 历史；我们不再往 messages 里塞 system 消息，身份/语调/画像全部经 `instructions` 函数进入官方 system 槽位。
- **存储面**（保持现状，已对齐）：对话/观测 = Mastra Memory + MemoryStorage OM 扩展面（自研 D1 适配器）；抽取 = OM Extractor；语义召回 = `retrieval.vector` + `MastraVector`（Vectorize 适配器）。
- **主人画像存储**保留自建 `om_profiles`（resource=room:<id> 与用户级画像错位，官方 WM 装不下）；**注入**改走 instructions 函数。备选（不在本切片）：主会话挂 `resource=user` 的 WorkingMemory。
- **OM 观察/反思指令**：官方配置为引擎创建时读取的静态串（`observation/reflection.instruction`）——移入配置数据，**生效于 isolate 冷启动**（新 isolate 读新值），此语义写进接口说明。

### S2.2 配置面（persona_config 扩展，文案零写死）

新增字段（种子 = 现文案，行为零回归）：`base_prompt`（原 INSTRUCTIONS 全文）、`tone_main`、`tone_room`、`om_observe`、`om_reflect`。字段上限：base_prompt 4000、tone_* 500、om_* 500。`GET/PUT /settings/persona` 全量暴露；SPA「秘书设置」面板加对应输入项（base_prompt 用 textarea）。

### S2.3 装配（src/mastra/persona.ts）

`buildSecretaryPrompt({ threadId })`：`base_prompt` + 【你的身份】(name/role/style) + 【语调】(is_main ? tone_main : tone_room，查询失败默认 tone_room) + 【成员画像】(om_profiles 注入，沿用 loadRoomProfileBlock)。`Agent.instructions` 传 `async ({ requestContext }) => buildSecretaryPrompt(...)`（读 requestContext 的 thread key）；**删除 chat.stream 的手拼 system 消息**（保留入队逻辑与画像注入改为由 instructions 承担）。

### S2.4 保留的非提示词防护（执行层，不动）

`sanitizeUserFacing` 出口脱敏、`redactKnownSecrets`、dispatch 工具的行为实现（工具 description 文案一并移入 `persona_config.tool_dispatch`，启动时读取）。

## [S3] Out of Scope

- 主人画像迁 WorkingMemory（备选方案另行切片）；OM 引擎指令的每轮热更新（引擎创建时定型）；Multi-line 模板语法/变量插值系统（就用直接文本拼接）；审计日志。

## Tasks

- [ ] T1: persona_config 扩展（5+1 字段 + 种子 + GET/PUT + 裁剪） — acceptance: GET 返回新字段且种子=原写死文案；PUT 后 GET 反映变更（covers: S2.2）
- [ ] T2: 装配函数 + Agent.instructions 函数化 + 删除 chat.stream 手拼 — acceptance: 生产实测改 base_prompt/tone_main 后**下一轮对话立即生效**；后台汇报（派发任务回执）同样遵守配置规则；装配零硬编码文案（covers: S2.1, S2.3, depends: T1）
- [ ] T3: OM 指令 + dispatch 工具描述读配置（冷启动生效） — acceptance: 配置值出现在引擎/工具行为中（日志或输出佐证）（covers: S2.2, S2.4, depends: T1）
- [ ] T4: SPA 设置面板新字段 — acceptance: 面板可改 base_prompt/tone/om 指令并保存生效（covers: S2.2, depends: T1）
- [ ] T5: 生产部署与端到端验证（真 D1/DeepSeek，无 mock） — acceptance: E2E：改配置→即时生效证据、双语调、主会话、零回归（既有房间/记忆链路）入 Report（covers: 全部, depends: T1–T4）

## Journey log
