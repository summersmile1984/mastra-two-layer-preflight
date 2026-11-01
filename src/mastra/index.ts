/**
 * L1 on Cloudflare Workers：官方 CloudflareDeployer + D1。
 * 仅用于 `mastra build`；本地 Node 版仍走 src/server.ts（AgentController + sendSignal）。
 *
 * P2（Worker 侧派发 + 回调）：
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
import { env } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { registerApiRoute } from '@mastra/core/server';
import { CloudflareDeployer } from '@mastra/deployer-cloudflare';
import { D1Store } from '@mastra/cloudflare-d1';
import { Memory } from '@mastra/memory';
import { z } from 'zod';

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
    .then(() => d.prepare('CREATE INDEX IF NOT EXISTS l2_tasks_thread ON l2_tasks(thread_id, updated_at)').run());
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
    if (!E.L2_A2A_URL) return { ok: false, reason: '后台执行端未配置（L2_A2A_URL 未设置）' };
    if (!E.PUSH_TOKEN) return { ok: false, reason: '后台回调未配置（PUSH_TOKEN 未设置）' };
    if (!threadId) return { ok: false, reason: '缺少会话 thread，无法回传结果' };
    try {
      const r = await fetch(normL2(String(E.L2_A2A_URL)), {
        method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/send', params: {
          message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text: runtime === 'local' ? `本地 ${prompt}` : prompt }] },
          configuration: { blocking: false, pushNotificationConfig: { url: callbackUrl(), token: String(E.PUSH_TOKEN) } },
        } }),
      });
      const j: any = await r.json().catch(() => null);
      if (!r.ok || !j || j.error || !j.result?.id) return { ok: false, reason: `后台暂不可用（${j?.error?.message ?? 'HTTP ' + r.status}）`.slice(0, 200) };
      const t = j.result; const now = Date.now();
      const { d, ready } = db(); await ready;
      await d.prepare('INSERT OR REPLACE INTO l2_tasks (task_id,thread_id,resource_id,runtime,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind(t.id, threadId, resourceId ?? null, runtime, t.status?.state ?? 'submitted', now, now).run();
      console.log('[L1] dispatched', JSON.stringify({ taskId: t.id, state: t.status?.state, threadId }));
      return { ok: true, status: t.status?.state ?? 'submitted', runtime };
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

const tokenOk = (got?: string | null) => {
  const want = E.PUSH_TOKEN ? String(E.PUSH_TOKEN) : '';
  if (!got || !want) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};
const TERMINAL = ['completed', 'failed', 'canceled', 'rejected'];

export const mastra = new Mastra({
  agents: { orchestrator },
  storage: new D1Store({ id: 'l1-d1', binding: E.DB }),
  deployer: new CloudflareDeployer({
    name: 'mastra-l1',
    compatibility_date: '2026-10-01',
    compatibility_flags: ['nodejs_compat'],
    vars: { NODE_ENV: 'production', L1_PUBLIC_URL: DEFAULT_PUBLIC },
    d1_databases: [{ binding: 'DB', database_name: 'mastra-l1', database_id: '26a19832-8ff9-4fe4-a253-9305ae02f6bb' }],
  } as any),
  server: {
    apiRoutes: [
      registerApiRoute('/health-l1', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c) => c.json({ ok: true, role: 'l1-mastra-cf', l2Configured: !!E.L2_A2A_URL, pushToken: !!E.PUSH_TOKEN, callback: callbackUrl() }),
      } as any),
      // A2A push webhook（L2 → L1）。真实路径：/a2a-callback（无 /api 前缀）
      registerApiRoute('/a2a-callback', {
        method: 'POST',
        requiresAuth: false,
        handler: async (c: any) => {
          if (!tokenOk(c.req.header('X-A2A-Notification-Token'))) { console.log('[L1] callback REJECTED bad token'); return c.json({ error: 'bad token' }, 401); }
          const task: any = await c.req.json().catch(() => null);
          if (!task?.id || !task?.status?.state) return c.json({ error: 'bad payload' }, 400);
          let text = (task.artifacts ?? []).flatMap((a: any) => a.parts ?? []).filter((p: any) => p.kind === 'text').map((p: any) => p.text).join('\n')
            || task.status?.message?.parts?.map((p: any) => p.text).join('') || '';
          let state = String(task.status.state);
          if (state === 'completed' && text.startsWith('【L2失败】')) { state = 'failed'; text = text.slice(6); }
          const { d, ready } = db(); await ready;
          const rec: any = await d.prepare('SELECT * FROM l2_tasks WHERE task_id=?').bind(task.id).first();
          console.log('[L1] callback', JSON.stringify({ taskId: task.id, state, known: !!rec, chars: text.length }));
          if (!rec) return c.json({ ok: true, ignored: 'unknown task' });
          if (TERMINAL.includes(rec.state)) return c.json({ ok: true, ignored: 'duplicate' }); // 幂等
          await d.prepare('UPDATE l2_tasks SET state=?, result=?, updated_at=? WHERE task_id=?').bind(state, text.slice(0, 20000), Date.now(), task.id).run();
          if (TERMINAL.includes(state)) {
            const compose = (async () => {
              try {
                const res: any = await orchestrator.generate(
                  `<sandbox-result state="${state}">${text.slice(0, 8000)}</sandbox-result>\n（这是后台任务的结果通知，不是用户消息；请直接向用户简要汇报）`,
                  { memory: { thread: rec.thread_id, resource: rec.resource_id ?? rec.thread_id }, maxSteps: 1 } as any);
                await d.prepare('UPDATE l2_tasks SET reply=?, updated_at=? WHERE task_id=?').bind(String(res?.text ?? '').slice(0, 8000), Date.now(), task.id).run();
              } catch (e: any) { console.log('[L1] compose failed', String(e?.message ?? e).slice(0, 200)); }
            })();
            try { c.executionCtx.waitUntil(compose); } catch { await compose; }
          }
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
