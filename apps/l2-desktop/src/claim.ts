/**
 * Poll L1 POST /l2-claim (same contract as src/l2-pull-worker.ts).
 * Auth: Authorization: Bearer <PUSH_TOKEN> or X-A2A-Notification-Token.
 */
import type { ClaimResponse, ClaimTask, CompletePayload, TaskResultState } from '@mastra-preflight/shared';
import type { L2Config } from './config.js';

export async function claimOnce(cfg: L2Config): Promise<ClaimTask | null> {
  const r = await fetch(`${cfg.l1Url}/l2-claim`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.token}`,
      'x-a2a-notification-token': cfg.token,
    },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await r.json().catch(() => null)) as ClaimResponse | null;
  if (!r.ok) throw new Error(`/l2-claim HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 200)}`);
  return j?.task ?? null;
}

export async function completeTask(cfg: L2Config, taskId: string, state: TaskResultState, text: string) {
  const body: CompletePayload = {
    id: taskId,
    kind: 'task',
    status: { state, timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: `${taskId}-out`, parts: [{ kind: 'text', text }] }],
  };
  const r = await fetch(`${cfg.l1Url}/a2a-callback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.token}`,
      'x-a2a-notification-token': cfg.token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`/a2a-callback HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 200)}`);
  return j;
}
