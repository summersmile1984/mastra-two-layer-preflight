/**
 * L2 专家 JIT 工厂（expert-forge S2.1，AGENTS.md buildL2Agent 口径）：
 * 专家定义即数据——agent_defs 快照（提示词/tools/mcp/skill/memory）按名现场构建 Mastra Agent，
 * threadId 与 L1 一一对应（同房间共享记忆线，跨房间不串），结果经 compose 回流 L1（权威记忆）。
 * 实例按 def.id+updated_at 缓存；MCP client 每任务独立生命周期。
 */
import { Agent } from '@mastra/core/agent';
import { createSkill } from '@mastra/core/skills';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { MCPClient } from '@mastra/mcp';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTools } from './tools-registry.js';

/** agent_defs 行快照（与 packages/shared ExpertDefSnapshot 同构；JSON 字段为字符串）。 */
export type ExpertDefSnapshot = {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  model?: string | null;
  tools_json?: string | null;
  mcp_json?: string | null;
  skills_json?: string | null;
  memory_json?: string | null;
  updated_at?: number | null;
};

export type L2ExpertTask = {
  prompt: string;
  expertId?: string | null;
  instructions?: string | null;
  model?: string | null;
  name?: string | null;
  threadId?: string | null;
  resourceId?: string | null;
  def?: ExpertDefSnapshot | null;
};

let store: any = null;
function localStore(): any {
  if (!store) {
    const dir = resolve(process.env.L2_MEMORY_DIR || 'workspace-l2');
    mkdirSync(dir, { recursive: true });
    store = new LibSQLStore({ id: 'l2-memory', url: `file:${resolve(dir, 'memory.db')}` } as any);
  }
  return store;
}

const FALLBACK_INSTRUCTIONS = '你是专家助手，用中文简短、结构化回复。';

function parseJson<T>(v: unknown): T | null {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return null; }
}

/** memory_json → Memory options（workingMemory 模板 / semanticRecall / OM 透传）。 */
function buildMemory(memoryJson: unknown): InstanceType<typeof Memory> {
  const opts = parseJson<any>(memoryJson) ?? {};
  return new Memory({
    storage: localStore() as any,
    options: {
      lastMessages: Number(opts.lastMessages) > 0 ? Number(opts.lastMessages) : 20,
      ...(opts.workingMemory ? { workingMemory: opts.workingMemory } : {}),
      ...(opts.semanticRecall ? { semanticRecall: opts.semanticRecall } : {}),
      ...(opts.observationalMemory ? { observationalMemory: opts.observationalMemory } : {}),
    },
  } as any) as any;
}

/** 技能名 slug 化：Mastra createSkill 仅允许 [a-z0-9-]；中文名保留进 description。 */
function slugifySkillName(name: string, used: Set<string>): string {
  let s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  if (!/^[a-z0-9]/.test(s)) s = `s-${s}`;
  let out = s, i = 2;
  while (used.has(out)) out = `${s}-${i++}`;
  used.add(out);
  return out;
}

/** skills_json → createSkill 内联技能（按需加载）。 */
function buildSkills(skillsJson: unknown): any[] {
  const list = parseJson<any[]>(skillsJson);
  if (!Array.isArray(list)) return [];
  const used = new Set<string>();
  return list
    .filter((s) => s && typeof s.name === 'string' && typeof s.instructions === 'string')
    .map((s) => createSkill({
      name: slugifySkillName(s.name, used),
      description: String(s.description ?? '').slice(0, 200) || `技能「${String(s.name).slice(0, 40)}」（按需加载）`,
      instructions: String(s.instructions).slice(0, 8000),
    }));
}

type McpConfig = { servers?: Record<string, { url?: string; command?: string; args?: string[]; env?: Record<string, string>; requireToolApproval?: boolean }> };

/** mcp_json → 每任务独立 MCPClient（env 仅字面值；secret: 引用递延见 spec S3）。 */
function buildMcpClient(mcpJson: unknown): InstanceType<typeof MCPClient> | null {
  const cfg = parseJson<McpConfig>(mcpJson);
  if (!cfg?.servers || !Object.keys(cfg.servers).length) return null;
  const servers: Record<string, any> = {};
  for (const [name, s] of Object.entries(cfg.servers)) {
    const env = s.env ?? {};
    for (const [k, v] of Object.entries(env)) {
      if (String(v).startsWith('secret:')) throw new Error(`MCP env ${k} 使用了 secret: 引用——明文管道未接通，请先填字面值`);
    }
    servers[name] = s.command
      ? { command: s.command, args: s.args ?? [], env, inheritDefaultEnv: false }
      : { url: new URL(String(s.url)), requestInit: { headers: {} }, requireToolApproval: s.requireToolApproval };
  }
  return new MCPClient({ id: `l2-mcp-${Date.now().toString(36)}`, servers } as any) as any;
}

const agentCache = new Map<string, InstanceType<typeof Agent>>();

/** def → Mastra Agent（JIT 装配；按 def.id+updated_at 缓存实例）。 */
export async function buildL2Agent(def: ExpertDefSnapshot): Promise<InstanceType<typeof Agent>> {
  const key = `${def.id ?? 'anon'}:${def.updated_at ?? 0}`;
  const hit = agentCache.get(key);
  if (hit) return hit;
  // 同 def.id 只保留最新一份（评审 MINOR：缓存不失效旧条目）
  for (const k of [...agentCache.keys()]) if (k !== key && k.startsWith(`${def.id ?? 'anon'}:`)) agentCache.delete(k);
  const skills = buildSkills(def.skills_json);
  const tools = resolveTools(def.tools_json);
  const agent = new Agent({
    id: `l2-${def.id ?? def.name ?? 'expert'}`,
    name: String(def.name ?? 'expert'),
    instructions: String(def.instructions || FALLBACK_INSTRUCTIONS),
    model: (def.model || process.env.L2_EXPERT_MODEL || 'deepseek/deepseek-chat') as any,
    ...(Object.keys(tools).length ? { tools } : {}),
    ...(skills.length ? { skills } : {}),
    memory: buildMemory(def.memory_json),
  } as any) as any;
  agentCache.set(key, agent);
  return agent;
}

/** 真执行：JIT 构建 + thread 对齐记忆 +（可选）MCP toolsets。 */
export async function runExpertAgent(task: L2ExpertTask): Promise<string> {
  const def: ExpertDefSnapshot = task.def ?? {
    id: task.expertId, name: task.name, instructions: task.instructions, model: task.model,
    updated_at: 0,
  };
  const agent = await buildL2Agent(def);
  const threadId = String(task.threadId || `expert-${Date.now()}`);
  const resourceId = String(task.resourceId || 'user:master');
  const mcp = buildMcpClient(def.mcp_json);
  try {
    const extra = mcp ? { toolsets: await (mcp as any).listToolsets() } : {};
    const res: any = await agent.generate([{ role: 'user', content: String(task.prompt).slice(0, 20000) }], {
      memory: { thread: threadId, resource: resourceId },
      ...extra,
    } as any);
    return String(res?.text ?? '').trim() || '(empty expert reply)';
  } finally {
    if (mcp) { try { await (mcp as any).disconnect(); } catch {} }
  }
}
