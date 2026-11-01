/**
 * 独立 L2 进程（默认 4121）：只跑 A2A 服务端 + ACP harness（dsh），不含 L1/UI。
 *   POST /api/a2a/l2-worker               A2A JSON-RPC（message/send blocking:false + pushNotificationConfig）
 *   GET  /api/.well-known/l2-worker/agent-card.json
 *   GET  /api/health
 * push 回调策略：
 *   L2_PUSH_ALLOWLIST=url1,url2  → AllowlistedPushSender（精确匹配；本机/127.0.0.1 回调必须用这个）
 *   未设置                        → Mastra 官方 DefaultPushNotificationSender（带 SSRF 防护，仅公网 https）
 * 注意：HITL 密码（secretRef→env）的明文保管在 L1 进程内存；跨进程拆分后不会传到 L2（设计如此，见 ARCHITECTURE.md）。
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Mastra } from '@mastra/core';
import { acpProfile } from './l2/acp-worker';
import { AllowlistedPushSender, buildL2Agent, L2_AGENT_ID, makeA2ARoutes, commandExists, a2aLog } from './l2/a2a-l2';

const PORT = Number(process.env.L2_PORT ?? process.env.PORT ?? 4121);
const PUBLIC = (process.env.L2_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const allow = (process.env.L2_PUSH_ALLOWLIST ?? '').split(',').map(s => s.trim()).filter(Boolean);
const sender = allow.length ? new AllowlistedPushSender(allow) : undefined;

const mastra = new Mastra({ logger: false, agents: { [L2_AGENT_ID]: buildL2Agent() } });
const app = new Hono();
app.get('/api/health', c => c.json({
  ok: true, role: 'l2', port: PORT, agent: L2_AGENT_ID, pushSender: sender ? `allowlist(${allow.length})` : 'official-default',
  harness: { cloud: commandExists(acpProfile('cloud').command), local: commandExists(acpProfile('local').command), dryRun: process.env.ACP_DRY_RUN === '1' },
  deepseekKey: !!process.env.DEEPSEEK_API_KEY,
}));
if (process.env.DEV_ENDPOINTS === '1') app.get('/api/a2a-log', c => c.json(a2aLog));
makeA2ARoutes(app, mastra, sender, PUBLIC);

serve({ fetch: app.fetch, port: PORT, hostname: process.env.HOST ?? '0.0.0.0' }, () =>
  console.log(`L2 (A2A+ACP) on http://localhost:${PORT}/api/a2a/${L2_AGENT_ID}  push=${sender ? 'allowlist' : 'official'}`));
