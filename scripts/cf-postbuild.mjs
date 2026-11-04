// CloudflareDeployer 不支持 assets/DO 配置：build 后给 .mastra/output/wrangler.json 补齐。
// 未命中静态文件的请求（/rooms/*、/auth/*、/health-l1 等自定义路由）照常进入 Mastra Worker。
// - apps/web/dist/      → static/        （SPA：登录 + 房间 + 聊天，根路径唯一入口）
// - room-do.js          → worker-entry.mjs 重导出 RoomDO（mastra 入口只导出 default { fetch }，
//                          DO 类穿不过；wrangler DO 绑定要求类从 main 模块导出，见 spec S2.8.1）
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
    "export { default } from './index.mjs';",
    "export * from './index.mjs';",
    "export { RoomDO } from './room-do.js';",
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
writeFileSync(f, JSON.stringify(w, null, 2));
console.log('[cf-postbuild] assets -> ./static, main -> ./worker-entry.mjs, DO binding ROOM_DO');
