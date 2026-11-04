import type { ClaimTask } from '@mastra-preflight/shared';
import { runAcp } from '../acp/runner.js';

/** Run an expert L2 job: DeepSeek/OpenAI if keyed, else ACP with instructions prefix. */
export async function runExpert(task: ClaimTask): Promise<{ ok: true; text: string }> {
  const instructions = String(task.instructions || '你是助手，用中文简短、结构化回复。不要加 [agent:…] 标记。').slice(0, 8000);
  const prompt = String(task.prompt || '').slice(0, 6000);
  const key = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
  if (key) {
    const base = process.env.DEEPSEEK_API_KEY
      ? 'https://api.deepseek.com/chat/completions'
      : `${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
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
    const text = String(j?.choices?.[0]?.message?.content ?? '').trim() || '(empty expert reply)';
    return { ok: true, text };
  }
  const wrapped = { ...task, prompt: `【专家指令】\n${instructions}\n\n【用户任务】\n${prompt}` };
  return runAcp(wrapped);
}
