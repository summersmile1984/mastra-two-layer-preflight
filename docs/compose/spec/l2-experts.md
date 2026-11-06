---
feature: l2-experts
status: delivered
updated: 2026-11-06
source: l2-experts
---

# L2 专家体系：agent_defs + dispatch_to_expert（执行位 = 用户电脑/云电脑）

## Report

**What was built** — L2 专家核心闭环：D1 `agent_defs` 专家目录（出厂种子 researcher/coder，owner 范围 CRUD：读/改 = 本人+system 种子，删 = 仅本人，种子可改不可删，重复 id→400）；`dispatch_to_expert`/`list_experts` 秘书工具（描述与基座护栏出自 persona_config，零写死）；`l2_tasks` 专家管道（kind/expert_id/instructions 快照，`/l2-claim` 契约带 expertId/instructions/resourceId/model，sandbox 任务向后兼容）；L2 执行位 `runExpertAgent`（Mastra Agent + LibSQL 本地记忆，thread id = L1 threadId，双房间不串线）；l2-pull-worker 与 l2-desktop 双端接通（ACP 兜底保留且带专家指令）。

**Verification** — `npm run cf:build` PASS（mastra bundle + worker-entry）；生产真 E2E `/tmp/l2exp-e2e.mjs`（真 D1/DeepSeek/L2 pull worker）**19/19 PASS**：agent_defs 种子+CRUD+dup-id 400+种子不可删 404、对话派发 ack、L2 领取 `kind=expert expert=researcher`、暗号 ZHOU7（经 PUT agent_defs.instructions 注入）出现在 L2 原始结果（指令快照链路实证）、`mastra_threads/mastra_resources` 含房间 A thread id、A 记「天舟」+同线程回忆「天舟」、B 房间不串线「不知道」、双 L2 线程并存、种子指令还原。独立评审（1 CRITICAL + 3 MAJOR）修复后聚焦复审 PASS、无新增 critical。隔离复现 `/tmp/l2mem-repro.mts` PASS（同线程回忆）。

## [S1] Problem

两层架构铁律（用户重申，已入项目记忆）：**只有一个主 agent（L1 常驻云端），其它都是 L2 worker agent，跑在用户登录了账号的电脑/云电脑上**。现状 L1 只会派「沙箱任务」（dispatch_to_sandbox），专家能力缺失；远端 v0.2.x 的 researcher/coder 多 agent 是**房间里挂多 bot** 的形态（AGENTS.md 非目标），但其 `agent_defs` 定义与 `l2_expert_id` 管道正是 L2 专家的正确零件——按整合规则（S2.0：本地基底、冲突本地优先）重解释为 L2 专家体系。

## [S2] Design

### S2.1 产品模型（口径护栏）

- L1 = 秘书（orchestrator），唯一主 agent，统管对话/派发/汇报。
- L2 = 专家（researcher/coder/自定义）+ 沙箱（ACP/CUA），执行位 = **用户 PC（默认，经 l2-claim 拉取）或云电脑（可插拔）**。**L2 专家本身也是 Mastra Agent**（prompt 驱动：agent_defs 的 instructions/model + 本地记忆），不是裸 LLM 调用——对齐 AGENTS.md 的 buildL2Agent 方向。
- **thread 对齐**：任务携带 L1 的 threadId（房间/主题）；L2 的 Mastra Agent 以**同一 threadId** 建自己的本地记忆线程——多线程（多房间/主题）一一对应，L2 侧按线程保持连续性；L1 仍是权威记忆（结果回流进 L1 线程）。
- 不做：房间内多 bot、@mention 路由、room_agents、bot 间对话（远端件冲突项，本地优先）。

### S2.2 agent_defs 专家目录（移植远端 schema）

- 表 `agent_defs`（0007_experts.sql）：id, owner_user_id, name, description, instructions, model, tools_json, mcp_json, memory_json, created_at, updated_at + owner 索引。出厂种子两位：researcher（调研专家）、coder（工程师）（instructions 取远端 EXPERT_CATALOG 文案，去掉 [agent:] 相关语）。
- 路由（本地风格）：`GET /agent-defs`（登录可读，owner 范围）、`POST /agent-defs`、`PUT/DELETE /agent-defs/:id`。字段上限 name 100 / description 500 / instructions 4000。
- owner 范围规则（评审 CRITICAL 修复，定稿）：读/改 = `owner_user_id ∈ {本人, 'system'}`；删 = 仅本人（出厂种子共享可改不可删）；重复 id → 400。L1 工具层（list_experts/resolveExpert）保持全目录视角（单主人产品）。

### S2.3 l2_tasks 专家管道（移植远端 0004 思路）

- `l2_tasks` 加 `expert_id TEXT` + `instructions TEXT`（派发时从 agent_defs 快照，L2 离线也能执行）+ `kind TEXT DEFAULT 'sandbox'`；索引 (expert_id, state)。
- `/l2-claim` 响应扩为 `{taskId, prompt, runtime, threadId, kind, expertId, instructions, resourceId, model}`（model 为 claim 时从 agent_defs 查的即时值，未配置为 null）——`resolveKind` 已支持 expert（apps/l2-desktop/src/dispatch.ts）；`runExpert` **升级为 Mastra Agent 执行**（S2.5）。
- 交互管道不变：A2A Task 形状报文 + HTTP（/l2-claim 轮询上行领、/a2a-callback hook 下行交），全链路异步。
- 汇报闭环复用：/a2a-callback → finalize → compose 落房 + RoomDO 通知。

### S2.4 秘书工具

- `dispatch_to_expert`：{expert（名或 id）, task, runtime?} → 查 agent_defs → 入队 l2_tasks(kind='expert') →「我来处理」。描述走 persona_config（延续零写死）。
- `list_experts`：列目录（name/description）。
- 护栏并入基座提示词种子：专家任务一律经 dispatch_to_expert 派 L2，不在 L1 里直接扮演专家。

### S2.5 L2 专家 = Mastra Agent（thread 对齐的本地记忆）

- `apps/l2-desktop/src/expert/runner.ts` 升级：`runExpert` 用 Mastra `Agent`（instructions=专家指令快照、model=agent_defs.model 或默认）+ `Memory`（**LibSQLStore 本地文件**，`memory: { thread: <task.threadId>, resource: <task.resourceId> }`）——同一房间/主题的任务在 L2 侧共享一条记忆线程，不同房间互不串。
- `buildL2Agent(def, task)` 小工厂（对齐 AGENTS.md 命名）：由 agent_defs + 任务上下文构造；后续可挂 tools_json。
- 产物经现有 compose 管道回流 L1 线程记忆（L1 权威）。

### S2.6 验收方式（真实执行，无 mock）

本机即「用户登录了账号的电脑」：起真实 L2（`src/l2-pull-worker.ts` 或 l2-desktop claim），`DEEPSEEK_API_KEY` 驱动 Mastra Agent 专家真执行。E2E：对话派发「让调研专家总结 X」→ L2 领取 → 专家（Mastra Agent，thread=该房间）真跑 → 汇报落房；**双房间派发验证 thread 对齐**（两房间各自成线，记忆不串）；agent_defs CRUD；claim 响应含 expert 字段。

## [S3] Out of Scope

- Agent Builder UI / 专家市场；@mention 与 room_agents（非目标）；云电脑执行位实测（接口留 runtime 参数，落地另片）；L2 与 L1 的记忆同步/合并（L2 本地记忆先行，回流经 compose）；tools_json/mcp_json 消费（先存不接）。

## Tasks

- [x] T1: agent_defs 表 + 种子 + CRUD 路由 — acceptance: GET 返回 researcher/coder；POST/PUT/DELETE 生效（covers: S2.2）
- [x] T2: l2_tasks 扩展（kind/expert_id/instructions）+ /l2-claim 响应 — acceptance: claim 返回 expert 字段（covers: S2.3）
- [x] T3: dispatch_to_expert / list_experts 工具 + 基座护栏 — acceptance: 对话「让调研专家…」入队 kind=expert（covers: S2.4）
- [x] T4: runExpert 升级为 Mastra Agent（buildL2Agent + 本地 LibSQL Memory，thread 对齐） — acceptance: 专家以 Mastra Agent 执行且 L2 本地记忆线程 id = L1 threadId（covers: S2.5, depends: T2）
- [x] T5: 真实 L2 端到端 — acceptance: 本机 L2 领取并真执行，汇报落房；双房间任务记忆不串线；证据入 Report（covers: S2.6, depends: T1–T4）

## Journey log

- E2E 进程陷阱：`spawn('npx', ['tsx', …])` 后 SIGTERM 杀不掉 tsx 子进程，孤儿 L2 会抢 claim 污染验证——验证脚本必须 `detached:true` + 杀进程组（或先 `pkill -f l2-pull-worker`）。同理，断言 L2 记忆别猜表名：LibSQLStore 是 `mastra_threads`/`mastra_resources` 前缀；`/l2-results` 有「reply 落库前 60s 退化回原始 result」的竞态，证据断言以 D1 原始行为准。
