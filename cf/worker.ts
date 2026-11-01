/**
 * Cloudflare Workers L1 占位（最小可部署）。完整 L1 尚未移植到 Workers：
 * 现 L1 依赖 node:fs / LibSQL 文件库 / Chrome 截图兜底，需改为 D1/Turso + Durable Objects(SSE/会话) + R2(截图)。
 * 本占位验证：Secrets 注入、到 L2（cloudflared tunnel）的 A2A 连通性、push 回调 token 校验。
 */
export interface Env { DEEPSEEK_API_KEY: string; PUSH_TOKEN: string; L2_A2A_URL: string; PUBLIC_BASE_URL?: string }
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const l2 = (env.L2_A2A_URL ?? '').replace(/\/$/, '').replace(/\/api\/a2a\/.*$/, '');
    if (url.pathname === '/api/health') {
      let l2Health: unknown = null;
      try { l2Health = await (await fetch(`${l2}/api/health`, { signal: AbortSignal.timeout(5000) })).json(); } catch (e) { l2Health = { error: String(e) }; }
      return json({ ok: true, role: 'l1-cf-placeholder', deepseekKey: !!env.DEEPSEEK_API_KEY, pushToken: !!env.PUSH_TOKEN, l2: l2Health });
    }
    if (url.pathname === '/api/a2a-callback' && req.method === 'POST') {
      if (req.headers.get('X-A2A-Notification-Token') !== env.PUSH_TOKEN) return json({ error: 'bad token' }, 401);
      const task: any = await req.json().catch(() => null);
      console.log('push received', task?.id, task?.status?.state);
      return json({ ok: true, note: 'placeholder: full L1 wake-up not ported yet' });
    }
    if (url.pathname === '/api/ping-l2' && req.method === 'POST') {
      // 手动触发一次 A2A 非阻塞派发，回调到本 Worker
      const base = (env.PUBLIC_BASE_URL ?? url.origin).replace(/\/$/, '');
      const body = { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text: (await req.text()) || '回复 pong' }] }, configuration: { blocking: false, pushNotificationConfig: { url: `${base}/api/a2a-callback`, token: env.PUSH_TOKEN } } } };
      const r = await fetch(`${l2}/api/a2a/l2-worker`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return json(await r.json());
    }
    return new Response('L1 (Cloudflare placeholder). See DEPLOY-CF.md', { status: 200 });
  },
};
