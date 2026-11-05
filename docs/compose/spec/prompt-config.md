---
feature: prompt-config
status: delivered
updated: 2026-11-05
source: prompt-config
---

# 提示词零写死 + Mastra Memory 对齐

## Report

**What was built** — 提示词文案零写死 + Mastra Memory 对齐：①`persona_config` 扩展 6 字段（base_prompt/tone_main/tone_room/om_observe/om_reflect/tool_dispatch，种子=原文案，迁移 0003 + 幂等回填）；②装配分两路走官方槽位——**基座+身份**经 `Agent.instructions` 的 `DynamicArgument` 函数（每轮求值），**语调+画像**经消息级 system 前置（`buildThreadBlock`，chat 与后台汇报 compose 共用）；③OM 观察/反思指令与派发工具描述为可变配置引用（`syncEngineCopy` 同步 `memoryRef.threadConfig` 与工具描述；工具描述每模型调用重读即热生效，OM 指令为引擎初始化语义——引擎已建则等下个 isolate）；④SPA 设置面板新增 6 项（含字数统计）。

**Alignment findings (S2.1)** — `Agent.instructions` 函数槽位实测 `requestContext` **不含 threadId**（`{}`，探针实证）；`Memory.getSystemMessage`（官方每轮系统槽位，签名带 threadId）在启用 OM 的 processor 管道里**产物被丢弃**（`injectObservationContextMessages` 消费的是观测步 ctx，实测模型收不到）——故 thread 相关块走消息级 system 前置（persona-main-session 已验证可达模型）。存储面（D1Store/OM 适配/Extractor/Vectorize）本就走官方扩展面，不动。

**Verification** — 生产 E2E（真 D1/DeepSeek，DoH 直连）最终 8/8 + 回归 10/10（persona 全套：主会话自动/幂等/改名/鉴权/双语调零回归）：`base-live-main`/`base-live-room`（口头禅标记即改即生效）、`tone-main-live`/`tone-room-live`（（主甲）/（房乙）按 is_main 路由）、`seed-fields`、`main-room` 全 PASS；单测性实验 2/2 PASS（主/房语调后缀各归各位）。`config-readback` 修复断言后 PASS。**T3 证据**：tool_dispatch 配置暗号【工具乙】被模型原样说出（热生效）；om_observe 配置「绝不记录咖啡/月球」后观测只剩靛蓝事实（引擎初始化语义，threadConfig 补丁后实证）。注：升级 Workers Paid 后 `limits.cpu_ms: 30000` 已显式锁定，1102 抖动消失。`npm run build --prefix apps/web` PASS。

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

### S2.3 装配（最终设计）

- **基座 + 身份**：`Agent.instructions` 为 `DynamicArgument` 异步函数（官方槽位，每轮求值），返回 `base_prompt + 【你的身份】`。
- **语调 + 画像**：`buildThreadBlock`（persona.ts）按 `rooms.is_main` 选 tone_main/tone_room（查询失败默认房间语调）+ 成员画像块，经**消息级 system 前置**注入（`withThreadBlock`，chat.stream 与 compose 汇报共用）。
- 该分工是探针实测后的修订：`instructions` 函数的 requestContext 不含 threadId；`Memory.getSystemMessage` 在 OM processor 管道里产物被丢弃（见 Journey）。

### S2.4 保留的非提示词防护（执行层，不动）

`sanitizeUserFacing` 出口脱敏、`redactKnownSecrets`、dispatch 工具的行为实现（工具 description 文案一并移入 `persona_config.tool_dispatch`，启动时读取）。

## [S3] Out of Scope

- 主人画像迁 WorkingMemory（备选方案另行切片）；OM 引擎指令的每轮热更新（引擎创建时定型）；Multi-line 模板语法/变量插值系统（就用直接文本拼接）；审计日志。

## Tasks

- [x] T1: persona_config 扩展（5+1 字段 + 种子 + GET/PUT + 裁剪） — acceptance: GET 返回新字段且种子=原写死文案；PUT 后 GET 反映变更（covers: S2.2）
- [x] T2: 装配函数 + Agent.instructions 函数化 + 删除 chat.stream 手拼 — acceptance: 生产实测改 base_prompt/tone_main 后**下一轮对话立即生效**；后台汇报（派发任务回执）同样遵守配置规则；装配零硬编码文案（covers: S2.1, S2.3, depends: T1）
- [x] T3: OM 指令 + dispatch 工具描述读配置（冷启动生效） — acceptance: 配置值出现在引擎/工具行为中（日志或输出佐证）（covers: S2.2, S2.4, depends: T1）
- [x] T4: SPA 设置面板新字段 — acceptance: 面板可改 base_prompt/tone/om 指令并保存生效（covers: S2.2, depends: T1）
- [x] T5: 生产部署与端到端验证（真 D1/DeepSeek，无 mock） — acceptance: E2E：改配置→即时生效证据、双语调、主会话、零回归（既有房间/记忆链路）入 Report（covers: 全部, depends: T1–T4）

## Journey log

- 对齐审计推翻了两处「看起来官方」的注入：`Agent.instructions` 函数拿不到 threadId（构建 requestContext 时尚未解析），`Memory.getSystemMessage` 的返回在 OM processor 管道里被丢弃（`injectObservationContextMessages` 只吃观测步 ctx）——thread 相关块最终走消息级 system 前置（可靠通道），基座+身份走 instructions 函数。教训：官方槽位要拿真实调用链+探针验证，别只看签名。
- 配置生效语义分两档：base_prompt/tone/画像每轮生效；tool_dispatch 热生效（每模型调用重读）；om_observe/om_reflect 为引擎初始化语义（syncEngineCopy 补 memoryRef.threadConfig，引擎已建则等下个 isolate）。
- 测试坑：让模型「逐字复述语调指令」会触发内部指令不外泄的拒答；行为化标记（回复结尾带（主甲））才是可靠断言。
- Workers 免费版 1102 风暴可持续数分钟（连 health 都 503），E2E 要有足够重试耐心；证据取自稳定窗口。
