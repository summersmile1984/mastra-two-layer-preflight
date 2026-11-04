/**
 * L2 desktop claim loop entry (Node sidecar for Tauri; also `npm run claim:dev`).
 * Aligns with repo root `src/l2-pull-worker.ts` + L1 `POST /l2-claim`.
 */
import { loadConfig } from './config.js';
import { claimOnce, completeTask } from './claim.js';
import { resolveKind } from './dispatch.js';
import { runAcp } from './acp/runner.js';
import { runCua } from './cua/runner.js';
import { runExpert } from './expert/runner.js';
import { writeStatus } from './status.js';
import { bootstrap } from './bootstrap.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  writeStatus({
    running: true,
    online: true,
    pid: process.pid,
    error: null,
    queueHint: 'polling',
    lastSummary: `claim loop → ${cfg.l1Url}/l2-claim`,
  });
  console.log('[l2-desktop] claim loop', `${cfg.l1Url}/l2-claim`, 'every', cfg.intervalMs, 'ms', 'pid', process.pid);

  const shutdown = () => {
    writeStatus({ running: false, online: false, queueHint: 'stopped', lastSummary: 'claim loop stopped' });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  for (;;) {
    try {
      writeStatus({ online: true, queueHint: 'polling', error: null });
      const task = await claimOnce(cfg);
      if (!task) {
        writeStatus({ queueHint: 'idle (no queued L2 task)' });
        await sleep(cfg.intervalMs);
        continue;
      }
      const kind = resolveKind(task);
      const claimAt = new Date().toISOString();
      console.log('[l2-desktop] claimed', task.taskId, kind);
      writeStatus({
        lastClaimAt: claimAt,
        lastTaskId: task.taskId,
        lastKind: kind,
        lastState: 'working',
        lastSummary: (task.prompt || '').slice(0, 160),
        queueHint: 'running task',
      });
      let state: 'completed' | 'failed' = 'completed';
      let text: string;
      try {
        const out = kind === 'expert' ? await runExpert(task) : kind === 'cua' ? await runCua(task) : await runAcp(task);
        text = out.text;
      } catch (e: any) {
        state = 'failed';
        text = String(e?.message ?? e).slice(0, 2000);
      }
      let r: unknown;
      try {
        r = await completeTask(cfg, task.taskId, state, text);
      } catch (e: any) {
        console.log('[l2-desktop] callback error', String(e?.message ?? e).slice(0, 160));
        await sleep(2000);
        r = await completeTask(cfg, task.taskId, state, text);
      }
      console.log('[l2-desktop] done', task.taskId, state, JSON.stringify(r)?.slice(0, 120));
      writeStatus({
        lastState: state,
        lastSummary: text.slice(0, 240).replace(/\n/g, ' '),
        queueHint: 'polling',
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 200);
      console.log('[l2-desktop] poll error', msg);
      writeStatus({ error: msg, queueHint: 'backoff' });
      await sleep(cfg.intervalMs * 2);
    }
  }
}

if (!bootstrap()) main().catch((e) => {
  writeStatus({ running: false, online: false, error: String(e?.message ?? e).slice(0, 300) });
  console.error(e);
  process.exit(1);
});
