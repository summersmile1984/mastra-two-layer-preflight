/**
 * Outbound fetch helper for L2 → L1 callback / claim paths.
 * Node's global fetch ignores system proxies; when HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 * (or lowercase) is set, route through undici ProxyAgent so Clash/local proxies work on Mac.
 */
import { ProxyAgent } from 'undici';

let cached: { key: string; agent: ProxyAgent } | null = null;

/** Resolve first non-empty standard proxy env (prefer HTTPS for workers.dev callbacks). */
export function resolveProxyUrl(): string | undefined {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (!raw?.trim()) return undefined;
  const url = raw.trim();
  return /:\/\//.test(url) ? url : `http://${url}`;
}

export function proxyDispatcher(): ProxyAgent | undefined {
  const url = resolveProxyUrl();
  if (!url) return undefined;
  if (cached?.key === url) return cached.agent;
  const agent = new ProxyAgent(url);
  cached = { key: url, agent };
  return agent;
}

/** Merge RequestInit with undici dispatcher when a proxy env is set. */
export function withProxy(init: RequestInit = {}): RequestInit {
  const dispatcher = proxyDispatcher();
  if (!dispatcher) return init;
  return { ...init, dispatcher } as RequestInit;
}
