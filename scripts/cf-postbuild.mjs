// CloudflareDeployer 不支持 assets 配置：build 后给 .mastra/output/wrangler.json 补 Workers Static Assets。
// 未命中静态文件的请求（/api/*、/health-l1）照常进入 Mastra Worker。
import { cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
const out = '.mastra/output';
rmSync(`${out}/static`, { recursive: true, force: true });
cpSync('cf-public', `${out}/static`, { recursive: true });
const f = `${out}/wrangler.json`;
const w = JSON.parse(readFileSync(f, 'utf8'));
w.assets = { directory: './static', html_handling: 'auto-trailing-slash', not_found_handling: 'none' };
writeFileSync(f, JSON.stringify(w, null, 2));
console.log('[cf-postbuild] assets -> ./static');
