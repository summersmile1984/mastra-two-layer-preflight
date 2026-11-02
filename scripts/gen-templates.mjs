// Writes bundled templates to apps/web/public/templates/*.json (static mirror of /api/templates).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
const src = readFileSync('src/l1/templates.ts', 'utf8');
const body = src.slice(src.indexOf('export const TEMPLATES'), src.indexOf('export function validateTemplate'));
const arr = eval(body.replace(/^export const TEMPLATES: BotTemplate\[\] = /, '').trim().replace(/;$/, ''));
mkdirSync('apps/web/public/templates', { recursive: true });
for (const t of arr) writeFileSync(`apps/web/public/templates/${t.id}.json`, JSON.stringify(t, null, 2) + '\n');
writeFileSync('apps/web/public/templates/index.json', JSON.stringify(arr.map(t => ({ id: t.id, name: t.agent.name, file: `${t.id}.json` })), null, 2) + '\n');
console.log('templates', arr.length);
