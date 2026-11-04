/**
 * Workers AI 嵌入（S2.7/T7）：env.AI.run('@cf/baai/bge-m3', { text[] }) → AI-SDK EmbeddingModelV3，
 * 供 Memory({ embedder }) 消费。bge-m3 中英双语，1024 维。
 */
import type { MastraEmbeddingModel } from '@mastra/core/vector';

export const BGE_M3_MODEL = '@cf/baai/bge-m3';
export const BGE_M3_DIM = 1024;

/** Cloudflare Workers AI 绑定（env.AI）中 text embedding 用到的方法面。 */
export interface AiLike {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
}

export function createWorkersAiEmbedder(aiBinding: AiLike, modelId: string = BGE_M3_MODEL): MastraEmbeddingModel<string> {
  return {
    specificationVersion: 'v3',
    provider: 'cloudflare-workers-ai',
    modelId,
    maxEmbeddingsPerCall: 10,
    supportsParallelCalls: true,
    async doEmbed({ values }: { values: string[] }) {
      if (!values.length) return { embeddings: [] };
      const res = await aiBinding.run(modelId, { text: values });
      const embeddings = res?.data;
      if (!Array.isArray(embeddings) || embeddings.length !== values.length) {
        throw new Error(`Workers AI embedder: expected ${values.length} embeddings from ${modelId}, got ${embeddings?.length ?? 0}`);
      }
      return { embeddings };
    },
  };
}
