/**
 * User-facing routes mounted as a Mastra server middleware (custom apiRoutes can't use the /api prefix):
 *   /api/auth/*            Better Auth handler
 *   /api/dev/otp           dev-only OTP read (AUTH_DEV_MODE=1)
 *   /api/rooms…            self-built rooms (session required)
 *   /api/butler/messages   private butler DM (session required)
 *   /api/butler/profile    PATCH display_name (session required)
 *   /api/agents/:id/(generate|stream…)  now requires a session; DEV bypass: Bearer PUSH_TOKEN (L2 tests only)
 * Non-matching requests fall through to Mastra (L2 /l2-* and /a2a-callback untouched).
 */
import { timingSafeEqual } from 'node:crypto';
import { createAuth, devMode } from '../auth';

type Deps = { env: any; agent: () => any; agents: () => Record<string, any> };
export const CATALOG = [
  { id: 'orchestrator', name: '管家 Orchestrator', desc: '默认管家：闲聊、派发后台任务' },
  { id: 'researcher', name: '调研专家', desc: '调研/分析/归纳' },
  { id: 'coder', name: '工程师', desc: '编程/排错/技术方案' },
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
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function appMiddleware({ env, agent, agents }: Deps) {
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

  const generate = async (text: string, thread: string, resource: string) => {
    const res: any = await agent().generate(text, { memory: { thread, resource }, maxSteps: 3 } as any);
    return String(res?.text ?? '');
  };

  const dbMsg = (role: 'user' | 'assistant', text: string, thread: string) => ({
    id: crypto.randomUUID(), role, threadId: thread, resourceId: thread, createdAt: new Date(),
    content: { format: 2, parts: [{ type: 'text', text }], content: text },
  });
  /** Room turn: persist the user turn once, then each target agent reads the thread (readOnly) and its reply is saved as `[agent:id] …`. nameOf prefers session user's butler display_name for orchestrator. */
  const roomTurn = async (wrapped: string, thread: string, targets: string[], nameOf: (id: string) => string, errNote?: string) => {
    const mem = await agent().getMemory?.();
    await mem.saveMessages({ messages: [dbMsg('user', wrapped, thread)] });
    const replies: { agentId: string; name: string; reply: string }[] = [];
    if (errNote) {
      const reply = errNote;
      await mem.saveMessages({ messages: [dbMsg('assistant', `[agent:orchestrator] ${reply}`, thread)] });
      replies.push({ agentId: 'orchestrator', name: nameOf('orchestrator'), reply });
    }
    for (const id of targets) {
      const a = agents()[id]; if (!a) continue;
      const res: any = await a.generate(`（系统提示：现在轮到你「${nameOf(id)}」回复上面群聊里最新的人类发言；只以你自己的身份简短回复。）`,
        { memory: { thread, resource: thread, options: { readOnly: true } }, maxSteps: 3 } as any);
      const reply = String(res?.text ?? '').replace(/^\s*\[agent:[\w-]+\]\s*/, '').trim();
      await mem.saveMessages({ messages: [dbMsg('assistant', `[agent:${id}] ${reply}`, thread)] });
      replies.push({ agentId: id, name: nameOf(id), reply });
    }
    return replies;
  };

  return async (c: any, next: () => Promise<void>) => {
    const req: Request = c.req.raw;
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    if (p.startsWith('/api/auth/')) return getAuth().handler(req);

    const isAgentRun = /^\/api\/agents\/[^/]+\/(generate|stream)/.test(p) && m === 'POST';
    const ours = p.startsWith('/api/rooms') || p.startsWith('/api/butler') || p === '/api/me' || p === '/api/agents' || p === '/api/dev/otp';
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
      return { dm_thread_id: row?.dm_thread_id ?? `user:${user.id}`, display_name, name };
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
          .bind(user.id, `user:${user.id}`, now(), raw).run();
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
      const { results: agents } = await db().prepare('SELECT agent_id, added_at FROM room_agents WHERE room_id=? ORDER BY added_at').bind(roomId).all();
      let pendingInvites: any[] = [];
      if (role === 'owner' || role === 'admin') pendingInvites = (await db().prepare("SELECT id, email, status, created_at FROM room_invites WHERE room_id=? AND status='pending' ORDER BY created_at DESC").bind(roomId).all()).results;
      return json({ room: { ...room, role }, role, members, agents, pendingInvites });
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

    if (p === '/api/agents' && m === 'GET') return json({ agents: CATALOG });

    mm = p.match(/^\/api\/rooms\/([\w-]+)\/agents(?:\/([\w-]+))?$/);
    if (mm && (m === 'POST' || m === 'DELETE')) {
      const role = await roleIn(mm[1]);
      if (!role) return json({ error: 'not a member' }, 404);
      if (role !== 'owner' && role !== 'admin') return json({ error: 'forbidden' }, 403);
      const agentId = m === 'POST' ? String(((await req.json().catch(() => ({}))) as any).agentId ?? '') : String(mm[2] ?? '');
      if (!CATALOG.some(a => a.id === agentId)) return json({ error: 'unknown agent' }, 400);
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
      const no = nameOf(butler.name);
      const { ids, unknown } = parseMentions(text, mentionAlias(butler.name));
      const missing = ids.filter(i => !inRoom.has(i));
      let targets = ids.filter(i => inRoom.has(i));
      let errNote: string | undefined;
      if (missing.length || (unknown.length && !ids.length)) {
        const what = [...missing.map(no), ...unknown.map(u => '@' + u)].join('、');
        errNote = `${what} 不在本群的 agent 列表里，请群主先添加。`;
      }
      if (!targets.length && !errNote) targets = ['orchestrator'];
      try {
        const replies = await roomTurn(wrapped, thread, targets, no, errNote);
        return json({ thread, replies, reply: replies.map(r => r.reply).join('\n\n') });
      } catch (e: any) { return json({ thread, error: 'agent failed', detail: String(e?.message ?? e).slice(0, 200) }, 502); }
    }

    if (p === '/api/butler/messages' && m === 'GET') {
      const thread = `user:${user.id}`;
      const mem = await agent().getMemory?.();
      const r = mem ? await mem.recall({ threadId: thread, resourceId: thread }).catch(() => ({ messages: [] })) : { messages: [] };
      return json({ thread, messages: (r.messages ?? []).map((x: any) => ({ role: x.role, content: x.content })) });
    }

    if (p === '/api/butler/messages' && m === 'POST') {
      const text = String(body.text ?? '').trim().slice(0, 8000);
      if (!text) return json({ error: 'text required' }, 400);
      const thread = `user:${user.id}`;
      const butler = await loadButler();
      try {
        const reply = await generate(text, thread, thread);
        return json({ thread, agentId: 'orchestrator', name: butler.name, reply });
      } catch (e: any) { return json({ thread, error: 'agent failed', detail: String(e?.message ?? e).slice(0, 200) }, 502); }
    }

    return json({ error: 'not found' }, 404);
  };
}
