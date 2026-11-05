---
feature: memory-recall-search
status: designed
updated: 2026-11-05
source: recall-model
---

# Memory Recall 语义检索补完（search 通路）

## Report

## [S1] Problem

「记得住」的另一半是「查得出」：recall 工具的 `mode:"search"`（语义检索）依赖 `Memory.searchMessages` → 观测组向量查询；经典 `semanticRecall`（消息向量 RAG）则从未开启——`memory_messages_1024` 索引是空的（OM 切片已注明）。且 Vectorize 元数据过滤缺 `observed_at` 索引，search 的时间过滤会打空。结果：语义问法只能靠 OM 摘要 + 最近消息兜底，超过 20 条窗口的事实查不回来。

## [S2] Design

### S2.1 通路现状（已核实的机制）

- recall `mode:"search"` → `Memory.searchMessages`（`@mastra/memory`）→ 查询 **`memory_observations_1024`**（观测组向量，`onIndexObservations` 在观察周期入库），filter：`resource_id`/`thread_id`/`observed_at`（ISO 串 $gt/$lt）。
- `options.semanticRecall`（默认关）= 消息向量 RAG：`saveMessages` 时把消息嵌入 **`memory_messages_1024`**，按 query 相似度召回历史消息（topK/messageRange，scope resource|thread），并自动注入上下文。

### S2.2 变更

1. **开启 semanticRecall**：`options.semanticRecall: { topK: 5, messageRange: 2, scope: 'resource' }`（观察期索引 + 保存期嵌入均在请求/队列内存活，Workers 安全）。与 OM 共存：OM 管压缩后的观测日志，semanticRecall 管原始消息细粒度找回（`mode:"observations"` 亦可用于回看被反思掉的组）。
2. **Vectorize 元数据索引补齐**：`observed_at`（string）加到 `om-memory-obs`（search 时间过滤）；确认消息索引过滤字段（`resource_id`/`thread_id` 已有）。运维动作：`wrangler vectorize create-metadata-index`。
3. 不改 resource=room:<id> 映射（跨房间语义检索不在本片；跨房间记忆继续由画像平面承担）。

### S2.3 验收方式（行为化，无 mock）

同房间制造「事实 + 25 条稀释消息」（事实沉出 lastMessages 窗口）→ 用改述语义提问 → 须答对（证明 search/semanticRecall 命中而非窗口记忆）；并用 Vectorize REST 确认 `memory_messages_1024` 出现向量、`observed_at` 过滤生效（时间窗查询非空）。

## [S3] Out of Scope

- 跨 resource（跨房间）语义检索；resource 映射改造；`retrieval.vector` 的 observations 回看面板；Embedding 模型更换（走 model-config 切片）。

## Tasks

- [ ] T1: 开启 semanticRecall（Memory options） — acceptance: 对话后 `memory_messages_1024` 经 REST 查询出现向量（covers: S2.2-1）
- [ ] T2: Vectorize 元数据索引补齐 observed_at — acceptance: 时间窗过滤查询非空（covers: S2.2-2）
- [ ] T3: 行为化验收（事实沉底 + 改述语义提问命中） — acceptance: 超出 lastMessages 窗口的事实被正确答出；无记忆时明确说不记得（covers: S2.3, depends: T1, T2）
- [ ] T4: 生产验证与定稿 — acceptance: E2E 证据入 Report，既有链路零回归（covers: 全部, depends: T1–T3）

## Journey log
