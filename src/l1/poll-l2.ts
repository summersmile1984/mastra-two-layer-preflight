/** Worker → (cloudflared tunnel) → L2 A2A `tasks/get` poller. Used when L2 cannot reach the L1 push callback. */
export interface PollDeps {
  url: () => string;
  getState: (taskId: string) => Promise<string | null>;
  terminal: string[];
  extract: (task: any) => { state: string; text: string };
  finalize: (taskId: string, state: string, text: string, src: string) => Promise<{ compose?: Promise<void> }>;
}
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
export async function pollL2Task(l2TaskId: string, deps: PollDeps, budgetMs = 14 * 60_000): Promise<void> {
  const end = Date.now() + budgetMs; let delay = 3000;
  while (Date.now() < end) {
    await sleep(delay); delay = Math.min(delay * 1.5, 15000);
    try {
      const cur = await deps.getState(l2TaskId);
      if (!cur || deps.terminal.includes(cur)) return; // callback already handled it
      const r = await fetch(deps.url(), { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tasks/get', params: { id: l2TaskId } }) });
      const j: any = await r.json().catch(() => null);
      const task = j?.result;
      if (!task?.status?.state) { console.log('[L1] poll no task', r.status, j?.error?.message); continue; }
      const { state, text } = deps.extract(task);
      if (deps.terminal.includes(state)) { const f = await deps.finalize(l2TaskId, state, text, 'poll'); if (f.compose) await f.compose; return; }
    } catch (e: any) { console.log('[L1] poll error', String(e?.message ?? e).slice(0, 160)); }
  }
  console.log('[L1] poll timeout', l2TaskId);
}
