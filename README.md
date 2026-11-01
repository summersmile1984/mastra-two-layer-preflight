# Mastra 两层 Agent：L1 AgentController + L2 ACP Harness（真实，不模拟）

- **L1** = Mastra `AgentController`（`@mastra/core/agent-controller`，DeepSeek `deepseek/deepseek-chat`）。它常驻运行，马上回复用户，工具只负责入队或查询：`dispatch_to_sandbox` / `follow_up_job` / `job_status` / `cancel_job`。
- **L2** = 用户自己安装的 harness 应用，通过 **ACP**（stdio JSON-RPC）调用，使用的是 Mastra 原生的 `@mastra/acp` 中的 `AcpAgent`（`src/l2/acp-worker.ts`）：
  - 每个 job 都会 `new AcpAgent({command,args,cwd,onPermissionRequest})`，然后调用 `agent.connection.promptStream(prompt)`，依次走 initialize → session/new → session/prompt。
  - `session/update` 包括 `tool_call`、`tool_call_update`、`plan`、`agent_thought_chunk`、`agent_message_chunk`，会转成进度事件，经 SSE 以聊天气泡推到页面。
  - 补充要求（follow-up）作为**同一个 ACP session** 的下一轮 `session/prompt` 发送；取消对应 `connection.cancel()`（即 session/cancel）。
  - harness 发来权限请求（permission request）时，回调会选 allow 类选项，并在页面上显示为一行过程。
  - 完成后调用 `session.sendSignal({type:'notification', tagName:'sandbox-result'})` 唤醒 L1，由 L1 用自然语言汇报。
- `cloud` / `local` 只是标签，表示用哪一套 ACP 配置（命令 / cwd），执行一律走 ACP。

## 1. 安装 harness（DeepSeek Harness）
```bash
export PATH=~/.local/node22/bin:$PATH        # Node >= 22.13
npm install -g @deepseek-ai/dsh              # 本机已装：dsh 0.2.1-rc.5
dsh --profile acp --help                     # acp profile 首次使用时自动初始化（~/.dsh/profiles/acp）
```
登录：只要环境里有 `DEEPSEEK_API_KEY`（本项目 `.env` 已有），`dsh --profile acp` 就能直接用，不需要交互登录。也可以运行一次 `dsh web`，在 Web UI 里保存 key。
可选的社区适配器：`dsh plugin --profile acp add @openma/deepseek-harness-acp@latest`，或者独立运行 `npm i -g @openma/deepseek-harness-acp && dsh-acp login`（再设置 `ACP_COMMAND=dsh-acp ACP_ARGS=`）。

## 2. 选择 harness（环境变量）
| 变量 | 默认值 | 说明 |
|---|---|---|
| `ACP_COMMAND` / `ACP_ARGS` / `ACP_CWD` | `dsh` / `--profile acp` / `./workspace-l2/<runtime>` | 通用配置 |
| `ACP_LOCAL_*`、`ACP_CLOUD_*` | 继承上面 | 按路由分别覆盖 |
| `ACP_MODEL` | – | 通过 ACP `session/set_model` 选模型 |
| `ACP_CONCURRENCY` | 2 | 每个 runtime 的并发数 |
| `ACP_DRY_RUN=1` | 关 | **最后手段**：不启动进程，页面上标注 ⚠️DRY-RUN |

换其他 harness，示例如下：
```bash
ACP_COMMAND=npx ACP_ARGS="@agentclientprotocol/claude-agent-acp" npm start   # Claude Code
ACP_COMMAND=npx ACP_ARGS="@zed-industries/codex-acp" npm start               # Codex
ACP_COMMAND=opencode ACP_ARGS="acp" npm start                                 # OpenCode
```

## 3. 运行
```bash
npm start          # http://localhost:4120 （UI + API）
npm run acp:probe  # 单独测 ACP 握手和一次 prompt（不经过 L1）
npm run smoke      # HTTP+SSE 跑一遍：派发、闲聊、补充、查进度、本地任务
```

## 4. 页面
- 只显示 L1（总管）；顶部连接状态点（已连接/重连中）、状态行（后台处理中/正在整理结果）；会话 sid 存 sessionStorage，可 `?sid=` 指定。
- L1 气泡可带截图；`secret_request` 时弹出密码表单（明文只发 `/api/secret`）。
- 架构细节、A2A/ACP、降级、CF 接入见 **ARCHITECTURE.md**；`.env.example` 列出全部变量。

## 目录
`src/server.ts`（HTTP/SSE/A2A callback/HITL）· `src/l1/controller.ts` · `src/l2/a2a-l2.ts`（A2A server + ACP run + AllowlistedPushSender）· `src/l2/acp-worker.ts`（queue 模式 worker）· `src/l2/queue.ts` · `public/index.html` · `scripts/` · `legacy/`


## 运行模式（L1 / L2 拆分）
| 命令 | 说明 |
|---|---|
| `npm start` / `npm run start:all` | 同进程 L1+L2（:4120），一键预演 |
| `npm run start:l2` | 仅 L2：A2A + ACP harness（:4121，`L2_PORT`），`/api/a2a/l2-worker`、`/api/health` |
| `npm run start:l1` | 仅 L1+UI+callback（:4120），`L2_A2A_URL` 默认 `http://127.0.0.1:4121` |

本机跨进程：
```bash
export PATH=~/.local/node22/bin:$PATH && npm ci && cp .env.example .env
L2_PUSH_ALLOWLIST=http://127.0.0.1:4120/api/a2a-callback npm run start:l2 &
L2_A2A_URL=http://127.0.0.1:4121 npm run start:l1
```
- **当前验证路径**：同机两进程（✅，见 RESULTS.md）。
- **CF 目标路径**：L1 → Cloudflare Workers，L2 → 云电脑 + cloudflared tunnel；见 [DEPLOY-CF.md](DEPLOY-CF.md)（目前为最小 Worker 占位 `cf/worker.ts`）。

拆分模式限制：截图收集读 L1 本地 `workspace-l2/`（仅同机有效）；HITL 密码明文留在 L1 内存，不随任务跨进程下发。
