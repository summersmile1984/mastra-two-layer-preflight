/**
 * L1 on Cloudflare Workers (P0)：官方 CloudflareDeployer + D1。
 * 仅用于 `mastra build`；本地 Node 版仍走 src/server.ts。
 */
import { env } from 'cloudflare:workers';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { registerApiRoute } from '@mastra/core/server';
import { CloudflareDeployer } from '@mastra/deployer-cloudflare';
import { D1Store } from '@mastra/cloudflare-d1';
import { Memory } from '@mastra/memory';

const orchestrator = new Agent({
  id: 'orchestrator',
  name: 'orchestrator',
  instructions: '你是 L1 总管，简短中文回复；闲聊直接回。',
  model: 'deepseek/deepseek-chat',
  // 会话记忆：使用 Mastra 实例的 D1Store；thread = 前端 sid
  memory: new Memory({ options: { lastMessages: 20 } }),
});

export const mastra = new Mastra({
  agents: { orchestrator },
  storage: new D1Store({ id: 'l1-d1', binding: (env as any).DB }),
  deployer: new CloudflareDeployer({
    name: 'mastra-l1',
    compatibility_date: '2026-10-01',
    compatibility_flags: ['nodejs_compat'],
    vars: { NODE_ENV: 'production' },
    d1_databases: [{ binding: 'DB', database_name: 'mastra-l1', database_id: '26a19832-8ff9-4fe4-a253-9305ae02f6bb' }],
  } as any),
  server: {
    apiRoutes: [
      registerApiRoute('/health-l1', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c) => c.json({ ok: true, role: 'l1-mastra-cf' }),
      } as any),
    ],
  },
});
