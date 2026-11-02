/**
 * L2 desktop claim loop entry (Node today; same module graph will run inside Tauri later).
 * Aligns with repo root `src/l2-pull-worker.ts` + L1 `POST /l2-claim`.
 */
import { loadConfig } from './config.js';
import { claimOnce, completeTask } from './claim.js';
import { resolveKind } from './dispatch.js';
import { runAcp } from './acp/runner.js';
import { runCua } from './cua/runner.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  console.log('[l2-desktop] claim loop', `${cfg.l1Url}/l2-claim`, 'every', cfg.intervalMs, 'ms');
  for (;;) {
    try {
      const task = await claimOnce(cfg);
      if (!task) {
        await sleep(cfg.intervalMs);
        continue;
      }
      console.log('[l2-desktop] claimed', task.taskId, resolveKind(task));
      const kind = resolveKind(task);
      let state: 'completed' | 'failed' = 'completed';
      let text: string;
      try {
        const out = kind === 'cua' ? await runCua(task) : await runAcp(task);
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
    } catch (e: any) {
      console.log('[l2-desktop] poll error', String(e?.message ?? e).slice(0, 200));
      await sleep(cfg.intervalMs * 2);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
