import type { ClaimTask, TaskKind } from '@mastra-preflight/shared';

/**
 * Route task → runtime. L1 currently sends `runtime: local|cloud` for ACP-style shell work.
 * Future CUA tasks should set `kind: 'cua'` (or runtime containing 'cua').
 */
export function resolveKind(task: ClaimTask): TaskKind {
  if (task.kind === 'cua' || task.kind === 'acp') return task.kind;
  const r = String(task.runtime || '').toLowerCase();
  if (r.includes('cua') || r.includes('computer')) return 'cua';
  return 'acp';
}
