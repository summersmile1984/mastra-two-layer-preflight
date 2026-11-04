/**
 * T0 探针路由（临时，PROBE_ROUTES=1 时启用）：
 * 验证 registerApiRoute handler 返回的流式 Response / WS 101 能否原样穿过
 * Mastra 分发层（handleCustomRouteRequest → return response）。
 * /probe/sse —— text/event-stream 流式推送 3 块
 * /probe/ws  —— WebSocketPair 101 升级并 echo（与 DO 升级返回同构的 Response）
 */
import { registerApiRoute } from '@mastra/core/server';
import { env as cfEnv } from 'cloudflare:workers';

export function probeRoutes() {
  return [
    registerApiRoute('/probe/sse', {
      method: 'GET',
      requiresAuth: false,
      handler: async () => {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            for (let i = 1; i <= 3; i++) {
              controller.enqueue(enc.encode(`data: {"type":"chunk","i":${i}}\n\n`));
              await new Promise((r) => setTimeout(r, 200));
            }
            controller.enqueue(enc.encode(`data: {"type":"done"}\n\n`));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
        });
      },
    } as any),
    registerApiRoute('/probe/ws', {
      method: 'GET',
      requiresAuth: false,
      handler: async () => {
        const pair = new (globalThis as any).WebSocketPair();
        const [client, server] = Object.values(pair) as any[];
        server.accept();
        server.addEventListener('message', (e: any) => {
          try {
            server.send(JSON.stringify({ echo: e.data }));
          } catch {}
        });
        return new Response(null, { status: 101, webSocket: client } as any);
      },
    } as any),
    registerApiRoute('/probe/do-ws', {
      method: 'GET',
      requiresAuth: false,
      handler: async (c: any) => {
        // 走真 RoomDO（Hibernation accept）：把升级请求转给 DO stub
        const stub = (cfEnv as any).ROOM_DO?.getByName?.('probe-room');
        if (!stub) return new Response('ROOM_DO not bound', { status: 500 });
        return stub.fetch(c.req.raw ?? new Request('http://do/probe'));
      },
    } as any),
  ];
}
