/**
 * L2 出站 PULL 客户端：轮询 L1 Worker /l2-claim → ACP (dsh) 或 CUA (cua CLI) → POST /a2a-callback。
 * 无需入站可达（不用 cloudflared）。Env: L1_PULL_URL, PUSH_TOKEN, L2_PULL_INTERVAL_MS(2000), ACP_DRY_RUN(可选)
 */
import { runAcpPrompt } from './l2/a2a-l2.js';
import { runCuaTask } from './l2/cua-cli.js';

const BASE = String(process.env.L1_PULL_URL || 'https://mastra-l1.summersmile1984.workers.dev').replace(/\/$/, '');
const TOKEN = process.env.PUSH_TOKEN || '';
const INTERVAL = Number(process.env.L2_PULL_INTERVAL_MS || 2000);
if (!TOKEN) { console.error('[L2-pull] PUSH_TOKEN missing'); process.exit(1); }
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isCuaTask(t: { runtime?: string; kind?: string }): boolean {
  const k = String(t.kind || '').toLowerCase();
  if (k === 'cua') return true;
  const r = String(t.runtime || '').toLowerCase();
  return r.includes('cua') || r.includes('computer');
}

async function post(path: string, body: any) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${path} HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 200)}`);
  return j;
}

async function complete(taskId: string, state: 'completed' | 'failed', text: string) {
  for (let i = 0; i < 5; i++) {
    try {
      return await post('/a2a-callback', { id: taskId, kind: 'task', status: { state, timestamp: new Date().toISOString() },
        artifacts: [{ artifactId: `${taskId}-out`, parts: [{ kind: 'text', text }] }] });
    } catch (e: any) { console.log('[L2-pull] callback retry', i, String(e?.message ?? e).slice(0, 160)); await sleep(2000 * (i + 1)); }
  }
}

console.log('[L2-pull] polling', `${BASE}/l2-claim`, 'every', INTERVAL, 'ms', process.env.ACP_DRY_RUN === '1' ? '(DRY-RUN)' : '');
for (;;) {
  try {
    const j = await post('/l2-claim', {});
    const t = j?.task;
    if (!t) { await sleep(INTERVAL); continue; }
    const kind = isCuaTask(t) ? 'cua' : 'acp';
    console.log('[L2-pull] claimed', t.taskId, t.runtime, 'kind=' + kind);
    let state: 'completed' | 'failed' = 'completed', text: string;
    try {
      if (kind === 'cua') {
        const out = await runCuaTask({ taskId: String(t.taskId), prompt: String(t.prompt || ''), runtime: t.runtime, kind });
        text = out.text;
      } else {
        text = await runAcpPrompt(String(t.prompt), t.runtime === 'local' ? 'local' : 'cloud');
      }
    } catch (e: any) { state = 'failed'; text = String(e?.message ?? e).slice(0, 2000); }
    const r = await complete(t.taskId, state, text);
    console.log('[L2-pull] done', t.taskId, state, JSON.stringify(r));
  } catch (e: any) { console.log('[L2-pull] poll error', String(e?.message ?? e).slice(0, 200)); await sleep(INTERVAL * 2); }
}
