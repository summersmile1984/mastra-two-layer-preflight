---
feature: model-gateway-config
status: in-progress
updated: 2026-11-05
source: recall-model
---

# 模型可配置：gateway → 模型 → effort（与 Mastra 对齐）

## Report

## [S1] Problem

模型仍是写死的 `deepseek/deepseek-chat`（Agent 与 OM 各一处）。用户要求「不许写死」的另一半：**使用的模型可配置**，且配置形态是「先选 gateway，再选模型，再选 effort」，**与 Mastra 的模型体系对齐**。同时 Workers AI 已在付费套餐内（含 DeepSeek V4 / Llama 等 28 个托管模型），切模型的成本面已具备。

## [S2] Design（对齐 Mastra 官方形态，见调研）

- **模型串 = gateway/provider 前缀 + 模型 id**：Mastra 的 `ModelRouterModelId` 路由（`cloudflare-workers-ai/@cf/meta/llama-3.2-3b-instruct`、`deepseek/deepseek-chat`、`mastra/...` 网关前缀），provider 鉴权走 `provider-registry.json` 的 `apiKeyEnvVar`（workers-ai 需 `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` 环境变量）。
- **effort = `modelSettings.reasoning`**：`'provider-default'|'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'`（LanguageModelV4 模型生效，其余为 no-op）。`AgentConfig.model` 与 `modelSettings` 均为官方 `DynamicArgument`（每轮可异步求值）——**effort/模型都即改即生效**。
- **OM 同源**：`observationalMemory.model` = 同一模型串；`observation/reflection.modelSettings.reasoning` = 同一 effort（经 threadConfig 补丁，引擎初始化语义，同 prompt-config）。

### S2.1 配置面（persona_config 增列，种子=现状零回归）

`model_gateway`（种子 `deepseek`）、`model_name`（`deepseek-chat`）、`model_effort`（`provider-default`）。装配：`modelId = ${model_gateway}/${model_name}`。字段上限：gateway 100、name 200、effort 20。

### S2.2 模型目录接口（零写死的级联数据源）

`GET /settings/models`（登录可读）→ 从已安装 `@mastra/core/dist/provider-registry.json` 运行时读出：`[{ gateway, name, models: string[] }]`（默认给 deepseek / cloudflare-workers-ai / mastra 三家；后续加网关只加注册表）+ `effortLevels` 枚举。SPA 面板据此渲染「gateway → 模型 → effort」三级级联。

### S2.3 SPA 设置面板

「模型设置」分组：gateway 下拉 → model 下拉（随 gateway 过滤）→ effort 下拉；保存走 `PUT /settings/persona`。

## [S3] Out of Scope

- 自定义网关（`mastra.addGateway`）接入；按 token 量自动分档（`ModelByInputTokens`）；嵌入模型更换（bge-m3 不动）；用量/费用面板。

## Tasks

- [ ] T1: persona_config 三字段 + 装配（Agent.model/modelSettings 均 DynamicArgument 函数，OM 同源） — acceptance: 种子下行为零回归；PUT 换模型后下一轮对话即走新模型（covers: S2.1）
- [ ] T2: GET /settings/models 目录接口（provider-registry 运行时读取） — acceptance: 返回三家网关的模型清单 + effort 枚举，无硬编码列表（covers: S2.2）
- [ ] T3: SPA 三级级联 — acceptance: 选 cloudflare-workers-ai → 模型列表过滤为 @cf/*；保存后 GET 反映（covers: S2.3, depends: T2）
- [ ] T4: 生产验证与定稿 — acceptance: 切到 Workers AI（如 @cf/deepseek-ai/deepseek-v4-flash-0731 + effort=high）对话正常、切回 deepseek 正常；E2E 证据入 Report（covers: 全部, depends: T1–T3）

## Journey log
