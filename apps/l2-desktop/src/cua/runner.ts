import type { ClaimTask } from '@mastra-preflight/shared';

export type CuaAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'done'; summary: string };

/**
 * Real CUA via trycua `cua` CLI (default). Pass stub only in tests via CUA_STUB=1.
 */
export async function runCua(task: ClaimTask): Promise<{ ok: true; text: string }> {
  if (process.env.CUA_STUB === '1') {
    throw new Error('CUA stub is disabled for production; unset CUA_STUB');
  }
  const mod: any = await import('../../../../src/l2/cua-cli.js');
  console.log('[cua] real loop start', task.taskId);
  const computer = new mod.CuaCliComputer();
  const out = await mod.runCuaTask(task, computer);
  console.log('[cua] done', task.taskId, (out.text || '').slice(0, 160).replace(/\n/g, ' '));
  if (/\[cua-stub\]/i.test(out.text || '')) throw new Error('refusing stub result');
  return { ok: true, text: out.text };
}
