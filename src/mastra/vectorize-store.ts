/**
 * VectorizeStore —— MastraVector 适配 Cloudflare Vectorize（S2.7/T7）。
 * 双索引模型：Mastra 按 memory_messages_* / memory_observations_* 两个逻辑索引读写（各带维度后缀），
 * 各路由到一个物理 Vectorize 绑定（om-memory / om-memory-obs）。listIndexes 返回两个逻辑名，
 * 这样 deleteThread 的前缀发现（getMemoryVectorIndexes）也能命中并清理。
 * 索引经 `wrangler vectorize create` 预建（1024 维 cosine），运行时只校验不创建。
 */
import { MastraVector } from '@mastra/core/vector';
import type {
  CreateIndexParams,
  DeleteIndexParams,
  DeleteVectorParams,
  DeleteVectorsParams,
  DescribeIndexParams,
  IndexStats,
  QueryResult,
  QueryVectorParams,
  UpdateVectorParams,
  UpsertVectorParams,
  VectorFilter,
} from '@mastra/core/vector';

/** Vectorize 绑定（env.VECTORIZE）的结构类型；workers-types 未装，按运行时方法面声明。 */
export interface VectorizeVector {
  id: string;
  values: number[];
  metadata?: Record<string, any>;
}
export interface VectorizeMatch {
  id: string;
  score: number;
  values?: number[];
  metadata?: Record<string, any>;
}
export interface VectorizeQueryResult {
  matches: VectorizeMatch[];
  count?: number;
}
export interface VectorizeIndexInfo {
  dimensions: number;
  vectorsCount?: number;
}
export interface VectorizeQueryOptions {
  topK?: number;
  returnValues?: boolean;
  returnMetadata?: 'none' | 'indexed' | 'all';
  filter?: Record<string, any>;
}
export interface VectorizeIndex {
  upsert(vectors: VectorizeVector[]): Promise<any>;
  query(vector: number[], options?: VectorizeQueryOptions): Promise<VectorizeQueryResult>;
  describe(): Promise<VectorizeIndexInfo>;
  deleteByIds(ids: string[]): Promise<any>;
  getByIds(ids: string[]): Promise<VectorizeVector[]>;
  queryById(vectorId: string, options?: VectorizeQueryOptions): Promise<VectorizeQueryResult>;
  /** 非官方面：若绑定暴露按过滤删除则直用，否则走 query 收集 id 的回退。 */
  deleteByFilter?(filter: Record<string, any>): Promise<any>;
}

const DEFAULT_MESSAGE_INDEX_NAME = 'memory_messages_1024';
const DEFAULT_OBSERVATION_INDEX_NAME = 'memory_observations_1024';
const PROVISION_HINT = (name: string, dimension: number, metric: string) =>
  `wrangler vectorize create ${name} --dimensions=${dimension} --metric=${metric}`;
const FILTER_OPS = new Set(['$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte']);

function scalar(v: unknown, field: string): string | number | boolean {
  if (v instanceof Date) return v.toISOString();
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v as string | number | boolean;
  throw new Error(`Vectorize filter: unsupported value for field "${field}" (${t}); use string/number/boolean/Date`);
}

function fieldValue(field: string, value: unknown): Record<string, any> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    const out: Record<string, any> = {};
    for (const [op, v] of Object.entries(value as Record<string, unknown>)) {
      if (!FILTER_OPS.has(op)) {
        throw new Error(`Vectorize filter: operator "${op}" is not supported (supported: $eq $ne $in $nin $gt $gte $lt $lte)`);
      }
      out[op] = op === '$in' || op === '$nin'
        ? (v as unknown[]).map((x) => scalar(x, field))
        : scalar(v, field);
    }
    return out;
  }
  return { $eq: scalar(value, field) };
}

function mergeField(out: Record<string, any>, field: string, cond: Record<string, any>) {
  const prev = out[field];
  if (prev === undefined) {
    out[field] = cond;
    return;
  }
  // $and 两个分支命中同一字段：运算符对象合并（同键冲突无法表达，报错）
  if (typeof prev === 'object' && typeof cond === 'object') {
    for (const [op, v] of Object.entries(cond)) {
      if (op in prev) throw new Error(`Vectorize filter: conflicting conditions on field "${field}"`);
      prev[op] = v;
    }
    return;
  }
  throw new Error(`Vectorize filter: conflicting conditions on field "${field}"`);
}

/** Mastra VectorFilter → Vectorize 元数据过滤：$eq/$ne/$in/$nin/$gt/$gte/$lt/$lte + 字段间 AND（含 $and 展平）。 */
export function toVectorizeFilter(filter: VectorFilter | undefined | null): Record<string, any> | undefined {
  if (filter == null) return undefined;
  const walk = (cond: any, out: Record<string, any>) => {
    if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) {
      throw new Error('Vectorize filter: condition must be an object');
    }
    for (const [key, value] of Object.entries(cond)) {
      if (key === '$and') {
        if (!Array.isArray(value)) throw new Error('Vectorize filter: $and requires an array');
        for (const branch of value) walk(branch, out);
      } else if (key === '$or' || key === '$nor' || key === '$not' || key.startsWith('$')) {
        throw new Error(`Vectorize filter: operator "${key}" is not supported (supported: $eq $ne $in $nin $gt $gte $lt $lte, top-level AND)`);
      } else {
        mergeField(out, key, fieldValue(key, value));
      }
    }
  };
  const out: Record<string, any> = {};
  walk(filter, out);
  return Object.keys(out).length ? out : undefined;
}

export class VectorizeStore extends MastraVector {
  /** 绑定在请求期才注入 env——统一存 thunk，每次调用现取。 */
  private readonly messageIndexRef: () => VectorizeIndex | undefined;
  private readonly observationsIndexRef: () => VectorizeIndex | undefined;
  readonly messageIndexName: string;
  readonly observationIndexName: string;

  constructor({
    id = 'vectorize',
    index,
    observationsIndex,
    messageIndexName = DEFAULT_MESSAGE_INDEX_NAME,
    observationIndexName = DEFAULT_OBSERVATION_INDEX_NAME,
  }: {
    id?: string;
    index: VectorizeIndex | (() => VectorizeIndex | undefined);
    observationsIndex?: VectorizeIndex | (() => VectorizeIndex | undefined);
    messageIndexName?: string;
    observationIndexName?: string;
  }) {
    super({ id });
    const asRef = (v: VectorizeIndex | (() => VectorizeIndex | undefined) | undefined): (() => VectorizeIndex | undefined) =>
      typeof v === 'function' ? v : () => v;
    this.messageIndexRef = asRef(index);
    this.observationsIndexRef = observationsIndex ? asRef(observationsIndex) : this.messageIndexRef;
    this.messageIndexName = messageIndexName;
    this.observationIndexName = observationIndexName;
  }

  /** 逻辑索引名 → 物理绑定（观测名路由到观测绑定，其余归消息绑定）。 */
  private resolve(indexName?: string): VectorizeIndex {
    const binding = indexName && indexName.startsWith('memory_observations')
      ? this.observationsIndexRef()
      : this.messageIndexRef();
    if (!binding) throw new Error('Vectorize binding not ready (env.VECTORIZE* unavailable)');
    return binding;
  }

  private async describe(indexName?: string): Promise<VectorizeIndexInfo> {
    const name = indexName ?? this.messageIndexName;
    try {
      return await this.resolve(indexName).describe();
    } catch (e: any) {
      throw new Error(
        `Vectorize index "${name}" is not available (describe failed: ${String(e?.message ?? e)}). ` +
        `Provision it first: ${PROVISION_HINT(name, 1024, 'cosine')}`,
      );
    }
  }

  async createIndex({ indexName, dimension, metric }: CreateIndexParams): Promise<void> {
    const info = await this.describe(indexName);
    if (dimension && info.dimensions && info.dimensions !== dimension) {
      throw new Error(
        `Vectorize index "${indexName}" has ${info.dimensions} dimensions but ${dimension} were requested. ` +
        `Vectorize cannot resize; rebuild the index: ${PROVISION_HINT(indexName, dimension, metric ?? 'cosine')}`,
      );
    }
  }

  async listIndexes(): Promise<string[]> {
    return [this.messageIndexName, this.observationIndexName];
  }

  async describeIndex({ indexName }: DescribeIndexParams): Promise<IndexStats> {
    const info = await this.describe(indexName);
    return { dimension: info.dimensions, count: info.vectorsCount ?? 0 };
  }

  async deleteIndex(_params: DeleteIndexParams): Promise<void> {
    throw new Error('not supported for Vectorize; delete the index via wrangler');
  }

  async upsert({ indexName, vectors, metadata, ids }: UpsertVectorParams): Promise<string[]> {
    if (ids && ids.length !== vectors.length) throw new Error(`VectorizeStore.upsert: ids length ${ids.length} != vectors length ${vectors.length}`);
    if (metadata && metadata.length !== vectors.length) throw new Error(`VectorizeStore.upsert: metadata length ${metadata.length} != vectors length ${vectors.length}`);
    const outIds: string[] = [];
    const payload: VectorizeVector[] = vectors.map((values, i) => {
      const id = ids?.[i] ?? crypto.randomUUID();
      outIds.push(id);
      return metadata?.[i] ? { id, values, metadata: metadata[i] } : { id, values };
    });
    await this.resolve(indexName).upsert(payload);
    return outIds;
  }

  async query({ indexName, queryVector, topK, filter, includeVector }: QueryVectorParams): Promise<QueryResult[]> {
    if (!queryVector) throw new Error('VectorizeStore.query: queryVector is required (Vectorize has no metadata-only query)');
    const vf = toVectorizeFilter(filter);
    const res = await this.resolve(indexName).query(queryVector, {
      topK: topK ?? 10,
      returnMetadata: 'all',
      ...(includeVector ? { returnValues: true } : {}),
      ...(vf ? { filter: vf } : {}),
    });
    return (res.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score,
      ...(m.metadata ? { metadata: m.metadata } : {}),
      ...(includeVector && m.values ? { vector: m.values } : {}),
    }));
  }

  /** 单向量覆盖写（Vectorize upsert 即替换；缺失的一半用 getByIds 回填）。 */
  async updateVector(params: UpdateVectorParams): Promise<void> {
    if (!('id' in params) || !params.id) {
      throw new Error('VectorizeStore.updateVector: filter-based update is not supported (Vectorize cannot scan by metadata); update by id');
    }
    const { id, update, indexName } = params;
    const idx = this.resolve(indexName);
    const existing = (await idx.getByIds([id]))[0];
    const values = update.vector ?? existing?.values;
    if (!values) throw new Error(`VectorizeStore.updateVector: no vector for id "${id}" (pass update.vector)`);
    const metadata = update.metadata ?? existing?.metadata;
    await idx.upsert([metadata ? { id, values, metadata } : { id, values }]);
  }

  async deleteVector({ indexName, id }: DeleteVectorParams): Promise<void> {
    await this.resolve(indexName).deleteByIds([id]);
  }

  async deleteVectors({ indexName, ids, filter }: DeleteVectorsParams): Promise<void> {
    if (ids && filter) throw new Error('VectorizeStore.deleteVectors: pass either ids or filter, not both');
    const idx = this.resolve(indexName);
    if (ids) {
      await idx.deleteByIds(ids);
      return;
    }
    if (!filter) throw new Error('VectorizeStore.deleteVectors: ids or filter is required');
    const vf = toVectorizeFilter(filter);
    if ((idx as any).deleteByFilter) {
      await (idx as any).deleteByFilter(vf);
      return;
    }
    // 回退：probe 向量 + 过滤查询收集 id 再删。deleteByIds 最终一致——已提交删除的 id 可能仍被查出，
    // 不能以「无新 id」为终止条件（topK 会被陈旧 id 占满，漏删后续匹配项）；以「查询归零」为准，空轮次等待生效。
    const dim = (await this.describe(indexName)).dimensions;
    const probe = Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0));
    const seen = new Set<string>();
    for (let round = 0; round < 30; round++) {
      const res = await idx.query(probe, { topK: 100, returnMetadata: 'none', ...(vf ? { filter: vf } : {}) });
      const matches = res.matches ?? [];
      if (matches.length === 0) break;
      const fresh = matches.map((m) => m.id).filter((id) => !seen.has(id));
      if (fresh.length === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      for (const id of fresh) seen.add(id);
      await idx.deleteByIds(fresh);
    }
  }
}
