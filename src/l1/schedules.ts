/**
 * 定时任务（schedules）— 纯 cron/时区逻辑 + D1 表操作。
 * 路由由 orchestrator 用 Hono `c.json` 挂载，本模块不产出 Response。
 * Cron：标准 5 字段（min hour dom mon dow）；预设名（every_minute 等）解析为 cron 串。
 * 时区默认 Asia/Shanghai；target 本产品仅 room（主会话 = is_main=1 的房间），butler/expert 后续切片放开。
 */
export type TargetType = 'room';
export type ScheduleRow = {
  id: string; user_id: string; name: string; cron: string; timezone: string; prompt: string;
  target_type: TargetType; target_id: string | null; enabled: number;
  next_run_at: number | null; last_run_at: number | null; created_at: number; updated_at: number;
};

export type SchedulePatch = {
  name?: string; cron?: string; timezone?: string; prompt?: string;
  target_type?: TargetType; target_id?: string | null; enabled?: boolean;
};

const now = () => Date.now();
const CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;
export const PRESETS: Record<string, string> = {
  every_minute: '* * * * *',
  hourly: '0 * * * *',
  daily_9: '0 9 * * *',
  weekdays_9: '0 9 * * 1-5',
  weekly_mon_9: '0 9 * * 1',
};

/** 预设名（every_minute 等）→ cron 串；本身是 cron 串则原样返回。 */
function resolveCron(cron: string): string {
  const t = String(cron ?? '').trim();
  return PRESETS[t] ?? t;
}

export function out(r: ScheduleRow) {
  return {
    id: r.id, name: r.name, cron: r.cron, timezone: r.timezone, prompt: r.prompt,
    target_type: r.target_type, target_id: r.target_id, enabled: !!r.enabled,
    next_run_at: r.next_run_at, last_run_at: r.last_run_at, created_at: r.created_at, updated_at: r.updated_at,
  };
}

/** Parts matching for a 5-field cron token against a numeric value (0-based dow: Sun=0). */
function matchField(tok: string, val: number, min: number, max: number): boolean {
  if (tok === '*') return true;
  for (const part of tok.split(',')) {
    const stepM = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!stepM) continue;
    const step = stepM[2] ? Number(stepM[2]) : 1;
    let start = min, end = max;
    if (stepM[1] !== '*') {
      const r = stepM[1].split('-').map(Number);
      start = r[0]; end = r.length > 1 ? r[1] : r[0];
    }
    if (val < start || val > end) continue;
    if ((val - start) % step === 0) return true;
  }
  return false;
}

/** Wall-clock parts in a named IANA timezone (fallback UTC+8 for Asia/Shanghai). */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function zonedParts(ms: number, tz = 'Asia/Shanghai') {
  try {
    // Intl.DateTimeFormat 构造开销大，按 tz 缓存（cron 扫描每分钟都会走到这里）
    let fmt = fmtCache.get(tz);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
      });
      fmtCache.set(tz, fmt);
    }
    const map: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== 'literal') map[p.type] = p.value;
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      year: Number(map.year), month: Number(map.month), day: Number(map.day),
      hour: Number(map.hour), minute: Number(map.minute), second: Number(map.second),
      dow: dowMap[map.weekday] ?? 0,
    };
  } catch {
    const d = new Date(ms + 8 * 3600_000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), dow: d.getUTCDay() };
  }
}

export function cronMatches(cron: string, ms: number, tz = 'Asia/Shanghai'): boolean {
  const m = resolveCron(cron).match(CRON_RE);
  if (!m) return false;
  const p = zonedParts(ms, tz);
  return matchField(m[1], p.minute, 0, 59) && matchField(m[2], p.hour, 0, 23)
    && matchField(m[3], p.day, 1, 31) && matchField(m[4], p.month, 1, 12) && matchField(m[5], p.dow, 0, 6);
}

/** fromMs 之后下一次命中的墙钟时间（分钟粒度，最多扫描 400 天）；永不命中返回 null。 */
export function computeNextRunAt(cron: string, timezone: string, fromMs: number): number | null {
  const c = resolveCron(cron);
  if (!CRON_RE.test(c)) return null;
  const tz = timezone || 'Asia/Shanghai';
  const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 60 * 24 * 400; i++) {
    const t = start + i * 60_000;
    if (cronMatches(c, t, tz)) return t;
  }
  return null;
}

export function validateCron(cron: string): string | null {
  const c = resolveCron(cron);
  if (!CRON_RE.test(c)) return 'cron must be 5-field (min hour dom mon dow)';
  if (computeNextRunAt(c, 'Asia/Shanghai', Date.now()) == null) return 'cron never matches';
  return null;
}

// ---------- D1 表操作（db = D1 绑定；校验失败抛 Error，未找到返回 null/false） ----------

export async function listSchedules(db: any, userId: string) {
  const { results } = await db
    .prepare('SELECT * FROM schedules WHERE user_id=? ORDER BY created_at DESC')
    .bind(userId).all();
  return ((results as ScheduleRow[]) || []).map(out);
}

export async function getSchedule(db: any, userId: string, id: string) {
  const row: any = await db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=?').bind(id, userId).first();
  return row ? out(row as ScheduleRow) : null;
}

export async function createSchedule(db: any, userId: string, patch: SchedulePatch) {
  const name = String(patch.name ?? '').trim().slice(0, 100);
  const prompt = String(patch.prompt ?? '').trim().slice(0, 4000);
  const cron = resolveCron(patch.cron ?? '');
  const timezone = String(patch.timezone || 'Asia/Shanghai').slice(0, 60);
  const target_type = (patch.target_type ?? 'room') as TargetType;
  const target_id = patch.target_id == null || patch.target_id === '' ? null : String(patch.target_id).slice(0, 64);
  if (!name || !prompt) throw new Error('name and prompt required');
  if (target_type !== 'room') throw new Error('bad target_type');
  const err = validateCron(cron);
  if (err) throw new Error(err);
  const id = `sch-${crypto.randomUUID().slice(0, 10)}`;
  const t = now();
  const next = computeNextRunAt(cron, timezone, t);
  const enabled = patch.enabled === false ? 0 : 1;
  await db
    .prepare(
      `INSERT INTO schedules (id,user_id,name,cron,timezone,prompt,target_type,target_id,enabled,next_run_at,last_run_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
    )
    .bind(id, userId, name, cron, timezone, prompt, target_type, target_id, enabled, next, t, t).run();
  return (await getSchedule(db, userId, id))!;
}

export async function updateSchedule(db: any, userId: string, id: string, patch: SchedulePatch) {
  const row: any = await db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!row) return null;
  const name = patch.name != null ? String(patch.name).trim().slice(0, 100) : row.name;
  const cron = patch.cron != null ? resolveCron(patch.cron) : row.cron;
  const timezone = patch.timezone != null ? String(patch.timezone).slice(0, 60) : row.timezone;
  const prompt = patch.prompt != null ? String(patch.prompt).trim().slice(0, 4000) : row.prompt;
  const target_type = (patch.target_type != null ? patch.target_type : row.target_type) as TargetType;
  const target_id = patch.target_id !== undefined ? (patch.target_id ? String(patch.target_id).slice(0, 64) : null) : row.target_id;
  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : row.enabled;
  if (!name || !prompt) throw new Error('name and prompt required');
  if (target_type !== 'room') throw new Error('bad target_type');
  const err = validateCron(cron);
  if (err) throw new Error(err);
  const t = now();
  const next = computeNextRunAt(cron, timezone, t);
  await db
    .prepare(
      `UPDATE schedules SET name=?,cron=?,timezone=?,prompt=?,target_type=?,target_id=?,enabled=?,next_run_at=?,updated_at=?
       WHERE id=? AND user_id=?`,
    )
    .bind(name, cron, timezone, prompt, target_type, target_id, enabled, next, t, id, userId).run();
  return await getSchedule(db, userId, id);
}

export async function deleteSchedule(db: any, userId: string, id: string) {
  const r = await db.prepare('DELETE FROM schedules WHERE id=? AND user_id=?').bind(id, userId).run();
  const ok = !!r?.meta?.changes;
  if (ok) await db.prepare('DELETE FROM schedule_runs WHERE schedule_id=?').bind(id).run();
  return ok;
}

export async function listRuns(db: any, userId: string, scheduleId: string, limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const { results } = await db
    .prepare('SELECT id,status,detail,created_at FROM schedule_runs WHERE schedule_id=? AND user_id=? ORDER BY created_at DESC LIMIT ?')
    .bind(scheduleId, userId, n).all();
  return results ?? [];
}

export async function dueSchedules(db: any, nowMs: number) {
  const { results } = await db
    .prepare('SELECT * FROM schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at')
    .bind(nowMs).all();
  return (results as ScheduleRow[]) || [];
}

/** 写一条运行记录并更新 last_run_at；返回 runId。 */
export async function markRun(db: any, a: { scheduleId: string; userId: string; status: string; detail?: string | null }) {
  const t = now();
  const runId = `sr-${crypto.randomUUID().slice(0, 12)}`;
  await db
    .prepare('INSERT INTO schedule_runs (id,schedule_id,user_id,status,detail,created_at) VALUES (?,?,?,?,?,?)')
    .bind(runId, a.scheduleId, a.userId, a.status, a.detail ?? null, t).run();
  await db.prepare('UPDATE schedules SET last_run_at=?, updated_at=? WHERE id=? AND user_id=?')
    .bind(t, t, a.scheduleId, a.userId).run();
  return runId;
}

/** 按 cron/时区重算并持久化 next_run_at（算不出就写 null，保持 enabled 不动）。 */
export async function advanceSchedule(db: any, id: string, nowMs: number): Promise<number | null> {
  const row: any = await db.prepare('SELECT * FROM schedules WHERE id=?').bind(id).first();
  if (!row) return null;
  const next = computeNextRunAt(row.cron, row.timezone || 'Asia/Shanghai', nowMs);
  await db.prepare('UPDATE schedules SET next_run_at=?, updated_at=? WHERE id=?').bind(next, nowMs, id).run();
  return next;
}
