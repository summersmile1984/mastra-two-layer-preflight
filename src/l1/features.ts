/**
 * Settings & builder features (session-scoped). Mounted from app-routes.ts.
 *   GET/PUT  /api/permissions            权限 (HITL policies; CF has no AgentController Session → applied as activeTools filter)
 *   GET/POST /api/vault, DELETE /api/vault/:id   保险库 (AES-GCM, key = env.VAULT_KEY or SHA-256(BETTER_AUTH_SECRET))
 *   GET      /api/usage                  用量与账单
 *   GET      /api/version                更新 pane
 *   CRUD     /api/agent-defs[/:id]       Agent Builder (OSS, D1) → dynamic L2 experts
 *   GET      /api/templates, POST /api/templates/import   Bot 模板
 */
import { TEMPLATES, validateTemplate } from './templates';
import { EXPERT_CATALOG } from './experts';

export const L1_VERSION = '0.2.4';
export const L2_STUB_VERSION = '0.2.2-cua';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const now = () => Date.now();

// ---------------- permissions ----------------
export type Policy = 'allow' | 'ask' | 'deny';
export const PERM_DEFAULTS: { key: string; label: string; desc: string; policy: Policy }[] = [
  { key: 'read', label: '读取', desc: '查询状态、读取历史与文件（job_status 等）', policy: 'allow' },
  { key: 'execute', label: '执行', desc: '派发沙箱任务 / L2 专家（dispatch_to_sandbox / dispatch_to_expert）', policy: 'allow' },
  { key: 'delete', label: '删除', desc: '删除文件、断开连接等破坏性操作', policy: 'deny' },
  { key: 'mcp:github', label: 'MCP · GitHub', desc: '连接应用 GitHub 注入的工具', policy: 'allow' },
];
export const TOOL_CATEGORY: Record<string, string> = {
  job_status: 'read', dispatch_to_sandbox: 'execute', dispatch_to_expert: 'execute',
};
export async function loadPermissions(db: any, userId: string) {
  const { results } = await db.prepare('SELECT category_or_tool, policy, updated_at FROM user_permission_rules WHERE user_id=?').bind(userId).all().catch(() => ({ results: [] }));
  const s: any = await db.prepare('SELECT auto_review FROM user_settings WHERE user_id=?').bind(userId).first().catch(() => null);
  const map: Record<string, Policy> = {};
  for (const d of PERM_DEFAULTS) map[d.key] = d.policy;
  for (const r of results as any[]) map[r.category_or_tool] = r.policy;
  return { autoReview: s ? !!s.auto_review : true, map };
}
/** Effective policy for a tool: explicit tool rule > mcp:<server> > category > allow. 'ask' + autoReview → allow (auto-approved). */
export function decide(perm: { autoReview: boolean; map: Record<string, Policy> }, tool: string, category?: string): { policy: Policy; effective: 'allow' | 'deny' | 'ask' } {
  const cat = category ?? TOOL_CATEGORY[tool];
  const policy: Policy = perm.map[tool] ?? (cat ? perm.map[cat] : undefined) ?? 'allow';
  const effective = policy === 'ask' ? (perm.autoReview ? 'allow' : 'ask') : policy;
  return { policy, effective };
}
/** activeTools list for an Agent.generate given its tool names (ask-without-auto-review is excluded: no HITL Session on Workers). */
export function filterTools(perm: Awaited<ReturnType<typeof loadPermissions>>, tools: string[], catOf: (t: string) => string | undefined = () => undefined) {
  const active: string[] = [], blocked: { tool: string; why: string }[] = [];
  for (const t of tools) {
    const d = decide(perm, t, catOf(t));
    if (d.effective === 'allow') active.push(t); else blocked.push({ tool: t, why: d.effective === 'deny' ? '已禁止' : '需确认（自动审核关闭）' });
  }
  return { active, blocked };
}

// ---------------- vault ----------------
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function vaultKey(env: any) {
  const raw = String(env.VAULT_KEY || env.BETTER_AUTH_SECRET || 'dev-insecure-vault-key');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vault:' + raw));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function vaultEncrypt(env: any, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await vaultKey(env), new TextEncoder().encode(plain)));
  return `v1:${b64(iv)}:${b64(ct)}`;
}
export async function vaultDecrypt(env: any, blob: string) {
  const [v, iv, ct] = blob.split(':');
  if (v !== 'v1') throw new Error('bad vault blob');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await vaultKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}
export async function vaultGet(env: any, db: any, userId: string, id: string): Promise<string | null> {
  const r: any = await db.prepare('SELECT ciphertext FROM vault_secrets WHERE id=? AND user_id=?').bind(id, userId).first().catch(() => null);
  return r ? vaultDecrypt(env, r.ciphertext) : null;
}

// ---------------- usage ----------------
export async function recordUsage(db: any, userId: string | null | undefined, kind: string, tokens: number, meta?: unknown) {
  if (!userId) return;
  try {
    await db.prepare('INSERT INTO usage_events (id,user_id,kind,tokens,meta,created_at) VALUES (?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), userId, kind, Math.max(0, Math.round(Number(tokens) || 0)), meta == null ? null : JSON.stringify(meta), now()).run();
  } catch (e: any) { console.log('[usage] record failed', String(e?.message ?? e).slice(0, 120)); }
}
export const tokensOf = (res: any) => Number(res?.usage?.totalTokens ?? res?.totalUsage?.totalTokens ?? ((res?.usage?.inputTokens ?? 0) + (res?.usage?.outputTokens ?? 0))) || 0;
/** Thread → owning user: `user:<id>` DM, `room_<roomId>` → room owner. */
export async function userForThread(db: any, thread: string): Promise<string | null> {
  if (thread.startsWith('user:')) return thread.slice(5);
  if (thread.startsWith('dm_')) return thread.slice(3);
  const m = thread.match(/^room_(.+)$/);
  if (m) return ((await db.prepare('SELECT owner_id FROM rooms WHERE id=?').bind(m[1]).first().catch(() => null)) as any)?.owner_id ?? null;
  return null;
}

// ---------------- agent defs (dynamic L2 experts) ----------------
export type AgentDefRow = { id: string; owner_user_id: string; name: string; description: string | null; instructions: string; model: string | null; tools_json: string | null; mcp_json: string | null; memory_json: string | null; created_at: number; updated_at: number };
const pj = (s: string | null | undefined, d: any) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const defOut = (r: AgentDefRow) => ({ id: r.id, name: r.name, description: r.description ?? '', instructions: r.instructions, model: r.model ?? 'deepseek/deepseek-chat',
  tools: pj(r.tools_json, []), mcp: pj(r.mcp_json, []), memory: pj(r.memory_json, { lastMessages: 20 }), created_at: r.created_at, updated_at: r.updated_at });
export async function getAgentDef(db: any, id: string): Promise<AgentDefRow | null> {
  return (await db.prepare('SELECT * FROM agent_defs WHERE id=?').bind(id).first().catch(() => null)) as any;
}
export async function listAgentDefs(db: any, userId: string): Promise<AgentDefRow[]> {
  return ((await db.prepare('SELECT * FROM agent_defs WHERE owner_user_id=? ORDER BY updated_at DESC').bind(userId).all().catch(() => ({ results: [] }))).results ?? []) as any;
}
/** Agent defs visible in a room: owned by any room member (so a member-built agent can be mounted). */
export async function roomAgentDefs(db: any, roomId: string): Promise<AgentDefRow[]> {
  return ((await db.prepare('SELECT a.* FROM agent_defs a JOIN room_members rm ON rm.user_id=a.owner_user_id WHERE rm.room_id=?').bind(roomId).all().catch(() => ({ results: [] }))).results ?? []) as any;
}
const SUPPORTED_MODELS = ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'];
async function upsertDef(db: any, userId: string, b: any, id?: string) {
  const name = String(b.name ?? '').trim().slice(0, 40);
  const instructions = String(b.instructions ?? '').trim().slice(0, 8000);
  if (!name || !instructions) return { error: 'name and instructions required' };
  if (EXPERT_CATALOG.some(e => e.name === name) || name === '管家 Orchestrator') return { error: 'name conflicts with built-in agent' };
  const model = SUPPORTED_MODELS.includes(String(b.model)) ? String(b.model) : 'deepseek/deepseek-chat';
  const tools = Array.isArray(b.tools) ? b.tools.map(String).slice(0, 20) : [];
  const mcp = Array.isArray(b.mcp) ? b.mcp.map(String).slice(0, 10) : [];
  const memory = { lastMessages: Math.min(100, Math.max(0, Number(b.memory?.lastMessages ?? 20) || 20)) };
  const t = now();
  if (id) {
    const r = await db.prepare('UPDATE agent_defs SET name=?, description=?, instructions=?, model=?, tools_json=?, mcp_json=?, memory_json=?, updated_at=? WHERE id=? AND owner_user_id=?')
      .bind(name, String(b.description ?? '').slice(0, 200), instructions, model, JSON.stringify(tools), JSON.stringify(mcp), JSON.stringify(memory), t, id, userId).run();
    if (!r?.meta?.changes) return { error: 'not found', status: 404 };
  } else {
    id = `ad-${crypto.randomUUID().slice(0, 8)}`;
    await db.prepare('INSERT INTO agent_defs (id,owner_user_id,name,description,instructions,model,tools_json,mcp_json,memory_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, userId, name, String(b.description ?? '').slice(0, 200), instructions, model, JSON.stringify(tools), JSON.stringify(mcp), JSON.stringify(memory), t, t).run();
  }
  return { def: defOut((await getAgentDef(db, id!))!) };
}
async function mountToRoom(db: any, userId: string, roomId: string, agentId: string) {
  const role = ((await db.prepare('SELECT role FROM room_members WHERE room_id=? AND user_id=?').bind(roomId, userId).first()) as any)?.role;
  if (role !== 'owner' && role !== 'admin') return { error: 'need room owner/admin to mount' };
  await db.prepare('INSERT OR IGNORE INTO room_agents (room_id,agent_id,added_at) VALUES (?,?,?)').bind(roomId, agentId, now()).run();
  return { ok: true };
}

// ---------------- MCP over HTTP (Workers-safe; stdio MCP cannot run on Workers) ----------------
async function mcpRpc(url: string, headers: Record<string, string>, method: string, params: unknown, sid?: string) {
  const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 100)}`);
  let j: any = null;
  if (/^\s*[{[]/.test(text)) j = JSON.parse(text);
  else { const line = text.split('\n').filter(l => l.startsWith('data:')).pop(); j = line ? JSON.parse(line.slice(5)) : null; }
  if (j?.error) throw new Error(j.error.message ?? 'mcp error');
  return { result: j?.result, sid: r.headers.get('mcp-session-id') ?? sid };
}
export async function mcpListTools(url: string, headers: Record<string, string>) {
  const init = await mcpRpc(url, headers, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mastra-l1', version: L1_VERSION } });
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(init.sid ? { 'mcp-session-id': init.sid } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).catch(() => null);
  const { result, sid } = await mcpRpc(url, headers, 'tools/list', {}, init.sid);
  return { tools: (result?.tools ?? []) as { name: string; description?: string; inputSchema?: any }[], sid, call: async (name: string, args: unknown) => (await mcpRpc(url, headers, 'tools/call', { name, arguments: args }, sid)).result };
}
/** Resolve a user's MCP connections into server configs (vault secret → Authorization header). */
export async function resolveConnections(env: any, db: any, userId: string) {
  const { results } = await db.prepare('SELECT server_id, label, config_json, vault_id FROM user_mcp_connections WHERE user_id=?').bind(userId).all().catch(() => ({ results: [] }));
  const out: { server_id: string; label: string; url: string | null; headers: Record<string, string>; transport: 'http' | 'stdio' | 'none'; vault_id: string | null; problem?: string }[] = [];
  for (const r of results as any[]) {
    const cfg = pj(r.config_json, {}) ?? {};
    const url: string | null = typeof cfg.url === 'string' && /^https:\/\//.test(cfg.url) ? cfg.url : null;
    const headers: Record<string, string> = {};
    let problem: string | undefined;
    if (r.vault_id) {
      try { const s = await vaultGet(env, db, userId, r.vault_id); if (s) headers[cfg.authHeader || 'authorization'] = cfg.authHeader ? s : `Bearer ${s}`; else problem = '保险库条目不存在'; }
      catch { problem = '保险库解密失败'; }
    }
    const transport = url ? 'http' : cfg.command ? 'stdio' : 'none';
    if (transport === 'stdio') problem = 'stdio MCP 无法在 Workers 运行（请改用 HTTP MCP URL，或由 L2 本机加载）';
    if (transport === 'none') problem = problem ?? '未配置 HTTP MCP URL';
    out.push({ server_id: r.server_id, label: r.label ?? r.server_id, url, headers, transport, vault_id: r.vault_id ?? null, problem });
  }
  return out;
}

export function featureRoutes(deps: { env: any; db: () => any; makeTool?: (spec: { id: string; description: string; call: (args: any) => Promise<unknown> }) => any }) {
  const { env, db } = deps;
  return async (req: Request, p: string, m: string, body: any, user: any, url: URL): Promise<Response | null> => {
    // ---- permissions ----
    if (p === '/api/permissions' && m === 'GET') {
      const perm = await loadPermissions(db(), user.id);
      return json({ autoReview: perm.autoReview, rules: Object.entries(perm.map).map(([key, policy]) => ({ key, policy, ...(PERM_DEFAULTS.find(d => d.key === key) ?? { label: key, desc: '自定义工具规则' }) })),
        runtime: 'cf-workers', note: 'Workers 上无常驻 AgentController Session：deny/ask(自动审核关闭) 的工具会从 activeTools 过滤；Node 版 controller 可调用 session.permissions.setForCategory。' });
    }
    if (p === '/api/permissions' && m === 'PUT') {
      const t = now(); const stmts: any[] = [];
      if (typeof body.autoReview === 'boolean') stmts.push(db().prepare('INSERT INTO user_settings (user_id,auto_review,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET auto_review=excluded.auto_review, updated_at=excluded.updated_at').bind(user.id, body.autoReview ? 1 : 0, t));
      for (const r of Array.isArray(body.rules) ? body.rules.slice(0, 50) : []) {
        const key = String(r.key ?? '').trim().slice(0, 64); const pol = String(r.policy);
        if (!key || !['allow', 'ask', 'deny'].includes(pol)) return json({ error: `bad rule ${key}` }, 400);
        stmts.push(db().prepare('INSERT INTO user_permission_rules (user_id,category_or_tool,policy,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id,category_or_tool) DO UPDATE SET policy=excluded.policy, updated_at=excluded.updated_at').bind(user.id, key, pol, t));
      }
      for (const k of Array.isArray(body.remove) ? body.remove : []) stmts.push(db().prepare('DELETE FROM user_permission_rules WHERE user_id=? AND category_or_tool=?').bind(user.id, String(k)));
      if (stmts.length) await db().batch(stmts);
      const perm = await loadPermissions(db(), user.id);
      return json({ ok: true, autoReview: perm.autoReview, map: perm.map });
    }
    // ---- vault ----
    if (p === '/api/vault' && m === 'GET') {
      const { results } = await db().prepare('SELECT id,name,kind,meta,created_at,length(ciphertext) AS n FROM vault_secrets WHERE user_id=? ORDER BY created_at DESC').bind(user.id).all();
      return json({ secrets: (results as any[]).map(r => ({ id: r.id, name: r.name, kind: r.kind, meta: pj(r.meta, {}), created_at: r.created_at, masked: '••••••' + (pj(r.meta, {})?.last4 ?? '') })),
        encryption: env.VAULT_KEY ? 'AES-GCM (VAULT_KEY)' : 'AES-GCM (派生自 BETTER_AUTH_SECRET；生产请设置 VAULT_KEY)' });
    }
    if (p === '/api/vault' && m === 'POST') {
      const name = String(body.name ?? '').trim().slice(0, 64); const kind = ['api_key', 'token', 'password', 'mcp_header', 'other'].includes(body.kind) ? body.kind : 'api_key';
      const value = String(body.value ?? '');
      if (!name || !value) return json({ error: 'name and value required' }, 400);
      if (value.length > 8000) return json({ error: 'value too long' }, 400);
      const id = `v-${crypto.randomUUID().slice(0, 12)}`;
      const meta = { last4: value.length >= 8 ? value.slice(-4) : '', note: String(body.note ?? '').slice(0, 120) };
      await db().prepare('INSERT INTO vault_secrets (id,user_id,name,kind,ciphertext,meta,created_at) VALUES (?,?,?,?,?,?,?)').bind(id, user.id, name, kind, await vaultEncrypt(env, value), JSON.stringify(meta), now()).run();
      return json({ secret: { id, name, kind, meta, masked: '••••••' + meta.last4 } }, 201);
    }
    let mm = p.match(/^\/api\/vault\/([\w-]+)$/);
    if (mm && m === 'DELETE') {
      await db().batch([
        db().prepare('DELETE FROM vault_secrets WHERE id=? AND user_id=?').bind(mm[1], user.id),
        db().prepare('UPDATE user_mcp_connections SET vault_id=NULL WHERE user_id=? AND vault_id=?').bind(user.id, mm[1]),
      ]);
      return json({ ok: true });
    }
    // ---- usage ----
    if (p === '/api/usage' && m === 'GET') {
      const d = new Date(); const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 8 * 3600_000; // Asia/Shanghai month
      const tot: any = await db().prepare('SELECT COALESCE(SUM(tokens),0) t, COUNT(*) n FROM usage_events WHERE user_id=? AND created_at>=?').bind(user.id, monthStart).first();
      const { results: byKind } = await db().prepare('SELECT kind, COALESCE(SUM(tokens),0) tokens, COUNT(*) n FROM usage_events WHERE user_id=? AND created_at>=? GROUP BY kind ORDER BY tokens DESC').bind(user.id, monthStart).all();
      const { results: jobs } = await db().prepare("SELECT CASE WHEN expert_id IS NULL OR expert_id='' THEN 'sandbox' ELSE 'expert' END k, state, COUNT(*) n FROM l2_tasks WHERE user_id=? AND created_at>=? GROUP BY k, state").bind(user.id, monthStart).all().catch(() => ({ results: [] }));
      const { results: events } = await db().prepare('SELECT kind, tokens, meta, created_at FROM usage_events WHERE user_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 500').bind(user.id, monthStart).all();
      return json({ plan: '自托管', monthStart, monthTokens: tot?.t ?? 0, events_count: tot?.n ?? 0, byKind, l2Jobs: jobs, events: (events as any[]).map(e => ({ ...e, meta: pj(e.meta, null) })),
        note: 'best-effort 计数：L1 回合 / L2 专家完成 / 沙箱回调汇报的模型 token（来自 Mastra usage）' });
    }
    if (p === '/api/version' && m === 'GET') return json({ l1: L1_VERSION, l2: L2_STUB_VERSION, runtime: 'cloudflare-workers', mastra: '@mastra/core 1.x' });
    // ---- agent defs ----
    if (p === '/api/agent-defs' && m === 'GET') return json({ defs: (await listAgentDefs(db(), user.id)).map(defOut), models: SUPPORTED_MODELS, toolChoices: ['job_status'] });
    if (p === '/api/agent-defs' && m === 'POST') {
      const r: any = await upsertDef(db(), user.id, body);
      if (r.error) return json({ error: r.error }, r.status ?? 400);
      let mounted: any = null;
      if (body.roomId) mounted = await mountToRoom(db(), user.id, String(body.roomId), r.def.id);
      return json({ def: r.def, mounted }, 201);
    }
    mm = p.match(/^\/api\/agent-defs\/([\w-]+)$/);
    if (mm && m === 'GET') { const r = await getAgentDef(db(), mm[1]); return r && r.owner_user_id === user.id ? json({ def: defOut(r) }) : json({ error: 'not found' }, 404); }
    if (mm && (m === 'PUT' || m === 'PATCH')) {
      const r: any = await upsertDef(db(), user.id, body, mm[1]);
      if (r.error) return json({ error: r.error }, r.status ?? 400);
      let mounted: any = null;
      if (body.roomId) mounted = await mountToRoom(db(), user.id, String(body.roomId), r.def.id);
      return json({ def: r.def, mounted });
    }
    if (mm && m === 'DELETE') {
      const r = await db().prepare('DELETE FROM agent_defs WHERE id=? AND owner_user_id=?').bind(mm[1], user.id).run();
      if (r?.meta?.changes) await db().prepare('DELETE FROM room_agents WHERE agent_id=?').bind(mm[1]).run();
      return json({ ok: !!r?.meta?.changes });
    }
    mm = p.match(/^\/api\/agent-defs\/([\w-]+)\/export$/);
    if (mm && m === 'GET') {
      const r = await getAgentDef(db(), mm[1]);
      if (!r || r.owner_user_id !== user.id) return json({ error: 'not found' }, 404);
      const d = defOut(r);
      return json({ schemaVersion: 1, agent: { name: d.name, description: d.description, instructions: d.instructions, model: d.model }, tools: d.tools, mcp: d.mcp, memory: d.memory, roomDefaults: { autoAdd: true } });
    }
    // ---- templates ----
    if (p === '/api/templates' && m === 'GET') return json({ templates: TEMPLATES });
    if (p === '/api/templates/import' && m === 'POST') {
      const t = body.template ?? (body.templateId ? TEMPLATES.find(x => x.id === body.templateId) : null);
      const err = validateTemplate(t);
      if (err) return json({ error: err }, 400);
      const r: any = await upsertDef(db(), user.id, { ...t.agent, tools: t.tools, mcp: t.mcp, memory: t.memory });
      if (r.error) return json({ error: r.error }, 400);
      let mounted: any = null;
      if (body.roomId) mounted = await mountToRoom(db(), user.id, String(body.roomId), r.def.id);
      return json({ def: r.def, mounted }, 201);
    }
    return null;
  };
}
