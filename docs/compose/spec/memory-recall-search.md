---
feature: memory-recall-search
status: delivered
updated: 2026-11-05
source: recall-model
---

# Memory Recall 语义检索补完（search 通路）

## Report

**What was built** — Memory recall 语义检索补完：①开启 `options.semanticRecall`（消息向量 RAG，topK 5 / messageRange 2 / resource 作用域）；②**自建消息向量索引**（`src/mastra/index-messages.ts`，队列观察周期后跑，按 message_id 幂等 upsert 到 `memory_messages_1024`）——上游 `indexMessagesList` 是死代码（安装版无调用点）、OM 落库走 `persistMessages`（明说不嵌入），消息向量化链路整体是断的，必须自己接；③Vectorize 元数据索引补 `observed_at`（search 时间过滤）。

**Verification** — 消息向量证据：`wrangler vectorize info` 11→13（2 条真消息含完整 metadata/content），线程过滤查询命中；行为化验收 ×2：「护照号 X123456 / Y987654」沉出 20 条窗口后被改述提问（办签证/证件号）正确答出；回归 10/10（persona 全套零回归）；`npm run build --prefix apps/web` PASS。注：Vectorize 索引水位线分钟级滞后，验证按 ~90s 轮询；之前误判「未落库」即此原因。

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

- [x] T1: 开启 semanticRecall（Memory options） — acceptance: 对话后 `memory_messages_1024` 经 REST 查询出现向量（covers: S2.2-1）
- [x] T2: Vectorize 元数据索引补齐 observed_at — acceptance: 时间窗过滤查询非空（covers: S2.2-2）
- [x] T3: 行为化验收（事实沉底 + 改述语义提问命中） — acceptance: 超出 lastMessages 窗口的事实被正确答出；无记忆时明确说不记得（covers: S2.3, depends: T1, T2）
- [x] T4: 生产验证与定稿 — acceptance: E2E 证据入 Report，既有链路零回归（covers: 全部, depends: T1–T3）

## Journey log

- **上游断链三连**：OM 落库走 `persistMessages`（不嵌入）→ `saveMessages` 的 semanticRecall 嵌入在 OM 开启后永远不跑；`indexMessagesList`（注释称 observe-time 向量化消息）在安装版**零调用点**（死代码）。消息向量化必须自建——教训：官方「有这个方法」不等于「链路通」，要顺着调用点核实。
- `listMessages` 的 `perPage: 0` 表示取 0 条，全部要用 `false`（n=0 静默坑）。
- Vectorize upsert 后索引水位线滞后 ~2 分钟（processedUpTo*），验证要按水位轮询，read-after-write 必然误判。
- 行为化验收的关键：事实必须沉出 lastMessages 窗口（25 条稀释），否则答对也可能来自窗口记忆而非检索。
