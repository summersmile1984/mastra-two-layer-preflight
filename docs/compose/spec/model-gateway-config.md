---
feature: model-gateway-config
status: delivered
updated: 2026-11-05
source: recall-model
---

# 模型可配置：gateway → 模型 → effort（与 Mastra 对齐）

## Report

**What was built** — 模型全面配置化（gateway → 模型 → effort），与 Mastra 模型体系对齐：①`persona_config` 增 `model_gateway`/`model_name`/`model_effort`（种子 deepseek/deepseek-chat/provider-default，零回归）；②`Agent.model` 与 `modelSettings` 均为官方 `DynamicArgument` 函数（每轮求值=即改即生效），OM 的 model/modelSettings 经 threadConfig 补丁同源（引擎初始化语义）；③`GET /settings/models` 目录接口：deepseek/cloudflare-workers-ai 两家从已装 `provider-registry.json` 读（含 28 个 @cf 模型），**mastra 网关运行时 `MastraGateway.fetchProviders()`**（无 key 降级空列表——评审 CRITICAL 修复：mastra 不在 registry，是运行时网关）；④SPA「模型设置」三级级联；⑤env：`CLOUDFLARE_ACCOUNT_ID` var + `CLOUDFLARE_API_KEY` secret（workers-ai provider 鉴权，DEPLOY-CF.md 已记 runbook）。

**Verification** — 生产实测：目录 `deepseek(4) | cloudflare-workers-ai(28) | mastra(0)` 三家齐（T2）；默认 deepseek 对话零回归；PUT 切 `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731` + `effort=high` → 真实对话正常（Workers AI 上的 DeepSeek V4 托管模型）；切回 deepseek 正常；persona 回归 10/10；SPA 构建 PASS + 面板截图（三级下拉：deepseek/deepseek-chat/provider-default）。

## [S1] Problem

模型仍是写死的 `deepseek/deepseek-chat`（Agent 与 OM 各一处）。用户要求「不许写死」的另一半：**使用的模型可配置**，且配置形态是「先选 gateway，再选模型，再选 effort」，**与 Mastra 的模型体系对齐**。同时 Workers AI 已在付费套餐内（含 DeepSeek V4 / Llama 等 28 个托管模型），切模型的成本面已具备。

## [S2] Design（对齐 Mastra 官方形态，见调研）

- **模型串 = gateway/provider 前缀 + 模型 id**：Mastra 的 `ModelRouterModelId` 路由（`cloudflare-workers-ai/@cf/meta/llama-3.2-3b-instruct`、`deepseek/deepseek-chat`、`mastra/...` 网关前缀），provider 鉴权走 `provider-registry.json` 的 `apiKeyEnvVar`（workers-ai 需 `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` 环境变量）。
- **effort = `modelSettings.reasoning`**：`'provider-default'|'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'`（LanguageModelV4 模型生效，其余为 no-op）。`AgentConfig.model` 与 `modelSettings` 均为官方 `DynamicArgument`（每轮可异步求值）——**effort/模型都即改即生效**。
- **OM 同源**：`observationalMemory.model` = 同一模型串；`observation/reflection.modelSettings.reasoning` = 同一 effort（经 threadConfig 补丁，引擎初始化语义，同 prompt-config）。

### S2.1 配置面（persona_config 增列，种子=现状零回归）

`model_gateway`（种子 `deepseek`）、`model_name`（`deepseek-chat`）、`model_effort`（`provider-default`）。装配：`modelId = ${model_gateway}/${model_name}`。字段上限：gateway 100、name 200、effort 20。

### S2.2 模型目录接口（零写死的级联数据源）

`GET /settings/models`（登录可读）→ deepseek / cloudflare-workers-ai 从已装 `@mastra/core/dist/provider-registry.json` 读（经 `@mastra/core/llm` 或相对路径内联）；**mastra 网关不在 registry**——经 `MastraGateway.fetchProviders()` 运行时取（无 key 降级空列表，面板保留自由值）；+ `effortLevels` 枚举。SPA 面板据此渲染「gateway → 模型 → effort」三级级联。

### S2.3 SPA 设置面板

「模型设置」分组：gateway 下拉 → model 下拉（随 gateway 过滤）→ effort 下拉；保存走 `PUT /settings/persona`。

## [S3] Out of Scope

- 自定义网关（`mastra.addGateway`）接入；按 token 量自动分档（`ModelByInputTokens`）；嵌入模型更换（bge-m3 不动）；用量/费用面板。

## Tasks

- [x] T1: persona_config 三字段 + 装配（Agent.model/modelSettings 均 DynamicArgument 函数，OM 同源） — acceptance: 种子下行为零回归；PUT 换模型后下一轮对话即走新模型（covers: S2.1）
- [x] T2: GET /settings/models 目录接口 — acceptance: 返回三家网关（registry 两家 + mastra 运行时 fetchProviders）模型清单 + effort 枚举，无硬编码模型列表（covers: S2.2）
- [x] T3: SPA 三级级联 — acceptance: 选 cloudflare-workers-ai → 模型列表过滤为 @cf/*；保存后 GET 反映（covers: S2.3, depends: T2）
- [x] T4: 生产验证与定稿 — acceptance: 切到 Workers AI（如 @cf/deepseek-ai/deepseek-v4-flash-0731 + effort=high）对话正常、切回 deepseek 正常；E2E 证据入 Report（covers: 全部, depends: T1–T3）

## Journey log

- `mastra` 网关**不在** `provider-registry.json`（它是运行时 `MastraGateway`（id=mastra，`fetchProviders()`）——评审揪出「三家网关」承诺落空的 CRITICAL；修法：registry 取两家 + MastraGateway 运行时取第三家（无 key 降级空列表）。
- MastraGateway 的正确导入是 `@mastra/core/llm`（package exports 放行）；`dist/llm/model/gateways/` 目录只有 .d.ts（实现在打包 chunk 里），相对路径导入会解析失败。
- `model`/`modelSettings` 都是官方 `DynamicArgument`（`{requestContext, mastra} => T | Promise<T>`）——模型与 effort 都能每轮热生效，与 instructions 同机制。
- 评审 minors 已顺手修：OM 构造字面量改 `SEED_MODEL_ID`（消除漂移）、syncEngineCopy 参数类型补模型字段、DEPLOY-CF.md 补 `wrangler secret put CLOUDFLARE_API_KEY` runbook。
