// 生成 .mastra/output/.dev.vars（本地 wrangler dev 专用）。
// mastra build 会重建 .mastra/output 把 .dev.vars 清掉——cf:dev 在 build 后调用本脚本补写。
// .mastra/ 已在 .gitignore；wrangler deploy 忽略 .dev.vars，无泄密风险。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

let key = '';
for (const p of ['.env', '../.env', '/Users/macstudio/mastra-two-layer-preflight/.env']) {
  if (existsSync(p)) {
    const m = readFileSync(p, 'utf8').match(/^DEEPSEEK_API_KEY=(.+)$/m);
    if (m) { key = m[1].trim(); break; }
  }
}
mkdirSync('.mastra/output', { recursive: true });
writeFileSync(
  '.mastra/output/.dev.vars',
  [
    'BETTER_AUTH_SECRET=local-dev-secret-0123456789abcdef0123456789ab',
    'BETTER_AUTH_URL=http://localhost:8790',
    'BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173,http://localhost:8790',
    'PUSH_TOKEN=local-dev-token',
    `DEEPSEEK_API_KEY=${key}`,
    '',
  ].join('\n'),
);
console.log(`[cf-dev-vars] wrote .mastra/output/.dev.vars (DEEPSEEK key ${key ? 'present' : 'MISSING'})`);
