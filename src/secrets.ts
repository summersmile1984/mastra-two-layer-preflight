/**
 * 服务端密钥保管（HITL 收密）。明文只在本进程内存，TTL 到期清除，从不写日志/DB/SSE。
 * - 模型只看到 `secret:xxxxxxxx` 句柄（tool resumeData 只含句柄 → 持久化快照里也只有句柄）。
 * - 派发 L2 时：prompt 里的句柄被替换为环境变量名，明文经 bindTaskSecrets → ACP 子进程 env，仅该次任务；任务结束 releaseTaskSecrets 清除。
 */
import { randomUUID } from 'node:crypto';

const vault = new Map<string, { value: string; label: string; expires: number }>();
const taskEnv = new Map<string, Record<string, string>>();
const TTL = 10 * 60_000;
setInterval(() => { const now = Date.now(); for (const [k, v] of vault) if (v.expires < now) vault.delete(k); }, 60_000).unref();

export function storeSecret(value: string, label: string): string {
  const ref = `secret:${randomUUID().slice(0, 8)}`;
  vault.set(ref, { value, label, expires: Date.now() + TTL });
  return ref;
}
export const REF_RE = /secret:[0-9a-f]{8}/g;

/** 把 prompt 中的 secretRef 换成 env 变量名，返回 { prompt, bindingId }；明文挂到 bindingId 下 */
export function bindTaskSecrets(prompt: string): { prompt: string; bindingId?: string } {
  const refs = [...new Set(prompt.match(REF_RE) ?? [])].filter(r => vault.has(r));
  if (!refs.length) return { prompt };
  const bindingId = randomUUID().slice(0, 12);
  const env: Record<string, string> = {};
  let p = prompt;
  refs.forEach((r, i) => { const name = `L2_SECRET_${i + 1}`; env[name] = vault.get(r)!.value; vault.delete(r); /* 一次性 */ p = p.split(r).join(`$${name}`); });
  taskEnv.set(bindingId, env);
  setTimeout(() => taskEnv.delete(bindingId), 30 * 60_000).unref();
  return { prompt: `${p}\n[secret-binding:${bindingId}]（敏感值在环境变量 ${Object.keys(env).join(', ')} 中，直接引用，不要打印其值）`, bindingId };
}
export function takeTaskSecrets(prompt: string): { prompt: string; env?: Record<string, string>; bindingId?: string } {
  const m = prompt.match(/\[secret-binding:([0-9a-f-]{12})\]/);
  if (!m) return { prompt };
  return { prompt, env: taskEnv.get(m[1]), bindingId: m[1] };
}
export const releaseTaskSecrets = (bindingId?: string) => { if (bindingId) taskEnv.delete(bindingId); };
/** 用于日志/SSE 的兜底脱敏：把仍在保管中的明文替换成 *** */
export function redactKnownSecrets(s: string): string {
  let out = s;
  for (const v of vault.values()) if (v.value.length >= 4) out = out.split(v.value).join('***');
  for (const env of taskEnv.values()) for (const v of Object.values(env)) if (v.length >= 4) out = out.split(v).join('***');
  return out;
}
