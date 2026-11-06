import type { ClaimTask } from '@mastra-preflight/shared';
import { runAcp } from '../acp/runner.js';

/** L2 专家 = Mastra Agent + thread 对齐本地记忆（l2-experts S2.5）；ACP 兜底保留。 */
export async function runExpert(task: ClaimTask): Promise<{ ok: true; text: string }> {
  const { runExpertAgent } = await import('../../../../src/l2/expert-agent.js');
  try {
    const text = await runExpertAgent({
      prompt: String(task.prompt || ''), expertId: task.expertId, instructions: task.instructions, model: task.model,
      threadId: (task as any).threadId, resourceId: task.resourceId,
    });
    return { ok: true, text };
  } catch (e) {
    console.log('[expert] mastra-agent failed, fallback ACP', String((e as any)?.message ?? e).slice(0, 120));
    return runAcp(task);
  }
}
