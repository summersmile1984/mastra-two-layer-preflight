/**
 * 双层架构入口（端口默认 4120）
 *   L1 = Mastra AgentController（常驻、对用户唯一可见）
 *   L2 = A2A 服务端上的 l2-worker（@mastra/server A2A handler）→ @mastra/acp → `dsh --profile acp`
 * 完成通知：A2A push → POST /api/a2a-callback（token 校验）→ 收截图到 pendingImages → session.sendSignal 唤醒 L1
 *          → L1 主动发消息，SSE `l1` 事件携带 images。用户无需追问。
 * L2_MODE=queue：同进程队列 + sendSignal（不走 A2A），用于对比/离线。
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { TaskStore, loadPushToken } from './task-store';
import { storeSecret, bindTaskSecrets, redactKnownSecrets } from './secrets';
import { Mastra } from '@mastra/core';
import { buildL1 } from './l1/controller';
import { JobQueue } from './l2/queue';
import { startAcpWorker, acpProfile } from './l2/acp-worker';
import type { L2Event } from './protocol';
import { AllowlistedPushSender, a2aSendNonBlocking, buildL2Agent, L2_AGENT_ID, log, makeA2ARoutes, a2aLog, commandExists } from './l2/a2a-l2';

const PORT = Number(process.env.PORT ?? 4120);
const USE_A2A = process.env.L2_MODE !== 'queue';
const DEV = process.env.DEV_ENDPOINTS === '1';
// L1 回调地址：本机默认 127.0.0.1；L2 在远端时设 PUBLIC_BASE_URL=https://xxx（如 CF Tunnel 域名）
const BASE = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') ?? `http://127.0.0.1:${PORT}`;
// SPLIT：设置 L2_A2A_URL 即视为 L2 在独立进程/远端（只给根地址也可，自动补 /api/a2a/l2-worker）
const SPLIT = !!process.env.L2_A2A_URL && process.env.L1_EMBED_L2 !== '1';
const normL2 = (u: string) => { u = u.replace(/\/$/, ''); return /\/api\/a2a\//.test(u) ? u : `${u}/api/a2a/${L2_AGENT_ID}`; };
const L2_URL = process.env.L2_A2A_URL ? normL2(process.env.L2_A2A_URL) : `http://127.0.0.1:${PORT}/api/a2a/${L2_AGENT_ID}`;
const CALLBACK = `${BASE}/api/a2a-callback`;
const DATA_DIR = process.env.DATA_DIR ?? './data';
const PUSH_TOKEN = loadPushToken(DATA_DIR); // 持久化，不打印
const isPublic = /^https:\/\//.test(BASE) && !/localhost|127\.0\.0\.1/.test(BASE);
// 公网 https 回调：交给官方 DefaultPushNotificationSender（传 undefined 走 handler 默认值，带 SSRF 防护）
const pushSender = isPublic && process.env.PUSH_SENDER !== 'allowlist' ? undefined : new AllowlistedPushSender([CALLBACK]);

// ---------- L1 侧任务 registry（taskId → 会话/状态），用于进度查询，不触碰 L2 ----------
const tasks = new TaskStore(DATA_DIR); // 落盘 data/tasks.json
const pendingImages = new Map<string, string[]>();
const sseStatus = new Map<string, Set<(busy: boolean) => void>>();
const ssePush = new Map<string, Set<(data: unknown) => void>>();
const emitStatus = (sid: string) => { const busy = tasks.values().some(t => t.sessionId === sid && t.state === 'working'); sseStatus.get(sid)?.forEach(f => f(busy)); };
const emitTo = (sid: string, data: unknown) => ssePush.get(sid)?.forEach(f => f(data));


// ---------- 构建两层 ----------
const queue = new JobQueue();
if (!USE_A2A) { startAcpWorker(queue, 'cloud'); startAcpWorker(queue, 'local'); }
const l1 = await buildL1(queue, DATA_DIR, {
  ...(USE_A2A ? {
    dispatch: async ({ sessionId, prompt, runtime }) => {
      // secretRef → 一次性 env 绑定（明文不进 A2A 消息体）
      const bound = bindTaskSecrets(prompt);
      const task = await a2aSendNonBlocking(L2_URL, runtime === 'local' ? `本地 ${bound.prompt}` : bound.prompt, { url: CALLBACK, token: PUSH_TOKEN });
      tasks.set({ id: task.id, sessionId, runtime, state: task.status.state, startedAt: Date.now() - 2000, updatedAt: Date.now() });
      log('L1 dispatched via A2A message/send (blocking:false)', { taskId: task.id, state: task.status.state, sessionId });
      emitStatus(sessionId);
      return { jobId: task.id, runtime, status: task.status.state };
    },
    status: (sessionId: string) => tasks.values().filter(t => t.sessionId === sessionId && t.state === 'working')
      .map(t => ({ id: t.id.slice(0, 8), runtime: t.runtime, status: t.state, last: `已运行 ${Math.round((Date.now() - t.startedAt) / 1000)}s` })),
  } : {}),
});
const l2Mastra = new Mastra({ logger: false, agents: { [L2_AGENT_ID]: buildL2Agent() } });

// ---------- 产物收集：L2 工作区新 PNG → ./screenshots；缺图时宿主 Chrome 兜底 ----------
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
async function newScreenshots(taskId: string, since: number): Promise<string[]> {
  const out = `task-${taskId.slice(0, 8)}.png`;
  const dest = new URL(`../screenshots/${out}`, import.meta.url);
  let found = false;
  for (const rt of ['cloud', 'local']) for (const sub of ['', 'site/']) {
    const wd = new URL(`../workspace-l2/${rt}/${sub}`, import.meta.url);
    try { for (const f of readdirSync(wd)) if (/^[\w.-]+\.png$/.test(f) && statSync(new URL(f, wd)).mtimeMs >= since) { copyFileSync(new URL(f, wd), dest); found = true; } } catch {}
  }
  // 兜底：cloud profile 在 bwrap 里起不来 Chrome → 宿主渲染 site/index.html
  if (!found && existsSync(CHROME)) for (const rt of ['cloud', 'local']) {
    const idx = new URL(`../workspace-l2/${rt}/site/index.html`, import.meta.url);
    try { if (statSync(idx).mtimeMs < since) continue; } catch { continue; }
    await new Promise<void>(r => execFile(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=/tmp/l2shot-${Date.now()}`, '--window-size=1280,1600', `--screenshot=${dest.pathname}`, idx.href], { timeout: 45000 }, e => { log('host screenshot fallback', { runtime: rt, ok: !e }); r(); }));
    found = true; break;
  }
  try { return found && statSync(dest).mtimeMs >= since ? [`/screenshots/${out}?t=${Date.now()}`] : []; } catch { return []; }
}

/** 对用户可见文本做脱敏：内部路径、任务 id、L2 术语、疑似密钥 */
function sanitizeUserFacing(text: string): string {
  return text
    .replace(/(?:\/[\w.-]+)*\/workspace-l2\/(?:cloud|local)\/?/g, '工作区/')
    .replace(/\/(?:home|workspace|tmp|root|Users)\/[\w./-]+/g, m => (m.split('/').pop() || '文件'))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '任务')
    .replace(/\bjob_[a-z0-9]+\b/gi, '任务')
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '***')
    .replace(/\b(ACP|acp|harness|dsh|sandbox-result|l2-worker|A2A)\b/g, '后台')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
const tokenOk = (got?: string) => { if (!got) return false; const a = Buffer.from(got), b = Buffer.from(PUSH_TOKEN); return a.length === b.length && timingSafeEqual(a, b); };

const SID = /^[\w-]{3,64}$/;
const pendingSecret = new Map<string, { sessionId: string; runId?: string; label: string }>();
const app = new Hono();
app.get('/', c => c.html(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')));
app.get('/screenshots/:f', c => { const f = c.req.param('f'); if (!/^[\w.-]+\.png$/.test(f)) return c.notFound(); try { return c.body(readFileSync(new URL('../screenshots/' + f, import.meta.url)), 200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); } catch { return c.notFound(); } });

// 健康检查：不含任何密钥
app.get('/api/health', c => c.json({
  ok: true, port: PORT, l2Mode: USE_A2A ? 'a2a' : 'queue', l1Model: l1.modelKind,
  pushSender: pushSender ? 'allowlist' : 'official-default', callback: CALLBACK.replace(/\/\/[^/]+/, '//…'),
  harness: { cloud: commandExists(acpProfile('cloud').command), local: commandExists(acpProfile('local').command), dryRun: process.env.ACP_DRY_RUN === '1' },
  chrome: existsSync(CHROME), split: SPLIT, l2: SPLIT ? L2_URL.replace(/\/\/[^/]+/, '//…') : 'embedded', deepseekKey: !!process.env.DEEPSEEK_API_KEY, devEndpoints: DEV,
}));

if (USE_A2A && !SPLIT) makeA2ARoutes(app, l2Mastra, pushSender, `http://127.0.0.1:${PORT}`);

// A2A push webhook：task 快照 → 唤醒 L1（无需用户消息）
app.post('/api/a2a-callback', async c => {
  if (!tokenOk(c.req.header('X-A2A-Notification-Token'))) { log('callback REJECTED bad token'); return c.json({ error: 'bad token' }, 401); }
  const task: any = await c.req.json().catch(() => null);
  if (!task?.id || !task?.status?.state) return c.json({ error: 'bad payload' }, 400);
  const rec = tasks.get(task.id);
  let text = (task.artifacts ?? []).flatMap((a: any) => a.parts ?? []).filter((p: any) => p.kind === 'text').map((p: any) => p.text).join('\n') || task.status?.message?.parts?.map((p: any) => p.text).join('') || '';
  let state = task.status.state as string;
  if (state === 'completed' && text.startsWith('【L2失败】')) { state = 'failed'; text = text.slice(6); }
  log('callback received', { taskId: task.id, state, known: !!rec, chars: text.length });
  if (!rec) return c.json({ ok: true, ignored: 'unknown task' });
  if (rec.state !== 'working') return c.json({ ok: true, ignored: 'duplicate' }); // 幂等
  tasks.update(task.id, { state });
  // 重启后会话不在内存：按 resourceId/threadId 重建（历史在 LibSQL），仍能 wake
  const s = l1.peekSession(rec.sessionId) ?? await l1.getSession(rec.sessionId);
  if (s && ['completed', 'failed', 'canceled', 'rejected'].includes(state)) {
    const imgs = state === 'completed' ? await newScreenshots(task.id, rec.startedAt) : [];
    if (imgs.length) { pendingImages.set(rec.sessionId, [...(pendingImages.get(rec.sessionId) ?? []), ...imgs]); log('images attached for L1 reply', { count: imgs.length }); }
    emitTo(rec.sessionId, { kind: 'status', busy: true, phase: 'l1-composing' });
    s.sendSignal({ type: 'notification', tagName: 'sandbox-result', contents: state === 'completed' ? text : `任务${state}：${text}`, attributes: { jobId: task.id.slice(0, 8), state } } as any);
    log('L1 woken via session.sendSignal', { sessionId: rec.sessionId });
  }
  emitStatus(rec.sessionId);
  return c.json({ ok: true });
});

// HITL：密码表单提交 → vault 存明文 → respondToToolSuspension({resumeData:{secretRef}})
app.post('/api/secret', async c => {
  const { sessionId, toolCallId, runId, value, cancel } = await c.req.json().catch(() => ({} as any));
  if (!SID.test(sessionId ?? '') || !toolCallId) return c.json({ ok: false, error: 'bad request' }, 400);
  const s = l1.peekSession(sessionId);
  const pend = pendingSecret.get(toolCallId);
  if (!s || !pend || pend.sessionId !== sessionId) return c.json({ ok: false, error: 'no pending request' }, 404);
  pendingSecret.delete(toolCallId);
  const resumeData = cancel || !value ? { cancelled: true } : { secretRef: storeSecret(String(value), pend.label) };
  try { await s.respondToToolSuspension({ resumeData, toolCallId, runId: runId ?? pend.runId }); }
  catch (e: any) { console.error('resume failed', redactKnownSecrets(String(e?.message ?? e)).slice(0, 200)); return c.json({ ok: false, error: 'resume failed' }, 500); }
  return c.json({ ok: true });
});

app.get('/api/bots', c => c.json([{ id: 'orchestrator', name: '总管 Orchestrator', desc: '随时在线' }]));
app.post('/api/session', async c => {
  const { sessionId } = await c.req.json();
  if (!SID.test(sessionId ?? '')) return c.json({ error: 'bad sessionId' }, 400);
  const s = await l1.getSession(sessionId);
  return c.json({ ok: true, sessionId, threadId: s.thread.getId(), controller: 'orchestrator' });
});
// 发消息：立即 202，L1 回复经 SSE。L2 运行中发消息不会打断 L2（L2 在独立 A2A task 里）
app.post('/api/message', async c => {
  const { sessionId, text } = await c.req.json();
  if (!SID.test(sessionId ?? '') || !String(text ?? '').trim()) return c.json({ error: 'bad request' }, 400);
  const s = await l1.getSession(sessionId);
  s.sendMessage({ content: String(text).slice(0, 8000) }).catch(e => { console.error('sendMessage', String(e?.message ?? e).slice(0, 200)); emitTo(sessionId, { kind: 'error', text: '出了点问题，请稍后再试' }); });
  return c.json({ accepted: true, t0: Date.now() }, 202);
});

if (DEV) {
  app.get('/api/a2a-log', c => c.json(a2aLog));
  // DEV-only：手工往气泡里推一张图，验证 UI 渲染；真实路径是 A2A→callback→sendSignal→pendingImages
  app.post('/api/demo/push-image', async c => {
    const { sessionId, text, file = 'site-demo.png' } = await c.req.json();
    const payload = { kind: 'l1', text: text || '（DEV）截图如下。', images: [`/screenshots/${file}?t=${Date.now()}`], at: new Date().toISOString() };
    if (!ssePush.get(sessionId)?.size) return c.json({ ok: false, reason: 'no sse subscriber' }, 404);
    emitTo(sessionId, payload); return c.json({ ok: true });
  });
}

app.get('/api/events', async c => {
  const sessionId = c.req.query('sessionId') ?? '';
  if (!SID.test(sessionId)) return c.text('bad sessionId', 400);
  const s = await l1.getSession(sessionId);
  return streamSSE(c, async stream => {
    const send = (data: unknown) => stream.writeSSE({ data: JSON.stringify(data) }).catch(() => {});
    const buf = new Map<string, { role: string; text: string }>();
    const unsub = s.subscribe((ev: any) => {
      if (ev.type === 'message_start') buf.set(ev.message.id, { role: ev.message.role, text: (ev.message.content?.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('') });
      else if (ev.type === 'message_update') { const b = buf.get(ev.id); if (b && ev.event.type === 'text-delta') b.text += ev.event.delta; if (b && ev.event.type === 'part' && ev.event.part?.type === 'text') b.text = ev.event.part.text ?? b.text; }
      else if (ev.type === 'message_end') {
        const b = buf.get(ev.id); buf.delete(ev.id);
        if (b?.role === 'assistant' && b.text.trim()) { const images = pendingImages.get(sessionId); pendingImages.delete(sessionId); send({ kind: 'l1', text: redactKnownSecrets(sanitizeUserFacing(b.text)), images, at: new Date().toISOString() }); emitStatus(sessionId); }
      } else if (ev.type === 'tool_suspended' && ev.toolName === 'request_secret') {
        const p: any = ev.suspendPayload ?? ev.args ?? {};
        pendingSecret.set(ev.toolCallId, { sessionId, runId: ev.runId, label: String(p.label ?? '密码') });
        send({ kind: 'secret_request', toolCallId: ev.toolCallId, runId: ev.runId, label: String(p.label ?? '密码'), purpose: sanitizeUserFacing(String(p.purpose ?? '')) });
      } else if (ev.type === 'tool_suspension_cancelled' && ev.toolName === 'request_secret') {
        pendingSecret.delete(ev.toolCallId); send({ kind: 'secret_cancelled', toolCallId: ev.toolCallId });
      } else if (ev.type === 'error') send({ kind: 'error', text: '出了点问题，请稍后再试' });
    });
    const onL2 = (e: L2Event) => { if (e.job.sessionId === sessionId && (e.type === 'result' || e.type === 'cancel')) send({ kind: 'status', busy: true, phase: 'l1-composing' }); };
    queue.on('event', onL2);
    const st = (busy: boolean) => send({ kind: 'status', busy, phase: busy ? 'background' : 'idle' });
    if (!sseStatus.has(sessionId)) sseStatus.set(sessionId, new Set());
    if (!ssePush.has(sessionId)) ssePush.set(sessionId, new Set());
    sseStatus.get(sessionId)!.add(st); ssePush.get(sessionId)!.add(send);
    send({ kind: 'hello', sessionId });
    emitStatus(sessionId);
    const ping = setInterval(() => stream.writeSSE({ event: 'ping', data: '' }).catch(() => {}), 15000);
    await new Promise<void>(r => stream.onAbort(() => r()));
    clearInterval(ping); unsub?.(); queue.off('event', onL2); sseStatus.get(sessionId)?.delete(st); ssePush.get(sessionId)?.delete(send);
  });
});

serve({ fetch: app.fetch, port: PORT, hostname: process.env.HOST ?? '0.0.0.0' }, () =>
  console.log(`${SPLIT ? 'L1 only (L2 remote)' : 'L1+L2'} preflight on http://localhost:${PORT}  (L2_MODE=${USE_A2A ? 'a2a' : 'queue'}, push=${pushSender ? 'allowlist' : 'official'}, dev=${DEV})`));
