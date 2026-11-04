/**
 * Observational Memory (OM) storage adapter for Cloudflare D1.
 *
 * Decorates a D1-backed MemoryStorage instance (store.stores.memory from
 * @mastra/cloudflare-d1's D1Store) with the full OM extension surface.
 * Semantics ported 1:1 from @mastra/libsql's MemoryLibSQL OM implementation
 * (same table/columns, same head ordering, same CAS guards, same chunk rules).
 */
import {
  OBSERVATIONAL_MEMORY_TABLE_SCHEMA,
  assertActiveObservationsApplied,
  isAppendOnlySince,
  isBufferedChunkCoveredByCursor,
  maxObservationCursor,
  planReflectionGenerationText,
} from '@mastra/core/storage';
import type {
  BufferedObservationChunk,
  BufferedObservationChunkInput,
  CreateObservationalMemoryInput,
  CreateReflectionGenerationInput,
  ObservationalMemoryHistoryOptions,
  ObservationalMemoryRecord,
  SwapBufferedReflectionToActiveInput,
  SwapBufferedToActiveInput,
  SwapBufferedToActiveResult,
  UpdateActiveObservationsInput,
  UpdateActiveObservationsResult,
  UpdateBufferedObservationsInput,
  UpdateBufferedObservationsResult,
  UpdateBufferedReflectionInput,
  UpdateObservationalMemoryConfigInput,
} from '@mastra/core/storage';

export const OM_TABLE = 'mastra_observational_memory';

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<{ success: boolean; meta?: { changes?: number }; changes?: number }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  /** D1 batch = 事务性多语句；多步生命周期（rollover）必须走它。 */
  batch?(stmts: D1PreparedStatementLike[]): Promise<Array<{ success: boolean; meta?: { changes?: number }; changes?: number }>>;
}

/** Canonical head order: newest generation, then earliest createdAt, then lowest id. */
const OM_HEAD_ORDER = `"generationCount" DESC, "createdAt" ASC, id ASC`;
/** Lifecycle writes aimed at a retired record follow `supersededBy` to the head at most this many times. */
const OM_MAX_HEAD_HOPS = 3;
/** Optimistic lifecycle writes rerun at most this many times when another process changes the row. */
const OM_MAX_CAS_ATTEMPTS = 10;
const OM_CAS_CONFLICT = Symbol('om-cas-conflict');

// libsql's SQLite type mapping (bigint→INTEGER, timestamp→TEXT, boolean→INTEGER, jsonb→TEXT).
const SQL_TYPE: Record<string, string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  timestamp: 'TEXT',
  boolean: 'INTEGER',
  jsonb: 'TEXT',
  bigint: 'INTEGER',
  float: 'REAL',
};

type SchemaColumn = { type: string; nullable?: boolean; primaryKey?: boolean };
type OmRow = Record<string, unknown>;
interface OmRowRef {
  record: ObservationalMemoryRecord;
  guard: { sql: string; args: unknown[] };
}

function getOmKey(threadId: string | null, resourceId: string): string {
  return threadId ? `thread:${threadId}` : `resource:${resourceId}`;
}

function bindValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * D1 bind accepts only primitive wire types; this normalizes every value
 * (booleans → 0/1, Dates → ISO strings, undefined → null) at the driver edge.
 */
function normalizeDb(db: D1DatabaseLike): D1DatabaseLike {
  const wrap = (stmt: D1PreparedStatementLike): D1PreparedStatementLike => {
    const wrapped: any = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values.map(bindValue))),
      run: () => stmt.run(),
      first: () => stmt.first(),
      all: () => stmt.all(),
    };
    wrapped.__raw = stmt;
    return wrapped;
  };
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (stmts: any[]) => db.batch!(stmts.map((s: any) => s?.__raw ?? s)),
  };
}

function changesOf(result: { meta?: { changes?: number }; changes?: number }): number {
  return result.meta?.changes ?? result.changes ?? 0;
}

function parseOmRow(row: OmRow): ObservationalMemoryRecord {
  return {
    id: row.id as string,
    scope: row.scope as ObservationalMemoryRecord['scope'],
    threadId: (row.threadId as string) || null,
    resourceId: row.resourceId as string,
    createdAt: new Date(row.createdAt as string),
    updatedAt: new Date(row.updatedAt as string),
    lastObservedAt: row.lastObservedAt ? new Date(row.lastObservedAt as string) : undefined,
    originType: (row.originType as ObservationalMemoryRecord['originType']) || 'initial',
    generationCount: Number(row.generationCount || 0),
    activeObservations: (row.activeObservations as string) || '',
    bufferedObservationChunks: row.bufferedObservationChunks
      ? typeof row.bufferedObservationChunks === 'string'
        ? JSON.parse(row.bufferedObservationChunks)
        : (row.bufferedObservationChunks as BufferedObservationChunk[])
      : undefined,
    bufferedObservations: (row.activeObservationsPendingUpdate as string) || undefined,
    bufferedObservationTokens: row.bufferedObservationTokens ? Number(row.bufferedObservationTokens) : undefined,
    bufferedMessageIds: undefined,
    bufferedReflection: (row.bufferedReflection as string) || undefined,
    bufferedReflectionTokens: row.bufferedReflectionTokens ? Number(row.bufferedReflectionTokens) : undefined,
    bufferedReflectionInputTokens: row.bufferedReflectionInputTokens
      ? Number(row.bufferedReflectionInputTokens)
      : undefined,
    reflectedObservationLineCount: row.reflectedObservationLineCount
      ? Number(row.reflectedObservationLineCount)
      : undefined,
    totalTokensObserved: Number(row.totalTokensObserved || 0),
    observationTokenCount: Number(row.observationTokenCount || 0),
    pendingMessageTokens: Number(row.pendingMessageTokens || 0),
    isReflecting: Boolean(row.isReflecting),
    isObserving: Boolean(row.isObserving),
    isBufferingObservation:
      row.isBufferingObservation === true || row.isBufferingObservation === 'true' || row.isBufferingObservation === 1,
    isBufferingReflection:
      row.isBufferingReflection === true || row.isBufferingReflection === 'true' || row.isBufferingReflection === 1,
    lastBufferedAtTokens:
      typeof row.lastBufferedAtTokens === 'number'
        ? row.lastBufferedAtTokens
        : parseInt(String(row.lastBufferedAtTokens ?? '0'), 10) || 0,
    lastBufferedAtTime: row.lastBufferedAtTime ? new Date(String(row.lastBufferedAtTime)) : null,
    config: row.config ? JSON.parse(row.config as string) : {},
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    observedMessageIds: row.observedMessageIds ? JSON.parse(row.observedMessageIds as string) : undefined,
    observedTimezone: (row.observedTimezone as string) || undefined,
    supersededBy: (row.supersededBy as string | null) ?? null,
  };
}

/** Full-row equality guard (`"col" IS ?` per column) so a stale read turns the write into a CAS conflict. */
function guardFromRow(row: OmRow): { sql: string; args: unknown[] } {
  const columns = Object.keys(row);
  return {
    sql: columns.map((c) => `"${c}" IS ?`).join(' AND '),
    args: columns.map((c) => bindValue(row[c])),
  };
}

function toOmRow(row: OmRow | null): OmRowRef | null {
  return row ? { record: parseOmRow(row), guard: guardFromRow(row) } : null;
}

async function selectRow(db: D1DatabaseLike, sql: string, args: unknown[]): Promise<OmRow | null> {
  return db.prepare(sql).bind(...args.map(bindValue)).first<OmRow>();
}

async function readOmRow(db: D1DatabaseLike, id: string): Promise<OmRowRef | null> {
  return toOmRow(await selectRow(db, `SELECT * FROM "${OM_TABLE}" WHERE id = ?`, [id]));
}

async function readOmHeadRow(db: D1DatabaseLike, lookupKey: string): Promise<OmRowRef | null> {
  return toOmRow(
    await selectRow(db, `SELECT * FROM "${OM_TABLE}" WHERE "lookupKey" = ? ORDER BY ${OM_HEAD_ORDER} LIMIT 1`, [
      lookupKey,
    ]),
  );
}

/** The live row a lifecycle write aimed at `row` lands on: the row itself while live, otherwise the head. */
async function resolveLiveOmRow(db: D1DatabaseLike, row: OmRowRef): Promise<OmRowRef> {
  let current = row;
  for (let hop = 0; current.record.supersededBy; hop++) {
    const head =
      hop < OM_MAX_HEAD_HOPS
        ? await readOmHeadRow(db, getOmKey(current.record.threadId, current.record.resourceId))
        : null;
    if (!head || head.record.id === current.record.id) {
      throw new Error(`Observational memory record ${row.record.id} is superseded but no live head was found`);
    }
    current = head;
  }
  return current;
}

async function withOmCas<T>(attempt: () => Promise<T | typeof OM_CAS_CONFLICT>): Promise<T> {
  for (let i = 0; i < OM_MAX_CAS_ATTEMPTS; i++) {
    const result = await attempt();
    if (result !== OM_CAS_CONFLICT) return result;
  }
  throw new Error(
    `Observational memory write kept conflicting with concurrent writers (${OM_MAX_CAS_ATTEMPTS} attempts)`,
  );
}

function deepMergeConfig(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const isPlainObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const output: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const tVal = target[key];
    const sVal = source[key];
    if (isPlainObj(tVal) && isPlainObj(sVal)) output[key] = deepMergeConfig(tVal, sVal);
    else if (sVal !== undefined) output[key] = sVal;
  }
  return output;
}

/**
 * Idempotent: creates the OM table (same DDL libsql derives from
 * OBSERVATIONAL_MEMORY_TABLE_SCHEMA) plus its lookupKey index, then retires
 * duplicate live rows left by adapters that never set supersededBy.
 */
export async function ensureOmTable(db: D1DatabaseLike): Promise<void> {
  db = normalizeDb(db);
  const schema = (OBSERVATIONAL_MEMORY_TABLE_SCHEMA as Record<string, Record<string, SchemaColumn>>)[OM_TABLE];
  const columns = Object.entries(schema).map(([name, def]) => {
    const parts = [`"${name}"`, SQL_TYPE[def.type] ?? 'TEXT'];
    if (def.nullable === false) parts.push('NOT NULL');
    if (def.primaryKey) parts.push('PRIMARY KEY');
    return parts.join(' ');
  });
  await db.prepare(`CREATE TABLE IF NOT EXISTS "${OM_TABLE}" (\n  ${columns.join(',\n  ')}\n)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_om_lookup_key ON "${OM_TABLE}" ("lookupKey")`).run();
  await backfillSupersededBy(db);
}

async function backfillSupersededBy(db: D1DatabaseLike): Promise<void> {
  const headOf = `(SELECT h.id FROM "${OM_TABLE}" h WHERE h."lookupKey" = "${OM_TABLE}"."lookupKey" ORDER BY ${OM_HEAD_ORDER} LIMIT 1)`;
  const duplicated = `SELECT "lookupKey" FROM "${OM_TABLE}" WHERE "supersededBy" IS NULL GROUP BY "lookupKey" HAVING COUNT(*) > 1`;
  const existing = await db.prepare(duplicated).all();
  if (!existing.results.length) return;
  await db
    .prepare(
      `UPDATE "${OM_TABLE}" SET "supersededBy" = ${headOf}
       WHERE "supersededBy" IS NULL AND "lookupKey" IN (${duplicated}) AND id <> ${headOf}`,
    )
    .run();
}

/**
 * Create the next generation from the stored (live) row and retire it, guarded by the
 * row as read. Buffered chunks move to the new generation; the cursor, buffering
 * markers, flags, counters, config, and metadata carry over; buffered reflection
 * state does not. Returns OM_CAS_CONFLICT when the row changed since it was read.
 */
async function rollOverObservationalMemory(
  db: D1DatabaseLike,
  storedRow: OmRowRef,
  observations: string,
  tokenCount: number,
  newRecordId?: string,
): Promise<ObservationalMemoryRecord | typeof OM_CAS_CONFLICT> {
  const stored = storedRow.record;
  const id = newRecordId ?? globalThis.crypto.randomUUID();
  const now = new Date();
  const chunks: BufferedObservationChunk[] = Array.isArray(stored.bufferedObservationChunks)
    ? stored.bufferedObservationChunks
    : [];
  const lookupKey = getOmKey(stored.threadId, stored.resourceId);
  const record: ObservationalMemoryRecord = {
    id,
    scope: stored.scope,
    threadId: stored.threadId,
    resourceId: stored.resourceId,
    createdAt: now,
    updatedAt: now,
    lastObservedAt: stored.lastObservedAt,
    originType: 'reflection',
    generationCount: stored.generationCount + 1,
    activeObservations: observations,
    bufferedObservationChunks: chunks.length > 0 ? chunks : undefined,
    totalTokensObserved: stored.totalTokensObserved,
    observationTokenCount: tokenCount,
    pendingMessageTokens: stored.pendingMessageTokens,
    isReflecting: false,
    isObserving: false,
    isBufferingObservation: stored.isBufferingObservation,
    isBufferingReflection: false,
    lastBufferedAtTokens: stored.lastBufferedAtTokens,
    lastBufferedAtTime: stored.lastBufferedAtTime,
    config: stored.config,
    metadata: stored.metadata,
    observedTimezone: stored.observedTimezone,
    supersededBy: null,
  };
  const retireStmt = db
    .prepare(
      `UPDATE "${OM_TABLE}" SET "supersededBy" = ?, "bufferedObservationChunks" = NULL,
       "bufferedReflection" = NULL, "bufferedReflectionTokens" = NULL,
       "bufferedReflectionInputTokens" = NULL, "reflectedObservationLineCount" = NULL, "updatedAt" = ?
       WHERE id = ? AND ${storedRow.guard.sql}`,
    )
    .bind(id, now.toISOString(), stored.id, ...storedRow.guard.args.map(bindValue));
  // Conditional insert: only lands when the retire above actually wrote this id as superseder.
  const insertStmt = db
    .prepare(
      `INSERT INTO "${OM_TABLE}" (
        id, "lookupKey", scope, "resourceId", "threadId",
        "activeObservations", "activeObservationsPendingUpdate",
        "originType", config, "generationCount", "lastObservedAt", "lastReflectionAt",
        "pendingMessageTokens", "totalTokensObserved", "observationTokenCount",
        "bufferedObservationChunks",
        "isObserving", "isReflecting", "isBufferingObservation", "isBufferingReflection", "lastBufferedAtTokens", "lastBufferedAtTime",
        "observedTimezone", metadata, "supersededBy", "createdAt", "updatedAt"
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM "${OM_TABLE}" WHERE id = ? AND "supersededBy" = ?)`,
    )
    .bind(
      id,
      lookupKey,
      record.scope,
      record.resourceId,
      record.threadId || null,
      observations,
      null,
      'reflection',
      JSON.stringify(record.config),
      record.generationCount,
      record.lastObservedAt ? new Date(record.lastObservedAt).toISOString() : null,
      now.toISOString(),
      record.pendingMessageTokens,
      record.totalTokensObserved,
      record.observationTokenCount,
      chunks.length > 0 ? JSON.stringify(chunks) : null,
      false,
      false,
      record.isBufferingObservation,
      false,
      record.lastBufferedAtTokens,
      record.lastBufferedAtTime ? new Date(record.lastBufferedAtTime).toISOString() : null,
      record.observedTimezone || null,
      record.metadata ? JSON.stringify(record.metadata) : null,
      null,
      now.toISOString(),
      now.toISOString(),
      stored.id,
      id,
    );
  // retire+insert 必须原子（D1 batch=事务）：否则中途被杀会留下悬空 supersededBy 指向不存在的世代。
  let retiredChanges: number;
  if (typeof db.batch === 'function') {
    const results = await db.batch([retireStmt, insertStmt]);
    retiredChanges = changesOf(results[0]);
  } else {
    const retired = await retireStmt.run();
    await insertStmt.run();
    retiredChanges = changesOf(retired);
  }
  return retiredChanges === 1 ? record : OM_CAS_CONFLICT;
}

/** OM method bodies over a raw D1 binding; installed onto a MemoryStorage instance. */
export class D1ObservationalMemory {
  #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = normalizeDb(db);
  }

  getObservationalMemory(threadId: string | null, resourceId: string): Promise<ObservationalMemoryRecord | null> {
    return readOmHeadRow(this.#db, getOmKey(threadId, resourceId)).then((row) => row?.record ?? null);
  }

  async getObservationalMemoryHistory(
    threadId: string | null,
    resourceId: string,
    limit = 10,
    options?: ObservationalMemoryHistoryOptions,
  ): Promise<ObservationalMemoryRecord[]> {
    const lookupKey = getOmKey(threadId, resourceId);
    const conditions = [`"lookupKey" = ?`];
    const args: unknown[] = [lookupKey];
    if (options?.recordId !== undefined) {
      conditions.push(`id = ?`);
      args.push(options.recordId);
    }
    if (options?.from) {
      conditions.push(`"createdAt" >= ?`);
      args.push(options.from.toISOString());
    }
    if (options?.to) {
      conditions.push(`"createdAt" <= ?`);
      args.push(options.to.toISOString());
    }
    if (options?.groupId !== undefined) {
      conditions.push(`(instr("activeObservations", ?) > 0 OR EXISTS (
        SELECT 1 FROM json_each("bufferedObservationChunks") AS chunk
        WHERE instr(json_extract(chunk.value, '$.observations'), ?) > 0
      ))`);
      const prefix = `<observation-group id="${options.groupId}"`;
      args.push(prefix, prefix);
    }
    if (options?.beforeGeneration !== undefined) {
      conditions.push(`"generationCount" < ?`);
      args.push(options.beforeGeneration);
    }
    if (options?.afterGeneration !== undefined) {
      conditions.push(`"generationCount" > ?`);
      args.push(options.afterGeneration);
    }
    const direction = options?.sortDirection === 'ASC' ? 'ASC' : 'DESC';
    args.push(limit);
    let sql = `SELECT * FROM "${OM_TABLE}" WHERE ${conditions.join(' AND ')} ORDER BY "generationCount" ${direction}, "createdAt" ASC, id ASC LIMIT ?`;
    if (options?.offset != null) {
      args.push(options.offset);
      sql += ` OFFSET ?`;
    }
    const result = await this.#db.prepare(sql).bind(...args.map(bindValue)).all<OmRow>();
    return result.results.map((row) => parseOmRow(row));
  }

  async initializeObservationalMemory(input: CreateObservationalMemoryInput): Promise<ObservationalMemoryRecord> {
    const lookupKey = getOmKey(input.threadId, input.resourceId);
    const id = globalThis.crypto.randomUUID();
    const now = new Date();
    const record: ObservationalMemoryRecord = {
      id,
      scope: input.scope,
      threadId: input.threadId,
      resourceId: input.resourceId,
      createdAt: now,
      updatedAt: now,
      lastObservedAt: undefined,
      originType: 'initial',
      generationCount: 0,
      activeObservations: '',
      totalTokensObserved: 0,
      observationTokenCount: 0,
      pendingMessageTokens: 0,
      isReflecting: false,
      isObserving: false,
      isBufferingObservation: false,
      isBufferingReflection: false,
      lastBufferedAtTokens: 0,
      lastBufferedAtTime: null,
      config: input.config,
      observedTimezone: input.observedTimezone,
      supersededBy: null,
    };
    return withOmCas(async () => {
      const existing = await readOmHeadRow(this.#db, lookupKey);
      if (existing) return existing.record;
      const inserted = await this.#db
        .prepare(
          `INSERT INTO "${OM_TABLE}" (
            id, "lookupKey", scope, "resourceId", "threadId",
            "activeObservations", "activeObservationsPendingUpdate",
            "originType", config, "generationCount", "lastObservedAt", "lastReflectionAt",
            "pendingMessageTokens", "totalTokensObserved", "observationTokenCount",
            "isObserving", "isReflecting", "isBufferingObservation", "isBufferingReflection", "lastBufferedAtTokens", "lastBufferedAtTime",
            "observedTimezone", "createdAt", "updatedAt"
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM "${OM_TABLE}" WHERE "lookupKey" = ? AND "supersededBy" IS NULL)`,
        )
        .bind(
          id,
          lookupKey,
          input.scope,
          input.resourceId,
          input.threadId || null,
          '',
          null,
          'initial',
          JSON.stringify(input.config),
          0,
          null,
          null,
          0,
          0,
          0,
          false,
          false,
          false,
          false,
          0,
          null,
          input.observedTimezone || null,
          now.toISOString(),
          now.toISOString(),
          lookupKey,
        )
        .run();
      if (changesOf(inserted) === 1) return record;
      const head = await readOmHeadRow(this.#db, lookupKey);
      return head?.record ?? OM_CAS_CONFLICT;
    });
  }

  async insertObservationalMemoryRecord(record: ObservationalMemoryRecord): Promise<void> {
    const lookupKey = getOmKey(record.threadId, record.resourceId);
    await this.#db
      .prepare(
        `INSERT INTO "${OM_TABLE}" (
          id, "lookupKey", scope, "resourceId", "threadId",
          "activeObservations", "activeObservationsPendingUpdate",
          "originType", config, "generationCount", "lastObservedAt", "lastReflectionAt",
          "pendingMessageTokens", "totalTokensObserved", "observationTokenCount",
          "observedMessageIds", "bufferedObservationChunks",
          "bufferedReflection", "bufferedReflectionTokens", "bufferedReflectionInputTokens",
          "reflectedObservationLineCount",
          "isObserving", "isReflecting", "isBufferingObservation", "isBufferingReflection",
          "lastBufferedAtTokens", "lastBufferedAtTime",
          "observedTimezone", metadata, "supersededBy", "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        lookupKey,
        record.scope,
        record.resourceId,
        record.threadId || null,
        record.activeObservations || '',
        null,
        record.originType || 'initial',
        record.config ? JSON.stringify(record.config) : null,
        record.generationCount || 0,
        record.lastObservedAt ? new Date(record.lastObservedAt).toISOString() : null,
        null,
        record.pendingMessageTokens || 0,
        record.totalTokensObserved || 0,
        record.observationTokenCount || 0,
        record.observedMessageIds ? JSON.stringify(record.observedMessageIds) : null,
        record.bufferedObservationChunks ? JSON.stringify(record.bufferedObservationChunks) : null,
        record.bufferedReflection || null,
        record.bufferedReflectionTokens ?? null,
        record.bufferedReflectionInputTokens ?? null,
        record.reflectedObservationLineCount ?? null,
        record.isObserving || false,
        record.isReflecting || false,
        record.isBufferingObservation || false,
        record.isBufferingReflection || false,
        record.lastBufferedAtTokens || 0,
        record.lastBufferedAtTime ? new Date(record.lastBufferedAtTime).toISOString() : null,
        record.observedTimezone || null,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.supersededBy ?? null,
        new Date(record.createdAt).toISOString(),
        new Date(record.updatedAt).toISOString(),
      )
      .run();
  }

  async updateActiveObservations(input: UpdateActiveObservationsInput): Promise<void> {
    assertActiveObservationsApplied(await this.commitActiveObservations(input), input.id);
  }

  async commitActiveObservations(input: UpdateActiveObservationsInput): Promise<UpdateActiveObservationsResult> {
    const now = new Date();
    const observedMessageIdsJson = input.observedMessageIds ? JSON.stringify(input.observedMessageIds) : null;
    return withOmCas(async () => {
      const row = await readOmRow(this.#db, input.id);
      if (!row) throw new Error(`Observational memory record not found: ${input.id}`);
      const stored = row.record;
      if (stored.supersededBy) return { applied: false, reason: 'retired' };
      if (input.expectedActiveObservations !== undefined && input.expectedActiveObservations !== stored.activeObservations)
        return { applied: false, reason: 'conflict' };
      const lastObservedAt = maxObservationCursor(stored.lastObservedAt, input.lastObservedAt)!;
      const updated = await this.#db
        .prepare(
          `UPDATE "${OM_TABLE}" SET
            "activeObservations" = ?,
            "lastObservedAt" = ?,
            "pendingMessageTokens" = 0,
            "observationTokenCount" = ?,
            "totalTokensObserved" = "totalTokensObserved" + ?,
            "observedMessageIds" = ?,
            "updatedAt" = ?
          WHERE id = ? AND ${row.guard.sql}`,
        )
        .bind(
          input.observations,
          lastObservedAt.toISOString(),
          input.tokenCount,
          input.tokenCount,
          observedMessageIdsJson,
          now.toISOString(),
          input.id,
          ...row.guard.args.map(bindValue),
        )
        .run();
      return changesOf(updated) === 1 ? { applied: true } : OM_CAS_CONFLICT;
    });
  }

  async createReflectionGeneration(input: CreateReflectionGenerationInput): Promise<ObservationalMemoryRecord> {
    return withOmCas(async () => {
      const { currentRecord } = input;
      const row = await readOmRow(this.#db, currentRecord.id);
      if (!row) return currentRecord;
      const stored = row.record;
      if (stored.supersededBy) return (await resolveLiveOmRow(this.#db, row)).record;
      const plan = planReflectionGenerationText({
        storedObservations: stored.activeObservations,
        storedObservationTokenCount: stored.observationTokenCount,
        snapshotObservations: currentRecord.activeObservations,
        snapshotObservationTokenCount: currentRecord.observationTokenCount,
        reflection: input.reflection,
        tokenCount: input.tokenCount,
      });
      if (!plan) return stored;
      return rollOverObservationalMemory(this.#db, row, plan.observations, plan.tokenCount, input.newRecordId);
    });
  }

  async updateBufferedReflection(input: UpdateBufferedReflectionInput): Promise<void> {
    const nowStr = new Date().toISOString();
    const updated = await this.#db
      .prepare(
        `UPDATE "${OM_TABLE}" SET
          "bufferedReflection" = CASE
            WHEN "bufferedReflection" IS NOT NULL AND "bufferedReflection" != ''
            THEN "bufferedReflection" || char(10) || char(10) || ?
            ELSE ?
          END,
          "bufferedReflectionTokens" = COALESCE("bufferedReflectionTokens", 0) + ?,
          "bufferedReflectionInputTokens" = COALESCE("bufferedReflectionInputTokens", 0) + ?,
          "reflectedObservationLineCount" = ?,
          "updatedAt" = ?
        WHERE id = ?`,
      )
      .bind(
        input.reflection,
        input.reflection,
        input.tokenCount,
        input.inputTokenCount,
        input.reflectedObservationLineCount,
        nowStr,
        input.id,
      )
      .run();
    if (changesOf(updated) === 0) throw new Error(`Observational memory record not found: ${input.id}`);
  }

  async swapBufferedReflectionToActive(
    input: SwapBufferedReflectionToActiveInput,
  ): Promise<ObservationalMemoryRecord> {
    return withOmCas(async () => {
      const { currentRecord } = input;
      const row = await readOmRow(this.#db, currentRecord.id);
      if (!row) return currentRecord;
      const stored = row.record;
      if (stored.supersededBy) return (await resolveLiveOmRow(this.#db, row)).record;
      const bufferedReflection = stored.bufferedReflection || '';
      if (!bufferedReflection) throw new Error('No buffered reflection to swap');
      if (!isAppendOnlySince(stored.activeObservations, currentRecord.activeObservations)) return stored;
      const reflectedLineCount = stored.reflectedObservationLineCount ?? 0;
      const unreflectedContent = (stored.activeObservations || '')
        .split('\n')
        .slice(reflectedLineCount)
        .join('\n')
        .trim();
      const newObservations = unreflectedContent ? `${bufferedReflection}\n\n${unreflectedContent}` : bufferedReflection;
      const tokenCount =
        input.tokenCount + Math.max(0, (stored.observationTokenCount ?? 0) - (currentRecord.observationTokenCount ?? 0));
      return rollOverObservationalMemory(this.#db, row, newObservations, tokenCount, input.newRecordId);
    });
  }

  async setReflectingFlag(id: string, isReflecting: boolean): Promise<void> {
    const updated = await this.#db
      .prepare(`UPDATE "${OM_TABLE}" SET "isReflecting" = ?, "updatedAt" = ? WHERE id = ?`)
      .bind(isReflecting, new Date().toISOString(), id)
      .run();
    if (changesOf(updated) === 0) throw new Error(`Observational memory record not found: ${id}`);
  }

  async setObservingFlag(id: string, isObserving: boolean): Promise<void> {
    const updated = await this.#db
      .prepare(`UPDATE "${OM_TABLE}" SET "isObserving" = ?, "updatedAt" = ? WHERE id = ?`)
      .bind(isObserving, new Date().toISOString(), id)
      .run();
    if (changesOf(updated) === 0) throw new Error(`Observational memory record not found: ${id}`);
  }

  async setBufferingObservationFlag(id: string, isBuffering: boolean, lastBufferedAtTokens?: number): Promise<void> {
    await withOmCas(async () => {
      const row = await readOmRow(this.#db, id);
      if (!row) throw new Error(`Observational memory record not found: ${id}`);
      const target = (await resolveLiveOmRow(this.#db, row)).record;
      const nowStr = new Date().toISOString();
      const updated =
        lastBufferedAtTokens !== undefined
          ? await this.#db
              .prepare(
                `UPDATE "${OM_TABLE}" SET "isBufferingObservation" = ?, "lastBufferedAtTokens" = ?, "updatedAt" = ? WHERE id = ? AND "supersededBy" IS NULL`,
              )
              .bind(isBuffering, lastBufferedAtTokens, nowStr, target.id)
              .run()
          : await this.#db
              .prepare(
                `UPDATE "${OM_TABLE}" SET "isBufferingObservation" = ?, "updatedAt" = ? WHERE id = ? AND "supersededBy" IS NULL`,
              )
              .bind(isBuffering, nowStr, target.id)
              .run();
      return changesOf(updated) === 1 ? undefined : OM_CAS_CONFLICT;
    });
  }

  async setBufferingReflectionFlag(id: string, isBuffering: boolean): Promise<void> {
    const updated = await this.#db
      .prepare(`UPDATE "${OM_TABLE}" SET "isBufferingReflection" = ?, "updatedAt" = ? WHERE id = ?`)
      .bind(isBuffering, new Date().toISOString(), id)
      .run();
    if (changesOf(updated) === 0) throw new Error(`Observational memory record not found: ${id}`);
  }

  async setPendingMessageTokens(id: string, tokenCount: number): Promise<void> {
    await withOmCas(async () => {
      const row = await readOmRow(this.#db, id);
      if (!row) throw new Error(`Observational memory record not found: ${id}`);
      const target = (await resolveLiveOmRow(this.#db, row)).record;
      const updated = await this.#db
        .prepare(
          `UPDATE "${OM_TABLE}" SET "pendingMessageTokens" = ?, "updatedAt" = ? WHERE id = ? AND "supersededBy" IS NULL`,
        )
        .bind(tokenCount, new Date().toISOString(), target.id)
        .run();
      return changesOf(updated) === 1 ? undefined : OM_CAS_CONFLICT;
    });
  }

  async clearObservationalMemory(threadId: string | null, resourceId: string): Promise<void> {
    await this.#db.prepare(`DELETE FROM "${OM_TABLE}" WHERE "lookupKey" = ?`).bind(getOmKey(threadId, resourceId)).run();
  }

  async updateObservationalMemoryConfig(input: UpdateObservationalMemoryConfigInput): Promise<void> {
    await withOmCas(async () => {
      const row = await selectRow(this.#db, `SELECT config FROM "${OM_TABLE}" WHERE id = ?`, [input.id]);
      if (!row) throw new Error(`Observational memory record not found: ${input.id}`);
      const existing = row.config ? JSON.parse(row.config as string) : {};
      const merged = deepMergeConfig(existing, input.config);
      const updated = await this.#db
        .prepare(`UPDATE "${OM_TABLE}" SET config = ?, "updatedAt" = ? WHERE id = ? AND config IS ?`)
        .bind(JSON.stringify(merged), new Date().toISOString(), input.id, row.config ?? null)
        .run();
      return changesOf(updated) === 1 ? undefined : OM_CAS_CONFLICT;
    });
  }

  async updateBufferedObservations(input: UpdateBufferedObservationsInput): Promise<void> {
    await this.appendBufferedObservations(input);
  }

  async appendBufferedObservations(input: UpdateBufferedObservationsInput): Promise<UpdateBufferedObservationsResult> {
    const nowStr = new Date().toISOString();
    return withOmCas(async () => {
      const row = await readOmRow(this.#db, input.id);
      if (!row) throw new Error(`Observational memory record not found: ${input.id}`);
      const targetRow = await resolveLiveOmRow(this.#db, row);
      const target = targetRow.record;
      const existingChunks: BufferedObservationChunk[] = Array.isArray(target.bufferedObservationChunks)
        ? target.bufferedObservationChunks
        : [];
      if (
        existingChunks.some((existing) => existing.cycleId === input.chunk.cycleId) ||
        isBufferedChunkCoveredByCursor(input.chunk.lastObservedAt, target.lastObservedAt)
      ) {
        return { persisted: false, recordId: target.id };
      }
      const newChunk: BufferedObservationChunk = {
        id: `ombuf-${globalThis.crypto.randomUUID()}`,
        cycleId: input.chunk.cycleId,
        observations: input.chunk.observations,
        tokenCount: input.chunk.tokenCount,
        messageIds: input.chunk.messageIds,
        messageTokens: input.chunk.messageTokens,
        lastObservedAt: input.chunk.lastObservedAt,
        createdAt: new Date(),
        suggestedContinuation: input.chunk.suggestedContinuation,
        currentTask: input.chunk.currentTask,
        threadTitle: input.chunk.threadTitle,
        extractedValues: input.chunk.extractedValues,
        extractionFailures: input.chunk.extractionFailures,
      };
      const lastBufferedAtTime = maxObservationCursor(target.lastBufferedAtTime, input.lastBufferedAtTime);
      const updated = await this.#db
        .prepare(
          `UPDATE "${OM_TABLE}" SET
            "bufferedObservationChunks" = ?,
            "lastBufferedAtTime" = ?,
            "updatedAt" = ?
          WHERE id = ? AND ${targetRow.guard.sql}`,
        )
        .bind(
          JSON.stringify([...existingChunks, newChunk]),
          lastBufferedAtTime ? lastBufferedAtTime.toISOString() : null,
          nowStr,
          target.id,
          ...targetRow.guard.args.map(bindValue),
        )
        .run();
      return changesOf(updated) === 1 ? { persisted: true, recordId: target.id } : OM_CAS_CONFLICT;
    });
  }

  async swapBufferedToActive(input: SwapBufferedToActiveInput): Promise<SwapBufferedToActiveResult> {
    const nowStr = new Date().toISOString();
    return withOmCas(async () => {
      const current = await readOmRow(this.#db, input.id);
      if (!current) throw new Error(`Observational memory record not found: ${input.id}`);
      const row = current.record;
      const guard = current.guard;
      const emptyResult: SwapBufferedToActiveResult = {
        chunksActivated: 0,
        messageTokensActivated: 0,
        observationTokensActivated: 0,
        messagesActivated: 0,
        activatedCycleIds: [],
        activatedMessageIds: [],
      };
      if (row.supersededBy) return { ...emptyResult, retired: true };
      // JSON round-trip: chunk dates are strings here — same as the libsql reference.
      let persistedChunks: BufferedObservationChunk[] = [];
      const rawChunks: unknown = row.bufferedObservationChunks;
      if (rawChunks) {
        try {
          const parsed = typeof rawChunks === 'string' ? JSON.parse(rawChunks) : rawChunks;
          persistedChunks = Array.isArray(parsed) ? parsed : [];
        } catch {
          persistedChunks = [];
        }
      }
      const refreshedWeights = new Map(
        (Array.isArray(input.bufferedChunks) ? input.bufferedChunks : []).map((c) => [c.id, c.messageTokens]),
      );
      const chunks = persistedChunks.map((c) =>
        refreshedWeights.has(c.id) ? { ...c, messageTokens: refreshedWeights.get(c.id)! } : c,
      );
      if (chunks.length === 0) return emptyResult;
      const retentionFloor = input.messageTokensThreshold * (1 - input.activationRatio);
      const targetMessageTokens = Math.max(0, input.currentPendingTokens - retentionFloor);
      let cumulativeMessageTokens = 0;
      let bestOverBoundary = 0;
      let bestOverTokens = 0;
      let bestUnderBoundary = 0;
      let bestUnderTokens = 0;
      for (let i = 0; i < chunks.length; i++) {
        cumulativeMessageTokens += chunks[i].messageTokens ?? 0;
        const boundary = i + 1;
        if (cumulativeMessageTokens >= targetMessageTokens) {
          if (bestOverBoundary === 0 || cumulativeMessageTokens < bestOverTokens) {
            bestOverBoundary = boundary;
            bestOverTokens = cumulativeMessageTokens;
          }
        } else if (cumulativeMessageTokens > bestUnderTokens) {
          bestUnderBoundary = boundary;
          bestUnderTokens = cumulativeMessageTokens;
        }
      }
      const maxOvershoot = retentionFloor * 0.95;
      const overshoot = bestOverTokens - targetMessageTokens;
      const remainingAfterOver = input.currentPendingTokens - bestOverTokens;
      const remainingAfterUnder = input.currentPendingTokens - bestUnderTokens;
      const minRemaining = Math.min(1000, retentionFloor);
      let chunksToActivate: number;
      if (input.forceMaxActivation && bestOverBoundary > 0 && remainingAfterOver >= minRemaining)
        chunksToActivate = bestOverBoundary;
      else if (bestOverBoundary > 0 && overshoot <= maxOvershoot && remainingAfterOver >= minRemaining)
        chunksToActivate = bestOverBoundary;
      else if (bestUnderBoundary > 0 && remainingAfterUnder >= minRemaining) chunksToActivate = bestUnderBoundary;
      else if (bestOverBoundary > 0) chunksToActivate = bestOverBoundary;
      else chunksToActivate = 1;
      const activatedChunks = chunks.slice(0, chunksToActivate);
      const remainingChunks = persistedChunks.slice(chunksToActivate);
      const activatedContent = activatedChunks.map((c) => c.observations).join('\n\n');
      const activatedTokens = activatedChunks.reduce((sum, c) => sum + c.tokenCount, 0);
      const activatedMessageTokens = activatedChunks.reduce((sum, c) => sum + (c.messageTokens ?? 0), 0);
      const activatedMessageCount = activatedChunks.reduce((sum, c) => sum + c.messageIds.length, 0);
      const activatedCycleIds = activatedChunks.map((c) => c.cycleId).filter((id) => !!id);
      const activatedMessageIds = activatedChunks.flatMap((c) => c.messageIds ?? []);
      const latestChunk = activatedChunks[activatedChunks.length - 1];
      const lastObservedAt =
        input.lastObservedAt ?? (latestChunk?.lastObservedAt ? new Date(latestChunk.lastObservedAt) : new Date());
      const lastObservedAtStr = maxObservationCursor(row.lastObservedAt, lastObservedAt)!.toISOString();
      const existingActive = row.activeObservations || '';
      const existingTokenCount = Number(row.observationTokenCount || 0);
      const boundary = `\n\n--- message boundary (${lastObservedAt.toISOString()}) ---\n\n`;
      const newActive = existingActive ? `${existingActive}${boundary}${activatedContent}` : activatedContent;
      const newTokenCount = existingTokenCount + activatedTokens;
      const existingPending = Number(row.pendingMessageTokens || 0);
      const newPending = Math.max(0, existingPending - activatedMessageTokens);
      const updated = await this.#db
        .prepare(
          `UPDATE "${OM_TABLE}" SET
            "activeObservations" = ?,
            "observationTokenCount" = ?,
            "pendingMessageTokens" = ?,
            "bufferedObservationChunks" = ?,
            "lastObservedAt" = ?,
            "updatedAt" = ?
          WHERE id = ? AND ${guard.sql}`,
        )
        .bind(
          newActive,
          newTokenCount,
          newPending,
          remainingChunks.length > 0 ? JSON.stringify(remainingChunks) : null,
          lastObservedAtStr,
          nowStr,
          input.id,
          ...guard.args.map(bindValue),
        )
        .run();
      if (changesOf(updated) === 0) return OM_CAS_CONFLICT;
      const latestChunkHints = activatedChunks[activatedChunks.length - 1];
      return {
        chunksActivated: activatedChunks.length,
        messageTokensActivated: activatedMessageTokens,
        observationTokensActivated: activatedTokens,
        messagesActivated: activatedMessageCount,
        activatedCycleIds,
        activatedMessageIds,
        observations: activatedContent,
        perChunk: activatedChunks.map((c) => ({
          cycleId: c.cycleId ?? '',
          messageTokens: c.messageTokens ?? 0,
          observationTokens: c.tokenCount,
          messageCount: c.messageIds.length,
          observations: c.observations,
        })),
        suggestedContinuation: latestChunkHints?.suggestedContinuation ?? undefined,
        currentTask: latestChunkHints?.currentTask ?? undefined,
      };
    });
  }
}

const OM_METHOD_NAMES = [
  'getObservationalMemory',
  'getObservationalMemoryHistory',
  'initializeObservationalMemory',
  'insertObservationalMemoryRecord',
  'updateActiveObservations',
  'commitActiveObservations',
  'updateBufferedObservations',
  'appendBufferedObservations',
  'swapBufferedToActive',
  'createReflectionGeneration',
  'updateBufferedReflection',
  'swapBufferedReflectionToActive',
  'setReflectingFlag',
  'setObservingFlag',
  'setBufferingObservationFlag',
  'setBufferingReflectionFlag',
  'setPendingMessageTokens',
  'clearObservationalMemory',
  'updateObservationalMemoryConfig',
] as const;

/** Assigns every OM method (bound) plus the capability flags onto a MemoryStorage instance. */
export function installD1OmSupport(memoryDomain: any, db: D1DatabaseLike): void {
  const impl = new D1ObservationalMemory(db);
  // 首次调用可能早于建表完成；所有方法先等建表就绪（幂等，失败由各方法自身报错）
  const ready = ensureOmTable(db).catch(() => undefined);
  for (const name of OM_METHOD_NAMES) {
    memoryDomain[name] = async (...args: unknown[]) => {
      await ready;
      return (impl[name] as (...a: unknown[]) => unknown).apply(impl, args);
    };
  }
  memoryDomain.supportsObservationalMemory = true;
  memoryDomain.supportsObservationalMemoryHistorySearch = true;
}
