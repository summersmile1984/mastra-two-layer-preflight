/**
 * L2 本地工具注册表（expert-forge S2.1）：agent_defs.tools_json 按 id 解析为 createTool 实现。
 * 首期一个内置：web_fetch（安全边界见下）。机制是重点，新工具在此登记即可。
 */
import { createTool } from '@mastra/core/tools';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { withProxy } from './proxy-fetch.js';

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;

function isPrivateIp(ip: string): boolean {
  if (ip === '::' || ip === '::1' || ip === '0.0.0.0') return true;
  // IPv4-mapped IPv6（::ffff:127.0.0.1 等）先还原成 IPv4 再判（评审 MAJOR）
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return isPrivateIp(mapped[1]);
  if (/^fc|^fd|^fe80/i.test(ip)) return true; // IPv6 ULA / link-local
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

async function assertPublicHttp(urlStr: string): Promise<URL> {
  let u: URL;
  try { u = new URL(urlStr); } catch { throw new Error('无效 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅允许 http/https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.internal|.*\.local)$/i.test(host)) throw new Error('禁止访问内网地址');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('禁止访问内网 IP');
    return u;
  }
  // 最佳努力解析后校验（代理环境下解析可能不一致，但挡直连 SSRF）
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('禁止访问内网 IP');
  } catch (e: any) {
    if (String(e?.message).includes('禁止')) throw e;
    // DNS 解析失败交给 fetch 报错
  }
  return u;
}

export const webFetchTool = createTool({
  id: 'web_fetch',
  description: '抓取一个公开网页（http/https）并返回文本内容（截断至 64KB）。用于查资料、读文档。',
  inputSchema: z.object({ url: z.string().describe('要抓取的 URL') }),
  execute: async ({ url }: { url: string }) => {
    // 重定向逐跳校验（评审 MAJOR：redirect:'follow' 会被 302 带进内网）
    let current: URL = await assertPublicHttp(url);
    let r: Response | null = null;
    for (let hop = 0; hop <= 3; hop++) {
      r = await fetch(current, withProxy({
        method: 'GET', redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'MastraL2Expert/0.3' },
      }));
      if (![301, 302, 303, 307, 308].includes(r.status)) break;
      const loc = r.headers.get('location');
      if (!loc) break;
      current = await assertPublicHttp(new URL(loc, current).toString());
    }
    const resp = r!;
    const buf = Buffer.from(await resp.arrayBuffer());
    const text = buf.subarray(0, MAX_BYTES).toString('utf8');
    return { ok: resp.ok, status: resp.status, url: String(current), bytes: buf.length, text: text.slice(0, 65536) };
  },
});

const REGISTRY: Record<string, ReturnType<typeof createTool>> = {
  web_fetch: webFetchTool,
};

/** 按 tools_json 解析工具白名单：`["web_fetch"]` 或 `[{id:"web_fetch", options:{}}]`。 */
export function resolveTools(toolsJson: string | null | undefined): Record<string, ReturnType<typeof createTool>> {
  let list: unknown = [];
  try { list = toolsJson ? JSON.parse(toolsJson) : []; } catch { return {}; }
  const out: Record<string, ReturnType<typeof createTool>> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const id = typeof item === 'string' ? item : String((item as any)?.id ?? '');
    const t = REGISTRY[id];
    if (t) out[id] = t;
  }
  return out;
}
