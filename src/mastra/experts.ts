// L2 专家目录（l2-experts spec S2.2）：agent_defs 存 D1——专家定义是数据（指令/模型可改），
// 执行位是 L2（用户 PC/云电脑）的 Mastra Agent，L1 只做目录管理与派发。
export type ExpertDef = {
  id: string;
  owner_user_id: string;
  name: string;
  description: string;
  instructions: string;
  model: string | null;
  tools_json: string | null;
  mcp_json: string | null;
  skills_json: string | null;
  memory_json: string | null;
  created_at: number;
  updated_at: number;
};

const LIMITS = { name: 100, description: 500, instructions: 4000, model: 100 };

// 出厂种子（默认值，可在 agent_defs 里改）
const SEED_EXPERTS: Array<{ id: string; name: string; description: string; instructions: string }> = [
  {
    id: 'researcher',
    name: '调研专家',
    description: '调研、对比分析、归纳要点；适合资料梳理与结论提炼。',
    instructions: `你是「调研专家」。擅长资料梳理、对比分析、归纳要点。回复简短、用中文；给出结构化要点。你在线程记忆里能看到同一房间/主题的过往任务——保持连续，但不要越界到其它线程。`,
  },
  {
    id: 'coder',
    name: '工程师',
    description: '编程、排错、技术方案；给最小可用示例。',
    instructions: `你是「工程师」。擅长写代码、排查 bug、解释技术方案；代码给最小可用示例。回复简短、用中文。你在线程记忆里能看到同一房间/主题的过往任务——保持连续，但不要越界到其它线程。`,
  },
];

export async function ensureAgentDefs(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS agent_defs (
        id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        instructions TEXT NOT NULL, model TEXT, tools_json TEXT, mcp_json TEXT, skills_json TEXT, memory_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    )
    .run();
  // 旧库补列（expert-forge S2.1）
  await db.prepare('ALTER TABLE agent_defs ADD COLUMN skills_json TEXT').run().catch(() => null);
  for (const e of SEED_EXPERTS) {
    await db
      .prepare(
        `INSERT INTO agent_defs (id, owner_user_id, name, description, instructions, model, tools_json, mcp_json, memory_json, created_at, updated_at)
         SELECT ?, 'system', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM agent_defs WHERE id = ?)`,
      )
      .bind(e.id, e.name, e.description, e.instructions, Date.now(), Date.now(), e.id)
      .run();
  }
}

export function expertOut(r: any) {
  if (!r) return null;
  const parse = (v: unknown) => {
    if (v == null) return null;
    try { return JSON.parse(String(v)); } catch { return null; }
  };
  return {
    id: r.id, name: r.name, description: r.description, instructions: r.instructions,
    model: r.model ?? null, owner_user_id: r.owner_user_id, updated_at: r.updated_at,
    tools_json: parse(r.tools_json), mcp_json: parse(r.mcp_json), skills_json: parse(r.skills_json), memory_json: parse(r.memory_json),
  };
}

const LIMITS_JSON = 8000;
/** 归一化 JSON 配置字段：对象/数组序列化；非法或超长直接抛错（评审 MAJOR：静默置 null 会丢配置）。 */
function jsonField(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length > LIMITS_JSON) throw new Error(`json field too large (>${LIMITS_JSON})`);
  try { JSON.parse(s); } catch { throw new Error('json field invalid'); }
  return s;
}

export async function listExperts(db: any, userId?: string): Promise<ExpertDef[]> {
  // owner 范围（评审 CRITICAL）：本人 + 出厂种子（'system' 共享）；不传 userId 时给全量（L1 工具视角）
  const { results } = userId
    ? await db.prepare('SELECT * FROM agent_defs WHERE owner_user_id IN (?, ?) ORDER BY created_at ASC').bind(userId, 'system').all()
    : await db.prepare('SELECT * FROM agent_defs ORDER BY created_at ASC').all();
  return (results ?? []) as ExpertDef[];
}

/** 按 id 或 name 解析专家（派发用）。 */
export async function resolveExpert(db: any, key: string): Promise<ExpertDef | null> {
  const k = String(key ?? '').trim();
  if (!k) return null;
  const row: any = await db.prepare('SELECT * FROM agent_defs WHERE id = ? OR name = ? LIMIT 1').bind(k, k).first();
  return (row as ExpertDef) ?? null;
}

export async function createExpert(db: any, ownerUserId: string, input: any): Promise<ExpertDef | { error: string }> {
  const name = String(input?.name ?? '').trim().slice(0, LIMITS.name);
  const instructions = String(input?.instructions ?? '').trim();
  if (!name) return { error: 'name required' };
  if (!instructions) return { error: 'instructions required' };
  const id = String(input?.id ?? '').trim().replace(/[^\w-]/g, '').slice(0, 40) || `exp-${crypto.randomUUID().slice(0, 8)}`;
  const dup: any = await db.prepare('SELECT id FROM agent_defs WHERE id = ?').bind(id).first();
  if (dup) return { error: `id already exists: ${id}` };
  const row: ExpertDef = {
    id, owner_user_id: ownerUserId, name,
    description: String(input?.description ?? '').trim().slice(0, LIMITS.description),
    instructions: instructions.slice(0, LIMITS.instructions),
    model: input?.model ? String(input.model).slice(0, LIMITS.model) : null,
    tools_json: jsonField(input?.tools_json), mcp_json: jsonField(input?.mcp_json),
    skills_json: jsonField(input?.skills_json), memory_json: jsonField(input?.memory_json),
    created_at: Date.now(), updated_at: Date.now(),
  };
  await db
    .prepare('INSERT INTO agent_defs (id,owner_user_id,name,description,instructions,model,tools_json,mcp_json,skills_json,memory_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(row.id, row.owner_user_id, row.name, row.description, row.instructions, row.model, row.tools_json, row.mcp_json, row.skills_json, row.memory_json, row.created_at, row.updated_at)
    .run();
  return row;
}

export async function updateExpert(db: any, id: string, input: any, userId: string): Promise<ExpertDef | null | { error: string }> {
  const cur: any = await db.prepare('SELECT * FROM agent_defs WHERE id = ? AND owner_user_id IN (?, ?)').bind(id, userId, 'system').first();
  if (!cur) return null;
  if (input?.name !== undefined && !String(input.name).trim()) return { error: 'name required' };
  const fields: string[] = [];
  const args: unknown[] = [];
  const put = (col: string, v: unknown, max: number) => {
    if (v === undefined || v === null) return;
    fields.push(`${col} = ?`);
    args.push(String(v).trim().slice(0, max));
  };
  put('name', input?.name, LIMITS.name);
  put('description', input?.description, LIMITS.description);
  put('instructions', input?.instructions, LIMITS.instructions);
  put('model', input?.model, LIMITS.model);
  for (const col of ['tools_json', 'mcp_json', 'skills_json', 'memory_json'] as const) {
    if (input?.[col] === undefined) continue;
    fields.push(`${col} = ?`);
    args.push(jsonField(input[col]));
  }
  if (fields.length) {
    args.push(Date.now(), id);
    await db.prepare(`UPDATE agent_defs SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).bind(...args).run();
  }
  return (await db.prepare('SELECT * FROM agent_defs WHERE id = ?').bind(id).first()) as ExpertDef;
}

export async function deleteExpert(db: any, id: string, userId: string): Promise<boolean> {
  // 只删本人的自定义专家；出厂种子（'system'）共享可改不可删
  const u = await db.prepare('DELETE FROM agent_defs WHERE id = ? AND owner_user_id = ?').bind(id, userId).run();
  return Number(u?.meta?.changes ?? 0) > 0;
}

// ---------- 专家工坊（expert-forge S2.2/S2.3）：草案校验 + 落库 ----------
export type AgentDefDraft = {
  id?: string;
  name: string;
  description?: string;
  instructions: string;
  model?: string | null;
  tools_json?: unknown;
  mcp_json?: unknown;
  skills_json?: unknown;
  memory_json?: unknown;
  overwrite?: boolean;
  rationale?: string;
};

/** 落库前硬校验：字段上限 + 结构合法性（mcp 仅 url/command 族，无任意代码）。 */
export function validateExpertDef(d: any): { ok: true } | { ok: false; error: string } {
  const name = String(d?.name ?? '').trim();
  const instructions = String(d?.instructions ?? '').trim();
  if (!name) return { ok: false, error: 'name required' };
  if (name.length > LIMITS.name) return { ok: false, error: `name 超长（>${LIMITS.name}）` };
  if (!instructions) return { ok: false, error: 'instructions required' };
  if (instructions.length > LIMITS.instructions) return { ok: false, error: `instructions 超长（>${LIMITS.instructions}）` };
  if (d?.description && String(d.description).length > LIMITS.description) return { ok: false, error: `description 超长（>${LIMITS.description}）` };
  if (d?.model && String(d.model).length > LIMITS.model) return { ok: false, error: `model 超长（>${LIMITS.model}）` };
  const tools = d?.tools_json;
  if (tools != null && tools !== '') {
    let list: any;
    try { list = typeof tools === 'string' ? JSON.parse(tools) : tools; } catch { return { ok: false, error: 'tools_json 非法 JSON' }; }
    if (String(typeof tools === 'string' ? tools : JSON.stringify(tools)).length > LIMITS_JSON) return { ok: false, error: `tools_json 超长（>${LIMITS_JSON}）` };
    if (!Array.isArray(list)) return { ok: false, error: 'tools_json 须为数组' };
    for (const t of list) {
      const id = typeof t === 'string' ? t : t?.id;
      if (typeof id !== 'string' || !id) return { ok: false, error: 'tools_json 条目须为字符串或 {id}' };
    }
  }
  const skills = d?.skills_json;
  if (skills != null && skills !== '') {
    let list: any;
    try { list = typeof skills === 'string' ? JSON.parse(skills) : skills; } catch { return { ok: false, error: 'skills_json 非法 JSON' }; }
    if (String(typeof skills === 'string' ? skills : JSON.stringify(skills)).length > LIMITS_JSON) return { ok: false, error: `skills_json 超长（>${LIMITS_JSON}）` };
    if (!Array.isArray(list)) return { ok: false, error: 'skills_json 须为数组' };
    for (const s of list) {
      if (!s || typeof s.name !== 'string' || typeof s.instructions !== 'string') {
        return { ok: false, error: 'skills_json 条目须含 name/instructions' };
      }
    }
  }
  const mcp = d?.mcp_json;
  if (mcp != null && mcp !== '') {
    let cfg: any = mcp;
    if (typeof mcp === 'string') { try { cfg = JSON.parse(mcp); } catch { return { ok: false, error: 'mcp_json 非法 JSON' }; } }
    if (String(typeof mcp === 'string' ? mcp : JSON.stringify(mcp)).length > LIMITS_JSON) return { ok: false, error: `mcp_json 超长（>${LIMITS_JSON}）` };
    if (typeof cfg !== 'object' || !cfg.servers || typeof cfg.servers !== 'object') return { ok: false, error: 'mcp_json 须含 servers' };
    const allowed = new Set(['url', 'command', 'args', 'env', 'requireToolApproval']);
    for (const s of Object.values<any>(cfg.servers)) {
      if (!s || typeof s !== 'object') return { ok: false, error: 'mcp server 配置须为对象' };
      if (!s.url && !s.command) return { ok: false, error: 'mcp server 须含 url 或 command' };
      for (const k of Object.keys(s)) if (!allowed.has(k)) return { ok: false, error: `mcp server 不支持字段 ${k}` };
    }
  }
  const mem = d?.memory_json;
  if (mem != null && mem !== '') {
    let cfg: any = mem;
    if (typeof mem === 'string') { try { cfg = JSON.parse(mem); } catch { return { ok: false, error: 'memory_json 非法 JSON' }; } }
    if (String(typeof mem === 'string' ? mem : JSON.stringify(mem)).length > LIMITS_JSON) return { ok: false, error: `memory_json 超长（>${LIMITS_JSON}）` };
    if (typeof cfg !== 'object') return { ok: false, error: 'memory_json 须为对象' };
  }
  return { ok: true };
}
