// 消息向量索引（memory-recall-search S2.2）：semanticRecall 的检索面需要 memory_messages_1024，
// 但 OM 管道落库走 persistMessages（不嵌入），且 @mastra/memory 的 indexMessagesList 为死代码
// （安装版本里无任何调用点）——故在队列观察周期后自建幂等索引：按 message_id upsert，重复安全。
import { createWorkersAiEmbedder } from './workers-ai-embedder';
import type { VectorizeStore } from './vectorize-store';

const INDEX_NAME = 'memory_messages_1024';

function textOf(m: any): string {
  const c = m?.content;
  if (typeof c === 'string') return c.trim();
  if (c?.content && typeof c.content === 'string') return c.content.trim();
  if (Array.isArray(c?.parts)) return c.parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join(' ').trim();
  return '';
}

export async function indexThreadMessages(opts: {
  store: any;
  vector: VectorizeStore;
  aiBinding: () => any;
  threadId: string;
  resourceId: string;
}): Promise<number> {
  const embed = createWorkersAiEmbedder(opts.aiBinding());
  const { messages } = await opts.store.listMessages({
    threadId: opts.threadId,
    perPage: false,
    orderBy: { field: 'createdAt', direction: 'ASC' },
  });
  const items = (messages ?? []).filter((m: any) => textOf(m) && m?.id);
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    const { embeddings } = await embed.doEmbed({ values: batch.map(textOf) });
    await opts.vector.upsert({
      indexName: INDEX_NAME,
      vectors: embeddings,
      ids: batch.map((m: any) => String(m.id)),
      metadata: batch.map((m: any) => ({
        message_id: String(m.id),
        thread_id: String(m.threadId ?? opts.threadId),
        resource_id: String(m.resourceId ?? opts.resourceId),
        role: String(m.role ?? 'user'),
        content: textOf(m).slice(0, 500),
        created_at: m.createdAt ? new Date(m.createdAt).toISOString() : new Date().toISOString(),
      })),
    });
  }
  return items.length;
}
