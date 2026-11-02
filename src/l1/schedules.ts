/**
 * Product scheduled tasks (定时任务). D1 + Workers cron — not Mastra Workflows EE.
 * Cron: standard 5-field (min hour dom mon dow). Timezone default Asia/Shanghai.
 */
export type TargetType = 'butler' | 'room' | 'expert';
export type ScheduleRow = {
  id: string; user_id: string; name: string; cron: string; timezone: string; prompt: string;
  target_type: TargetType; target_id: string | null; enabled: number;
  next_run_at: number | null; last_run_at: number | null; created_at: number; updated_at: number;
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const now = () => Date.now();
const CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;
const PRESETS: Record<string, string> = {
  every_minute: '* * * * *',
  hourly: '0 * * * *',
  daily_9: '0 9 * * *',
  weekdays_9: '0 9 * * 1-5',
  weekly_mon_9: '0 9 * * 1',
};

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
export function zonedParts(ms: number, tz = 'Asia/Shanghai') {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
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
  const m = cron.trim().match(CRON_RE);
  if (!m) return false;
  const p = zonedParts(ms, tz);
  return matchField(m[1], p.minute, 0, 59) && matchField(m[2], p.hour, 0, 23)
    && matchField(m[3], p.day, 1, 31) && matchField(m[4], p.month, 1, 12) && matchField(m[5], p.dow, 0, 6);
}

/** Next fire strictly after `fromMs` (minute resolution). Scans up to 400 days. */
export function nextRunAt(cron: string, tz = 'Asia/Shanghai', fromMs = Date.now()): number | null {
  if (!CRON_RE.test(cron.trim())) return null;
  const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 60 * 24 * 400; i++) {
    const t = start + i * 60_000;
    if (cronMatches(cron, t, tz)) return t;
  }
  return null;
}

export function validateCron(cron: string): string | null {
  if (!CRON_RE.test(cron.trim())) return 'cron must be 5-field (min hour dom mon dow)';
  if (nextRunAt(cron, 'Asia/Shanghai', Date.now()) == null) return 'cron never matches';
  return null;
}

export async function ensureSchedulesSchema(db: any) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, cron TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', prompt TEXT NOT NULL,
    target_type TEXT NOT NULL, target_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER, last_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS schedules_user ON schedules(user_id, enabled)').run().catch(() => null);
  await db.prepare('CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_run_at)').run().catch(() => null);
  await db.prepare(`CREATE TABLE IF NOT EXISTS schedule_runs (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS schedule_runs_sched ON schedule_runs(schedule_id, created_at)').run().catch(() => null);
}

export type FireDeps = {
  db: any;
  generateButler: (userId: string, prompt: string, thread: string) => Promise<{ text: string }>;
  enqueueExpert: (a: { threadId: string; expertId: string; prompt: string; userId: string; roomId?: string | null }) => Promise<{ jobId: string }>;
  roomPost?: (a: { roomId: string; userId: string; text: string }) => Promise<{ ok: boolean; detail?: string }>;
};

async function butlerThread(db: any, userId: string) {
  const row: any = await db.prepare('SELECT dm_thread_id FROM butler_profile WHERE user_id=?').bind(userId).first().catch(() => null);
  const t = row?.dm_thread_id; return t && !String(t).startsWith('user:') ? t : `dm_${userId}`;
}

/** Fire one schedule once; advances next_run_at / last_run_at; writes schedule_runs. */
export async function fireSchedule(row: ScheduleRow, deps: FireDeps, src: 'cron' | 'manual') {
  const t = now();
  const next = nextRunAt(row.cron, row.timezone || 'Asia/Shanghai', t);
  await deps.db.prepare('UPDATE schedules SET last_run_at=?, next_run_at=?, updated_at=? WHERE id=?')
    .bind(t, next, t, row.id).run();
  const runId = `sr-${crypto.randomUUID().slice(0, 12)}`;
  let status = 'ok', detail = '';
  try {
    const prompt = `[定时任务·${row.name}] ${row.prompt}`;
    if (row.target_type === 'butler') {
      const thread = await butlerThread(deps.db, row.user_id);
      const r = await deps.generateButler(row.user_id, prompt, thread);
      detail = String(r.text ?? '').slice(0, 2000);
    } else if (row.target_type === 'expert') {
      const expertId = String(row.target_id || '');
      if (!expertId) throw new Error('expert target_id required');
      const thread = await butlerThread(deps.db, row.user_id);
      const r = await deps.enqueueExpert({ threadId: thread, expertId, prompt, userId: row.user_id });
      detail = `queued ${r.jobId}`;
    } else if (row.target_type === 'room') {
      const roomId = String(row.target_id || '');
      if (!roomId) throw new Error('room target_id required');
      if (deps.roomPost) {
        const r = await deps.roomPost({ roomId, userId: row.user_id, text: prompt });
        if (!r.ok) throw new Error(r.detail || 'room post failed');
        detail = r.detail || 'posted';
      } else {
        // Fallback: treat as butler note mentioning the room
        const thread = `room_${roomId}`;
        const r = await deps.generateButler(row.user_id, prompt, thread);
        detail = String(r.text ?? '').slice(0, 2000);
      }
    } else throw new Error(`bad target_type ${row.target_type}`);
  } catch (e: any) {
    status = 'failed';
    detail = String(e?.message ?? e).slice(0, 2000);
  }
  await deps.db.prepare('INSERT INTO schedule_runs (id,schedule_id,user_id,status,detail,created_at) VALUES (?,?,?,?,?,?)')
    .bind(runId, row.id, row.user_id, status, detail, t).run();
  // prune old runs (keep last 20 per schedule)
  try {
    await deps.db.prepare(`DELETE FROM schedule_runs WHERE schedule_id=? AND id NOT IN (
      SELECT id FROM schedule_runs WHERE schedule_id=? ORDER BY created_at DESC LIMIT 20)`).bind(row.id, row.id).run();
  } catch {}
  console.log('[schedules] fired', JSON.stringify({ id: row.id, src, status, chars: detail.length }));
  return { runId, status, detail, next_run_at: next };
}

/** Claim due schedules (enabled + next_run_at <= now) and fire them. */
export async function tickDueSchedules(deps: FireDeps, limit = 20) {
  await ensureSchedulesSchema(deps.db);
  const t = now();
  const { results } = await deps.db.prepare(
    'SELECT * FROM schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT ?',
  ).bind(t, limit).all();
  const out: any[] = [];
  for (const row of (results as ScheduleRow[]) || []) {
    // optimistic lock: bump next_run_at before fire so parallel ticks don't double-run
    const nxt = nextRunAt(row.cron, row.timezone || 'Asia/Shanghai', t) ?? (t + 60_000);
    const u = await deps.db.prepare('UPDATE schedules SET next_run_at=?, updated_at=? WHERE id=? AND next_run_at=?')
      .bind(nxt, t, row.id, row.next_run_at).run();
    if (!u?.meta?.changes) continue;
    out.push(await fireSchedule({ ...row, next_run_at: nxt }, deps, 'cron'));
  }
  return { checked: (results as any[])?.length ?? 0, fired: out };
}

export async function scheduleRoutes(
  req: Request, p: string, m: string, body: any, user: any,
  deps: FireDeps,
): Promise<Response | null> {
  await ensureSchedulesSchema(deps.db);
  if (p === '/api/schedules' && m === 'GET') {
    const { results } = await deps.db.prepare('SELECT * FROM schedules WHERE user_id=? ORDER BY created_at DESC').bind(user.id).all();
    return json({ schedules: ((results as ScheduleRow[]) || []).map(out), presets: PRESETS });
  }
  if (p === '/api/schedules' && m === 'POST') {
    const name = String(body.name ?? '').trim().slice(0, 64);
    const cron = String(body.cron || (body.preset ? PRESETS[body.preset] : '') || '').trim();
    const timezone = String(body.timezone || 'Asia/Shanghai').slice(0, 64);
    const prompt = String(body.prompt ?? '').trim().slice(0, 4000);
    const target_type = String(body.target_type || 'butler') as TargetType;
    const target_id = body.target_id == null || body.target_id === '' ? null : String(body.target_id).slice(0, 64);
    if (!name || !prompt) return json({ error: 'name and prompt required' }, 400);
    if (!['butler', 'room', 'expert'].includes(target_type)) return json({ error: 'bad target_type' }, 400);
    if (target_type !== 'butler' && !target_id) return json({ error: 'target_id required for room/expert' }, 400);
    const err = validateCron(cron); if (err) return json({ error: err }, 400);
    const id = `sch-${crypto.randomUUID().slice(0, 10)}`;
    const t = now();
    const next = nextRunAt(cron, timezone, t);
    const enabled = body.enabled === false ? 0 : 1;
    await deps.db.prepare(`INSERT INTO schedules (id,user_id,name,cron,timezone,prompt,target_type,target_id,enabled,next_run_at,last_run_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?)`).bind(id, user.id, name, cron, timezone, prompt, target_type, target_id, enabled, next, t, t).run();
    const row: any = await deps.db.prepare('SELECT * FROM schedules WHERE id=?').bind(id).first();
    return json({ schedule: out(row) }, 201);
  }
  let mm = p.match(/^\/api\/schedules\/([\w-]+)$/);
  if (mm && (m === 'PATCH' || m === 'PUT')) {
    const row: any = await deps.db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=?').bind(mm[1], user.id).first();
    if (!row) return json({ error: 'not found' }, 404);
    const name = body.name != null ? String(body.name).trim().slice(0, 64) : row.name;
    const cron = body.cron != null ? String(body.cron).trim() : (body.preset && PRESETS[body.preset]) || row.cron;
    const timezone = body.timezone != null ? String(body.timezone).slice(0, 64) : row.timezone;
    const prompt = body.prompt != null ? String(body.prompt).trim().slice(0, 4000) : row.prompt;
    const target_type = body.target_type != null ? String(body.target_type) : row.target_type;
    const target_id = body.target_id !== undefined ? (body.target_id ? String(body.target_id).slice(0, 64) : null) : row.target_id;
    const enabled = body.enabled != null ? (body.enabled ? 1 : 0) : row.enabled;
    if (!['butler', 'room', 'expert'].includes(target_type)) return json({ error: 'bad target_type' }, 400);
    const err = validateCron(cron); if (err) return json({ error: err }, 400);
    const t = now();
    const next = nextRunAt(cron, timezone, t);
    await deps.db.prepare(`UPDATE schedules SET name=?,cron=?,timezone=?,prompt=?,target_type=?,target_id=?,enabled=?,next_run_at=?,updated_at=? WHERE id=? AND user_id=?`)
      .bind(name, cron, timezone, prompt, target_type, target_id, enabled, next, t, mm[1], user.id).run();
    const updated: any = await deps.db.prepare('SELECT * FROM schedules WHERE id=?').bind(mm[1]).first();
    return json({ schedule: out(updated) });
  }
  if (mm && m === 'DELETE') {
    const r = await deps.db.prepare('DELETE FROM schedules WHERE id=? AND user_id=?').bind(mm[1], user.id).run();
    if (r?.meta?.changes) await deps.db.prepare('DELETE FROM schedule_runs WHERE schedule_id=?').bind(mm[1]).run();
    return json({ ok: !!r?.meta?.changes });
  }
  mm = p.match(/^\/api\/schedules\/([\w-]+)\/run$/);
  if (mm && m === 'POST') {
    const row: any = await deps.db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=?').bind(mm[1], user.id).first();
    if (!row) return json({ error: 'not found' }, 404);
    const result = await fireSchedule(row as ScheduleRow, deps, 'manual');
    return json({ ok: result.status === 'ok', ...result });
  }
  mm = p.match(/^\/api\/schedules\/([\w-]+)\/runs$/);
  if (mm && m === 'GET') {
    const row: any = await deps.db.prepare('SELECT id FROM schedules WHERE id=? AND user_id=?').bind(mm[1], user.id).first();
    if (!row) return json({ error: 'not found' }, 404);
    const { results } = await deps.db.prepare('SELECT id,status,detail,created_at FROM schedule_runs WHERE schedule_id=? ORDER BY created_at DESC LIMIT 20').bind(mm[1]).all();
    return json({ runs: results ?? [] });
  }
  return null;
}
