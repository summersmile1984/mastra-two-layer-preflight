/**
 * User-facing routes mounted as a Mastra server middleware (custom apiRoutes can't use the /api prefix):
 *   /api/auth/*            Better Auth handler
 *   /api/dev/otp           dev-only OTP read (AUTH_DEV_MODE=1)
 *   /api/rooms…            self-built rooms (session required)
 *   /api/butler/messages   private butler DM (session required)
 *   /api/agents/:id/(generate|stream…)  now requires a session; DEV bypass: Bearer PUSH_TOKEN (L2 tests only)
 * Non-matching requests fall through to Mastra (L2 /l2-* and /a2a-callback untouched).
 */
import { timingSafeEqual } from 'node:crypto';
import { createAuth, devMode } from '../auth';

type Deps = { env: any; agent: () => any };
const now = () => Date.now();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function appMiddleware({ env, agent }: Deps) {
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

  return async (c: any, next: () => Promise<void>) => {
    const req: Request = c.req.raw;
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    if (p.startsWith('/api/auth/')) return getAuth().handler(req);

    const isAgentRun = /^\/api\/agents\/[^/]+\/(generate|stream)/.test(p) && m === 'POST';
    const ours = p.startsWith('/api/rooms') || p.startsWith('/api/butler') || p === '/api/me' || p === '/api/dev/otp';
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
    const body: any = m === 'POST' ? await req.clone().json().catch(() => ({})) : {};

    if (p === '/api/me' && m === 'GET') {
      const bp = await db().prepare('SELECT dm_thread_id FROM butler_profile WHERE user_id=?').bind(user.id).first();
      return json({ user: { id: user.id, email: user.email, name: user.name }, butler: bp });
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
      try { return json({ thread, reply: await generate(wrapped, thread, thread) }); }
      catch (e: any) { return json({ thread, error: 'agent failed', detail: String(e?.message ?? e).slice(0, 200) }, 502); }
    }

    if (p === '/api/butler/messages' && m === 'POST') {
      const text = String(body.text ?? '').trim().slice(0, 8000);
      if (!text) return json({ error: 'text required' }, 400);
      const thread = `user:${user.id}`;
      try { return json({ thread, reply: await generate(text, thread, thread) }); }
      catch (e: any) { return json({ thread, error: 'agent failed', detail: String(e?.message ?? e).slice(0, 200) }, 502); }
    }

    return json({ error: 'not found' }, 404);
  };
}
