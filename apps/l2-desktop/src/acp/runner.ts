import type { ClaimTask } from '@mastra-preflight/shared';

/**
 * ACP runner stub — real impl will call local harness (dsh --profile acp / Claude / Codex)
 * via @mastra/acp or the existing runAcpPrompt in src/l2/a2a-l2.ts.
 */
export async function runAcp(task: ClaimTask): Promise<{ ok: true; text: string }> {
  console.log('[acp] stub run', task.taskId, (task.prompt || '').slice(0, 80));
  return {
    ok: true,
    text: `[acp-stub] completed task ${task.taskId} (runtime=${task.runtime ?? 'n/a'}). Prompt length=${(task.prompt || '').length}`,
  };
}
