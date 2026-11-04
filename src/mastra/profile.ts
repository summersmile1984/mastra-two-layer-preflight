// 主人画像平面（observational-memory spec S2.3）：Extractor 抽取的稳定信息按发言者归集到
// om_profiles（多用户共享房间下 working memory 会按房间归集，承载不了「主人画像」），注入回上下文。
export type ProfilePayload = {
  name?: string;
  preferredName?: string;
  timezone?: string;
  preferences?: string[];
  ongoing?: string[];
  facts?: string[];
};

export async function ensureProfileTable(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS om_profiles (
        user_id TEXT PRIMARY KEY,
        email TEXT,
        name TEXT,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    )
    .run();
}

function uniqStrings(xs: unknown, cap = 12): string[] {
  if (!Array.isArray(xs)) return [];
  const out: string[] = [];
  for (const x of xs) {
    const s = String(x ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

export function mergePayload(prev: ProfilePayload | null, next: ProfilePayload): ProfilePayload {
  const p = prev ?? {};
  return {
    name: next.name ?? p.name,
    preferredName: next.preferredName ?? p.preferredName,
    timezone: next.timezone ?? p.timezone,
    preferences: uniqStrings([...(p.preferences ?? []), ...(next.preferences ?? [])]),
    ongoing: uniqStrings([...(p.ongoing ?? []), ...(next.ongoing ?? [])]),
    facts: uniqStrings([...(p.facts ?? []), ...(next.facts ?? [])]),
  };
}

export async function upsertProfile(
  db: any,
  row: { userId: string; email?: string | null; name?: string | null; payload: ProfilePayload },
): Promise<void> {
  const prevRow = await db.prepare('SELECT payload FROM om_profiles WHERE user_id=?').bind(row.userId).first();
  let prev: ProfilePayload | null = null;
  try {
    prev = prevRow ? JSON.parse(String((prevRow as any).payload)) : null;
  } catch {}
  const merged = mergePayload(prev, row.payload);
  await db
    .prepare(
      `INSERT INTO om_profiles (user_id, email, name, payload, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET email=COALESCE(excluded.email, om_profiles.email),
         name=COALESCE(excluded.name, om_profiles.name), payload=excluded.payload, updated_at=excluded.updated_at`,
    )
    .bind(row.userId, row.email ?? null, row.name ?? null, JSON.stringify(merged), Date.now())
    .run();
}

/** 按显示名找用户（Extractor 只能从消息里的【名字】识别发言者）。 */
export async function resolveUserByName(db: any, name: string): Promise<{ id: string; email: string; name: string } | null> {
  const n = String(name ?? '').trim();
  if (!n) return null;
  const row = await db.prepare('SELECT id, email, name FROM "user" WHERE name=? LIMIT 1').bind(n).first();
  return row ? ({ id: (row as any).id, email: (row as any).email, name: (row as any).name } as any) : null;
}

/** 读出房间成员的画像，拼成紧凑注入块（没有画像返回空串）。 */
export async function loadRoomProfileBlock(db: any, roomId: string): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT u.name AS name, u.email AS email, p.payload AS payload FROM room_members m
       JOIN "user" u ON u.id = m.user_id
       LEFT JOIN om_profiles p ON p.user_id = m.user_id
       WHERE m.room_id = ?`,
    )
    .bind(roomId)
    .all();
  const lines: string[] = [];
  for (const r of results ?? []) {
    if (!(r as any).payload) continue;
    let p: ProfilePayload = {};
    try {
      p = JSON.parse(String((r as any).payload));
    } catch {
      continue;
    }
    const bits: string[] = [];
    if (p.preferredName || p.name) bits.push(`称呼：${p.preferredName ?? p.name}`);
    if (p.timezone) bits.push(`时区：${p.timezone}`);
    if (p.preferences?.length) bits.push(`偏好：${p.preferences.join('；')}`);
    if (p.ongoing?.length) bits.push(`在做：${p.ongoing.join('；')}`);
    if (p.facts?.length) bits.push(`事实：${p.facts.join('；')}`);
    if (bits.length) lines.push(`- ${(r as any).name ?? (r as any).email}：${bits.join('｜')}`);
  }
  if (!lines.length) return '';
  return `【成员画像（你们之前聊到过，回复时自然体现，不要照念）】\n${lines.join('\n')}`;
}
