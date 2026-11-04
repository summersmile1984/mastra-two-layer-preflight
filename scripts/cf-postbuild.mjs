// CloudflareDeployer 不支持 assets 配置：build 后给 .mastra/output/wrangler.json 补 Workers Static Assets。
// 未命中静态文件的请求（/api/*、/health-l1）照常进入 Mastra Worker。
// - cf-public/          → static/        （根路径旧流式 demo，保留）
// - apps/web/dist/      → static/app/    （现行 SPA，登录 + 房间 + 聊天）
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
const out = '.mastra/output';
rmSync(`${out}/static`, { recursive: true, force: true });
cpSync('cf-public', `${out}/static`, { recursive: true });

// SPA（apps/web 构建产物，base=/app/）
const webDist = 'apps/web/dist';
if (existsSync(`${webDist}/index.html`)) {
  mkdirSync(`${out}/static/app`, { recursive: true });
  cpSync(webDist, `${out}/static/app`, { recursive: true });
  console.log('[cf-postbuild] SPA apps/web/dist -> ./static/app');
} else {
  console.log('[cf-postbuild] WARN: apps/web/dist 未找到，跳过 SPA（先跑 npm run web:build）');
}

const f = `${out}/wrangler.json`;
const w = JSON.parse(readFileSync(f, 'utf8'));
// html_handling:auto-trailing-slash 让 /app 命中 app/index.html；SPA 无服务端兜底路由，not_found 交 Worker
w.assets = { directory: './static', html_handling: 'auto-trailing-slash', not_found_handling: 'none' };
writeFileSync(f, JSON.stringify(w, null, 2));
console.log('[cf-postbuild] assets -> ./static');
