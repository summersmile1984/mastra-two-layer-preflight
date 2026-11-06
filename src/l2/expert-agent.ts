/**
 * L2 专家 = Mastra Agent（l2-experts S2.5，对齐 AGENTS.md 的 buildL2Agent 口径）：
 * agent_defs 的指令快照起一个 Mastra Agent，配本地 LibSQL 记忆——threadId 与 L1 一一对应
 * （同房间/主题的任务共享一条 L2 记忆线，不同房间互不串）。结果经 compose 回流 L1（权威记忆）。
 */
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

let storeP: Promise<any> | null = null;
function localStore() {
  storeP ??= Promise.resolve().then(() => {
    const dir = resolve(process.env.L2_MEMORY_DIR || 'workspace-l2');
    mkdirSync(dir, { recursive: true });
    return new LibSQLStore({ id: 'l2-memory', url: `file:${resolve(dir, 'memory.db')}` } as any);
  });
  return storeP;
}

const FALLBACK_INSTRUCTIONS = '你是专家助手，用中文简短、结构化回复。';

export type L2ExpertTask = {
  prompt: string;
  expertId?: string | null;
  instructions?: string | null;
  model?: string | null;
  name?: string | null;
  threadId?: string | null;
  resourceId?: string | null;
};

/** 由专家定义 + 任务上下文构造 L2 Mastra Agent。 */
export async function buildL2Agent(def: { id?: string | null; name?: string | null; instructions?: string | null; model?: string | null }): Promise<InstanceType<typeof Agent>> {
  const store = await localStore();
  return new Agent({
    id: `l2-${def.id ?? 'expert'}`,
    name: String(def.name ?? 'expert'),
    instructions: String(def.instructions || FALLBACK_INSTRUCTIONS),
    model: (def.model || process.env.L2_EXPERT_MODEL || 'deepseek/deepseek-chat') as any,
    memory: new Memory({ storage: store as any, options: { lastMessages: 20 } }),
  } as any) as any;
}

/** 真执行：Mastra Agent + thread 对齐记忆。 */
export async function runExpertAgent(task: L2ExpertTask): Promise<string> {
  const agent = await buildL2Agent({ id: task.expertId, name: task.name, instructions: task.instructions, model: task.model });
  const threadId = String(task.threadId || `expert-${Date.now()}`);
  const resourceId = String(task.resourceId || 'user:master');
  const res: any = await agent.generate([{ role: 'user', content: String(task.prompt).slice(0, 20000) }], {
    memory: { thread: threadId, resource: resourceId },
  } as any);
  return String(res?.text ?? '').trim() || '(empty expert reply)';
}
