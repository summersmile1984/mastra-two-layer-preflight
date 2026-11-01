/**
 * L1 侧 A2A 任务登记（taskId → sessionId/state），落盘到 data/tasks.json（原子写 rename）。
 * 重启后仍能把迟到的 A2A push 对上会话并 wake L1。终态记录保留 TASK_TTL_H（默认 24h）后清理；
 * working 超过 TASK_STALE_H（默认 6h）标记为 lost。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type TaskRec = { id: string; sessionId: string; runtime: string; state: string; startedAt: number; updatedAt: number };

export class TaskStore {
  private m = new Map<string, TaskRec>();
  private file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = resolve(dir, 'tasks.json');
    try { for (const r of JSON.parse(readFileSync(this.file, 'utf8')) as TaskRec[]) if (r && typeof r === 'object' && r.id) this.m.set(r.id, r); } catch {}
    this.gc();
    setInterval(() => this.gc(), 10 * 60_000).unref();
  }
  private flush() { const tmp = `${this.file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify([...this.m.values()], null, 1)); renameSync(tmp, this.file); }
  get(id: string) { return this.m.get(id); }
  values() { return [...this.m.values()]; }
  set(r: TaskRec) { this.m.set(r.id, r); this.flush(); }
  update(id: string, patch: Partial<TaskRec>) { const r = this.m.get(id); if (!r) return; Object.assign(r, patch, { updatedAt: Date.now() }); this.flush(); return r; }
  gc() {
    const now = Date.now(), ttl = Number(process.env.TASK_TTL_H ?? 24) * 3.6e6, stale = Number(process.env.TASK_STALE_H ?? 6) * 3.6e6;
    let dirty = false;
    for (const r of this.m.values()) {
      if (r.state === 'working' && now - r.startedAt > stale) { r.state = 'lost'; r.updatedAt = now; dirty = true; }
      else if (r.state !== 'working' && now - r.updatedAt > ttl) { this.m.delete(r.id); dirty = true; }
    }
    if (dirty) this.flush();
  }
}

/** push token 持久化：未设 A2A_PUSH_TOKEN 时生成并存 data/push-token（0600），重启后旧任务回调仍能通过校验 */
export function loadPushToken(dir: string): string {
  if (process.env.A2A_PUSH_TOKEN) return process.env.A2A_PUSH_TOKEN;
  const f = resolve(dir, 'push-token');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  const t = randomUUID(); writeFileSync(f, t, { mode: 0o600 }); chmodSync(f, 0o600); return t;
}
