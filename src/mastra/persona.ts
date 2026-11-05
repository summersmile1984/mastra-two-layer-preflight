// 人格配置（persona-main-session spec S2.2）：人格是数据不是代码——name/role/style/main_room_name 存 D1，
// 出厂种子只是默认值；装配 = 固定安全基座（index.ts 的 INSTRUCTIONS）+ 本模块读出的人格块 + 语调路由。
export type PersonaConfig = {
  name: string;
  role: string;
  style: string;
  main_room_name: string;
  updated_at: number;
  updated_by: string | null;
};

const SEED: Omit<PersonaConfig, 'updated_at' | 'updated_by'> = {
  name: '我的秘书',
  role: '24 小时贴身秘书、管家与伴侣',
  style: '温和、可靠、尽责；记得主人的信息与偏好并自然引用（不要背诵）；「我来处理」式的担当，偶尔一句体己话；说中文，句子短。',
  main_room_name: '我的秘书',
};

const LIMITS = { name: 200, role: 500, style: 1000, main_room_name: 50 };

export async function ensurePersonaConfig(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS persona_config (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, style TEXT NOT NULL,
        main_room_name TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO persona_config (id, name, role, style, main_room_name, updated_at, updated_by)
       SELECT 1, ?, ?, ?, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM persona_config WHERE id = 1)`,
    )
    .bind(SEED.name, SEED.role, SEED.style, SEED.main_room_name, Date.now())
    .run();
}

let cache: { persona: PersonaConfig; at: number } | null = null;
const CACHE_MS = 30_000;

export async function getPersona(db: any, force = false): Promise<PersonaConfig> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.persona;
  let row: any = null;
  try {
    row = await db.prepare('SELECT * FROM persona_config WHERE id = 1').first();
  } catch {}
  if (!row) {
    await ensurePersonaConfig(db);
    row = await db.prepare('SELECT * FROM persona_config WHERE id = 1').first();
  }
  const persona: PersonaConfig = {
    name: String(row?.name ?? SEED.name),
    role: String(row?.role ?? SEED.role),
    style: String(row?.style ?? SEED.style),
    main_room_name: String(row?.main_room_name ?? SEED.main_room_name),
    updated_at: Number(row?.updated_at ?? 0),
    updated_by: row?.updated_by ? String(row.updated_by) : null,
  };
  cache = { persona, at: Date.now() };
  return persona;
}

function clip(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().slice(0, max);
  return s || undefined;
}

export async function updatePersona(db: any, patch: Record<string, unknown>, updatedBy: string): Promise<PersonaConfig> {
  const next = {
    name: clip(patch.name, LIMITS.name),
    role: clip(patch.role, LIMITS.role),
    style: clip(patch.style, LIMITS.style),
    main_room_name: clip(patch.main_room_name, LIMITS.main_room_name),
  };
  const fields: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(next)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      args.push(v);
    }
  }
  if (fields.length) {
    args.push(Date.now(), updatedBy);
    await db.prepare(`UPDATE persona_config SET ${fields.join(', ')}, updated_at = ?, updated_by = ? WHERE id = 1`).bind(...args).run();
  }
  return getPersona(db, true);
}

/** 装配进上下文的人格块（S2.2/S2.3）。 */
export function personaBlock(p: PersonaConfig): string {
  return `【你的身份】你是${p.name}，${p.role}。${p.style}`;
}
