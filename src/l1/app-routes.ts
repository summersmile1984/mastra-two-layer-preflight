/**
 * User-facing routes mounted as a Mastra server middleware (custom apiRoutes can't use the /api prefix):
 *   /api/auth/*            Better Auth handler
 *   /api/dev/otp           dev-only OTP read (AUTH_DEV_MODE=1)
 *   /api/rooms…            self-built rooms (session required)
 *   /api/butler/messages   private butler DM (session required)
 *   /api/butler/profile    PATCH display_name (session required)
 *   /api/connections       连接应用 catalog + user connects (session required)
 *   /api/device            L2 / Bot computer status stub (session required)
 *   /api/agents/:id/(generate|stream…)  now requires a session; DEV bypass: Bearer PUSH_TOKEN (L2 tests only)
 * Non-matching requests fall through to Mastra (L2 /l2-* and /a2a-callback untouched).
 *
 * Product: L1 = butler/orchestrator only. Room experts = L2 (enqueue l2_tasks.expert_id → L2 runner →
 * push [agent:id] into thread). NOT AgentController.subagents[] / NOT sync await generate in roomTurn.
 * room_agents gates which expert ids may be @mentioned this turn (orchestrator non-removable).
 */
import { timingSafeEqual } from 'node:crypto';
import { createAuth, devMode } from '../auth';
import { AGENT_CATALOG, isExpertId } from './experts';
import { featureRoutes, loadPermissions, filterTools, decide, recordUsage, tokensOf, listAgentDefs, roomAgentDefs, resolveConnections, mcpListTools } from './features';
import { scheduleRoutes, type FireDeps } from './schedules';

type Deps = { buildMcpToolsets?: (conns: Awaited<ReturnType<typeof resolveConnections>>, allow: (tool: string, server: string) => boolean) => Promise<{ toolsets: Record<string, Record<string, any>>; injected: { server_id: string; tools: string[]; error?: string }[] }>; env: any; agent: () => any; agents: () => Record<string, any>; enqueueExpert?: (a: { roomId: string; threadId: string; expertId: string; prompt: string; userId: string }) => Promise<{ jobId: string }>; schedule?: (p: Promise<unknown>) => void; summarize?: (prompt: string) => Promise<string>; vector?: () => any };
export const CATALOG = AGENT_CATALOG;

/** Catalog for 「连接应用」. Each connection stores HTTP MCP config (url + optional vault secret); tools are listed via MCP tools/list and injected as toolsets on orchestrator generate (stdio MCP unsupported on Workers). */
export const MCP_APP_CATALOG = [
  { id: 'github', name: 'GitHub', desc: 'Issues / PR / 仓库只读', category: 'dev' },
  { id: 'slack', name: 'Slack', desc: '频道消息与搜索', category: 'chat' },
  { id: 'notion', name: 'Notion', desc: '页面与数据库', category: 'docs' },
  { id: 'linear', name: 'Linear', desc: '议题与项目板', category: 'dev' },
  { id: 'google-drive', name: 'Google Drive', desc: '文件列表与摘要', category: 'docs' },
];
const DEFAULT_BUTLER_NAME = '管家 Orchestrator';
const BASE_ALIAS: Record<string, string> = { '管家': 'orchestrator', orchestrator: 'orchestrator', '调研': 'researcher', '调研专家': 'researcher', researcher: 'researcher', '工程师': 'coder', coder: 'coder' };
/** @mentions in order of appearance (deduped). Unknown @words returned separately. Optional extraAlias maps a custom butler name → orchestrator for this request. */
export function parseMentions(text: string, extraAlias?: Record<string, string>) {
  const alias = { ...BASE_ALIAS, ...(extraAlias || {}) };
  const ids: string[] = [], unknown: string[] = [];
  for (const mt of text.matchAll(/[@＠]([\p{L}\p{N}_-]+)/gu)) {
    const w = mt[1]; const key = Object.keys(alias).sort((a, b) => b.length - a.length).find(k => w.toLowerCase().startsWith(k.toLowerCase()));
    if (key) { if (!ids.includes(alias[key])) ids.push(alias[key]); } else unknown.push(w);
  }
  return { ids, unknown };
}
const catalogName = (id: string) => CATALOG.find(a => a.id === id)?.name ?? id;
const butlerDisplay = (raw: unknown) => {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s || DEFAULT_BUTLER_NAME;
};
const now = () => Date.now();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
/** DM memory ids: thread `dm_<uid>` (per-conversation history), resource `user:<uid>` (working memory + semantic recall scope). Legacy thread `user:<uid>` migrated on first access. */
export const dmThread = (uid: string) => `dm_${uid}`;
export const dmResource = (uid: string) => `user:${uid}`;
const migrated = new Set<string>();
async function migrateDm(d: any, uid: string) {
  if (migrated.has(uid)) return;
  const oldT = `user:${uid}`, newT = dmThread(uid), res = dmResource(uid);
  try {
    const has: any = await d.prepare('SELECT 1 x FROM mastra_threads WHERE id=?').bind(newT).first().catch(() => null);
    await d.batch([
      ...(has ? [] : [d.prepare('UPDATE mastra_threads SET id=?, resourceId=? WHERE id=?').bind(newT, res, oldT)]),
      d.prepare('UPDATE mastra_messages SET thread_id=?, resourceId=? WHERE thread_id=?').bind(newT, res, oldT),
      d.prepare('UPDATE l2_tasks SET thread_id=?, resource_id=? WHERE thread_id=?').bind(newT, res, oldT),
      d.prepare('UPDATE butler_profile SET dm_thread_id=? WHERE user_id=?').bind(newT, uid),
    ]);
    migrated.add(uid);
  } catch (e: any) { console.log('[mem] dm migrate failed', String(e?.message ?? e).slice(0, 160)); }
}
/** Rolling summary for long DM threads (D1 store lacks Observational Memory support). */
const SUMMARY_KEEP = 20, SUMMARY_EVERY = 20;
async function ensureSummaryTable(d: any) {
  await d.prepare('CREATE TABLE IF NOT EXISTS memory_summaries (thread_id TEXT PRIMARY KEY, summary TEXT, upto INTEGER, updated_at INTEGER)').run();
}
const msgText = (c: string) => { try { const j = JSON.parse(c); return String(j?.content ?? (j?.parts ?? []).map((p: any) => p?.text ?? '').join(' ')); } catch { return String(c); } };
export async function maybeSummarize(d: any, thread: string, summarize: (prompt: string) => Promise<string>) {
  await ensureSummaryTable(d);
  const n = Number(((await d.prepare('SELECT COUNT(*) n FROM mastra_messages WHERE thread_id=?').bind(thread).first()) as any)?.n ?? 0);
  const row: any = await d.prepare('SELECT summary, upto FROM memory_summaries WHERE thread_id=?').bind(thread).first();
  const upto = Number(row?.upto ?? 0), target = n - SUMMARY_KEEP;
  if (target <= 0 || target - upto < SUMMARY_EVERY) return { skipped: true, n, upto };
  const { results } = await d.prepare('SELECT role, content FROM mastra_messages WHERE thread_id=? ORDER BY createdAt LIMIT ? OFFSET ?').bind(thread, target - upto, upto).all();
  const transcript = (results as any[]).map(r => `${r.role}: ${msgText(r.content).slice(0, 1200)}`).join('\n');
  const summary = (await summarize(`把下面对话压缩成要点摘要（中文，<=600字，保留用户偏好、事实、待办、决定）。\n已有摘要：${row?.summary ?? '（无）'}\n新增对话：\n${transcript}`)).slice(0, 4000);
  await d.prepare('INSERT INTO memory_summaries (thread_id, summary, upto, updated_at) VALUES (?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET summary=excluded.summary, upto=excluded.upto, updated_at=excluded.updated_at')
    .bind(thread, summary, target, Date.now()).run();
  return { skipped: false, n, upto: target };
}
async function getSummary(d: any, thread: string) {
  try { await ensureSummaryTable(d); return ((await d.prepare('SELECT summary FROM memory_summaries WHERE thread_id=?').bind(thread).first()) as any)?.summary ?? null; } catch { return null; }
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function appMiddleware({ env, agent, agents, enqueueExpert, schedule, buildMcpToolsets, summarize, vector }: Deps) {
  const features = featureRoutes({ env, db: () => env.DB });
  const ORCH_TOOLS = ['dispatch_to_sandbox', 'dispatch_to_expert'];
  /** Permission-filtered activeTools + MCP toolsets for an orchestrator generate on behalf of userId. */
  const orchOpts = async (userId: string) => {
    const perm = await loadPermissions(env.DB, userId);
    const { active, blocked } = filterTools(perm, ORCH_TOOLS);
    let toolsets: Record<string, Record<string, any>> | undefined; let injected: any[] = [];
    try {
      const conns = await resolveConnections(env, env.DB, userId);
      if (conns.some(c => c.transport === 'http') && buildMcpToolsets) {
        const r = await buildMcpToolsets(conns, (tool, server) => decide(perm, tool, `mcp:${server}`).effective === 'allow');
        toolsets = Object.keys(r.toolsets).length ? r.toolsets : undefined; injected = r.injected;
      }
    } catch (e: any) { console.log('[mcp] toolsets failed', String(e?.message ?? e).slice(0, 160)); }
    const mcpNames = toolsets ? Object.values(toolsets).flatMap(t => Object.keys(t)) : [];
    return { activeTools: [...active, ...mcpNames], toolsets, blocked, injected };
  };
  let auth: ReturnType<typeof createAuth> | null = null;
  const getAuth = () => (auth ??= createAuth(env));
  const db = () => env.DB;

  const bypassOk = (req: Request) => {
    const h = req.headers.get('authorization') ?? '';
    const want = env.PUSH_TOKEN ? String(env.PUSH_TOKEN) : '';
    if (!h.startsWith('Bearer ') || !want) return false;
    const a = Buffer.from(h.slice(7)), b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** Explicit CF semantic recall (Workers AI bge-m3 + Vectorize), scoped by metadata filter. */
  const embed1 = async (t: string): Promise<number[] | null> => {
    try { const r: any = await env.AI?.run('@cf/baai/bge-m3', { text: [t.slice(0, 4000)] }); return r?.data?.[0] ?? null; } catch (e: any) { console.log('[mem] embed failed', String(e?.message ?? e).slice(0, 120)); return null; }
  };
  const semIndex = async (items: { id: string; text: string; role: string }[], thread: string, resource: string) => {
    if (!vector) return;
    try {
      const r: any = await env.AI.run('@cf/baai/bge-m3', { text: items.map(i => i.text.slice(0, 4000)) });
      await vector().upsert({ indexName: 'x', ids: items.map(i => i.id), vectors: r.data,
        metadata: items.map(i => ({ thread_id: thread, resource_id: resource, role: i.role, content: i.text.slice(0, 1500), created_at: new Date().toISOString() })) });
    } catch (e: any) { console.log('[mem] index failed', String(e?.message ?? e).slice(0, 160)); }
  };
  const semRecall = async (q: string, filter: Record<string, string>, topK = 4) => {
    if (!vector) return [] as any[];
    const v = await embed1(q); if (!v) return [];
    try { return (await vector().query({ indexName: 'x', queryVector: v, topK, filter })).filter((h: any) => h.score >= 0.55); } catch (e: any) { console.log('[mem] query failed', String(e?.message ?? e).slice(0, 160)); return []; }
  };
  const semContext = (hits: any[]) => hits.length ? `以下是与当前问题语义相关的较早记忆片段（可能已不在最近 20 条里）：\n${hits.map((h: any) => `- [${h.metadata?.role}] ${String(h.metadata?.content ?? '').slice(0, 400)}`).join('\n')}` : '';
  const generate = async (text: string, thread: string, resource: string, userId: string) => {
    const o = await orchOpts(userId);
    const summary = await getSummary(env.DB, thread);
    const hits = await semRecall(text, { resource_id: resource });
    const sys = [summary ? `早前对话摘要（较旧消息已压缩）：\n${summary}` : '', semContext(hits)].filter(Boolean).join('\n\n');
    const context = sys ? [{ role: 'system', content: sys }] : undefined;
    const res: any = await agent().generate(text, { memory: { thread, resource }, ...(context ? { context } : {}), maxSteps: 3, activeTools: [...o.activeTools, 'save_working_memory'], ...(o.toolsets ? { toolsets: o.toolsets } : {}) } as any);
    await recordUsage(env.DB, userId, 'l1_dm', tokensOf(res), { thread });
    const idx = semIndex([{ id: crypto.randomUUID(), text, role: 'user' }, ...(res?.text ? [{ id: crypto.randomUUID(), text: String(res.text), role: 'assistant' }] : [])], thread, resource);
    schedule ? schedule(idx) : await idx;
    (generate as any).lastHits = hits.length;
    return { text: String(res?.text ?? ''), blocked: o.blocked, injected: o.injected };
  };

  const dbMsg = (role: 'user' | 'assistant', text: string, thread: string, resource = thread) => ({
    id: crypto.randomUUID(), role, threadId: thread, resourceId: resource, createdAt: new Date(),
    content: { format: 2, parts: [{ type: 'text', text }], content: text },
  });
  /**
   * Room turn (async experts):
   * 1) save user message once
   * 2) expert targets → enqueue L2 (l2_tasks.expert_id) via enqueueExpert; return immediately
   * 3) orchestrator stays L1 inline (snappy ack listing who was dispatched)
   * Experts MUST NOT await Agent.generate in this request.
   */
  const roomTurn = async (
    wrapped: string,
    thread: string,
    targets: string[],
    nameOf: (id: string) => string,
    opts: { roomId: string; userId: string; userText: string; errNote?: string; isExpert: (id: string) => boolean },
  ) => {
    const mem = await agent().getMemory?.();
    await mem.saveMessages({ messages: [dbMsg('user', wrapped, thread)] });
    const roomHits = await semRecall(opts.userText, { thread_id: thread });
    { const idx = semIndex([{ id: crypto.randomUUID(), text: opts.userText, role: 'user' }], thread, thread); schedule ? schedule(idx) : await idx; }
    const replies: { agentId: string; name: string; reply: string }[] = [];
    const dispatched: { expertId: string; jobId: string }[] = [];
    if (opts.errNote) {
      const reply = opts.errNote;
      await mem.saveMessages({ messages: [dbMsg('assistant', `[agent:orchestrator] ${reply}`, thread)] });
      replies.push({ agentId: 'orchestrator', name: nameOf('orchestrator'), reply });
    }
    const expertTargets = targets.filter(id => id !== 'orchestrator' && opts.isExpert(id));
    const wantOrch = targets.includes('orchestrator') || (!expertTargets.length && !opts.errNote);

    for (const id of expertTargets) {
      if (!enqueueExpert) {
        // Fallback should not block forever; skip with note
        continue;
      }
      try {
        const { jobId } = await enqueueExpert({
          roomId: opts.roomId, threadId: thread, expertId: id,
          prompt: opts.userText, userId: opts.userId,
        });
        dispatched.push({ expertId: id, jobId });
      } catch (e: any) {
        const reply = `派发 ${nameOf(id)} 失败：${String(e?.message ?? e).slice(0, 120)}`;
        await mem.saveMessages({ messages: [dbMsg('assistant', `[agent:orchestrator] ${reply}`, thread)] });
        replies.push({ agentId: 'orchestrator', name: nameOf('orchestrator'), reply });
      }
    }

    // L1 butler: always give a quick ack when experts were dispatched; full inline reply when targeted alone.
    if (!opts.errNote && (wantOrch || dispatched.length)) {
      let reply: string;
      if (dispatched.length && !targets.includes('orchestrator')) {
        reply = `已派给${dispatched.map(d => nameOf(d.expertId)).join('、')}，好了会推回来。`;
        await mem.saveMessages({ messages: [dbMsg('assistant', `[agent:orchestrator] ${reply}`, thread)] });
      } else if (dispatched.length && targets.includes('orchestrator')) {
        // Brief listing first, then optional fuller generate would block — keep brief.
        reply = `收到。已派给${dispatched.map(d => nameOf(d.expertId)).join('、')}处理，好了推回本群；有需要我再补充。`;
        await mem.saveMessages({ messages: [dbMsg('assistant', `[agent:orchestrator] ${reply}`, thread)] });
      } else {
        // orchestrator-only: generate inline (L1)
        const a = agents()['orchestrator'] || agent();
        const o = await orchOpts(opts.userId);
        const res: any = await a.generate(`（系统提示：现在轮到你「${nameOf('orchestrator')}」回复上面群聊里最新的人类发言；只以你自己的身份简短回复。）`,
          { memory: { thread, resource: thread, options: { readOnly: true } }, ...(roomHits.length ? { context: [{ role: 'system', content: semContext(roomHits) }] } : {}), maxSteps: 3, activeTools: o.activeTools, ...(o.toolsets ? { toolsets: o.toolsets } : {}) } as any);
        await recordUsage(env.DB, opts.userId, 'l1_room', tokensOf(res), { roomId: opts.roomId });
        reply = String(res?.text ?? '').replace(/^\s*\[agent:[\w-]+\]\s*/, '').trim();
        await mem.saveMessages({ messages: [dbMsg('assistant', `[agent:orchestrator] ${reply}`, thread)] });
      }
      replies.push({ agentId: 'orchestrator', name: nameOf('orchestrator'), reply: reply! });
    }
    return { replies, dispatched };
  };

  return async (c: any, next: () => Promise<void>) => {
    const req: Request = c.req.raw;
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    if (p.startsWith('/api/auth/')) return getAuth().handler(req);

    const isAgentRun = /^\/api\/agents\/[^/]+\/(generate|stream)/.test(p) && m === 'POST';
    const ours = p.startsWith('/api/rooms') || p.startsWith('/api/butler') || p.startsWith('/api/connections') || p === '/api/device' || p === '/api/me' || p === '/api/agents' || p === '/api/dev/otp'
      || p.startsWith('/api/permissions') || p.startsWith('/api/vault') || p === '/api/usage' || p === '/api/version' || p.startsWith('/api/agent-defs') || p.startsWith('/api/templates') || p.startsWith('/api/schedules') || p === '/api/memory';
    if (!ours && !isAgentRun) return next();

    if (p === '/api/dev/otp') {
      if (!devMode(env)) return json({ error: 'not found' }, 404);
      const email = (url.searchParams.get('email') ?? '').toLowerCase();
      const row: any = await db().prepare('SELECT otp, type, created_at FROM dev_otps WHERE email=? ORDER BY created_at DESC LIMIT 1').bind(email).first();
      return json(row ? { email, ...row, devMode: true } : { error: 'no otp' }, row ? 200 : 404);
    }

    const session: any = await getAuth().api.getSession({ headers: req.headers }).catch(() => null);
    if (isAgentRun) {
      if (session?.user || bypassOk(req)) return next();
      return json({ error: 'unauthorized' }, 401);
    }
    if (!session?.user) return json({ error: 'unauthorized' }, 401);
    const user = session.user;
    const body: any = (m === 'POST' || m === 'PATCH' || m === 'PUT') ? await req.clone().json().catch(() => ({})) : {};

    const loadButler = async () => {
      const row: any = await db().prepare('SELECT dm_thread_id, display_name FROM butler_profile WHERE user_id=?').bind(user.id).first();
      const display_name = row?.display_name ?? null;
      const name = butlerDisplay(display_name);
      return { dm_thread_id: (row?.dm_thread_id && !String(row.dm_thread_id).startsWith('user:')) ? row.dm_thread_id : dmThread(user.id), display_name, name };
    };
    const nameOf = (butlerName: string) => (id: string) => id === 'orchestrator' ? butlerName : catalogName(id);
    const mentionAlias = (butlerName: string) => {
      const extra: Record<string, string> = {};
      if (butlerName && butlerName !== DEFAULT_BUTLER_NAME) {
        extra[butlerName] = 'orchestrator';
        // also allow first token if multi-word (e.g. "小蜜" already single; "我的管家" → full string)
        const first = butlerName.split(/\s+/)[0];
        if (first && first !== butlerName) extra[first] = 'orchestrator';
      }
      return extra;
    };

    const fr = await features(req, p, m, body, user, url);
    if (fr) return fr;

    // ---- 定时任务 ----
    if (p.startsWith('/api/schedules')) {
      const fireDeps: FireDeps = {
        db: db(),
        generateButler: async (userId, prompt, thread) => {
          const r = await generate(prompt, thread, thread, userId);
          return { text: r.text };
        },
        enqueueExpert: async ({ threadId, expertId, prompt, userId, roomId }) => {
          if (!enqueueExpert) throw new Error('enqueueExpert unavailable');
          return enqueueExpert({ roomId: roomId || '', threadId, expertId, prompt, userId });
        },
        roomPost: async ({ roomId, userId, text }) => {
          const role = ((await db().prepare('SELECT role FROM room_members WHERE room_id=? AND user_id=?').bind(roomId, userId).first()) as any)?.role;
          if (!role) return { ok: false, detail: 'not a room member' };
          const room: any = await db().prepare('SELECT thread_id FROM rooms WHERE id=?').bind(roomId).first();
          if (!room) return { ok: false, detail: 'room not found' };
          const butler = await (async () => {
            const row: any = await db().prepare('SELECT display_name FROM butler_profile WHERE user_id=?').bind(userId).first();
            return butlerDisplay(row?.display_name);
          })();
          const wrapped = `<turn from_name="定时任务">${esc(text)}</turn>`;
          const r = await roomTurn(wrapped, room.thread_id, ['orchestrator'], nameOf(butler), {
            roomId, userId, userText: text, isExpert: isExpertId,
          });
          return { ok: true, detail: r.replies.map(x => x.reply).join(' | ').slice(0, 2000) };
        },
      };
      const sr = await scheduleRoutes(req, p, m, body, user, fireDeps);
      if (sr) return sr;
    }


    if (p === '/api/me' && m === 'GET') {
      const butler = await loadButler();
      return json({ user: { id: user.id, email: user.email, name: user.name }, butler });
    }

    if (p === '/api/butler/profile' && (m === 'PATCH' || m === 'PUT')) {
      const raw = String(body.display_name ?? '').trim();
      if (!raw || raw.length < 1 || raw.length > 32) return json({ error: 'display_name must be 1–32 chars after trim' }, 400);
      await db().prepare('UPDATE butler_profile SET display_name=? WHERE user_id=?').bind(raw, user.id).run();
      // ensure row exists (e.g. legacy users missing profile)
      const check: any = await db().prepare('SELECT user_id FROM butler_profile WHERE user_id=?').bind(user.id).first();
      if (!check) {
        await db().prepare('INSERT INTO butler_profile (user_id, dm_thread_id, created_at, display_name) VALUES (?,?,?,?)')
          .bind(user.id, dmThread(user.id), now(), raw).run();
      }
      const butler = await loadButler();
      return json({ butler });
    }

    if (p === '/api/rooms' && m === 'GET') {
      const { results } = await db().prepare(`SELECT r.id, r.name, r.thread_id, r.created_at, rm.role FROM rooms r JOIN room_members rm ON rm.room_id=r.id WHERE rm.user_id=? ORDER BY r.created_at DESC`).bind(user.id).all();
      const { results: invites } = await db().prepare(`SELECT i.id, i.room_id, r.name FROM room_invites i JOIN rooms r ON r.id=i.room_id WHERE i.email=? AND i.status='pending'`).bind(String(user.email).toLowerCase()).all();
      return json({ rooms: results, invites });
    }

    if (p === '/api/rooms' && m === 'POST') {
      const name = String(body.name ?? '').trim().slice(0, 100);
      if (!name) return json({ error: 'name required' }, 400);
      const id = crypto.randomUUID(); const thread = `room_${id}`; const t = now();
      await db().batch([
        db().prepare('INSERT INTO rooms (id,name,owner_id,thread_id,tenant_id,created_at) VALUES (?,?,?,?,NULL,?)').bind(id, name, user.id, thread, t),
        db().prepare("INSERT INTO room_members (room_id,user_id,role,joined_at) VALUES (?,?,'owner',?)").bind(id, user.id, t),
        db().prepare("INSERT INTO room_agents (room_id,agent_id,added_at) VALUES (?,'orchestrator',?)").bind(id, t),
      ]);
      // Mastra thread: try eager create; on failure first message creates it lazily
      let threadCreated = false;
      try {
        const mem = await agent().getMemory?.();
        if (mem) { await mem.createThread({ threadId: thread, resourceId: thread, title: name }); threadCreated = true; }
      } catch (e: any) { console.log('[rooms] createThread deferred', String(e?.message ?? e).slice(0, 120)); }
      return json({ room: { id, name, thread_id: thread, role: 'owner' }, agents: ['orchestrator'], threadCreated }, 201);
    }

    const roleIn = async (roomId: string) => ((await db().prepare('SELECT role FROM room_members WHERE room_id=? AND user_id=?').bind(roomId, user.id).first()) as any)?.role as string | undefined;

    let mm = p.match(/^\/api\/rooms\/invites\/([\w-]+)\/accept$/);
    if (mm && m === 'POST') {
      const inv: any = await db().prepare("SELECT * FROM room_invites WHERE id=? AND status='pending'").bind(mm[1]).first();
      if (!inv) return json({ error: 'invite not found' }, 404);
      if (inv.email !== String(user.email).toLowerCase()) return json({ error: 'invite is for another email' }, 403);
      await db().batch([
        db().prepare("INSERT OR IGNORE INTO room_members (room_id,user_id,role,joined_at) VALUES (?,?,'member',?)").bind(inv.room_id, user.id, now()),
        db().prepare("UPDATE room_invites SET status='accepted', accepted_at=? WHERE id=?").bind(now(), inv.id),
      ]);
      return json({ ok: true, room_id: inv.room_id });
    }

    mm = p.match(/^\/api\/rooms\/([\w-]+)$/);
    if (mm && m === 'GET' && mm[1] !== 'invites') {
      const roomId = mm[1];
      const role = await roleIn(roomId);
      if (!role) return json({ error: 'not a member' }, 403);
      const room: any = await db().prepare('SELECT id, name, thread_id, owner_id, created_at FROM rooms WHERE id=?').bind(roomId).first();
      if (!room) return json({ error: 'not found' }, 404);
      const { results: members } = await db().prepare('SELECT rm.user_id, u.name, u.email, rm.role, rm.joined_at FROM room_members rm LEFT JOIN "user" u ON u.id=rm.user_id WHERE rm.room_id=? ORDER BY rm.joined_at').bind(roomId).all();
      const { results: agentsRaw } = await db().prepare('SELECT agent_id, added_at FROM room_agents WHERE room_id=? ORDER BY added_at').bind(roomId).all();
      const rdefs = await roomAgentDefs(db(), roomId);
      const agents = (agentsRaw as any[]).map(a => { const d = rdefs.find(x => x.id === a.agent_id); return d ? { ...a, name: d.name, custom: true, desc: d.description } : a; });
      let pendingInvites: any[] = [];
      if (role === 'owner' || role === 'admin') pendingInvites = (await db().prepare("SELECT id, email, status, created_at FROM room_invites WHERE room_id=? AND status='pending' ORDER BY created_at DESC").bind(roomId).all()).results;
      return json({ room: { ...room, role }, role, members, agents, pendingInvites });
    }

    // ---- 群管理：拒绝邀请 / 改名 / 解散 / 退出 / 成员管理 / 撤销邀请 / 专家任务状态 ----
    mm = p.match(/^\/api\/rooms\/invites\/([\w-]+)\/decline$/);
    if (mm && m === 'POST') {
      const inv: any = await db().prepare("SELECT * FROM room_invites WHERE id=? AND status='pending'").bind(mm[1]).first();
      if (!inv) return json({ error: 'invite not found' }, 404);
      if (inv.email !== String(user.email).toLowerCase()) return json({ error: 'invite is for another email' }, 403);
      await db().prepare("UPDATE room_invites SET status='declined' WHERE id=?").bind(inv.id).run();
      return json({ ok: true });
    }
    mm = p.match(/^\/api\/rooms\/([\w-]+)$/);
    if (mm && (m === 'PATCH' || m === 'DELETE') && mm[1] !== 'invites') {
      const role = await roleIn(mm[1]);
      if (!role) return json({ error: 'not a member' }, 404);
      if (m === 'PATCH') {
        if (role !== 'owner' && role !== 'admin') return json({ error: 'forbidden' }, 403);
        const name = String(body.name ?? '').trim().slice(0, 100);
        if (!name) return json({ error: 'name required' }, 400);
        await db().prepare('UPDATE rooms SET name=? WHERE id=?').bind(name, mm[1]).run();
        return json({ ok: true, room: { id: mm[1], name } });
      }
      if (role !== 'owner') return json({ error: 'only owner can delete' }, 403);
      await db().batch([
        db().prepare('DELETE FROM room_agents WHERE room_id=?').bind(mm[1]),
        db().prepare('DELETE FROM room_invites WHERE room_id=?').bind(mm[1]),
        db().prepare('DELETE FROM room_members WHERE room_id=?').bind(mm[1]),
        db().prepare('DELETE FROM rooms WHERE id=?').bind(mm[1]),
        db().prepare('DELETE FROM l2_tasks WHERE thread_id=?').bind(`room_${mm[1]}`),
      ]);
      // memory cleanup: Mastra thread (messages) + Vectorize embeddings + summary
      const cleanup: Record<string, unknown> = {};
      try { const mem = await agent().getMemory?.(); await mem?.deleteThread(`room_${mm[1]}`); cleanup.thread = 'deleted'; } catch (e: any) { cleanup.thread = String(e?.message ?? e).slice(0, 120); }
      try { await db().prepare('DELETE FROM mastra_messages WHERE thread_id=?').bind(`room_${mm[1]}`).run(); } catch {}
      try { await ensureSummaryTable(db()); await db().prepare('DELETE FROM memory_summaries WHERE thread_id=?').bind(`room_${mm[1]}`).run(); } catch {}
      try { await vector?.()?.deleteVectors({ indexName: 'x', filter: { thread_id: `room_${mm[1]}` } }); cleanup.vectors = 'deleted'; } catch (e: any) { cleanup.vectors = String(e?.message ?? e).slice(0, 120); }
      return json({ ok: true, deleted: mm[1], cleanup });
    }
    mm = p.match(/^\/api\/rooms\/([\w-]+)\/leave$/);
    if (mm && m === 'POST') {
      const role = await roleIn(mm[1]);
      if (!role) return json({ error: 'not a member' }, 404);
      if (role === 'owner') return json({ error: '群主不能退出，请解散群或先转让' }, 400);
      await db().prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').bind(mm[1], user.id).run();
      return json({ ok: true });
    }
    mm = p.match(/^\/api\/rooms\/([\w-]+)\/members\/([\w-]+)$/);
    if (mm && (m === 'DELETE' || m === 'PATCH')) {
      const role = await roleIn(mm[1]);
      if (!role) return json({ error: 'not a member' }, 404);
      const target: any = await db().prepare('SELECT role FROM room_members WHERE room_id=? AND user_id=?').bind(mm[1], mm[2]).first();
      if (!target) return json({ error: 'member not found' }, 404);
      if (target.role === 'owner') return json({ error: 'cannot modify owner' }, 400);
      if (m === 'PATCH') {
        if (role !== 'owner') return json({ error: 'only owner can change roles' }, 403);
        const nr = String(body.role ?? '');
        if (nr !== 'admin' && nr !== 'member') return json({ error: 'role must be admin|member' }, 400);
        await db().prepare('UPDATE room_members SET role=? WHERE room_id=? AND user_id=?').bind(nr, mm[1], mm[2]).run();
        return json({ ok: true, role: nr });
      }
      if (role !== 'owner' && !(role === 'admin' && target.role === 'member')) return json({ error: 'forbidden' }, 403);
      await db().prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').bind(mm[1], mm[2]).run();
      return json({ ok: true });
    }
    mm = p.match(/^\/api\/rooms\/([\w-]+)\/invites\/([\w-]+)$/);
    if (mm && m === 'DELETE') {
      const role = await roleIn(mm[1]);
      if (role !== 'owner' && role !== 'admin') return json({ error: 'forbidden' }, 403);
      await db().prepare("UPDATE room_invites SET status='revoked' WHERE id=? AND room_id=? AND status='pending'").bind(mm[2], mm[1]).run();
      return json({ ok: true });
    }
    mm = p.match(/^\/api\/rooms\/([\w-]+)\/tasks$/);
    if (mm && m === 'GET') {
      if (!(await roleIn(mm[1]))) return json({ error: 'not a member' }, 403);
      const { results } = await db().prepare("SELECT task_id, expert_id, state, created_at, updated_at FROM l2_tasks WHERE thread_id=? AND expert_id IS NOT NULL AND expert_id<>'' ORDER BY created_at DESC LIMIT 20").bind(`room_${mm[1]}`).all().catch(() => ({ results: [] as any[] }));
      return json({ tasks: results });
    }

    mm = p.match(/^\/api\/rooms\/([\w-]+)\/invites$/);
    if (mm && m === 'POST') {
      const role = await roleIn(mm[1]);
      if (!role) return json({ error: 'not a member' }, 404);
      if (role !== 'owner' && role !== 'admin') return json({ error: 'forbidden' }, 403);
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return json({ error: 'email required' }, 400);
      const id = crypto.randomUUID();
      await db().prepare('INSERT INTO room_invites (id,room_id,email,invited_by,status,created_at) VALUES (?,?,?,?,?,?)').bind(id, mm[1], email, user.id, 'pending', now()).run();
      return json({ invite: { id, room_id: mm[1], email, status: 'pending' } }, 201);
    }

    if (p === '/api/agents' && m === 'GET') {
      const defs = await listAgentDefs(db(), user.id);
      return json({ agents: [...CATALOG, ...defs.map(d => ({ id: d.id, name: d.name, desc: `L2 · 自建 · ${d.description || ''}`, custom: true }))] });
    }

    mm = p.match(/^\/api\/rooms\/([\w-]+)\/agents(?:\/([\w-]+))?$/);
    if (mm && (m === 'POST' || m === 'DELETE')) {
      const role = await roleIn(mm[1]);
      if (!role) return json({ error: 'not a member' }, 404);
      if (role !== 'owner' && role !== 'admin') return json({ error: 'forbidden' }, 403);
      const agentId = m === 'POST' ? String(((await req.json().catch(() => ({}))) as any).agentId ?? '') : String(mm[2] ?? '');
      const okCustom = agentId.startsWith('ad-') && (await roomAgentDefs(db(), mm[1])).some(d => d.id === agentId);
      if (!CATALOG.some(a => a.id === agentId) && !okCustom && !(m === 'DELETE' && agentId.startsWith('ad-'))) return json({ error: 'unknown agent' }, 400);
      if (m === 'POST') await db().prepare('INSERT OR IGNORE INTO room_agents (room_id,agent_id,added_at) VALUES (?,?,?)').bind(mm[1], agentId, now()).run();
      else {
        if (agentId === 'orchestrator') return json({ error: 'cannot remove orchestrator' }, 400);
        await db().prepare('DELETE FROM room_agents WHERE room_id=? AND agent_id=?').bind(mm[1], agentId).run();
      }
      const { results } = await db().prepare('SELECT agent_id, added_at FROM room_agents WHERE room_id=? ORDER BY added_at').bind(mm[1]).all();
      return json({ ok: true, agents: results });
    }

    mm = p.match(/^\/api\/rooms\/([\w-]+)\/messages$/);
    if (mm && (m === 'POST' || m === 'GET')) {
      const roomId = mm[1];
      if (!(await roleIn(roomId))) return json({ error: 'not a member' }, 403);
      const thread = `room_${roomId}`;
      if (m === 'GET') {
        const mem = await agent().getMemory?.();
        const r = mem ? await mem.recall({ threadId: thread, resourceId: thread }).catch(() => ({ messages: [] })) : { messages: [] };
        return json({ thread, messages: (r.messages ?? []).map((x: any) => ({ role: x.role, content: x.content })) });
      }
      const text = String(body.text ?? '').trim().slice(0, 8000);
      if (!text) return json({ error: 'text required' }, 400);
      const wrapped = `<turn room="${roomId}" from_user="${user.id}" from_name="${esc(String(user.name || user.email))}">${esc(text)}</turn>`;
      const { results: ra } = await db().prepare('SELECT agent_id FROM room_agents WHERE room_id=?').bind(roomId).all();
      const inRoom = new Set((ra as any[]).map(r => r.agent_id));
      const butler = await loadButler();
      const rdefs = await roomAgentDefs(db(), roomId);
      const no = (id: string) => rdefs.find(d => d.id === id)?.name ?? nameOf(butler.name)(id);
      const alias = mentionAlias(butler.name);
      for (const d of rdefs) { alias[d.name] = d.id; alias[d.id] = d.id; }
      const { ids, unknown } = parseMentions(text, alias);
      const missing = ids.filter(i => !inRoom.has(i));
      let targets = ids.filter(i => inRoom.has(i));
      let errNote: string | undefined;
      if (missing.length || (unknown.length && !ids.length)) {
        const what = [...missing.map(no), ...unknown.map(u => '@' + u)].join('、');
        errNote = `${what} 不在本群的 agent 列表里，请群主先添加。`;
      }
      if (!targets.length && !errNote) targets = ['orchestrator'];
      // 权限：派发专家属于 execute 类；deny / ask(自动审核关闭) → 不派发，由管家说明
      const perm = await loadPermissions(db(), user.id);
      const ex = decide(perm, 'dispatch_to_expert');
      const wantExperts = targets.filter(t => t !== 'orchestrator');
      if (wantExperts.length && ex.effective !== 'allow' && !errNote) {
        errNote = ex.effective === 'deny'
          ? `你的权限设置禁止「执行」类操作，未派发 ${wantExperts.map(no).join('、')}。可在 设置 → 权限 中修改。`
          : `派发 ${wantExperts.map(no).join('、')} 需要你确认（自动审核已关闭）。请在 设置 → 权限 打开自动审核或将「执行」设为允许后重试。`;
        targets = targets.filter(t => t === 'orchestrator');
      }
      try {
        const isExpert = (id: string) => isExpertId(id) || rdefs.some(d => d.id === id);
        const { replies, dispatched } = await roomTurn(wrapped, thread, targets, no, {
          roomId, userId: user.id, userText: text, errNote, isExpert,
        });
        return json({
          thread, replies, dispatched,
          reply: replies.map(r => r.reply).join('\n\n'),
        });
      } catch (e: any) { return json({ thread, error: 'agent failed', detail: String(e?.message ?? e).slice(0, 200) }, 502); }
    }

    // ---------- 记忆：查看 / 清除（settings stub）----------
    if (p === '/api/memory' && (m === 'GET' || m === 'DELETE')) {
      await migrateDm(db(), user.id);
      const thread = dmThread(user.id), resource = dmResource(user.id);
      const mem = await agent().getMemory?.();
      if (m === 'GET') {
        const wm = await mem?.getWorkingMemory?.({ threadId: thread, resourceId: resource }).catch(() => null);
        const n = Number(((await db().prepare('SELECT COUNT(*) n FROM mastra_messages WHERE thread_id=?').bind(thread).first()) as any)?.n ?? 0);
        return json({ thread, resource, messages: n, workingMemory: wm ?? null, summary: await getSummary(db(), thread),
          semanticRecall: { embedder: '@cf/baai/bge-m3', index: 'mastra-l1-memory', scope: 'resource', stats: await vector?.()?.describeIndex({ indexName: 'x' }).catch((e: any) => ({ error: String(e?.message ?? e) })) },
          probe: url.searchParams.get('q') && vector ? await (async () => { const e: any = await (env as any).AI.run('@cf/baai/bge-m3', { text: [String(url.searchParams.get('q'))] }); const v = e.data[0]; const hits = await vector().query({ indexName: 'x', queryVector: v, topK: 3, filter: { resource_id: resource } }); return { dim: v.length, hits: hits.map((h: any) => ({ score: h.score, thread_id: h.metadata?.thread_id })) }; })().catch((e: any) => ({ error: String(e?.message ?? e).slice(0, 200) })) : undefined, workingMemoryScope: 'resource (DM only; rooms read-only, room resource=room thread)' });
      }
      const what = url.searchParams.get('what') ?? 'working';
      const done: string[] = [];
      if (what === 'working' || what === 'all') { await mem?.updateWorkingMemory?.({ threadId: thread, resourceId: resource, workingMemory: '' }).catch(() => null); await db().prepare('UPDATE mastra_resources SET workingMemory=NULL WHERE id=?').bind(resource).run().catch(() => null); done.push('working'); }
      if (what === 'history' || what === 'all') {
        await mem?.deleteThread?.(thread).catch(() => null);
        await db().prepare('DELETE FROM mastra_messages WHERE thread_id=?').bind(thread).run().catch(() => null);
        await ensureSummaryTable(db()); await db().prepare('DELETE FROM memory_summaries WHERE thread_id=?').bind(thread).run();
        await vector?.()?.deleteVectors({ indexName: 'x', filter: { resource_id: resource } }).catch(() => null);
        done.push('history', 'vectors', 'summary');
      }
      return json({ ok: true, cleared: done });
    }

    if (p === '/api/butler/messages' && m === 'GET') {
      await migrateDm(db(), user.id);
      const thread = dmThread(user.id);
      const mem = await agent().getMemory?.();
      const r = mem ? await mem.recall({ threadId: thread, resourceId: dmResource(user.id), perPage: 200 } as any).catch(() => ({ messages: [] })) : { messages: [] };
      return json({ thread, messages: (r.messages ?? []).map((x: any) => ({ role: x.role, content: x.content })) });
    }

    if (p === '/api/butler/messages' && m === 'POST') {
      const text = String(body.text ?? '').trim().slice(0, 8000);
      if (!text) return json({ error: 'text required' }, 400);
      await migrateDm(db(), user.id);
      const thread = dmThread(user.id);
      const butler = await loadButler();
      try {
        const g = await generate(text, thread, dmResource(user.id), user.id);
        if (summarize) { const job = maybeSummarize(db(), thread, summarize).catch((e: any) => console.log('[mem] summarize failed', String(e?.message ?? e).slice(0, 160))); schedule ? schedule(job) : await job; }
        return json({ thread, agentId: 'orchestrator', name: butler.name, reply: g.text, semanticHits: (generate as any).lastHits ?? 0, blockedTools: g.blocked, mcpInjected: g.injected });
      } catch (e: any) { return json({ thread, error: 'agent failed', detail: String(e?.message ?? e).slice(0, 200) }, 502); }
    }


    // ---------- 连接应用 (HTTP MCP + vault) ----------
    if (p === '/api/connections' && m === 'GET') {
      const conns = await resolveConnections(env, db(), user.id);
      const { results } = await db().prepare('SELECT server_id, config_json, created_at FROM user_mcp_connections WHERE user_id=? ORDER BY created_at').bind(user.id).all().catch(() => ({ results: [] }));
      const probe = url.searchParams.get('probe') === '1';
      const perm = await loadPermissions(db(), user.id);
      const connected = await Promise.all(conns.map(async c => {
        const row: any = (results as any[]).find(r => r.server_id === c.server_id) ?? {};
        let cfg: any = null; try { cfg = row.config_json ? JSON.parse(row.config_json) : null; } catch {}
        const pol = decide(perm, `mcp:${c.server_id}`, `mcp:${c.server_id}`);
        let tools: string[] | null = null; let status = c.problem ? 'needs_config' : 'ready'; let error = c.problem ?? null;
        if (probe && c.url) {
          try { tools = (await mcpListTools(c.url, c.headers)).tools.map(t => t.name); status = 'ok'; }
          catch (e: any) { status = 'error'; error = String(e?.message ?? e).slice(0, 160); }
        }
        return { server_id: c.server_id, label: c.label, transport: c.transport, url: c.url, vault_id: c.vault_id, config_json: cfg ? { ...cfg, url: cfg.url } : null,
          created_at: row.created_at, status, error, tools, policy: pol.policy, willInject: c.transport === 'http' && !c.problem && pol.effective === 'allow' };
      }));
      return json({ catalog: MCP_APP_CATALOG, connected, injectNote: '管家生成回复时，对 willInject=true 的 HTTP MCP 服务调用 tools/list 并以 toolsets 注入（权限 deny 的 MCP 不注入）；stdio MCP 只能在 L2 本机运行。' });
    }

    if (p === '/api/connections' && m === 'POST') {
      const server_id = String(body.server_id ?? body.serverId ?? '').trim();
      if (!MCP_APP_CATALOG.some(a => a.id === server_id)) return json({ error: 'unknown app' }, 400);
      const label = String(body.label ?? MCP_APP_CATALOG.find(a => a.id === server_id)?.name ?? server_id).slice(0, 64);
      const cfg = body.config ?? (body.config_json != null ? (() => { try { return JSON.parse(String(body.config_json)); } catch { return null; } })() : null);
      if (cfg?.url && !/^https:\/\//.test(String(cfg.url))) return json({ error: 'MCP url must be https://' }, 400);
      const config_json = cfg != null ? JSON.stringify(cfg) : null;
      const vault_id = body.vault_id ? String(body.vault_id) : null;
      if (vault_id && !(await db().prepare('SELECT id FROM vault_secrets WHERE id=? AND user_id=?').bind(vault_id, user.id).first())) return json({ error: 'vault entry not found' }, 400);
      const t = now();
      await db().prepare('INSERT INTO user_mcp_connections (user_id, server_id, label, config_json, created_at, vault_id) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, server_id) DO UPDATE SET label=excluded.label, config_json=excluded.config_json, vault_id=excluded.vault_id').bind(user.id, server_id, label, config_json, t, vault_id).run();
      return json({ ok: true, server_id, label, vault_id }, 201);
    }

    let cm = p.match(/^\/api\/connections\/([\w.-]+)$/);
    if (cm && m === 'DELETE') {
      const server_id = cm[1];
      // UI disconnect is a direct human action (permissions govern agent tool calls, not the user).
      await db().prepare('DELETE FROM user_mcp_connections WHERE user_id=? AND server_id=?').bind(user.id, server_id).run();
      return json({ ok: true, server_id });
    }

    // ---------- 电脑 / L2 device status (minimal) ----------
    if (p === '/api/device' && m === 'GET') {
      // Prefer Worker health fields when present; otherwise stub offline for Settings → 电脑.
      let queued: number | null = null;
      let pullMode = false;
      try {
        const row: any = await db().prepare("SELECT COUNT(*) AS n FROM l2_tasks WHERE state='queued'").first().catch(() => null);
        if (row && typeof row.n === 'number') { queued = row.n; pullMode = true; }
      } catch {}
      const online = pullMode; // L2 pull worker presence is not tracked yet; queued table ⇒ L1 pull mode ready
      return json({
        ok: true,
        l2: {
          online,
          status: online ? 'ready' : 'offline',
          label: online ? 'Bot 电脑 · 可认领任务' : 'Bot 电脑 · 离线（未检测到 L2 认领面）',
          pullMode,
          queued,
          note: '本地执行由本机 L2（claim + 真机 ACP / trycua CUA）完成；对用户不可见。设备在线探测仍为 MVP。',
        },
        devices: [
          { id: 'bot-computer', name: 'Bot 电脑', kind: 'bot', online, detail: online ? '可认领 L2 任务' : '离线' },
        ],
      });
    }

    return json({ error: 'not found' }, 404);
  };
}
