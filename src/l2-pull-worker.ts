/**
 * L2 出站 PULL 客户端：轮询 L1 Worker /l2-claim → expert LLM | ACP | CUA → POST /a2a-callback。
 * P1: experts 与 sandbox 同一 claim 队列（无 Worker waitUntil 专家路径）。
 * Env: L1_PULL_URL, PUSH_TOKEN, L2_PULL_INTERVAL_MS(2000), ACP_DRY_RUN(可选), DEEPSEEK_API_KEY(专家优先)
 */
import { runAcpPrompt } from './l2/a2a-l2.js';
import { runCuaTask } from './l2/cua-cli.js';
import { withProxy, resolveProxyUrl } from './l2/proxy-fetch.js';

const BASE = String(process.env.L1_PULL_URL || 'https://mastra-l1.summersmile1984.workers.dev').replace(/\/$/, '');
const TOKEN = process.env.PUSH_TOKEN || '';
const INTERVAL = Number(process.env.L2_PULL_INTERVAL_MS || 2000);
if (!TOKEN) { console.error('[L2-pull] PUSH_TOKEN missing'); process.exit(1); }
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Claimed = {
  taskId: string; prompt?: string; runtime?: string; kind?: string;
  expertId?: string | null; instructions?: string | null; threadId?: string;
};

function resolveKind(t: Claimed): 'expert' | 'cua' | 'acp' {
  const k = String(t.kind || '').toLowerCase();
  if (k === 'expert' || t.expertId) return 'expert';
  if (k === 'cua') return 'cua';
  const r = String(t.runtime || '').toLowerCase();
  if (r === 'expert') return 'expert';
  if (r.includes('cua') || r.includes('computer')) return 'cua';
  return 'acp';
}

async function runExpert(t: Claimed): Promise<string> {
  const instructions = String(t.instructions || '你是助手，用中文简短、结构化回复。不要加 [agent:…] 标记。').slice(0, 8000);
  const prompt = String(t.prompt || '').slice(0, 6000);
  const key = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
  if (key) {
    const base = process.env.DEEPSEEK_API_KEY
      ? 'https://api.deepseek.com/chat/completions'
      : (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions';
    const model = process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : (process.env.OPENAI_MODEL || 'gpt-4o-mini');
    const r = await fetch(base, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: prompt },
        ],
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`expert LLM HTTP ${r.status} ${JSON.stringify(j)?.slice(0, 200)}`);
    return String(j?.choices?.[0]?.message?.content ?? '').trim() || '(empty expert reply)';
  }
  // Fallback: ACP with prefixed instructions (no Mac LLM key)
  return runAcpPrompt(`【专家指令】\n${instructions}\n\n【用户任务】\n${prompt}`, 'cloud');
}

async function post(path: string, body: any) {
  const r = await fetch(`${BASE}${path}`, withProxy({ method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }));
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

console.log('[L2-pull] polling', `${BASE}/l2-claim`, 'every', INTERVAL, 'ms', process.env.ACP_DRY_RUN === '1' ? '(DRY-RUN)' : '', resolveProxyUrl() ? `proxy=${resolveProxyUrl()}` : 'proxy=off');
for (;;) {
  try {
    const j = await post('/l2-claim', {});
    const t: Claimed | null = j?.task;
    if (!t) { await sleep(INTERVAL); continue; }
    const kind = resolveKind(t);
    console.log('[L2-pull] claimed', t.taskId, t.runtime, 'kind=' + kind, t.expertId ? `expert=${t.expertId}` : '');
    let state: 'completed' | 'failed' = 'completed', text: string;
    try {
      if (kind === 'expert') text = await runExpert(t);
      else if (kind === 'cua') {
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
