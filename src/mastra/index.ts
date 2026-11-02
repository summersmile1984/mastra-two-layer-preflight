/**
 * L1 on Cloudflare Workers：官方 CloudflareDeployer + D1。
 * 仅用于 `mastra build`；本地 Node 版仍走 src/server.ts（AgentController + sendSignal）。
 *
 * P3（主路径 = L2 出站 PULL；本机出口劫持 argotunnel DNS，cloudflared 不可用）：
 *   dispatch_to_sandbox 本地生成 task_id（t-<uuid>），D1 l2_tasks 写入 state=queued + prompt，立即 ok:true
 *     （只需 PUSH_TOKEN + thread；不要求 L2_A2A_URL 可达）
 *   本机 L2（src/l2-pull-worker.ts）轮询 POST /l2-claim（Bearer/X-A2A-Notification-Token = PUSH_TOKEN）
 *     → 原子 queued→working，返回 {taskId,prompt,runtime,threadId}（无任务 {task:null}）
 *     → runAcpPrompt（dsh --profile acp）→ POST /a2a-callback（A2A Task 形状）→ 下面原有 compose + /l2-results 不变
 *   若配置了 L2_A2A_URL：额外 best-effort A2A push（成功则改用 L2 的 task id；失败仅记日志，留给 pull）
 *
 * P2（Worker 侧派发 + 回调，现为可选 push 路径）：
 *   orchestrator 工具 dispatch_to_sandbox → HTTP POST ${L2_A2A_URL}/api/a2a/l2-worker
 *     A2A message/send { configuration:{ blocking:false, pushNotificationConfig:{ url: <L1>/a2a-callback, token: PUSH_TOKEN } } }
 *   → D1 表 l2_tasks 登记 taskId → thread/resource（不用 in-memory Map：Worker isolate 随时被回收/多实例）
 *   → L2（本机 src/l2-server.ts，Mastra Agent + @mastra/acp → dsh --profile acp）完成后 push
 *   → POST /a2a-callback（注意：registerApiRoute 自定义路由**不带 /api 前缀**，与 /health-l1 一致）
 *     校验 X-A2A-Notification-Token（timing-safe）→ D1 写 result
 *     → ctx.waitUntil(orchestrator.generate(<sandbox-result>…, memory=同 thread)) 生成对用户的汇报，写入 D1.reply 并进 thread 记忆
 *   → 前端轮询 GET /l2-results?thread=sid 拿到 reply 后作为 L1 消息显示。
 * 为什么不是 sendSignal：Workers 上没有常驻 AgentController session；用 waitUntil + generate（单次请求内完成，
 * 受 Worker CPU/墙钟限制，DeepSeek 一次调用通常 <30s）+ D1 落盘，是 Workers 上能稳定跑的方案。
 * 即使 generate 失败，原始 result 仍在 D1，前端会退化显示原始结果。
 */
import { env, waitUntil } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { registerApiRoute } from '@mastra/core/server';
import { CloudflareDeployer } from '@mastra/deployer-cloudflare';
import { D1Store } from '@mastra/cloudflare-d1';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import { pollL2Task } from '../l1/poll-l2';
import { appMiddleware } from '../l1/app-routes';

const E = env as any;
const L2_AGENT_ID = 'l2-worker';
const DEFAULT_PUBLIC = 'https://mastra-l1.summersmile1984.workers.dev';
const publicBase = () => String(E.L1_PUBLIC_URL || DEFAULT_PUBLIC).replace(/\/$/, '');
const callbackUrl = () => `${publicBase()}/a2a-callback`;
const normL2 = (u: string) => { u = u.replace(/\/$/, ''); return /\/api\/a2a\//.test(u) ? u : `${u}/api/a2a/${L2_AGENT_ID}`; };

// ---------- D1 任务登记 ----------
let schemaReady: Promise<unknown> | null = null;
function db() {
  const d = E.DB;
  schemaReady ??= d.prepare(`CREATE TABLE IF NOT EXISTS l2_tasks (
    task_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, resource_id TEXT, runtime TEXT, state TEXT NOT NULL,
    result TEXT, reply TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)`).run()
    .then(() => d.prepare('CREATE INDEX IF NOT EXISTS l2_tasks_thread ON l2_tasks(thread_id, updated_at)').run())
    .then(() => d.prepare('ALTER TABLE l2_tasks ADD COLUMN prompt TEXT').run().catch(() => null))
    .then(() => d.prepare('CREATE INDEX IF NOT EXISTS l2_tasks_state ON l2_tasks(state, created_at)').run());
  return { d, ready: schemaReady };
}

const INSTRUCTIONS = `你是总管（orchestrator），必须立即回复用户，绝不等待长任务。
慢任务（用户说“帮我…/跑…/分析…/测试…/生成…/构建…/部署…”，需要读写文件、跑命令、做网页、截图等）一律调用 dispatch_to_sandbox 派发，然后立刻用一句话告诉用户“我来处理，好了告诉你”，可以继续聊别的。
对用户不可见的内部细节：绝不提 L2、harness、ACP、沙箱、运行时、任务 id、内部路径、A2A。只用自然语言说“我来处理/处理好了”。
消息含“本地”或 route=local 时 runtime 选 local，否则选 cloud。不要反问澄清，信息不全也直接派发。
如果 dispatch_to_sandbox 返回 ok:false，如实简短告诉用户“后台处理暂时不可用”，并给出你力所能及的直接回答。
收到 <sandbox-result> 通知时，简要向用户汇报结果（不要复述内部细节）。
闲聊或询问在线状态直接一句话回复。绝不让用户在聊天里发密码，也绝不复述任何密钥。回复简短，用中文。`;

const dispatch_to_sandbox = createTool({
  id: 'dispatch_to_sandbox',
  description: '把慢任务派发到后台执行，立即返回（不等待结果）；完成后会自动通知。',
  inputSchema: z.object({ prompt: z.string(), runtime: z.enum(['cloud', 'local']).default('cloud') }),
  execute: async ({ prompt, runtime }, ctx: any) => {
    const threadId: string | undefined = ctx?.agent?.threadId ?? ctx?.threadId;
    const resourceId: string | undefined = ctx?.agent?.resourceId ?? ctx?.resourceId;
    if (!E.PUSH_TOKEN) return { ok: false, reason: '后台回调未配置（PUSH_TOKEN 未设置）' };
    if (!threadId) return { ok: false, reason: '缺少会话 thread，无法回传结果' };
    const text = runtime === 'local' ? `本地 ${prompt}` : prompt;
    const taskId = `t-${crypto.randomUUID()}`; const now = Date.now();
    try {
      const { d, ready } = db(); await ready;
      await d.prepare('INSERT INTO l2_tasks (task_id,thread_id,resource_id,runtime,state,prompt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(taskId, threadId, resourceId ?? null, runtime, 'queued', text, now, now).run();
      console.log('[L1] queued', JSON.stringify({ taskId, threadId, runtime }));
      if (E.L2_A2A_URL) {
        try {
          const r = await fetch(normL2(String(E.L2_A2A_URL)), {
            method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/send', params: {
              message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text }] },
              configuration: { blocking: false, pushNotificationConfig: { url: callbackUrl(), token: String(E.PUSH_TOKEN) } },
            } }),
          });
          const j: any = await r.json().catch(() => null);
          if (r.ok && j?.result?.id) {
            const u = await d.prepare("UPDATE l2_tasks SET task_id=?, state=?, updated_at=? WHERE task_id=? AND state='queued'")
              .bind(j.result.id, j.result.status?.state ?? 'submitted', Date.now(), taskId).run();
            console.log('[L1] pushed via A2A', JSON.stringify({ taskId, l2TaskId: j.result.id, changed: u?.meta?.changes }));
            // Mac 侧 DNS 污染 workers.dev → push 回调可能到不了；Worker 经 tunnel 主动 tasks/get 轮询兜底（幂等）
            try { waitUntil(pollL2(String(j.result.id))); } catch (e: any) { console.log('[L1] waitUntil unavailable', String(e?.message ?? e)); }
          } else console.log('[L1] A2A push failed, left queued for pull', JSON.stringify({ status: r.status, err: j?.error?.message }));
        } catch (e: any) { console.log('[L1] A2A push error, left queued for pull', String(e?.message ?? e).slice(0, 160)); }
      }
      return { ok: true, status: 'queued', runtime };
    } catch (e: any) {
      return { ok: false, reason: `后台暂不可用（${String(e?.message ?? e).slice(0, 120)}）` };
    }
  },
});

const orchestrator = new Agent({
  id: 'orchestrator',
  name: 'orchestrator',
  instructions: INSTRUCTIONS,
  model: 'deepseek/deepseek-chat',
  tools: { dispatch_to_sandbox },
  // 会话记忆：使用 Mastra 实例的 D1Store；thread = 前端 sid
  memory: new Memory({ options: { lastMessages: 20 } }),
});

const RESEARCHER = `你是「调研专家」(researcher)，群聊里的调研/分析助手。擅长资料梳理、对比分析、归纳要点。
你在多人多 agent 群聊中，历史里 <turn from_name=…> 是人类发言，以 [agent:xxx] 开头的是其他 agent 的发言。只以你自己的身份回复，不要替其他 agent 说话，回复开头不要加 [agent:…] 标记。简短，用中文。`;
const CODER = `你是「工程师」(coder)，群聊里的编程助手。擅长写代码、排查 bug、解释技术方案，代码给最小可用示例。
你在多人多 agent 群聊中，历史里 <turn from_name=…> 是人类发言，以 [agent:xxx] 开头的是其他 agent 的发言。只以你自己的身份回复，不要替其他 agent 说话，回复开头不要加 [agent:…] 标记。简短，用中文。`;
const researcher = new Agent({ id: 'researcher', name: '调研专家', instructions: RESEARCHER, model: 'deepseek/deepseek-chat', memory: new Memory({ options: { lastMessages: 20 } }) });
const coder = new Agent({ id: 'coder', name: '工程师', instructions: CODER, model: 'deepseek/deepseek-chat', memory: new Memory({ options: { lastMessages: 20 } }) });
export const AGENTS: Record<string, Agent> = { orchestrator, researcher, coder } as any;

const tokenOk = (got?: string | null) => {
  const want = E.PUSH_TOKEN ? String(E.PUSH_TOKEN) : '';
  if (!got || !want) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};
const reqToken = (c: any) => {
  const auth = c.req.header('Authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : c.req.header('X-A2A-Notification-Token');
};

const TERMINAL = ['completed', 'failed', 'canceled', 'rejected'];
const extractTask = (task: any) => {
  let text = (task.artifacts ?? []).flatMap((a: any) => a.parts ?? []).filter((p: any) => p.kind === 'text').map((p: any) => p.text).join('\n')
    || task.status?.message?.parts?.map((p: any) => p.text).join('') || '';
  let state = String(task.status?.state ?? '');
  if (state === 'completed' && text.startsWith('【L2失败】')) { state = 'failed'; text = text.slice(6); }
  return { state, text };
};
/** 写入终态并 compose 回复；幂等（已终态则忽略）。返回 compose promise（若有） */
const finalizeTask = async (taskId: string, state: string, text: string, src: string): Promise<{ ignored?: string; compose?: Promise<void> }> => {
  const { d, ready } = db(); await ready;
  const rec: any = await d.prepare('SELECT * FROM l2_tasks WHERE task_id=?').bind(taskId).first();
  console.log('[L1] finalize', JSON.stringify({ src, taskId, state, known: !!rec, chars: text.length }));
  if (!rec) return { ignored: 'unknown task' };
  if (TERMINAL.includes(rec.state)) return { ignored: 'duplicate' };
  const u = await d.prepare(`UPDATE l2_tasks SET state=?, result=?, updated_at=? WHERE task_id=? AND state NOT IN ('completed','failed','canceled','rejected')`)
    .bind(state, text.slice(0, 20000), Date.now(), taskId).run();
  if (!TERMINAL.includes(state) || !u?.meta?.changes) return {};
  const compose = (async () => {
    try {
      const res: any = await orchestrator.generate(
        `<sandbox-result state="${state}">${text.slice(0, 8000)}</sandbox-result>\n（这是后台任务的结果通知，不是用户消息；请直接向用户简要汇报）`,
        { memory: { thread: rec.thread_id, resource: rec.resource_id ?? rec.thread_id }, maxSteps: 1 } as any);
      await d.prepare('UPDATE l2_tasks SET reply=?, updated_at=? WHERE task_id=?').bind(String(res?.text ?? '').slice(0, 8000), Date.now(), taskId).run();
    } catch (e: any) { console.log('[L1] compose failed', String(e?.message ?? e).slice(0, 200)); }
  })();
  return { compose };
};
/** Worker → tunnel → L2 A2A tasks/get 轮询，直到终态或超时 */
const pollL2 = (id: string) => pollL2Task(id, { url: () => normL2(String(E.L2_A2A_URL)), getState: async (tid) => { const { d, ready } = db(); await ready; return ((await d.prepare('SELECT state FROM l2_tasks WHERE task_id=?').bind(tid).first()) as any)?.state ?? null; }, terminal: TERMINAL, extract: extractTask, finalize: finalizeTask });

export const mastra = new Mastra({
  agents: { orchestrator, researcher, coder },
  storage: new D1Store({ id: 'l1-d1', binding: E.DB }),
  deployer: new CloudflareDeployer({
    name: 'mastra-l1',
    compatibility_date: '2026-10-01',
    compatibility_flags: ['nodejs_compat'],
    vars: { NODE_ENV: 'production', L1_PUBLIC_URL: DEFAULT_PUBLIC },
    d1_databases: [{ binding: 'DB', database_name: 'mastra-l1', database_id: '26a19832-8ff9-4fe4-a253-9305ae02f6bb' }],
  } as any),
  server: {
    // Better Auth + rooms + butler DM；auth gate for agent generate/stream. L2 routes below unaffected.
    middleware: [appMiddleware({ env: E, agent: () => orchestrator, agents: () => AGENTS }) as any],
    apiRoutes: [
      registerApiRoute('/health-l1', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c) => {
          let queued: number | null = null;
          try { const { d, ready } = db(); await ready; queued = ((await d.prepare("SELECT COUNT(*) n FROM l2_tasks WHERE state='queued'").first()) as any)?.n ?? 0; } catch {}
          return c.json({ ok: true, role: 'l1-mastra-cf', pullMode: true, claim: `${publicBase()}/l2-claim`, queued, l2Configured: !!E.L2_A2A_URL, pushToken: !!E.PUSH_TOKEN, callback: callbackUrl() });
        },
      } as any),
      // L2 出站 PULL：原子领取一个 queued 任务 → working
      registerApiRoute('/l2-claim', {
        method: 'POST',
        requiresAuth: false,
        handler: async (c: any) => {
          if (!tokenOk(reqToken(c))) return c.json({ error: 'bad token' }, 401);
          const { d, ready } = db(); await ready;
          const row: any = await d.prepare(`UPDATE l2_tasks SET state='working', updated_at=?
            WHERE task_id=(SELECT task_id FROM l2_tasks WHERE state='queued' ORDER BY created_at LIMIT 1) AND state='queued'
            RETURNING task_id, prompt, runtime, thread_id`).bind(Date.now()).first();
          if (!row) return c.json({ task: null });
          console.log('[L1] claimed', JSON.stringify({ taskId: row.task_id }));
          return c.json({ task: { taskId: row.task_id, prompt: row.prompt ?? '', runtime: row.runtime ?? 'cloud', threadId: row.thread_id } });
        },
      } as any),
      // A2A push webhook（L2 → L1）。真实路径：/a2a-callback（无 /api 前缀）
      registerApiRoute('/a2a-callback', {
        method: 'POST',
        requiresAuth: false,
        handler: async (c: any) => {
          if (!tokenOk(reqToken(c))) { console.log('[L1] callback REJECTED bad token'); return c.json({ error: 'bad token' }, 401); }
          const task: any = await c.req.json().catch(() => null);
          if (!task?.id || !task?.status?.state) return c.json({ error: 'bad payload' }, 400);
          const { state, text } = extractTask(task);
          const f = await finalizeTask(String(task.id), state, text, 'callback');
          if (f.ignored) return c.json({ ok: true, ignored: f.ignored });
          if (f.compose) { try { c.executionCtx.waitUntil(f.compose); } catch { await f.compose; } }
          return c.json({ ok: true });
        },
      } as any),
      // 前端轮询：本 thread 已完成且未投递的后台结果（reply 优先，否则原始 result）
      registerApiRoute('/l2-results', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c: any) => {
          const thread = c.req.query('thread') ?? '';
          if (!/^[\w-]{3,64}$/.test(thread)) return c.json({ error: 'bad thread' }, 400);
          const { d, ready } = db(); await ready;
          const { results } = await d.prepare('SELECT task_id,state,result,reply,updated_at FROM l2_tasks WHERE thread_id=? AND delivered=0 ORDER BY created_at').bind(thread).all();
          const busy = results.some((r: any) => !TERMINAL.includes(r.state));
          const done = results.filter((r: any) => TERMINAL.includes(r.state) && (r.reply || Date.now() - r.updated_at > 60_000));
          for (const r of done as any[]) await d.prepare('UPDATE l2_tasks SET delivered=1 WHERE task_id=?').bind(r.task_id).run();
          return c.json({ busy, results: done.map((r: any) => ({ state: r.state, text: r.reply || (r.state === 'completed' ? `处理好了：${r.result ?? ''}` : '这次后台处理没成功，请稍后再试。') })) });
        },
      } as any),
    ],
  },
});
