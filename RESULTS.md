# RESULTS：真实 ACP 端到端（2026-11-01，UTC+8）

环境：Node 22.23.3，`@mastra/core 1.78.0`，`@mastra/acp 0.4.4`（依赖 `@agentclientprotocol/sdk ^0.21`），`@deepseek-ai/dsh 0.2.1-rc.5`。L1 用 `deepseek/deepseek-chat`，L2 用 `dsh --profile acp`。

## 握手探测（`npm run acp:probe`）
spawn `dsh --profile acp`，然后依次 initialize → session/new → session/prompt。收到 `agent_thought_chunk`、`usage_update`、`tool_call`（bash `ls`）、`tool_call_update`、`agent_message_chunk`，最终回答“1+1 等于 2 …目录文件数为 0”，耗时 6.3s。

## 冒烟（`npm run smoke`，完整日志见 results-acp.log）
| t | 事件 |
|---|---|
| +0.34s | 用户：帮我统计文件数并写 hello.txt |
| +2.16s | L1 调用 dispatch_to_sandbox(cloud)，+2.21s 启动 `dsh --profile acp` |
| +3.21s | L1 回复“已派发”（不阻塞） |
| +4.71s | 闲聊：L1 照常回复，同时 L2 在执行 tool_call |
| +6.5s | 补充要求：follow_up 送达；+11.67s 作为同一 session 的第 2 轮 prompt 发出，harness 执行 `wc -c hello.txt` |
| +10.7s | 本地任务派发，`workspace-l2/local` 里启动第二个 dsh 进程并发执行 `node -v` |
| +15.4s / +15.9s | 两个 L2 任务都返回 result（`v22.23.3`；hello.txt 18 字节，文件**真实存在于** `workspace-l2/cloud/hello.txt`） |
| +17.7s | sendSignal 唤醒 L1，L1 汇总两条结果 |

## 截图
`screenshots/acp-chat-running.png`、`acp-chat-done-light.png`、`acp-chat-done-dark.png`（headless Chrome 截取的新聊天界面）。旧截图 01–03 是之前的双栏调试界面。

## 已知点
- 补充要求不能插进正在跑的那一轮 prompt，会排到当前这一轮之后，作为同一 session 的下一轮发送。
- permission 默认自动选 allow（dsh 的 acp profile 本次没有发出权限请求）。要改成人工审批，在 `onPermissionRequest` 里接 UI 即可。

## 更新：L2 对用户不可见（2026-11-01 16:00 UTC+8）
- `/api/bots` 只返回 L1（总管 Orchestrator），不再暴露任何 L2/harness 条目。
- `/api/events`：不再转发 L2 队列事件、L1 tool_start、原始错误文本。浏览器只收到 `hello`、`l1`（L1 的自然语言消息）、`status{busy:true}`（L2 结果回到 L1 时出现，仅在 L1 线程上显示“正在输入”）、通用 `error`。
- UI：去掉侧栏“后台任务”、ACP 任务卡和 harness 联系人；名单只有 L1。
- L1 instructions：对用户不提 L2 / harness / ACP / jobId / 沙箱。
- L2 不变：`dsh --profile acp` worker + 队列 + `sendSignal(sandbox-result)` 唤醒 L1，由 L1 汇总。
- 冒烟：`screenshots/l1-only-events.txt` 是原始 SSE（只有 hello/l1/status），`screenshots/l1-only-chat.png` 是真实一次运行的截图。
- 已知点：L1 汇报时偶尔还会自己引用 L2 工作目录路径（模型的措辞选择，不是事件泄漏）；要彻底杜绝，可以在 L1 汇报前对路径做一次后处理。

## A2A 完成通知（2026-11-01 16:08 UTC+8）

**结论：能做到。** L2 做完会通过 A2A push notification 通知 L1，L1 收到后自己回复用户，用户不用追问。有一个限制：Mastra 默认的 push 发送器禁止回调到本机或内网地址，所以同一进程或本机部署时，要换一个只放行指定回调 URL 的 sender。

### 链路
1. 用户发一条消息，L1 调用 `dispatch_to_sandbox`，它向 `POST /api/a2a/l2-worker` 发 A2A v0.3 `message/send`，参数里 `configuration: { blocking: false, pushNotificationConfig: { url: /api/a2a-callback, token } }`。立即返回状态为 `working` 的 Task，L1 回复“我来处理”。
2. A2A 服务端用的是 `@mastra/server@1.78.0` 的 `getAgentExecutionHandler` 加 `InMemoryTaskStore`（真实的 A2A 生命周期），agent card 在 `/api/.well-known/l2-worker/agent-card.json`，声明了 `pushNotifications: true`。
3. L2 是一个 Mastra Agent（`l2-worker`）。它的规划步骤是确定性的脚本模型，只做一件事：调用工具 `run_harness`，由 `@mastra/acp` 拉起 `dsh --profile acp` 干活。活是真的：bash、write、read 都执行了，`workspace-l2/cloud/a2a.txt`（hello a2a）和 `workspace-l2/local/a2a-ui.txt`（notified by A2A，这次 L1 选了 local 路由）都真实写出。
4. Task 变成 `completed` 后，Mastra 的 `saveTaskAndMaybeSendPushNotification` 调用 `pushNotificationSender.sendNotifications`，HTTP POST 任务快照（带 `X-A2A-Notification-Token`）到 `/api/a2a-callback`。
5. callback 校验 token，用 taskId 找到会话，调用 `session.sendSignal(<sandbox-result>)`。L1 被唤醒，生成完成消息，经 SSE 推给用户。

### 证据
- `screenshots/a2a-events.txt`：用户只发了一条消息。16:06:00 L1 回复“我来处理”；16:06:19 push 到达；16:06:21 L1 主动发出“处理好了…”。期间用户没有任何输入。
- `screenshots/a2a-log.json`：完整时间线，依次是 dispatched (working)、harness tool_call ×N、push POST (completed)、callback received、sendSignal、delivered 200。
- `screenshots/a2a-ui-dispatched.png`、`a2a-ui-completed.png`：浏览器里真实跑一次的截图（只显示 L1）。
- `screenshots/a2a-ssrf-probe.txt`（`npx tsx scripts/a2a-ssrf-probe.ts`）：默认 sender 回调 127.0.0.1 或 localhost 时，任务照样 completed，但推送被拒：`Push notification URL must not target local or private IPs: 127.0.0.1`。

### 可以 / 不可以
- ✅ A2A 的 `blocking:false` 加 `pushNotificationConfig` 正好就是“派发后不等，完成时回调”的语义；`completed|failed|canceled|rejected|input-required|auth-required` 都会推送。
- ✅ push 只负责把 webhook 打过来。让 L1 主动说话的是 AgentController 的 `session.sendSignal`，它不需要新的用户消息就能触发一轮回复，实测稳定。
- ❌ 默认的 `DefaultPushNotificationSender` 会拦截 localhost、`*.local`、`*.internal`、不带点的主机名、10/8、127/8、169.254、172.16/12、192.168/16、::1 和 fc/fd 段。连域名解析出来的 IP 也会检查。`allowedHosts` 只能进一步收窄，没法重新放行这些地址。所以同机回调必须换 sender。本实现里的 `AllowlistedPushSender`（`src/l2/a2a-l2.ts`）只 POST 到精确匹配的回调 URL，payload 和 token 头与官方一致。
- ⚠️ Task 和 push 配置都存在内存里，重启后就没了，进行中的任务不会再通知。L2 失败时 Task 状态为 `failed` 也会推送，L1 照常汇报。
- ⚠️ A2A 帮不了“任务运行中途追加要求”：`blocking:false` 加 `working` 状态时再发 message 只会拿回当前 Task。追加要求仍然走旧的队列模式（`L2_MODE=queue`）。

### grokbot-clone 推荐做法
- L2 放到独立服务或远端：用 A2A `message/send(blocking:false)` 加 push webhook（https 公网或内网网关地址，加 token 校验），在 L1 的 webhook 里调用 `session.sendSignal`。L1 侧只需要维护 taskId 到 sessionId 的映射，最好持久化。
- L2 和 L1 在同一进程或同一台机器：A2A push 只是绕了一圈。直接在完成回调里 `sendSignal` 就够了（旧的 queue 模式效果一样）。如果想统一协议，就用自定义的 allowlist sender。
- 不管哪种，真正让 L1 主动开口的都是 `sendSignal`。A2A 负责的是“跨进程把完成事件送回来”。

运行：默认是 A2A 模式；`L2_MODE=queue` 切回旧的进程内队列。服务地址 :4120。

## 做网站 + 截图给前端用户看（2026-11-01 16:37 UTC+8）
- 用户在 :4120 的聊天里发了一条消息，L1 通过 A2A `blocking:false` 派发给 L2，由 `dsh --profile acp` 真实执行：在 `workspace-l2/local/site/` 建 Mastra Café 落地页（index.html + style.css，含营业时间区块和页脚），再用 headless Chrome 截图。
- 交付链路：A2A push 到 `/api/a2a-callback`，`newScreenshots()` 把 L2 工作区新产生的 PNG 拷贝到 `screenshots/site-demo.png`（经 `GET /screenshots/:f` 提供），记到 `pendingImages[session]`，然后 `sendSignal` 唤醒 L1。L1 的下一条 SSE `l1` 消息带上 `images:[url]`，UI 的气泡里显示成 `<img>`。
- 证据：`screenshots/site-events-l1.txt`。用户只发了一条消息，16:31:44 L1 回复“我来处理”，16:37:36 L1 主动发出“网站已就绪 ✅…”，并带 `images:["/screenshots/site-demo.png?..."]`。用户没有追问。
- 坑：cloud profile 的 bash 在 bwrap 沙箱里运行，只有自己的工作区可写，headless Chrome 在里面起不来，端口 8765 在宿主上也被占用了。因此加了宿主侧兜底：L2 建好了站但没有截图时，由服务端用宿主 Chrome 渲染 file://（异步）。这次 L1 选了 local 路由，截图是 harness 自己完成的。
- 是否都是 Mastra：L1 AgentController、A2A server（@mastra/server）、L2 Agent 和 @mastra/acp 都是 Mastra。真正干活的 `dsh` 是 DeepSeek 驱动的外部 ACP agent，Chrome 截图也在 Mastra 之外。

## 生产级完善（2026-11-01 22:50 UTC+8）
改动：
- `src/server.ts` 重写：L1 侧 task registry（`job_status` 只读、不打断 L2）；状态 SSE `status{phase: idle|background|l1-composing}`；callback 用 `timingSafeEqual` 校验 token、校验 payload、幂等去重、未知 task 忽略；截图按任务命名 `screenshots/task-<id8>.png`；`sanitizeUserFacing` 增加任意绝对路径/UUID/`sk-` 密钥/A2A 术语；sessionId 校验；`/api/health`（无密钥）；`/api/demo/push-image` 与 `/api/a2a-log` 改为 **DEV-only**（`DEV_ENDPOINTS=1`）；`PUBLIC_BASE_URL`/`L2_A2A_URL` 支持远端 L2，https 公网自动切官方 `DefaultPushNotificationSender`；A2A 模式下不再启动无用的 queue worker。
- `src/l2/a2a-l2.ts`：harness 命令存在性检查、`ACP_TIMEOUT_MS` 超时（cancel+disconnect）、错误转 `【L2失败】` → callback 识别为 failed 推给 L1；push 发送失败不崩；A2A client 15s 超时。
- `src/l1/controller.ts`：hooks 形式（dispatch/status/requestSecret）；新增 `request_secret` tool（HITL 收密 stub）；A2A 模式下 follow_up 明确返回不支持。
- `public/index.html`：连接状态+自动重连、状态行、密码表单、新 chip。
- 新增 `.env.example`、`ARCHITECTURE.md`；README 更新。

验证（真实 DeepSeek L1 + 真实 dsh L2，A2A 模式）：
- `screenshots/e2e-v2-events.txt`：用户一条消息 → 14:51:05Z(22:51:05 UTC+8) L1“我来处理” → 约 11s 后 L1 **主动**回复“已创建 e2e.txt … 12 字节”；`workspace-l2/local/e2e.txt` 真实存在。期间问“进度”时任务已完成，L1 正确答“没有进行中的任务”。
- 伪造 token 调 callback → 401。
- `screenshots/hitl-secret-events.txt`：L1 调 `request_secret` → UI 收到 `secret_request` → POST `/api/secret`；明文 `hunter2-SECRET` 在 SSE、server.log、data/mastra.db 中出现次数 = 0。

剩余缺口：
- ~~HITL 是 stub~~（第 2 轮已修复，见下）：观察到 AgentController 在 tool 等待期间就让 L1 先回了话（tool 结果晚到），未来换 `suspend()/resumeStream`；`secretRef` 尚未注入 L2 env。
- ~~task registry 在内存~~（第 2 轮已持久化到 data/tasks.json）。
- A2A 模式不支持运行中追加要求（queue 模式支持）。
- 本轮未重拍 UI PNG（旧截图仍有效，UI 新增了连接点/状态行/表单）；CF Tunnel/Secrets 只写文档。


## 第 2 轮：修关键缺口（23:10 UTC+8）

改动文件：
- `src/secrets.ts`（新）：内存 vault（TTL 10 分钟）→ `secret:xxxxxxxx` 句柄；`bindTaskSecrets` 一次性绑定到某个 task；`redactKnownSecrets` 对所有出站文本打码。
- `src/task-store.ts`（新）：`data/tasks.json` 原子写；working 超过 6h 标 `lost`，终态超过 24h 删除；push token 持久化在 `data/push-token`（0600）。
- `src/l1/controller.ts`：`request_secret` 改成原生 `suspend()`，resume 后只拿到 `secretRef`。
- `src/server.ts`：SSE `tool_suspended`→`secret_request`；`POST /api/secret` → `respondToToolSuspension`；callback 支持重启后重建 session，并做幂等处理。
- `src/l2/a2a-l2.ts`：secret 以 `L2_SECRET_n` env 注入 AcpAgent，同时写一次性 0600 文件 `.l2secret/<binding>/`（dsh 的 bash tool 会清洗 env），结束后删除目录并给输出打码；超时/失败返回 `【L2失败】`。
- `public/index.html`：连接点（带重连）、状态行、密码表单。

证据（真 DeepSeek L1 + 真 dsh L2）：
- HITL：`screenshots/hitl-before-submit.txt`：提交前 SSE 只有 `secret_request`，没有 L1 文本。`hitl-suspend-events.txt`：提交后 L1 才回复，L2 写出 pwlen.txt=14，L1 收到 push 后主动回复。明文在 SSE/server.log/data/* 中出现 0 次，`.l2secret` 已清理。
- 运行中问进度：`progress-midrun-events.txt`：L1 回答“还在跑”，L2 没被打断，完成后 L1 主动汇报。
- 重启后回调：`persist-restart-events.txt`：重启后 push 照样唤醒 L1，重复 push 被忽略。
- UI：`screenshots/ui-v3-connected.png`（连接点+状态）、`ui-v3-secret-form.png`（密码表单）。`chrome --screenshot` 会因为 SSE 一直不关而挂住，改用 CDP `Page.captureScreenshot`（脚本思路：新开 tab，等几秒再截）。

剩余缺口：
- 进程内 L2 用的是 A2A `InMemoryTaskStore`，重启会杀掉还在跑的 L2；持久化只对远程/独立 L2 有效。
- task 运行中不支持 A2A follow-up（只能等完成后再派新任务）。
- secret vault 在内存（重启后句柄失效，用户需重新输入）；生产应换 KV/Secrets Store。
- CF Tunnel/Secrets 只有文档。

## 跨进程验证（2026-11-02 01:02 UTC+8）：L2 独立进程 :4121 ↔ L1 :4120
- `L2_PUSH_ALLOWLIST=http://127.0.0.1:4120/api/a2a-callback npm run start:l2`；`L2_A2A_URL=http://127.0.0.1:4121 npm run start:l1`
- L1 `/api/health` → `split:true`；L2 `/api/health` → `role:l2, harness cloud/local:true`
- 任务「创建 hello.txt 写入 split-ok」：L1 A2A `message/send(blocking:false)` → L2 dsh harness (write/read) → L2 push POST → L1 callback 200 → `session.sendSignal` → L1 **主动** SSE 回复「处理好了…内容 split-ok」，用户无追问。约 50 s。
- 日志：`docs/split-process-events.txt`
