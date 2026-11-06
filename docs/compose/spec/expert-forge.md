---
feature: expert-forge
status: delivered
updated: 2026-11-06
source: expert-forge
---

# L2 专家 JIT 运行时 + 专家工坊（定义即数据）

## Report

**What was built** — 专家定义即数据 + JIT 初始化的产品闭环：`agent_defs` 扩 `skills_json`；`l2_tasks.def_json` 派发全量定义快照（含 tools/mcp/skill/memory，secretRef 不含明文），`/l2-claim` 返回 `def`；L2 `buildL2Agent` JIT 装配（tools 注册表+web_fetch 安全抓取、skills_json→createSkill、memory_json→Memory、mcp_json→MCPClient 每任务独立、按 def.id+updated_at 缓存）；专家工坊对话式创建（`draft_expert` 零副作用草案 → 主人确认 → `save_expert` 落库，validateExpertDef 硬校验），builder prompt/tool 描述全在 persona_config（零写死）。HITL 硬闸：permissions（deny 拒/allow 放/默认 ask）+ 最近一条用户消息必须含确认词才可保存。

**Verification** — `npm run cf:build` PASS。生产真 E2E `/tmp/forge-e2e.mjs`（真 D1/DeepSeek/L2）**13/13 PASS**：对话建「报销管家」→草案→确认→落库（tools_json=["web_fetch"]、skills_json 含票据技能）→ dispatch → L2 JIT 构建执行 → **web_fetch 真抓取 example.com（HTTP 200，结果含 Example Domain）** → def_json 快照含工具 → 清理还原。HITL 负向探针 PASS：无确认词不落库、「确认保存」后落库。SSRF 防护走真实 URL 入口 7/7 PASS（含 `::ffff:7f00:1` 十六进制 mapped、`2130706433` 十进制 IP）。独立评审 3 MAJOR + 复审 1 残留（SSRF mapped 绕过）全部修复并终审 PASS。

## [S1] Problem

用户定调（产品铁律）：**专家不是代码，是数据**——数据库里存专家的提示词 / tools / mcp / skill / memory 配置，任务到达时按专家名（或 id）**JIT 构建 Mastra Agent 实例**执行。现状 gap：T28 只消费 instructions/model（tools_json/mcp_json/memory_json「先存不接」，无 skills 字段）；创建专家要写 SQL/调 API，没有对话入口。另需自研「agent builder」：参照 `@mastra/agent-builder` 源码方法论（理解→规划→生成→校验、attemptCompletion、validate 循环、planningAndApproval），**clean-room 实现**——产物是 `agent_defs` 数据行而非 Mastra 项目代码；不依赖该包（生产需 Enterprise 许可）。

## [S2] Design

### S2.1 专家即数据 + JIT 工厂（核心契约）

- `agent_defs` 行 = 专家全部定义：`name/description/instructions/model/tools_json/mcp_json/memory_json` + 新列 **`skills_json`**。
- **JIT 工厂** `buildL2Agent(def)`（现 `src/l2/expert-agent.ts` 升级，名对齐 AGENTS.md）按 def 现场装配 Mastra Agent：
  - `instructions` / `model`：现状不变（model 空则 `L2_EXPERT_MODEL`/默认）。
  - `tools_json` → `tools`：**本地工具注册表**（`src/l2/tools-registry.ts`）按 id 解析实现，配置可带 options。首期内置 `web_fetch` 一个（HTTP(S) 抓取，走 withProxy，禁内网 IP、15s 超时、大小上限）——机制是重点，工具可增。
  - `mcp_json` → `MCPClient`（新依赖 `@mastra/mcp`）：`{servers:{name:{url|command,args?,env?,requireToolApproval?}}}` → `listToolsets()`（每任务独立 client，用完 disconnect）。`env` 值首期仅字面值；`secret:<vault_id>` 引用递延（S3）——vault 现无明文读取管道，半通不如不通。
  - `skills_json` → `[{name, description, instructions}]` → `createSkill()`（`@mastra/core/skills`）内联技能，按需加载。
  - `memory_json` → `Memory` options：`{lastMessages, workingMemory:{template}, semanticRecall?, observationalMemory?}`（观测记忆已知约束照旧：threadId 必填、关库前 `memory.settled()`）。
- **实例缓存**：`Map<def_id, {updated_at, agent}>`，def 变更即失效；同实例多次 `generate`（Mastra Agent 每调用无共享可变态）安全。
- **claim 契约扩展**：`l2_tasks` 加 **`def_json`**（派发时对 agent_defs 行全量快照；含 secretRef 不含明文）；`/l2-claim` kind=expert 时返回 `def`。L2 用 def 做 JIT；旧 `instructions` 列保留作兜底兼容。快照语义与 l2-experts S2.3 一致，从「指令快照」扩为「定义快照」。

### S2.2 专家工坊（对话式创建/修改，HITL）

- L1 新工具（描述入 `persona_config.tool_forge`，延续零写死）：
  - **`draft_expert`**：`{需求, 基于?已有专家名|模板名}` → 工坊生成（独立 builder Agent，structured output 出 `AgentDefDraft` zod）→ 返回**人话摘要 + 完整定义 JSON**，不落库。方法论提示词（理解需求→规划职责→生成定义→自检）入配置（builder prompt 是 persona_config 新字段）。
  - **`save_expert`**：`{draft（完整定义 JSON）}` → `validateExpertDef` → 写 `agent_defs`（同 id 已存在 = 更新覆盖，需 draft 里显式 `overwrite:true`；否则自动改名后缀）→ 「专家已就位，可以派活了」。
  - `list_experts` 已有。修改场景 = `draft_expert{基于:某专家, 需求:改…}` → 生成新草案 → save 覆盖。
- **HITL 审批**（硬闸，非仅提示词）：`save_expert` 先查 `user_permission_rules`（deny 直拒 / allow 放行 / 默认 ask）；ask 档要求**最近一条用户消息含确认词**（确认/同意/就这样/可以了/approved）才落库，fail-closed。草案阶段零副作用。这是 AGENTS.md 安全债 #1 的第一处硬落地（弹窗式审批路由仍递延）。
- **validateExpertDef**（落库前硬校验）：必填 name/instructions；字段上限沿用 l2-experts S2.2（name 100 / description 500 / instructions 4000 / model 100）；skills/tools 引用结构合法；mcp_json 仅允许 url/command 字段（不含任意代码）。

### S2.3 模板与生成质量

- 内置模板：`researcher` / `coder`（现种子文案派生）+ `blank`。`draft_expert` 可「基于模板」；模板同时作为 builder Agent 的 few-shot 示例（配置化，不写死在代码）。
- builder Agent 的 structured output schema 即 `AgentDefDraft`（name/description/instructions/model/tools_json/mcp_json/skills_json/memory_json + rationale 摘要），保证产物永远是合法数据行。

### S2.4 安全边界

- secret 引用（`secret:<vault_id>`）解析只发生在 L2 构建子进程/MCP client env 时；claim 快照、日志、模型上下文只见句柄。
- `web_fetch`：仅 http(s)、解析后禁私网/环回 IP、超时与体积上限。
- `save_expert` 是唯一写入口且须 confirm；draft 阶段零副作用。

## [S3] Out of Scope

- 工具**代码**生成 / 任何磁盘落盘（工坊产物 = 数据行，明确不做）
- `secret:<vault_id>` 引用 → L2 子进程 env 的解析管道（vault 尚无明文读取路径，随 HITL/vault 加固片落地；本片遇 `secret:` 前缀直接报错提示）
- MCP 连接管理面板 / OAuth 授权流（首期 mcp_json 手写或工坊生成 url 级配置）
- SPA 专家工坊面板（递延）；@mention 房间路由（非目标）
- ACP/CUA 变专家 tools、cloud 执行位实测（P4 递延）
- 依赖 `@mastra/agent-builder` 包（EE 许可，只学方法论）

## Tasks

- [x] T1: `l2_tasks.def_json` + 派发全量快照 + `/l2-claim` 返回 `def` — acceptance: claim kind=expert 带完整 def（含 skills/mcp/memory 字段）(covers: S2.1)
- [x] T2: JIT 工厂升级（tools 注册表+web_fetch、skills_json→createSkill、memory_json→Memory、mcp_json→MCPClient、实例缓存） — acceptance: 用带工具/技能/记忆配置的 def 真构建并执行成功 (covers: S2.1)
- [x] T3: 工坊 draft_expert/save_expert + validateExpertDef + builder prompt 配置 + HITL 护栏 — acceptance: 对话「建一个报销管家」→草案→确认→落库→list 可见 (covers: S2.2, S2.3)
- [x] T4: 真实端到端 — acceptance: 工坊创建专家→dispatch→L2 JIT 构建执行，证据含工具/技能/MCP 至少一项真实生效（如 web_fetch 被调用）；证据入 Report (covers: S2.4, depends: T1–T3)

## Journey log

- **createSkill 名字面约束**：Mastra 技能名只允许 `[a-z0-9-]`，中文名直接抛错——构建时 slug 化（原名进 description）+ builder 提示词规范命名，两头兜住。**localStore 必须同步返回**：异步 Promise 塞进 `Memory({storage})` 会在 `getStore` 处炸（老代码有 await，重写时丢过一次）。
- **SSRF 校验必须走真实 URL 入口测**：WHATWG `new URL()` 把 `::ffff:127.0.0.1` 规范化成 `::ffff:7f00:1`（十六进制段）、把十进制 IP `2130706433` 规范化成点分四段——手写正则防不住规范化后的形态。正确原语是 `net.BlockList.check(ip,'ipv6')`（内建 IPv4-mapped 识别）+ 未识别 IP fail-closed；测试矩阵若只打裸判定函数会全绿却仍可绕过。
- **HITL 硬闸可行形态**（弹窗审批路由递延期间）：permissions 数据面（deny/allow/ask）+ 「最近一条用户消息含确认词」fail-closed 检查——模型无法伪造用户消息，可拦住「出完草案就顺手保存」。
