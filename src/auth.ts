/**
 * better-auth（邮箱 + 密码）挂在 CF Worker 上，存储 D1（与 l2_tasks 同库）。
 * 路由：POST /api/auth/* → auth.handler（fetch 兼容）；业务路由用 requireSession 取当前用户。
 * DEV 旁路：AUTH_DEV_MODE=1 时允许 Authorization: Bearer <PUSH_TOKEN> 直接放行（本地调试免注册）。
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';

export type AuthEnv = {
  DB: any; // D1Database
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string; // 逗号分隔；跨源 SPA 时必配
  L1_PUBLIC_URL?: string;
  PUSH_TOKEN?: string;
  AUTH_DEV_MODE?: string;
};

let cached: { key: string; auth: ReturnType<typeof betterAuth> } | null = null;

export function getAuth(E: AuthEnv) {
  const key = String(E.BETTER_AUTH_SECRET ?? '');
  if (cached && cached.key === key) return cached.auth;
  const db = drizzle(E.DB, { schema });
  const baseURL = E.BETTER_AUTH_URL || E.L1_PUBLIC_URL || 'https://mastra-l1.summersmile1984.workers.dev';
  const trusted = (E.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const auth = betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema, usePlural: false }),
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    secret: E.BETTER_AUTH_SECRET,
    baseURL,
    // 跨源 SPA（本地 dev：vite 5173 → API 8787）需要 trustedOrigins；同源生产可不配
    ...(trusted.length ? { trustedOrigins: trusted } : {}),
    // http（本地 dev）下 __Secure- 前缀 cookie 会被浏览器拒收，仅 https 强制 secure
    advanced: { useSecureCookies: baseURL.startsWith('https:') },
  } as any);
  cached = { key, auth };
  return auth;
}

export type SessionUser = { id: string; email: string; name?: string };

/** 把 Request | HonoRequestLike | {headers} 规整成标准 Headers。 */
function toHeaders(req: Request | { headers?: any; header?: (n: string) => string | undefined }): Headers {
  if (req instanceof Request) return req.headers;
  const h = (req as any)?.headers;
  if (h instanceof Headers) return h;
  if (h && typeof h === 'object') {
    const out = new Headers();
    for (const [k, v] of Object.entries(h)) if (v != null) out.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    return out;
  }
  return new Headers();
}

/** 从请求头解析当前用户；DEV 旁路返回合成人。未登录返回 null。 */
export async function getSessionUser(req: Request | { headers?: any; header?: (n: string) => string | undefined }, E: AuthEnv): Promise<SessionUser | null> {
  const headers = toHeaders(req);
  if (E.AUTH_DEV_MODE === '1') {
    const auth = headers.get('Authorization') ?? '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : headers.get('X-A2A-Notification-Token') ?? '';
    if (tok && E.PUSH_TOKEN && tok === E.PUSH_TOKEN) return { id: 'dev-user', email: 'dev@local', name: 'DEV' };
  }
  try {
    const auth = getAuth(E);
    const s: any = await (auth.api as any).getSession({ headers });
    if (s?.user?.id) return { id: String(s.user.id), email: String(s.user.email ?? ''), name: s.user.name ? String(s.user.name) : undefined };
    return null;
  } catch (e: any) {
    console.log('[auth] getSession error', String(e?.message ?? e).slice(0, 120));
    return null;
  }
}

/** 路由守卫：返回用户或抛 401 标记。 */
export async function requireSession(req: Request | { headers: Headers }, E: AuthEnv): Promise<SessionUser> {
  const u = await getSessionUser(req, E);
  if (!u) throw new AuthError(401, 'unauthorized');
  return u;
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Mastra server auth 配置：锁住内置 /api/*（含 /api/agents/*），避免未登录白用 agent。
 * authenticateToken 从 cookie 读 better-auth 会话（忽略空 Bearer）；无会话返回 null → 401。
 * /api/auth/* 由 defaultAuthConfig.public 放行；/api/rooms/* 自带 requireSession。
 */
export function buildMastraAuth(E: AuthEnv) {
  return {
    // 默认 protected: ['/api/*'] 已覆盖 /api/agents/*；public 里 /api/auth/* 留给登录注册
    authenticateToken: async (_token: string, request: any): Promise<SessionUser> => {
      const u = await getSessionUser(request, E);
      if (!u) throw new AuthError(401, 'unauthorized');
      return u;
    },
    mapUserToResourceId: (user: SessionUser) => String(user.id),
  };
}
