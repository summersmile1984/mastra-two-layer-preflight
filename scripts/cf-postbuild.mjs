// CloudflareDeployer 不支持 assets/DO/AI/Vectorize 配置：build 后给 .mastra/output/wrangler.json 补齐。
// 未命中静态文件的请求（/rooms/*、/auth/*、/health-l1 等自定义路由）照常进入 Mastra Worker。
// - apps/web/dist/      → static/        （SPA：登录 + 房间 + 聊天，根路径唯一入口）
// - room-do.js          → worker-entry.mjs 重导出 RoomDO（mastra 入口只导出 default { fetch }，
//                          DO 类穿不过；wrangler DO 绑定要求类从 main 模块导出，见 spec S2.8.1）
// - AI + VECTORIZE(om-memory)：OM 语义召回的嵌入与向量库（observational-memory spec S2.7）
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
const out = '.mastra/output';
rmSync(`${out}/static`, { recursive: true, force: true });

// SPA（apps/web 构建产物，base=/）
const webDist = 'apps/web/dist';
if (existsSync(`${webDist}/index.html`)) {
  cpSync(webDist, `${out}/static`, { recursive: true });
  console.log('[cf-postbuild] SPA apps/web/dist -> ./static (root)');
} else {
  console.log('[cf-postbuild] WARN: apps/web/dist 未找到，跳过 SPA（先跑 npm run web:build）');
}

// RoomDO：拷入产物 + 生成 worker-entry.mjs 重导出
copyFileSync('src/mastra/room-do.js', `${out}/room-do.js`);
writeFileSync(
  `${out}/worker-entry.mjs`,
  [
    "// 生成文件（cf-postbuild.mjs）：DO 类必须从 wrangler main 模块导出。",
    "import base from './index.mjs';",
    "export { RoomDO } from './room-do.js';",
    "// OM 队列消费者（S2.8）与定时任务 tick（S2.1）：挂到 default 导出对象 + 具名导出；",
    "// 逻辑经 globalThis 注册表转发（mastra build 只保留 mastra/default 导出）。",
    "async function queue(batch, env, ctx) {",
    "  const handler = (globalThis).__omQueueHandler;",
    "  if (!handler) { for (const m of batch?.messages ?? []) { try { m.retry(); } catch {} } return; }",
    "  await handler(batch);",
    "}",
    "async function scheduled(event, env, ctx) {",
    "  const handler = (globalThis).__schedulesTick;",
    "  if (handler) await handler();",
    "}",
    "export { queue, scheduled };",
    "export default { ...base, queue, scheduled };",
    '',
  ].join('\n'),
);
console.log('[cf-postbuild] RoomDO -> worker-entry.mjs');

const f = `${out}/wrangler.json`;
const w = JSON.parse(readFileSync(f, 'utf8'));
// html_handling:auto-trailing-slash 让 / 命中 index.html；SPA 无服务端兜底路由，not_found 交 Worker
w.assets = { directory: './static', html_handling: 'auto-trailing-slash', not_found_handling: 'none' };
// main 重指 worker-entry（重导出 RoomDO 供 DO 绑定）
w.main = './worker-entry.mjs';
w.durable_objects = { bindings: [{ name: 'ROOM_DO', class_name: 'RoomDO' }] };
w.migrations = [{ tag: 'v1', new_sqlite_classes: ['RoomDO'] }];
w.ai = { binding: 'AI' };
// Paid 套餐显式锁 30s CPU（免费版曾拒绝此配置，API 100328）
w.limits = { cpu_ms: 30000 };
// Workers AI provider（Mastra provider-registry）鉴权：CLOUDFLARE_API_KEY secret + 账号 ID
w.vars = { ...(w.vars ?? {}), CLOUDFLARE_ACCOUNT_ID: '8a1dca996a18a595f0b931f106539248' };
// Secrets Store（schedules-secrets S2.3）：vault 密钥托管
w.vars.VAULT_STORE_ID = '450ea560af844a8d856197dd7ffa64ca';
w.secrets_store = [{ binding: 'VAULT_STORE', store_id: '450ea560af844a8d856197dd7ffa64ca' }];
w.vectorize = [
  { binding: 'VECTORIZE', index_name: 'om-memory' },
  { binding: 'VECTORIZE_OBS', index_name: 'om-memory-obs' },
];
// OM 周期走队列（S2.8）：请求侧只入队，consumer 独立 invocation 跑 Observer/Reflector
w.queues = {
  producers: [{ queue: 'om-cycles', binding: 'OM_QUEUE' }],
  consumers: [{ queue: 'om-cycles', max_retries: 10, retry_delay: 30 }],
};
// 定时任务（schedules-secrets S2.1）：每分钟 tick
w.triggers = { crons: ['* * * * *'] };
writeFileSync(f, JSON.stringify(w, null, 2));
console.log('[cf-postbuild] assets -> ./static, main -> ./worker-entry.mjs, DO ROOM_DO, AI + VECTORIZE + queues(om-cycles)');
