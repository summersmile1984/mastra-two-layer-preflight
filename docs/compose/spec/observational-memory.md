---
feature: observational-memory
status: in-progress
updated: 2026-11-04
source: observational-memory
---

# Observational Memory（OM）——秘书的长期记忆

## Report

## [S1] Problem

L1 秘书目前只记得每个房间最近 20 条消息（`src/mastra/index.ts:131` 的 `Memory({ lastMessages: 20 })`）。主人的称呼、偏好、在做的事、做过的任务，跨会话即忘；房间聊过的内容也无法沉淀与回查。这与「记住所有主人的信息、偏好、做的事情，它也会记住所有的事情」的产品愿景直接冲突，也是人格化、运筹管理、主动关怀三块后续能力的共同地基。

技术症结：Mastra 官方 Observational Memory（Observer → observation log → Reflector 压缩，`@mastra/memory@1.40.0`）持久化依赖 `MemoryStorage` 的 OM 扩展面（`supportsObservationalMemory` + 一组观测生命周期方法），官方适配器只实现了 pg/libsql/mongodb——`@mastra/cloudflare-d1` 对 OM 是**零支持**（经勘察：`D1Store` 无任何 ObservationalMemory 符号）。AGENTS.md 既定方向：OM 存储由本项目自行扩展到 D1。

## [S2] Design

### S2.0 领域映射（既有约定，不改）

- 会话归属沿用官方 multi-user threads 模式：共享房间 `thread = roomId`、`resource = room:<roomId>`，发言者身份在消息体（现为 `【名字】` 前缀）。
- OM 采用 **thread scope**（官方默认且推荐；resource scope 已废弃）。每个房间/未来的主会话各自积累观测日志；跨会话连续性靠 recall 工具（S2.4）与主人画像平面（S2.3）。

### S2.1 D1 的 OM 存储适配（核心）

新增 `src/mastra/om-d1.ts`，把 OM 扩展面**装饰**到 `D1Store` 的 memory domain 实例上（不动 node_modules；不重写整个 storage）：

- 能力位：`supportsObservationalMemory = true`；`supportsObservationalMemoryHistorySearch = true`（D1 单表索引可满足 history 过滤）。
- 表 `mastra_observational_memory`（参照 `@mastra/libsql` 同名表 + core 的 `OBSERVATIONAL_MEMORY_LIFECYCLE_COLUMNS`）：列含 `id, scope, thread_id, resource_id, created_at, updated_at, last_observed_at, origin_type, generation_count, superseded_by, active_observations, buffered_chunks(JSON), buffered_reflection, buffered_reflection_tokens, buffered_reflection_input_tokens, reflected_observation_line_count, observed_message_ids(JSON), config(JSON), is_buffering_observation, last_buffered_at_tokens` 等（以 `ObservationalMemoryRecord` 形状为准）。
- 方法（契约以 `@mastra/core` `MemoryStorage` OM 扩展面为准）：`getObservationalMemory`、`getObservationalMemoryHistory`、`initializeObservationalMemory`、`insertObservationalMemoryRecord`、`updateActiveObservations`/`commitActiveObservations`（带 expected 文本/记录 CAS 的 fencing）、`updateBufferedObservations`/`appendBufferedObservations`、`swapBufferedToActive`、`createReflectionGeneration`、`updateBufferedReflection`、`swapBufferedReflectionToActive`、`setBufferingObservationFlag`、`clearObservationalMemory`、`updateObservationalMemoryConfig`。
- 并发语义：复用 core 导出的共享生命周期规则（`compareObservationalMemoryHeadOrder`、`planReflectionGenerationText`、`isBufferedChunkCoveredByCursor` 等）；D1 无跨语句事务，fencing 写一律用**单语句条件更新**（`UPDATE … WHERE …` 判定 changes）或 `D1 batch()`（事务性）提交多步生命周期。头选取规则：`generation_count DESC, created_at ASC, id ASC`，head 的 `superseded_by IS NULL`。
- 本地 `wrangler dev`（miniflare 本地 D1）为第一验证环境，生产 D1 为最终验收环境。

### S2.2 orchestrator 启用 OM

`src/mastra/index.ts` 的 Memory 配置改为：

- `observationalMemory: { model: 'deepseek/deepseek-chat', observation: { messageTokens: 2_000, bufferOnIdle: true, activateAfterIdle: 300_000, instruction: <秘书取向> }, reflection: { observationTokens: 8_000, instruction: <合并保留偏好/决定/待办> } }`（阈值按聊天节奏调小；OM 的 Observer/Reflector 走真 DeepSeek，禁 mock）。
- `observation.instruction` 指明观察重点：主人的身份/称呼/偏好/决定/在做的事/承诺与待办；`reflection.instruction` 指明压缩时优先保留上述事实、丢弃寒暄。
- 观测失败策略 `observation.failurePolicy: 'continue'`（记忆不能阻断对话）。

### S2.3 主人画像平面（跨会话、按人归集）

房间是多用户共享 thread（resource=room），working memory 会按房间归集，无法承载「主人画像」。故画像走 Extractor API + 自有表：

- `observation.extract` 挂自定义 `Extractor({ name: 'User profile', schema: z.object({ name, preferredName, timezone, preferences, ongoing, facts }) })`，instructions 指明只从带 `【名字】` 的发言中抽取该发言者的稳定信息。
- `onExtracted` 把结果 upsert 到 D1 表 `om_profiles(user_id PRIMARY KEY, email, payload JSON, updated_at)`，按消息里的发言者（`【名字】` ↔ user 表）归集；抽取失败不影响其它 extractor。
- 注入：`sendMessage` 在调 `chat.stream` 前读取房间成员的 `om_profiles`，把紧凑画像块（成员几行以内）并入上下文（system 消息），让回复自然体现「记得主人」。
- 检索与画像互补：观测记事实流，画像记稳定结论。

### S2.4 跨会话召回（recall，含向量语义检索）

- `observationalMemory.retrieval: { vector: true }`（messages / threads / search / observations 四模式）。`search` 走语义相似度：消息与观测组被向量化入库，recall 工具可跨会话按语义找回历史。
- 向量层契约见 S2.7：Cloudflare Vectorize 承载向量，Workers AI `@cf/baai/bge-m3` 出嵌入（中英双语，1024 维，cosine）。
- recall 工具自动注入 agent；instructions 提示：需要核实历史细节时先 recall（语义搜索或翻页）再回答。

### S2.7 向量层（Vectorize + Workers AI embeddings）

- `src/mastra/vectorize-store.ts`：`class VectorizeStore extends MastraVector`（`@mastra/core` 的向量抽象：`query/upsert/createIndex/listIndexes/describeIndex/deleteIndex/updateVector/deleteVector/deleteVectors`），实现落在 `env.VECTORIZE`（Vectorize binding）：
  - `upsert` → `index.upsert`（向量附 metadata：threadId/resourceId/kind 等）；`updateVector` → 同 upsert 覆盖。
  - `query` → `index.query`（topK + returnMetadata；filter 映射 Vectorize 元数据过滤）。
  - `deleteVectors({ids|filter})` → `deleteByIds`；filter 删除先 query 取 id 再删（Vectorize 无按过滤整删时的回退路径）。
  - `createIndex`/`describeIndex` → 运行时校验索引存在（`om-memory`，1024 维，cosine；索引经 `wrangler vectorize create` 预建）；`deleteIndex` 不支持并显式报错。
- `src/mastra/workers-ai-embedder.ts`：把 `env.AI.run('@cf/baai/bge-m3', { text[] })` 包成 AI-SDK EmbeddingModel（`doEmbed`），供 `Memory({ embedder })` 消费。批量与错误重试按 `MastraEmbeddingOptions` 约定。
- `wrangler.jsonc` 增加绑定：`ai`（`AI`）与 `vectorize`（`VECTORIZE` → `om-memory`）。
- 维度/度量一致性：索引 1024 维 cosine 与 bge-m3 输出一致；换模型必须重建索引。

### S2.5 记忆检视接口（最小，覆盖 AGENTS.md 缺口 3 的入口）

鉴权路由（复用 better-auth 会话）：

- `GET /om/profile` → 当前登录用户画像（自己）。
- `GET /om/observations?thread=<roomId>` → 该房间观测日志（调用者须为房间成员；返回 active/buffered 文本与 generation 链）。
- `GET /om/export` → 当前用户全部画像 + 其可见房间观测的 JSON 导出。
- 前端暂不建设管理界面；接口可 curl/脚本消费。

### S2.6 失败与降级

- OM 存储异常（D1 报错）只记日志并跳过本周期，不影响对话主链路。
- `PROBE/调试`：观测计数、generation 变化打 `console.log`（worker 日志可见），便于 tail 验证。

## [S3] Out of Scope

- KnowledgeStorage 全契约移植、`Subconscious`（remind/curate）实验面、pinned pages、knowledge tools（向量层只服务 Memory 的语义召回，不做 knowledge 域）。
- 主会话 UI、拟人化人格改写（下一独立切片）；OM 管理界面的图形版（本切片只做数据面 + JSON 检视接口）。
- 多 PC/云执行位、运筹工具补全、调度例程（另片）。
- 不改 resource=room:<id> 的多用户会话映射（官方模式，已验证）。

## Tasks

- [ ] T1: D1 OM 存储适配（`src/mastra/om-d1.ts` + `mastra_observational_memory` 表 + 全部生命周期方法 + 能力位） — acceptance: 本地 wrangler dev + 真 DeepSeek 下 `observe({force:true})` 后 D1 出现观测记录；连续观察→触发反射后 `generation_count` 递增、旧记录 `superseded_by` 正确链接（covers: S2.1）
- [ ] T2: orchestrator 启用 OM（配置阈值/指令/失败策略） — acceptance: 真实房间对话 2–3 轮后（idle/阈值激活）观测文本包含对话事实；下一轮上下文可见观测内容（covers: S2.2, depends: T1）
- [ ] T3: 主人画像平面（Extractor + `om_profiles` 表 + 上下文注入） — acceptance: 对话中陈述「我叫小王，我喜欢 X」后 `om_profiles` 出现对应用户画像行；同房间后续提问能正确复述画像内容（covers: S2.3, depends: T2）
- [ ] T4: recall 工具接线（retrieval 含 vector） — acceptance: agent 工具列表含 `recall`；让 agent 回忆「上次说了什么」能经 recall 取回并正确作答；用与原话不同措辞的语义查询也能命中（covers: S2.4, depends: T2, T7）
- [ ] T5: 检视/导出接口 `/om/profile`、`/om/observations`、`/om/export` — acceptance: 登录用户可取回自己的画像；房间成员可取回该房间观测；非成员 403；导出 JSON 含画像+观测（covers: S2.5, depends: T2, T3）
- [ ] T6: 生产部署与端到端记忆验证（真 D1 + 真 DeepSeek + 真 Vectorize/Workers AI，无 mock） — acceptance: 部署到 mastra-l1 后跨会话记忆场景通过（先告知偏好→新会话提问能回忆，含语义改述查询），并留存 curl/E2E 证据（covers: S2.1–S2.5, S2.7, depends: T1–T5, T7）
- [ ] T7: 向量层（VectorizeStore + Workers AI embedder + `om-memory` 索引 + wrangler 绑定） — acceptance: upsert/query/deleteVectors 在生产 Vectorize 真实生效（curl/脚本可见命中）；embedder 对中英文文本返回 1024 维向量（covers: S2.7）

## Journey log

- 勘察确认：OM 数据面在 `@mastra/memory@1.40.0` 为 `observationalMemory` 选项（Observer/Reflector/Extractor/recall），存储走 `MemoryStorage` 的 OM 扩展面（`supportsObservationalMemory` 等），`@mastra/cloudflare-d1` 无任何实现——与 AGENTS.md「自行扩展到 D1」一致。移植参考为 `@mastra/libsql` 的 `mastra_observational_memory` 实现（约 15 个生命周期方法），core 已导出共享生命周期规则可直接复用。
- 多用户房间的记忆归属沿用官方 multi-user threads（resource=room:<id> + 消息体内身份）；主人画像因此不走 working memory（会按房间归集），而走 Extractor `onExtracted` → 自有 `om_profiles` 表 + 注入。
- 语义召回最初列为「留后续」（顾虑 D1 无向量索引）；用户指正：Cloudflare 有 Vectorize + Workers AI 可做 memory recall——改为本切片内做 `MastraVector` 适配（Vectorize）+ bge-m3 嵌入（S2.7/T7），`retrieval: { vector: true }` 全开。
