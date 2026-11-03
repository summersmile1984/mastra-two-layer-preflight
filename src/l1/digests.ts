/**
 * Dual-resource memory helpers:
 *  - room_digests: promote L2/room milestone conclusions into each member's user: resource view
 *  - force working-memory reconcile after every DM turn
 *  - room name/id resolution for recall_room / post_to_room
 */
export const roomThread = (rid: string) => `room_${rid}`;
export const roomResource = (rid: string) => `room:${rid}`;
export const dmThread = (uid: string) => `dm_${uid}`;
export const dmResource = (uid: string) => `user:${uid}`;

export async function ensureDigestsSchema(d: any) {
  await d.prepare(`CREATE TABLE IF NOT EXISTS room_digests (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, source TEXT NOT NULL,
    conclusion TEXT NOT NULL, evidence TEXT, open_questions TEXT, task_id TEXT, created_at INTEGER NOT NULL)`).run();
  await d.prepare('CREATE INDEX IF NOT EXISTS room_digests_user ON room_digests(user_id, created_at DESC)').run().catch(() => null);
  await d.prepare('CREATE INDEX IF NOT EXISTS room_digests_room ON room_digests(room_id, created_at DESC)').run().catch(() => null);
}

export type DigestInput = {
  roomId: string;
  conclusion: string;
  source?: string;
  evidence?: string | null;
  openQuestions?: string | null;
  taskId?: string | null;
  /** If set, only promote to these members; default = all current members */
  memberIds?: string[];
};

/** Promote a conclusion-only package into room_digests for each current member. Idempotent on task_id. */
export async function promoteRoomConclusion(d: any, input: DigestInput) {
  await ensureDigestsSchema(d);
  const conclusion = String(input.conclusion ?? '').trim().slice(0, 2000);
  if (!conclusion || !input.roomId) return { promoted: 0, skipped: 'empty' as const };
  if (input.taskId) {
    const exist: any = await d.prepare('SELECT id FROM room_digests WHERE task_id=? LIMIT 1').bind(input.taskId).first().catch(() => null);
    if (exist) return { promoted: 0, skipped: 'duplicate_task' as const };
  }
  let members = input.memberIds;
  if (!members) {
    const { results } = await d.prepare('SELECT user_id FROM room_members WHERE room_id=?').bind(input.roomId).all();
    members = (results as any[]).map(r => r.user_id);
  }
  const t = Date.now();
  let n = 0;
  for (const uid of members ?? []) {
    await d.prepare('INSERT INTO room_digests (id,room_id,user_id,source,conclusion,evidence,open_questions,task_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), input.roomId, uid, input.source ?? 'milestone', conclusion,
        input.evidence ?? null, input.openQuestions ?? null, input.taskId ?? null, t).run();
    n++;
  }
  return { promoted: n, skipped: null as null };
}

export async function listUserDigests(d: any, userId: string, limit = 8) {
  await ensureDigestsSchema(d);
  const { results } = await d.prepare(
    `SELECT d.id, d.room_id, d.conclusion, d.source, d.evidence, d.open_questions, d.created_at, r.name AS room_name
     FROM room_digests d LEFT JOIN rooms r ON r.id=d.room_id
     WHERE d.user_id=? ORDER BY d.created_at DESC LIMIT ?`).bind(userId, limit).all().catch(() => ({ results: [] }));
  return results as any[];
}

export function digestsContext(rows: any[]) {
  if (!rows?.length) return '';
  return `你参与的群聊近期结论摘要（跨群知情；勿把私聊内容回写到群）：\n` +
    rows.map(r => `- [${r.room_name || r.room_id}] ${String(r.conclusion).slice(0, 280)}${r.open_questions ? `｜未决：${String(r.open_questions).slice(0, 120)}` : ''}`).join('\n');
}

export async function deleteRoomDigests(d: any, roomId: string) {
  await ensureDigestsSchema(d);
  await d.prepare('DELETE FROM room_digests WHERE room_id=?').bind(roomId).run().catch(() => null);
}

/** Resolve room by id or name among the user's memberships. */
export async function resolveUserRoom(d: any, userId: string, roomIdOrName: string): Promise<
  | { ok: true; room: { id: string; name: string; thread_id: string } }
  | { ok: false; reason: string; candidates?: { id: string; name: string }[] }
> {
  const q = String(roomIdOrName ?? '').trim();
  if (!q) return { ok: false, reason: '请指定房间 id 或名称' };
  const { results } = await d.prepare(
    `SELECT r.id, r.name, r.thread_id FROM rooms r JOIN room_members rm ON rm.room_id=r.id WHERE rm.user_id=? ORDER BY r.created_at DESC`).bind(userId).all();
  const rooms = results as any[];
  if (!rooms.length) return { ok: false, reason: '你还没有加入任何群' };
  const byId = rooms.find(r => r.id === q || r.thread_id === q || r.thread_id === `room_${q}`);
  if (byId) return { ok: true, room: byId };
  const lower = q.toLowerCase();
  const exact = rooms.filter(r => String(r.name).toLowerCase() === lower);
  if (exact.length === 1) return { ok: true, room: exact[0] };
  if (exact.length > 1) return { ok: false, reason: '多个群同名，请用 room id', candidates: exact.map(r => ({ id: r.id, name: r.name })) };
  const partial = rooms.filter(r => String(r.name).toLowerCase().includes(lower));
  if (partial.length === 1) return { ok: true, room: partial[0] };
  if (partial.length > 1) return { ok: false, reason: `「${q}」匹配到多个群，请确认是哪一个`, candidates: partial.map(r => ({ id: r.id, name: r.name })) };
  return { ok: false, reason: `未找到名为「${q}」的群`, candidates: rooms.slice(0, 8).map(r => ({ id: r.id, name: r.name })) };
}

const SLOT_HINT = `输出一份完整的用户工作记忆 Markdown（覆盖旧版），只含这些槽位（无内容写「无」）：
## 姓名
## 所在地
## 关注项目
## 待办
## 偏好
## 过敏/忌讳
## 其他
不要解释，不要代码块。`;

/** Force-update resource-scoped working memory after every DM turn (not optional tool). */
export async function forceReconcileWorking(opts: {
  mem: any;
  threadId: string;
  resourceId: string;
  userText: string;
  assistantText: string;
  summarize: (prompt: string) => Promise<string>;
}) {
  if (!opts.resourceId.startsWith('user:')) return { ok: false, reason: 'not_user_resource' };
  const prev = String(await opts.mem?.getWorkingMemory?.({ threadId: opts.threadId, resourceId: opts.resourceId }).catch(() => '') ?? '');
  // Skip LLM if neither side looks like durable fact (keep cheap); still touch when prev empty and user stated identity-ish
  const blob = `${opts.userText}\n${opts.assistantText}`;
  const looksDurable = /我叫|我是|住在|在.{0,8}工作|过敏|喜欢|不喜欢|待办|记住|偏好|项目|目标|忌讳|我的名字/.test(blob)
    || /name|allergic|prefer|todo|remember|live in/i.test(blob)
    || !prev;
  if (!looksDurable && prev) {
    // Still rewrite with lightweight merge of "关注项目" from digests? Skip — no durable signal.
    return { ok: true, skipped: true as const, chars: prev.length };
  }
  const prompt = `${SLOT_HINT}\n\n已有记忆：\n${prev || '（空）'}\n\n本轮用户：\n${opts.userText.slice(0, 2000)}\n\n本轮助手：\n${opts.assistantText.slice(0, 1500)}`;
  const next = (await opts.summarize(prompt)).trim().slice(0, 6000);
  if (!next || next.length < 8) return { ok: false, reason: 'empty_reconcile' };
  await opts.mem.updateWorkingMemory({ threadId: opts.threadId, resourceId: opts.resourceId, workingMemory: next });
  return { ok: true, skipped: false as const, chars: next.length };
}

/** Turn L2 result text into a short conclusion package (no process dump). */
export function conclusionOnly(text: string, max = 900) {
  const t = String(text ?? '').replace(/\r/g, '').trim();
  if (!t) return '';
  // Prefer bullet-ish lines; else first paragraphs
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  const bullets = lines.filter(l => /^[-*•\d.、]/.test(l) || l.length < 160).slice(0, 8);
  const body = (bullets.length >= 2 ? bullets.join('\n') : lines.slice(0, 6).join('\n')).slice(0, max);
  return body;
}

export function roomIdFromThread(thread: string): string | null {
  const m = String(thread).match(/^room_(.+)$/);
  return m ? m[1] : null;
}
