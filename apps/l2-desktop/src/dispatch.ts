import type { ClaimTask, TaskKind } from '@mastra-preflight/shared';

/**
 * Route task → runtime. P1: expert | cua | acp (unified L2 claim class).
 */
export function resolveKind(task: ClaimTask): TaskKind {
  if (task.kind === 'expert' || task.kind === 'cua' || task.kind === 'acp') return task.kind;
  if (task.expertId) return 'expert';
  const r = String(task.runtime || '').toLowerCase();
  if (r === 'expert') return 'expert';
  if (r.includes('cua') || r.includes('computer')) return 'cua';
  return 'acp';
}
