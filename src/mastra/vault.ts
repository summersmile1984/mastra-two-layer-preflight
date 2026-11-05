// 密钥保管（schedules-secrets spec S2.3）：密钥本体托管 Cloudflare Secrets Store（store: vault），
// D1 vault_meta 只存元数据——不落任何明文/密文。运行时经 CF REST API 增删（CLOUDFLARE_API_KEY）。
// TTL 语义：expires_at 过期即视为不存在（HITL 短时 vault 的地基）。
const CF_API = 'https://api.cloudflare.com/client/v4';

export type VaultMeta = {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  secret_id: string;
  secret_name: string;
  created_at: number;
  expires_at: number | null;
  created_by: string | null;
};

const LIMITS = { name: 100, kind: 40, value: 8000 };

export async function ensureVaultTable(db: any): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS vault_meta (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        secret_id TEXT NOT NULL, secret_name TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER, created_by TEXT)`,
    )
    .run();
}

function api(env: any, path: string, init?: RequestInit) {
  return fetch(`${CF_API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_KEY}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

export function vaultOut(r: any) {
  return {
    id: r.id, name: r.name, kind: r.kind, secret_name: r.secret_name,
    created_at: r.created_at, expires_at: r.expires_at ?? null,
    expired: r.expires_at ? Number(r.expires_at) < Date.now() : false,
  };
}

export async function createVaultEntry(env: any, db: any, userId: string, input: any, createdBy: string): Promise<VaultMeta | { error: string }> {
  const name = String(input?.name ?? '').trim().slice(0, LIMITS.name);
  const value = String(input?.value ?? '');
  const kind = String(input?.kind ?? 'generic').trim().slice(0, LIMITS.kind) || 'generic';
  const ttl = Number(input?.ttl ?? 0);
  if (!name) return { error: 'name required' };
  if (!value) return { error: 'value required' };
  if (value.length > LIMITS.value) return { error: 'value too long' };
  const id = `vault-${crypto.randomUUID()}`;
  const secretName = `vault__${userId}__${id}`;
  const storeId = String(env.VAULT_STORE_ID ?? '');
  let created: any;
  try {
    const res = await api(env, `/secrets_store/stores/${storeId}/secrets`, {
      method: 'POST',
      body: JSON.stringify([{ name: secretName, value, scopes: ['workers'] }]),
    });
    const body: any = await res.json().catch(() => ({}));
    created = body?.result?.[0];
    if (!body?.success || !created?.id) return { error: `secrets-store create failed: ${JSON.stringify(body?.errors ?? []).slice(0, 160)}` };
  } catch (e: any) {
    return { error: `secrets-store unreachable: ${String(e?.message ?? e).slice(0, 120)}` };
  }
  const row: VaultMeta = {
    id, user_id: userId, name, kind,
    secret_id: String(created.id), secret_name: secretName,
    created_at: Date.now(), expires_at: ttl > 0 ? Date.now() + ttl * 1000 : null,
    created_by: createdBy,
  };
  try {
    await db
      .prepare('INSERT INTO vault_meta (id,user_id,name,kind,secret_id,secret_name,created_at,expires_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(row.id, row.user_id, row.name, row.kind, row.secret_id, row.secret_name, row.created_at, row.expires_at, row.created_by)
      .run();
  } catch (e: any) {
    // D1 写失败则回滚 Secrets Store，避免孤儿密钥
    try { await api(env, `/secrets_store/stores/${storeId}/secrets/${created.id}`, { method: 'DELETE' }); } catch {}
    return { error: `vault_meta write failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }
  return row;
}

export async function listVaultEntries(db: any, userId: string): Promise<VaultMeta[]> {
  const { results } = await db.prepare('SELECT * FROM vault_meta WHERE user_id=? ORDER BY created_at DESC').bind(userId).all();
  const now = Date.now();
  return ((results ?? []) as VaultMeta[]).filter((r) => !r.expires_at || Number(r.expires_at) >= now);
}

export async function deleteVaultEntry(env: any, db: any, userId: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const row: any = await db.prepare('SELECT * FROM vault_meta WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!row) return { ok: false, error: 'not found' };
  const storeId = String(env.VAULT_STORE_ID ?? '');
  try {
    // fetch 不会因 HTTP 错误抛错——必须校验响应，否则 CF 删失败仍删行会留下孤儿密钥
    const res = await api(env, `/secrets_store/stores/${storeId}/secrets/${row.secret_id}`, { method: 'DELETE' });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body?.success === false) {
      return { ok: false, error: `secrets-store delete failed: ${JSON.stringify(body?.errors ?? []).slice(0, 140)}` };
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
  await db.prepare('DELETE FROM vault_meta WHERE id=?').bind(id).run();
  return { ok: true };
}

/** 单条读取（S2.3）：过期即视为不存在。 */
export async function getVaultEntry(db: any, userId: string, id: string): Promise<VaultMeta | null> {
  const row: any = await db.prepare('SELECT * FROM vault_meta WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!row) return null;
  if (row.expires_at && Number(row.expires_at) < Date.now()) return null;
  return row as VaultMeta;
}

/** 过期清扫（并入 schedules cron tick）：过期条目连密钥一起删。 */
export async function purgeExpiredVault(env: any, db: any): Promise<number> {
  const { results } = await db.prepare('SELECT * FROM vault_meta WHERE expires_at IS NOT NULL AND expires_at < ?').bind(Date.now()).all();
  let n = 0;
  for (const r of (results ?? []) as VaultMeta[]) {
    if ((await deleteVaultEntry(env, db, r.user_id, r.id)).ok) n++;
  }
  return n;
}
