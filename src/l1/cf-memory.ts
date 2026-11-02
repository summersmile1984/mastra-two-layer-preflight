/**
 * Cloudflare-native semantic memory for Mastra:
 *  - Workers AI embedder (@cf/baai/bge-m3, 1024-d, multilingual/中文) via env.AI binding
 *  - MastraVector adapter over a Vectorize binding (env.VECTORIZE → index `mastra-l1-memory`)
 * Mastra's indexName is ignored (single CF index); scoping uses metadata thread_id / resource_id
 * (metadata indexes created via `wrangler vectorize create-metadata-index`).
 */
import { MastraVector } from '@mastra/core/vector';

export const CF_EMBED_MODEL = '@cf/baai/bge-m3';
export const CF_EMBED_DIM = 1024;

export function workersAiEmbedder(getAI: () => any) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'cloudflare-workers-ai',
    modelId: CF_EMBED_MODEL,
    maxEmbeddingsPerCall: 50,
    supportsParallelCalls: true,
    async doEmbed({ values }: { values: string[] }) {
      const ai = getAI();
      if (!ai) throw new Error('AI binding missing');
      console.log('[mem] embed', values.length);
      const r: any = await ai.run(CF_EMBED_MODEL, { text: values.map(v => String(v).slice(0, 8000)) });
      return { embeddings: r.data as number[][], usage: { tokens: 0 } };
    },
  };
}

const clean = (m: Record<string, any> = {}) => {
  const o: Record<string, any> = {};
  for (const [k, v] of Object.entries(m)) if (v != null && ['string', 'number', 'boolean'].includes(typeof v)) o[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
  return o;
};
/** Mastra filter {thread_id:'x'} / {resource_id:{$eq:'y'}} → Vectorize filter */
const toFilter = (f: any) => {
  if (!f || typeof f !== 'object') return undefined;
  const o: Record<string, any> = {};
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith('$')) continue;
    o[k] = v && typeof v === 'object' && '$eq' in (v as any) ? (v as any).$eq : v;
  }
  return Object.keys(o).length ? o : undefined;
};

export class VectorizeBindingVector extends MastraVector<any> {
  constructor(private getIdx: () => any) { super({ id: 'cf-vectorize' }); }
  private idx() { const i = this.getIdx(); if (!i) throw new Error('VECTORIZE binding missing'); return i; }
  async query(p: any) {
    if (!p.queryVector) return [];
    const r = await this.idx().query(p.queryVector, { topK: Math.min(p.topK ?? 5, 20), filter: toFilter(p.filter), returnMetadata: 'all', returnValues: !!p.includeVector });
    return (r.matches ?? []).map((m: any) => ({ id: m.id, score: m.score, metadata: m.metadata, vector: m.values }));
  }
  async upsert(p: any) {
    const ids: string[] = p.ids ?? p.vectors.map(() => crypto.randomUUID());
    console.log('[mem] vec upsert', p.vectors.length, JSON.stringify(p.metadata?.[0] ?? {}).slice(0, 120));
    if (p.deleteFilter) await this.deleteVectors({ indexName: p.indexName, filter: p.deleteFilter }).catch(() => null);
    await this.idx().upsert(p.vectors.map((v: number[], i: number) => ({ id: ids[i].slice(0, 64), values: v, metadata: clean(p.metadata?.[i]) })));
    return ids;
  }
  async createIndex() { /* provisioned via wrangler */ }
  async listIndexes() { return []; }
  async describeIndex() { const d: any = await this.idx().describe().catch(() => ({})); return { dimension: d.dimensions ?? CF_EMBED_DIM, count: d.vectorCount ?? d.vectorsCount ?? 0, metric: 'cosine' as const }; }
  async deleteIndex() { /* no-op */ }
  async updateVector(p: any) {
    if (!p.id || !p.update?.vector) return;
    await this.idx().upsert([{ id: p.id, values: p.update.vector, metadata: clean(p.update.metadata) }]);
  }
  async deleteVector(p: any) { await this.idx().deleteByIds([p.id]); }
  async deleteVectors(p: any) {
    if (p.ids?.length) { await this.idx().deleteByIds(p.ids); return; }
    // Vectorize has no delete-by-filter: query matching ids with a zero-ish probe and delete in pages
    const f = toFilter(p.filter); if (!f) return;
    const probe = new Array(CF_EMBED_DIM).fill(0); probe[0] = 1;
    for (let i = 0; i < 20; i++) {
      const r = await this.idx().query(probe, { topK: 20, filter: f, returnMetadata: 'none' });
      const ids = (r.matches ?? []).map((m: any) => m.id); if (!ids.length) break;
      await this.idx().deleteByIds(ids);
      if (ids.length < 20) break;
    }
  }
}
