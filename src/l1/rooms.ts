/**
 * 多用户共享房间 + 聊天消息路由（挂在 CF Worker / Mastra L1）。
 * - 鉴权：requireSession（better-auth cookie 或 DEV 旁路）
 * - 归属：rooms + room_members；/api/rooms/* 全部校验成员身份
 * - 聊天：POST /api/rooms/:id/messages 直接调 orchestrator.stream（memory: thread=room.id）
 *   返回 SSE 文本增量，流结束后把 assistant 消息写回 messages（房间内所有成员可见）
 * - 同步：GET /api/rooms/:id/messages?after= 轮询，返回 {messages, busy}
 */
import { requireSession, AuthError, getAuth, type AuthEnv } from '../auth';

export type RoomEnv = AuthEnv & { DB: any };

/** 可注入的聊天执行器（生产为 Mastra orchestrator，测试用假实现）。 */
export type ChatRunner = {
  stream: (messages: any[], opts: any) => Promise<{ textStream: ReadableStream<string> }>;
};

export type RoomDeps = { E: RoomEnv; chat: ChatRunner; notifyRoom?: (roomId: string, evt: { kind: 'message' | 'busy'; messageId?: string }) => Promise<void> };

const now = () => Date.now();
const rid = (p: string) => `${p}-${crypto.randomUUID()}`;

// ---------- D1 帮手 ----------

async function isMember(d: any, roomId: string, userId: string): Promise<{ ok: boolean; role?: string }> {
  const row: any = await d
    .prepare('SELECT role FROM room_members WHERE room_id=? AND user_id=?')
    .bind(roomId, userId)
    .first();
  return row ? { ok: true, role: row.role } : { ok: false };
}

async function touchRead(d: any, roomId: string, userId: string) {
  await d.prepare('UPDATE room_members SET last_read_at=? WHERE room_id=? AND user_id=?').bind(now(), roomId, userId).run();
}

// ---------- SSE ----------

function sseFromStream(textStream: ReadableStream<string>, onFinish: (full: string) => Promise<void>): ReadableStream {
  const enc = new TextEncoder();
  let full = '';
  const reader = textStream.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        try {
          await onFinish(full);
        } catch (e: any) {
          console.log('[rooms] persist assistant failed', String(e?.message ?? e).slice(0, 120));
        }
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'done', text: full })}\n\n`));
        controller.close();
        return;
      }
      full += value;
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'delta', text: value })}\n\n`));
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {}
    },
  });
}

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

// ---------- 路由处理器 ----------

// 房间列表
async function listRooms(c: any, E: RoomEnv) {
  const user = await requireSession(c.req.raw ?? { headers: c.req.headers }, E);
  const { results } = await E.DB.prepare(
    `SELECT r.id, r.name, r.created_by, r.updated_at, m.role, m.last_read_at,
            (SELECT content FROM messages WHERE room_id=r.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM messages WHERE room_id=r.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
     FROM rooms r JOIN room_members m ON m.room_id=r.id
     WHERE m.user_id=? ORDER BY COALESCE((SELECT created_at FROM messages WHERE room_id=r.id ORDER BY created_at DESC LIMIT 1), r.updated_at) DESC`,
  )
    .bind(user.id)
    .all();
  return c.json({ rooms: results ?? [] });
}

// 新建房间
async function createRoom(c: any, E: RoomEnv) {
  const user = await requireSession(c.req.raw ?? { headers: c.req.headers }, E);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body?.name ?? '').trim().slice(0, 80) || '新房间';
  const id = rid('room');
  const t = now();
  await E.DB.prepare('INSERT INTO rooms (id,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?)').bind(id, name, user.id, t, t).run();
  await E.DB.prepare('INSERT INTO room_members (room_id,user_id,role,joined_at,last_read_at) VALUES (?,?,?,?,?)').bind(id, user.id, 'owner', t, t).run();
  return c.json({ room: { id, name, created_by: user.id, updated_at: t } });
}

// 房间详情 + 成员
async function getRoom(c: any, E: RoomEnv) {
  const user = await requireSession(c.req.raw ?? { headers: c.req.headers }, E);
  const roomId = c.req.param('id');
  const m = await isMember(E.DB, roomId, user.id);
  if (!m.ok) throw new AuthError(403, 'not a member');
  const room: any = await E.DB.prepare('SELECT id,name,created_by,updated_at FROM rooms WHERE id=?').bind(roomId).first();
  if (!room) throw new AuthError(404, 'no room');
  const { results: members } = await E.DB.prepare(
    'SELECT m.user_id, m.role, m.joined_at, u.name, u.email FROM room_members m JOIN "user" u ON u.id=m.user_id WHERE m.room_id=?',
  )
    .bind(roomId)
    .all();
  return c.json({ room, members: members ?? [] });
}

// 加成员（owner）
async function addMember(c: any, E: RoomEnv) {
  const user = await requireSession(c.req.raw ?? { headers: c.req.headers }, E);
  const roomId = c.req.param('id');
  const m = await isMember(E.DB, roomId, user.id);
  if (!m.ok) throw new AuthError(403, 'not a member');
  const body = await c.req.json().catch(() => ({}));
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!email) throw new AuthError(400, 'email required');
  const target: any = await E.DB.prepare('SELECT id FROM "user" WHERE email=?').bind(email).first();
  if (!target) throw new AuthError(404, 'user not found');
  await E.DB.prepare('INSERT OR IGNORE INTO room_members (room_id,user_id,role,joined_at,last_read_at) VALUES (?,?,?,?,0)')
    .bind(roomId, target.id, 'member', now())
    .run();
  return c.json({ ok: true, userId: target.id });
}

// 消息列表（轮询）
async function listMessages(c: any, E: RoomEnv) {
  const user = await requireSession(c.req.raw ?? { headers: c.req.headers }, E);
  const roomId = c.req.param('id');
  const m = await isMember(E.DB, roomId, user.id);
  if (!m.ok) throw new AuthError(403, 'not a member');
  const after = String(c.req.query('after') ?? '');
  let afterTs = 0;
  if (after) {
    const row: any = await E.DB.prepare('SELECT created_at FROM messages WHERE id=?').bind(after).first();
    afterTs = row ? Number(row.created_at) : 0;
  }
  const { results } = await E.DB.prepare(
    `SELECT id, user_id, role, content, created_at FROM messages WHERE room_id=? AND created_at>? ORDER BY created_at ASC LIMIT 200`,
  )
    .bind(roomId, afterTs)
    .all();
  // busy 标志来自 l2_tasks（由 mastra db() 惰性建）；表可能尚未创建，降级为非 busy
  let busy = false;
  try {
    const b: any = await E.DB.prepare(
      "SELECT COUNT(*) n FROM l2_tasks WHERE thread_id=? AND state NOT IN ('completed','failed','canceled','rejected')",
    )
      .bind(roomId)
      .first();
    busy = Number(b?.n ?? 0) > 0;
  } catch {
    busy = false;
  }
  await touchRead(E.DB, roomId, user.id);
  return c.json({ messages: results ?? [], busy });
}

// 发消息 + 流式回复
async function sendMessage(c: any, E: RoomEnv, chat: ChatRunner, notifyRoom?: RoomDeps['notifyRoom']) {
  const user = await requireSession(c.req.raw ?? { headers: c.req.headers }, E);
  const roomId = c.req.param('id');
  const m = await isMember(E.DB, roomId, user.id);
  if (!m.ok) throw new AuthError(403, 'not a member');
  const body = await c.req.json().catch(() => ({}));
  const text = String(body?.text ?? '').trim().slice(0, 8000);
  if (!text) throw new AuthError(400, 'text required');

  // 写用户消息（干净文本 + 归属）
  const userMsgId = rid('msg');
  await E.DB.prepare('INSERT INTO messages (id,room_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)')
    .bind(userMsgId, roomId, user.id, 'user', text, now())
    .run();
  await E.DB.prepare('UPDATE rooms SET updated_at=? WHERE id=?').bind(now(), roomId).run();
  await touchRead(E.DB, roomId, user.id);
  try { await notifyRoom?.(roomId, { kind: 'message', messageId: userMsgId }); } catch {}

  // L1 上下文带发言者名（共享房间里“帮我看下”要知道是谁）
  const who = user.name || user.email || '用户';
  const out = await chat.stream([{ role: 'user', content: `【${who}】${text}` }], {
    memory: { thread: roomId, resource: `room:${roomId}` },
    maxSteps: 4,
  });

  const persistAssistant = async (full: string) => {
    const content = full.trim() || '（空回复）';
    const asstId = rid('msg');
    await E.DB.prepare('INSERT INTO messages (id,room_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)')
      .bind(asstId, roomId, null, 'assistant', content, now())
      .run();
    await E.DB.prepare('UPDATE rooms SET updated_at=? WHERE id=?').bind(now(), roomId).run();
    await touchRead(E.DB, roomId, user.id);
    try { await notifyRoom?.(roomId, { kind: 'message', messageId: asstId }); } catch {}
  };

  return sseResponse(sseFromStream(out.textStream, persistAssistant));
}

// ---------- 路由表 ----------

/** WS 升级：鉴权 + 成员校验后转 RoomDO（S2.2 / T2）。无会话 401、非成员 403、未绑 DO 503。 */
async function upgradeWs(c: any, E: RoomEnv): Promise<Response> {
  const user = await requireSession(c.req.raw ?? { headers: c.req.headers }, E);
  const roomId = c.req.param('id');
  const m = await isMember(E.DB, roomId, user.id);
  if (!m.ok) throw new AuthError(403, 'not a member');
  const stub = (E as any).ROOM_DO?.getByName?.(roomId);
  if (!stub) throw new AuthError(503, 'realtime not available');
  // 升级请求（含 Upgrade 头）原样转给 DO，由 DO acceptWebSocket 接管
  return stub.fetch(c.req.raw ?? new Request(`http://do/${roomId}/ws`));
}

/** 生成 rooms/messages 的 registerApiRoute 描述数组（不含 auth catch-all）。 */
export function roomHandlers(deps: RoomDeps) {
  const { E, chat, notifyRoom } = deps;
  // 把处理器包一层：抛 AuthError/其它错误时转成 HTTP 响应，避免裸抛
  const wrap = (fn: (c: any) => Promise<Response>) => async (c: any) => {
    try {
      return await fn(c);
    } catch (e) {
      return errorResponse(e);
    }
  };
  return [
    { path: '/rooms', method: 'GET' as const, requiresAuth: false, handler: wrap((c) => listRooms(c, E)) },
    { path: '/rooms', method: 'POST' as const, requiresAuth: false, handler: wrap((c) => createRoom(c, E)) },
    { path: '/rooms/:id', method: 'GET' as const, requiresAuth: false, handler: wrap((c) => getRoom(c, E)) },
    { path: '/rooms/:id/members', method: 'POST' as const, requiresAuth: false, handler: wrap((c) => addMember(c, E)) },
    { path: '/rooms/:id/messages', method: 'GET' as const, requiresAuth: false, handler: wrap((c) => listMessages(c, E)) },
    { path: '/rooms/:id/messages', method: 'POST' as const, requiresAuth: false, handler: wrap((c) => sendMessage(c, E, chat, notifyRoom)) },
    { path: '/rooms/:id/ws', method: 'GET' as const, requiresAuth: false, handler: wrap((c) => upgradeWs(c, E)) },
    // better-auth catch-all
    {
      path: '/auth/*',
      method: 'ALL' as const,
      requiresAuth: false,
      handler: async (c: any) => {
        const req: Request = c.req.raw ?? c.req;
        return getAuth(E).handler(req);
      },
    },
  ];
}

/** 统一错误 → HTTP 响应（供 index.ts 的包装器用）。 */
export function errorResponse(e: any): Response {
  if (e instanceof AuthError) return new Response(JSON.stringify({ error: e.message }), { status: e.status, headers: { 'content-type': 'application/json' } });
  console.log('[rooms] handler error', String(e?.message ?? e).slice(0, 160));
  return new Response(JSON.stringify({ error: 'internal' }), { status: 500, headers: { 'content-type': 'application/json' } });
}
