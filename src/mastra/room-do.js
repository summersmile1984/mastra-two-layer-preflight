/**
 * RoomDO —— 每房间一个 Durable Object（idFromName(roomId)）。
 * 独立自包含：仅依赖 cloudflare:workers 内置模块 + 直接 D1 查询，不 import Mastra 链路。
 * （原因：mastra build 的入口模板只导出 export default { fetch }，DO 类需从 worker-entry.mjs 重导出。）
 *
 * Hibernation API（本特性的核心）：连接经 ctx.acceptWebSocket 挂在 DO 上，实例可休眠——
 * 不在内存、不计 duration，webSockets 由运行时保管，状态一律从 D1 读。禁止 WebSocketPair 常驻方案。
 *
 * 入站两类：
 *   1) Upgrade: websocket —— Worker 侧已完成鉴权+成员校验后转发；accept 后回 101。
 *   2) POST /notify —— Worker 写库后的「闹钟」；唤醒 → 读 D1 权威数据 → 广播 → 回休眠。
 */
const TERMINAL = ['completed', 'failed', 'canceled', 'rejected'];

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  get roomId() {
    return this.ctx?.id?.name || '';
  }

  async fetch(request) {
    // 1) WS 升级（鉴权已在 Worker 侧完成）
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    // 2) 内部 notify（DO 仅经 stub 可达，不暴露公网）
    const url = new URL(request.url);
    if (url.pathname === '/notify' && request.method === 'POST') {
      let body = {};
      try {
        body = await request.json();
      } catch {}
      await this.notify(body || {});
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  /** 闹钟语义：只被唤醒，内容一律以 D1 为准。 */
  async notify(evt) {
    try {
      if (evt.kind === 'message' && evt.messageId) {
        const msg = await this.env.DB.prepare(
          'SELECT id, room_id, user_id, role, content, created_at FROM messages WHERE id = ?',
        )
          .bind(String(evt.messageId))
          .first();
        if (msg) this.broadcast({ type: 'message', message: msg });
      } else if (evt.kind === 'busy') {
        this.broadcast({ type: 'busy', busy: await this.computeBusy() });
      }
    } catch (e) {
      console.log('[RoomDO] notify error', String((e && e.message) || e).slice(0, 120));
    }
  }

  async computeBusy() {
    try {
      const row = await this.env.DB.prepare(
        `SELECT COUNT(*) n FROM l2_tasks WHERE thread_id=? AND state NOT IN (${TERMINAL.map(() => '?').join(',')})`,
      )
        .bind(this.roomId, ...TERMINAL)
        .first();
      return Number((row && row.n) || 0) > 0;
    } catch {
      return false;
    }
  }

  broadcast(event) {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {}
    }
  }

  // ---- Hibernation 回调（休眠唤醒后仍生效） ----

  async webSocketMessage(ws, raw) {
    try {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      const msg = JSON.parse(text);
      if (msg && msg.type === 'ping') {
        // 客户端心跳 → pong（客户端以「收到任意帧」判定连接健康）
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch {}
  }

  async webSocketClose(ws, _code, _reason, _wasClean) {
    // 休眠 API 的连接表由运行时维护，无需手动清理
  }

  async webSocketError(ws, _error) {}
}
