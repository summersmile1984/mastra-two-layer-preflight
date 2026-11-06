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
        instructions TEXT NOT NULL, model TEXT, tools_json TEXT, mcp_json TEXT, memory_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    )
    .run();
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
  return {
    id: r.id, name: r.name, description: r.description, instructions: r.instructions,
    model: r.model ?? null, owner_user_id: r.owner_user_id, updated_at: r.updated_at,
  };
}

export async function listExperts(db: any): Promise<ExpertDef[]> {
  const { results } = await db.prepare('SELECT * FROM agent_defs ORDER BY created_at ASC').all();
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
  const row: ExpertDef = {
    id, owner_user_id: ownerUserId, name,
    description: String(input?.description ?? '').trim().slice(0, LIMITS.description),
    instructions: instructions.slice(0, LIMITS.instructions),
    model: input?.model ? String(input.model).slice(0, LIMITS.model) : null,
    tools_json: null, mcp_json: null, memory_json: null,
    created_at: Date.now(), updated_at: Date.now(),
  };
  await db
    .prepare('INSERT INTO agent_defs (id,owner_user_id,name,description,instructions,model,tools_json,mcp_json,memory_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(row.id, row.owner_user_id, row.name, row.description, row.instructions, row.model, null, null, null, row.created_at, row.updated_at)
    .run();
  return row;
}

export async function updateExpert(db: any, id: string, input: any): Promise<ExpertDef | null | { error: string }> {
  const cur: any = await db.prepare('SELECT * FROM agent_defs WHERE id = ?').bind(id).first();
  if (!cur) return null;
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
  if (fields.length) {
    args.push(Date.now(), id);
    await db.prepare(`UPDATE agent_defs SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`).bind(...args).run();
  }
  return (await db.prepare('SELECT * FROM agent_defs WHERE id = ?').bind(id).first()) as ExpertDef;
}

export async function deleteExpert(db: any, id: string): Promise<boolean> {
  const u = await db.prepare('DELETE FROM agent_defs WHERE id = ?').bind(id).run();
  return Number(u?.meta?.changes ?? 0) > 0;
}
