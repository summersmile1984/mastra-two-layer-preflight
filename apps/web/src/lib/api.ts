export type ApiResult<T = Record<string, unknown>> = {
  ok: boolean
  status: number
  j: T & { error?: string; message?: string; detail?: string }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<ApiResult<T>> {
  const r = await fetch(path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const j = (await r.json().catch(() => ({}))) as T & {
    error?: string
    message?: string
    detail?: string
  }
  return { ok: r.ok, status: r.status, j }
}

export function msgText(c: unknown): string {
  if (typeof c === 'string') {
    try {
      return msgText(JSON.parse(c))
    } catch {
      return c
    }
  }
  if (c && typeof c === 'object') {
    const o = c as { parts?: Array<{ type?: string; text?: string }>; content?: string }
    if (Array.isArray(o.parts)) {
      const t = o.parts.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('')
      if (t) return t
    }
    if (typeof o.content === 'string') return o.content
  }
  return typeof c === 'string' ? c : JSON.stringify(c)
}

export function unturn(s: string) {
  const m = String(s).match(/^<turn[^>]*from_name="([^"]*)"[^>]*>([\s\S]*)<\/turn>$/)
  const d = (x: string) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const fu = String(s).match(/from_user="([^"]*)"/)
  return m
    ? { who: d(m[1]), uid: fu?.[1] ?? null, text: d(m[2]) }
    : { who: null as string | null, uid: null as string | null, text: s }
}

export function unagent(t: unknown) {
  const s = String(t ?? '')
  const m = s.match(/^\s*\[agent:([\w-]+)\]\s*/) || s.match(/\[agent:([\w-]+)\]\s*/)
  if (!m) return { id: 'orchestrator', text: s }
  const id = m[1]
  const text = s.replace(m[0], '').replace(/^\s*\[agent:[\w-]+\]\s*/, '').trim()
  return { id, text }
}
