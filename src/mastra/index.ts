/**
 * L1 on Cloudflare Workers：官方 CloudflareDeployer + D1。
 * 仅用于 `mastra build`；本地 Node 版仍走 src/server.ts（AgentController + sendSignal）。
 *
 * P3（主路径 = L2 出站 PULL；本机出口劫持 argotunnel DNS，cloudflared 不可用）：
 *   dispatch_to_sandbox 本地生成 task_id（t-<uuid>），D1 l2_tasks 写入 state=queued + prompt，立即 ok:true
 *     （只需 PUSH_TOKEN + thread；不要求 L2_A2A_URL 可达）
 *   本机 L2（src/l2-pull-worker.ts）轮询 POST /l2-claim（Bearer/X-A2A-Notification-Token = PUSH_TOKEN）
 *     → 原子 queued→working，返回 {taskId,prompt,runtime,threadId}（无任务 {task:null}）
 *     → runAcpPrompt（dsh --profile acp）→ POST /a2a-callback（A2A Task 形状）→ 下面原有 compose + /l2-results 不变
 *   若配置了 L2_A2A_URL：额外 best-effort A2A push（成功则改用 L2 的 task id；失败仅记日志，留给 pull）
 *
 * P2（Worker 侧派发 + 回调，现为可选 push 路径）：
 *   orchestrator 工具 dispatch_to_sandbox → HTTP POST ${L2_A2A_URL}/api/a2a/l2-worker
 *     A2A message/send { configuration:{ blocking:false, pushNotificationConfig:{ url: <L1>/a2a-callback, token: PUSH_TOKEN } } }
 *   → D1 表 l2_tasks 登记 taskId → thread/resource（不用 in-memory Map：Worker isolate 随时被回收/多实例）
 *   → L2（本机 src/l2-server.ts，Mastra Agent + @mastra/acp → dsh --profile acp）完成后 push
 *   → POST /a2a-callback（注意：registerApiRoute 自定义路由**不带 /api 前缀**，与 /health-l1 一致）
 *     校验 X-A2A-Notification-Token（timing-safe）→ D1 写 result
 *     → ctx.waitUntil(orchestrator.generate(<sandbox-result>…, memory=同 thread)) 生成对用户的汇报，写入 D1.reply 并进 thread 记忆
 *   → 前端轮询 GET /l2-results?thread=sid 拿到 reply 后作为 L1 消息显示。
 * 为什么不是 sendSignal：Workers 上没有常驻 AgentController session；用 waitUntil + generate（单次请求内完成，
 * 受 Worker CPU/墙钟限制，DeepSeek 一次调用通常 <30s）+ D1 落盘，是 Workers 上能稳定跑的方案。
 * 即使 generate 失败，原始 result 仍在 D1，前端会退化显示原始结果。
 */
import { env, waitUntil } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { registerApiRoute } from '@mastra/core/server';
import { CloudflareDeployer } from '@mastra/deployer-cloudflare';
import { D1Store } from '@mastra/cloudflare-d1';
import { Memory, Extractor } from '@mastra/memory';
import { z } from 'zod';
import { pollL2Task } from '../l1/poll-l2';
import { roomHandlers } from '../l1/rooms';
import { probeRoutes } from './probe-routes';
import { buildMastraAuth, getSessionUser } from '../auth';
import { ensureOmTable, installD1OmSupport } from './om-d1';
import { VectorizeStore } from './vectorize-store';
import { createWorkersAiEmbedder } from './workers-ai-embedder';
import { ensureProfileTable, upsertProfile, resolveUserByName, loadRoomProfileBlock } from './profile';
import { ensurePersonaConfig, getPersona, updatePersona, personaBlock, buildThreadBlock, buildModelId, SEED_MODEL_ID } from './persona';
import { indexThreadMessages } from './index-messages';
import { ensureVaultTable, createVaultEntry, listVaultEntries, deleteVaultEntry, vaultOut, purgeExpiredVault } from './vault';
import {
  listSchedules, getSchedule, createSchedule, updateSchedule, deleteSchedule,
  listRuns, dueSchedules, markRun, advanceSchedule,
} from '../l1/schedules';
// provider-registry 的 package exports 不放行子路径——相对路径导入让打包器内联（运行时无解析）
import providerRegistry from '../../node_modules/@mastra/core/dist/provider-registry.json';

const E = env as any;
const L2_AGENT_ID = 'l2-worker';
const DEFAULT_PUBLIC = 'https://mastra-l1.emdash-ssg-site.workers.dev';
const publicBase = () => String(E.L1_PUBLIC_URL || DEFAULT_PUBLIC).replace(/\/$/, '');
const callbackUrl = () => `${publicBase()}/a2a-callback`;
/** 闹钟语义：唤醒对应房间 RoomDO，推送内容由 DO 读 D1（S2.3）。失败仅记日志不影响主流程。 */
const notifyRoom = async (roomId: string, evt: { kind: 'message' | 'busy'; messageId?: string }) => {
  try {
    const stub = (E as any).ROOM_DO?.getByName?.(roomId);
    if (!stub) return;
    await stub.fetch(new Request('http://do/notify', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(evt),
    }));
  } catch (e: any) {
    console.log('[L1] notifyRoom failed', String(e?.message ?? e).slice(0, 120));
  }
};
const normL2 = (u: string) => { u = u.replace(/\/$/, ''); return /\/api\/a2a\//.test(u) ? u : `${u}/api/a2a/${L2_AGENT_ID}`; };

// ---------- D1 任务登记 ----------
let schemaReady: Promise<unknown> | null = null;
function db() {
  const d = E.DB;
  schemaReady ??= d.prepare(`CREATE TABLE IF NOT EXISTS l2_tasks (
    task_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, resource_id TEXT, runtime TEXT, state TEXT NOT NULL,
    result TEXT, reply TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)`).run()
    .then(() => d.prepare('CREATE INDEX IF NOT EXISTS l2_tasks_thread ON l2_tasks(thread_id, updated_at)').run())
    .then(() => d.prepare('ALTER TABLE l2_tasks ADD COLUMN prompt TEXT').run().catch(() => null))
    .then(() => d.prepare('CREATE INDEX IF NOT EXISTS l2_tasks_state ON l2_tasks(state, created_at)').run())
    .then(() => d.prepare('ALTER TABLE rooms ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0').run().catch(() => null))
    .then(() => ensureOmTable(d))
    .then(() => ensureProfileTable(d))
    .then(() => ensurePersonaConfig(d))
    .then(() => ensureVaultTable(d))
    .then(() => d.prepare(`CREATE TABLE IF NOT EXISTS user_permission_rules (
      user_id TEXT NOT NULL, category_or_tool TEXT NOT NULL,
      policy TEXT NOT NULL CHECK (policy IN ('allow','ask','deny')), updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, category_or_tool))`).run())
    .then(() => d.prepare(`CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY, auto_review INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)`).run())
    .then(() => d.prepare(`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, cron TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', prompt TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('room')), target_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, next_run_at INTEGER, last_run_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`).run())
    .then(() => d.prepare(`CREATE TABLE IF NOT EXISTS schedule_runs (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)`).run())
    .then(() => d.prepare('CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_run_at)').run());
  return { d, ready: schemaReady };
}

// 提示词零写死（prompt-config S2.2/S2.3）：全部文案出自 persona_config——见下方 syncEngineCopy 与
// Agent.instructions 装配；代码只做拼装。
const dispatch_to_sandbox = createTool({
  id: 'dispatch_to_sandbox',
  description: '',
  inputSchema: z.object({ prompt: z.string(), runtime: z.enum(['cloud', 'local']).default('cloud') }),
  execute: async ({ prompt, runtime }, ctx: any) => {
    const threadId: string | undefined = ctx?.agent?.threadId ?? ctx?.threadId;
    const resourceId: string | undefined = ctx?.agent?.resourceId ?? ctx?.resourceId;
    if (!E.PUSH_TOKEN) return { ok: false, reason: '后台回调未配置（PUSH_TOKEN 未设置）' };
    if (!threadId) return { ok: false, reason: '缺少会话 thread，无法回传结果' };
    const text = runtime === 'local' ? `本地 ${prompt}` : prompt;
    const taskId = `t-${crypto.randomUUID()}`; const now = Date.now();
    try {
      const { d, ready } = db(); await ready;
      await d.prepare('INSERT INTO l2_tasks (task_id,thread_id,resource_id,runtime,state,prompt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(taskId, threadId, resourceId ?? null, runtime, 'queued', text, now, now).run();
      console.log('[L1] queued', JSON.stringify({ taskId, threadId, runtime }));
      try { await notifyRoom(threadId, { kind: 'busy' }); } catch {}
      if (E.L2_A2A_URL) {
        try {
          const r = await fetch(normL2(String(E.L2_A2A_URL)), {
            method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/send', params: {
              message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text }] },
              configuration: { blocking: false, pushNotificationConfig: { url: callbackUrl(), token: String(E.PUSH_TOKEN) } },
            } }),
          });
          const j: any = await r.json().catch(() => null);
          if (r.ok && j?.result?.id) {
            const u = await d.prepare("UPDATE l2_tasks SET task_id=?, state=?, updated_at=? WHERE task_id=? AND state='queued'")
              .bind(j.result.id, j.result.status?.state ?? 'submitted', Date.now(), taskId).run();
            console.log('[L1] pushed via A2A', JSON.stringify({ taskId, l2TaskId: j.result.id, changed: u?.meta?.changes }));
            // Mac 侧 DNS 污染 workers.dev → push 回调可能到不了；Worker 经 tunnel 主动 tasks/get 轮询兜底（幂等）
            try { waitUntil(pollL2(String(j.result.id))); } catch (e: any) { console.log('[L1] waitUntil unavailable', String(e?.message ?? e)); }
          } else console.log('[L1] A2A push failed, left queued for pull', JSON.stringify({ status: r.status, err: j?.error?.message }));
        } catch (e: any) { console.log('[L1] A2A push error, left queued for pull', String(e?.message ?? e).slice(0, 160)); }
      }
      return { ok: true, status: 'queued', runtime };
    } catch (e: any) {
      return { ok: false, reason: `后台暂不可用（${String(e?.message ?? e).slice(0, 120)}）` };
    }
  },
});

// D1 存储单例：Mastra 与 Memory 共用；OM 扩展面装饰到 memory domain（observational-memory S2.1）。
// 绑定（DB 等）在请求期才注入 env——store 必须懒建（构建器会把 new Mastra(...) 包成惰性工厂，请求期才调用）。
let _store: any = null;
const getStore = () => (_store ??= new D1Store({ id: 'l1-d1', binding: E.DB }));
let omInstalled = false;
const ensureOmInstalled = () => {
  if (omInstalled) return;
  try {
    installD1OmSupport(getStore().stores?.memory, E.DB);
    omInstalled = true;
  } catch (e: any) {
    console.log('[OM] install deferred', String(e?.message ?? e).slice(0, 120));
  }
};
const vectorStore = new VectorizeStore({ index: () => E.VECTORIZE, observationsIndex: () => E.VECTORIZE_OBS });

// 主人画像抽取（S2.3）：从【名字】发言归集稳定信息到 om_profiles（多用户共享 thread 时 working memory 装不下主人画像）
const userProfileExtractor = new Extractor({
  name: 'User profile',
  instructions: '从带【名字】前缀的发言中抽取每位发言者的稳定信息（称呼/时区/偏好/在做的事/事实）。只记稳定信息，不记一次性寒暄；每个条目的 speaker 填【名字】里的名字。',
  schema: z.object({
    people: z.array(z.object({
      speaker: z.string(),
      name: z.string().optional(),
      preferredName: z.string().optional(),
      timezone: z.string().optional(),
      preferences: z.array(z.string()).optional(),
      ongoing: z.array(z.string()).optional(),
      facts: z.array(z.string()).optional(),
    })),
  }),
  onExtracted: async ({ current }: any) => {
    for (const p of current?.people ?? []) {
      try {
        const u = await resolveUserByName(E.DB, String(p?.speaker ?? ''));
        if (!u) continue;
        await upsertProfile(E.DB, {
          userId: u.id, email: u.email, name: u.name,
          payload: { name: p.name, preferredName: p.preferredName, timezone: p.timezone, preferences: p.preferences, ongoing: p.ongoing, facts: p.facts },
        });
      } catch (e: any) {
        console.log('[OM] profile upsert failed', String(e?.message ?? e).slice(0, 120));
      }
    }
    return current;
  },
});

// 引擎/工具创建时读取的文案（S2.1 生效语义：冷启动）：可变引用传入，创建前的更新都能生效。
const omObservationCfg = {
  messageTokens: 2_000, bufferTokens: 0.25, bufferOnIdle: true, activateAfterIdle: 300_000, failurePolicy: 'continue',
  instruction: '', extract: [userProfileExtractor],
} as any;
const omReflectionCfg = { observationTokens: 8_000, failurePolicy: 'continue', instruction: '' } as any;

export async function syncEngineCopy(p?: { om_observe: string; om_reflect: string; tool_dispatch: string; model_gateway: string; model_name: string; model_effort: string }) {
  try {
    const persona = p ?? (await getPersona(E.DB));
    omObservationCfg.instruction = persona.om_observe;
    omReflectionCfg.instruction = persona.om_reflect;
    // Memory 构造时把 options 拷进 threadConfig——必须同步补实例上的这份（引擎初始化读它）；
    // 引擎创建后改这里不再热生效（引擎快照），冷启动兜底（S2.1 生效语义）。
    const tc: any = (memoryRef as any)?.threadConfig;
    if (tc?.observationalMemory?.observation) {
      tc.observationalMemory.observation.instruction = persona.om_observe;
      tc.observationalMemory.observation.modelSettings = { ...(tc.observationalMemory.observation.modelSettings ?? {}), reasoning: persona.model_effort };
    }
    if (tc?.observationalMemory?.reflection) {
      tc.observationalMemory.reflection.instruction = persona.om_reflect;
      tc.observationalMemory.reflection.modelSettings = { ...(tc.observationalMemory.reflection.modelSettings ?? {}), reasoning: persona.model_effort };
    }
    if (tc?.observationalMemory) tc.observationalMemory.model = buildModelId(persona);
    (dispatch_to_sandbox as any).description = persona.tool_dispatch;
  } catch {}
}

// 会话记忆：D1 + OM（Observer/Reflector 观测日志）+ Vectorize 语义召回；thread = roomId。
// 不显式传 storage（构建期无 env 会炸 D1Store 初始化）；Memory 经 Mastra 注册拿到同一个 store。
const memoryRef = new Memory({
  vector: vectorStore,
  embedder: createWorkersAiEmbedder(() => E.AI),
  options: {
    lastMessages: 20,
    // 消息向量 RAG（memory-recall-search S2.2）：saveMessages 时嵌入 memory_messages_1024，
    // 与 OM 观测检索互补——OM 管压缩摘要，semanticRecall 找回沉出窗口的原始消息。
    semanticRecall: { topK: 5, messageRange: 2, scope: 'resource' },
    observationalMemory: {
      model: SEED_MODEL_ID,
      retrieval: { vector: true },
      observation: omObservationCfg,
      reflection: omReflectionCfg,
    },
  },
});
// memoryRef 就绪后做首次同步（模块加载时尚未声明，不能提前调）
syncEngineCopy();

/** thread 作用域提示词块（语调+画像）：chat 与后台汇报共用的消息级 system 前置（S2.3）。 */
async function withThreadBlock(messages: any[], threadId: string | undefined): Promise<any[]> {
  try {
    const block = await buildThreadBlock(E.DB, threadId, loadRoomProfileBlock);
    if (block) return [{ role: 'system', content: block }, ...messages];
  } catch (e: any) {
    console.log('[persona] thread block failed', String(e?.message ?? e).slice(0, 120));
  }
  return messages;
}

// 提示词装配（S2.3）：基座+身份走 Agent.instructions（官方函数槽位）；语调+画像走
// 消息级 system 前置（withThreadBlock，chat 与后台汇报共用）。
const orchestrator = new Agent({
  id: 'orchestrator',
  name: 'orchestrator',
  instructions: async () => {
    const p = await getPersona(E.DB);
    return `${p.base_prompt}\n${personaBlock(p)}`;
  },
  // 模型与 effort 全配置（model-gateway-config S2.1）：官方 DynamicArgument 函数槽位，每轮求值
  model: async () => {
    const p = await getPersona(E.DB);
    return buildModelId(p) as any;
  },
  modelSettings: async () => {
    const p = await getPersona(E.DB);
    return { reasoning: p.model_effort } as any;
  },
  tools: { dispatch_to_sandbox },
  memory: memoryRef,
});

const tokenOk = (got?: string | null) => {
  const want = E.PUSH_TOKEN ? String(E.PUSH_TOKEN) : '';
  if (!got || !want) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};
const reqToken = (c: any) => {
  const auth = c.req.header('Authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : c.req.header('X-A2A-Notification-Token');
};

const TERMINAL = ['completed', 'failed', 'canceled', 'rejected'];
const extractTask = (task: any) => {
  let text = (task.artifacts ?? []).flatMap((a: any) => a.parts ?? []).filter((p: any) => p.kind === 'text').map((p: any) => p.text).join('\n')
    || task.status?.message?.parts?.map((p: any) => p.text).join('') || '';
  let state = String(task.status?.state ?? '');
  if (state === 'completed' && text.startsWith('【L2失败】')) { state = 'failed'; text = text.slice(6); }
  return { state, text };
};
/** 写入终态并 compose 回复；幂等（已终态则忽略）。返回 compose promise（若有） */
const finalizeTask = async (taskId: string, state: string, text: string, src: string): Promise<{ ignored?: string; compose?: Promise<void> }> => {
  const { d, ready } = db(); await ready;
  const rec: any = await d.prepare('SELECT * FROM l2_tasks WHERE task_id=?').bind(taskId).first();
  console.log('[L1] finalize', JSON.stringify({ src, taskId, state, known: !!rec, chars: text.length }));
  if (!rec) return { ignored: 'unknown task' };
  if (TERMINAL.includes(rec.state)) return { ignored: 'duplicate' };
  const u = await d.prepare(`UPDATE l2_tasks SET state=?, result=?, updated_at=? WHERE task_id=? AND state NOT IN ('completed','failed','canceled','rejected')`)
    .bind(state, text.slice(0, 20000), Date.now(), taskId).run();
  if (!TERMINAL.includes(state) || !u?.meta?.changes) return {};
  const compose = (async () => {
    let reply = '';
    try {
      const composePrompt = `<sandbox-result state="${state}">${text.slice(0, 8000)}</sandbox-result>\n（这是后台任务的结果通知，不是用户消息；请直接向用户简要汇报）`;
      const res: any = await orchestrator.generate(
        await withThreadBlock([{ role: 'user', content: composePrompt }], rec.thread_id),
        { memory: { thread: rec.thread_id, resource: rec.resource_id ?? rec.thread_id }, maxSteps: 1 } as any);
      reply = String(res?.text ?? '').slice(0, 8000);
      await d.prepare('UPDATE l2_tasks SET reply=?, updated_at=? WHERE task_id=?').bind(reply, Date.now(), taskId).run();
    } catch (e: any) { console.log('[L1] compose failed', String(e?.message ?? e).slice(0, 200)); }
    // S2.5：后台结果落成房间 assistant 消息（room_id = thread_id）——compose 失败也要落（降级用原始 result）
    try {
      const content = reply || (state === 'completed' ? `处理好了：${text.slice(0, 2000)}` : '这次后台处理没成功，请稍后再试。');
      const msgId = `msg-${crypto.randomUUID()}`;
      await d.prepare('INSERT INTO messages (id,room_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)')
        .bind(msgId, rec.thread_id, null, 'assistant', content, Date.now()).run();
      await d.prepare('UPDATE rooms SET updated_at=? WHERE id=?').bind(Date.now(), rec.thread_id).run();
      try { await notifyRoom(rec.thread_id, { kind: 'message', messageId: msgId }); } catch {}
    } catch (e: any) { console.log('[L1] result->messages failed', String(e?.message ?? e).slice(0, 160)); }
    try { await notifyRoom(rec.thread_id, { kind: 'busy' }); } catch {}
  })();
  return { compose };
};
/** Worker → tunnel → L2 A2A tasks/get 轮询，直到终态或超时 */
const pollL2 = (id: string) => pollL2Task(id, { url: () => normL2(String(E.L2_A2A_URL)), getState: async (tid) => { const { d, ready } = db(); await ready; return ((await d.prepare('SELECT state FROM l2_tasks WHERE task_id=?').bind(tid).first()) as any)?.state ?? null; }, terminal: TERMINAL, extract: extractTask, finalize: finalizeTask });

export const mastra = new Mastra({
  agents: { orchestrator },
  storage: getStore(),
  deployer: new CloudflareDeployer({
    name: 'mastra-l1',
    compatibility_date: '2026-10-01',
    compatibility_flags: ['nodejs_compat'],
    vars: { NODE_ENV: 'production', L1_PUBLIC_URL: DEFAULT_PUBLIC },
    d1_databases: [{ binding: 'DB', database_name: 'mastra-l1', database_id: '067cc9a0-be08-4b16-a527-a29ed4bf31b6' }],
  } as any),
  server: {
    auth: buildMastraAuth(E as any) as any,
    apiRoutes: [
      ...(E.PROBE_ROUTES === '1' ? probeRoutes() : []),
      registerApiRoute('/health-l1', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c) => {
          let queued: number | null = null;
          try { const { d, ready } = db(); await ready; queued = ((await d.prepare("SELECT COUNT(*) n FROM l2_tasks WHERE state='queued'").first()) as any)?.n ?? 0; } catch {}
          return c.json({ ok: true, role: 'l1-mastra-cf', pullMode: true, claim: `${publicBase()}/l2-claim`, queued, l2Configured: !!E.L2_A2A_URL, pushToken: !!E.PUSH_TOKEN, callback: callbackUrl() });
        },
      } as any),
      // OM 记忆检视（S2.5）：自己的画像、所在房间的观测日志、全量导出
      registerApiRoute('/om/profile', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const row: any = await E.DB.prepare('SELECT payload, updated_at FROM om_profiles WHERE user_id=?').bind(u.id).first();
          let payload: any = null;
          try { payload = row ? JSON.parse(String(row.payload)) : null; } catch {}
          return c.json({ user: { id: u.id, name: u.name, email: u.email }, profile: payload, updatedAt: row?.updated_at ?? null });
        },
      } as any),
      registerApiRoute('/om/observations', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const thread = String(c.req.query('thread') ?? '');
          if (!/^[\w-]{3,64}$/.test(thread)) return c.json({ error: 'bad thread' }, 400);
          const m = await E.DB.prepare('SELECT 1 AS x FROM room_members WHERE room_id=? AND user_id=?').bind(thread, u.id).first();
          if (!m) return c.json({ error: 'not a member' }, 403);
          const { results } = await E.DB.prepare(
            'SELECT id, generationCount, activeObservations, bufferedObservationChunks, bufferedReflection, originType, createdAt, updatedAt, supersededBy FROM mastra_observational_memory WHERE threadId=? ORDER BY generationCount DESC, createdAt ASC, id ASC',
          ).bind(thread).all();
          return c.json({ thread, records: results ?? [] });
        },
      } as any),
      registerApiRoute('/om/export', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const prow: any = await E.DB.prepare('SELECT payload, updated_at FROM om_profiles WHERE user_id=?').bind(u.id).first();
          let payload: any = null;
          try { payload = prow ? JSON.parse(String(prow.payload)) : null; } catch {}
          const { results: rooms } = await E.DB.prepare('SELECT room_id FROM room_members WHERE user_id=?').bind(u.id).all();
          const observations: any[] = [];
          for (const r of rooms ?? []) {
            const { results } = await E.DB.prepare(
              'SELECT threadId, generationCount, activeObservations, createdAt, supersededBy FROM mastra_observational_memory WHERE threadId=? ORDER BY generationCount DESC',
            ).bind((r as any).room_id).all();
            observations.push({ thread: (r as any).room_id, records: results ?? [] });
          }
          return c.json({ exportedAt: Date.now(), user: { id: u.id, name: u.name, email: u.email }, profile: payload, observations });
        },
      } as any),
      // T7 生产实证探针（PROBE_ROUTES=1）：phase=up 走适配器 upsert；phase=del 走适配器 deleteVectors(filter)。
      // Vectorize 索引水位线是分钟级最终一致——可见性/删除确认由调用方在外部轮询 REST 完成。
      ...(E.PROBE_ROUTES === '1'
        ? [
            registerApiRoute('/probe/vector-del', {
              method: 'GET',
              requiresAuth: false,
              handler: async (c: any) => {
                try {
                  ensureOmInstalled();
                  const phase = String(c.req.query('phase') ?? 'up');
                  const tag = String(c.req.query('tag') ?? `del-${Date.now()}`);
                  const v1 = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
                  const v2 = Array.from({ length: 1024 }, (_, i) => (i === 1 ? 1 : 0));
                  if (phase === 'up') {
                    await vectorStore.upsert({
                      indexName: 'memory_messages_1024',
                      vectors: [v1, v2],
                      ids: [`${tag}-1`, `${tag}-2`],
                      metadata: [{ thread_id: tag }, { thread_id: tag }],
                    });
                    return c.json({ ok: true, phase, tag });
                  }
                  await vectorStore.deleteVectors({ indexName: 'memory_messages_1024', filter: { thread_id: tag } });
                  return c.json({ ok: true, phase: 'del', tag });
                } catch (e: any) {
                  return c.json({ ok: false, error: String(e?.message ?? e).slice(0, 300) });
                }
              },
            } as any),
          ]
        : []),
      // 模型目录（model-gateway-config S2.2）：从已装 provider-registry 读，级联数据源零硬编码
      registerApiRoute('/settings/models', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const reg: any = providerRegistry;
          const providers: any = reg?.providers ?? {};
          const gateways = ['deepseek', 'cloudflare-workers-ai']
            .filter((g) => providers[g])
            .map((g) => ({ gateway: g, models: providers[g].models ?? [] }));
          // mastra 网关不在 provider-registry（运行时 MastraGateway）——清单运行时 fetchProviders，无 key 时降级空列表
          let mastraModels: string[] = [];
          try {
            const { MastraGateway } = await import('@mastra/core/llm');
            const gw = new MastraGateway();
            if (gw.shouldEnable?.()) {
              const provs = await gw.fetchProviders();
              mastraModels = Object.entries(provs ?? {}).flatMap(([prov, cfg]: any) =>
                ((cfg?.models ?? []) as any[]).map((m: any) => `${prov}/${typeof m === 'string' ? m : m?.id ?? ''}`));
            }
          } catch {}
          gateways.push({ gateway: 'mastra', models: mastraModels });
          return c.json({
            gateways,
            effortLevels: ['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          });
        },
      } as any),
      // 定时任务（schedules-secrets S2.1）：cron 例程，执行走 Workers cron tick
      registerApiRoute('/schedules', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const { d, ready } = db();
          await ready;
          return c.json({ schedules: await listSchedules(d, u.id) });
        },
      } as any),
      registerApiRoute('/schedules', {
        method: 'POST',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const body: any = await c.req.json().catch(() => ({}));
          const { d, ready } = db();
          await ready;
          try {
            return c.json({ schedule: await createSchedule(d, u.id, body) }, 201);
          } catch (e: any) {
            return c.json({ error: String(e?.message ?? e).slice(0, 160) }, 400);
          }
        },
      } as any),
      registerApiRoute('/schedules/:id', {
        method: 'PUT',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const body: any = await c.req.json().catch(() => ({}));
          const { d, ready } = db();
          await ready;
          try {
            const schedule = await updateSchedule(d, u.id, String(c.req.param('id') ?? ''), body);
            return schedule ? c.json({ schedule }) : c.json({ error: 'not found' }, 404);
          } catch (e: any) {
            return c.json({ error: String(e?.message ?? e).slice(0, 160) }, 400);
          }
        },
      } as any),
      registerApiRoute('/schedules/:id', {
        method: 'DELETE',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const { d, ready } = db();
          await ready;
          const okDel = await deleteSchedule(d, u.id, String(c.req.param('id') ?? ''));
          return c.json(okDel ? { ok: true } : { error: 'not found' }, okDel ? 200 : 404);
        },
      } as any),
      registerApiRoute('/schedules/:id/runs', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const { d, ready } = db();
          await ready;
          return c.json({ runs: await listRuns(d, u.id, String(c.req.param('id') ?? '')) });
        },
      } as any),
      // 权限数据面（schedules-secrets S2.2）：allow/ask/deny 规则 + 用户设置；消费方（HITL）后续接入
      registerApiRoute('/permissions', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const { d, ready } = db();
          await ready;
          const rules = (await d.prepare('SELECT category_or_tool, policy, updated_at FROM user_permission_rules WHERE user_id=?').bind(u.id).all()).results ?? [];
          const settings: any = await d.prepare('SELECT auto_review, updated_at FROM user_settings WHERE user_id=?').bind(u.id).first();
          return c.json({ rules, settings: settings ?? { auto_review: 1 } });
        },
      } as any),
      registerApiRoute('/permissions', {
        method: 'PUT',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const body: any = await c.req.json().catch(() => ({}));
          const { d, ready } = db();
          await ready;
          if (Array.isArray(body?.rules)) {
            for (const r of body.rules) {
              const cat = String(r?.category_or_tool ?? '').trim().slice(0, 100);
              const policy = String(r?.policy ?? '');
              if (!cat || !['allow', 'ask', 'deny'].includes(policy)) continue;
              await d.prepare(`INSERT INTO user_permission_rules (user_id, category_or_tool, policy, updated_at) VALUES (?,?,?,?)
                ON CONFLICT(user_id, category_or_tool) DO UPDATE SET policy=excluded.policy, updated_at=excluded.updated_at`)
                .bind(u.id, cat, policy, Date.now()).run();
            }
          }
          if (body?.auto_review !== undefined) {
            await d.prepare(`INSERT INTO user_settings (user_id, auto_review, updated_at) VALUES (?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET auto_review=excluded.auto_review, updated_at=excluded.updated_at`)
              .bind(u.id, body.auto_review ? 1 : 0, Date.now()).run();
          }
          const rules = (await d.prepare('SELECT category_or_tool, policy, updated_at FROM user_permission_rules WHERE user_id=?').bind(u.id).all()).results ?? [];
          return c.json({ rules });
        },
      } as any),
      // 密钥保管（schedules-secrets S2.3）：Secrets Store 托管，D1 只存元数据，不回密文
      registerApiRoute('/vault', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const { d, ready } = db();
          await ready;
          return c.json({ entries: (await listVaultEntries(d, u.id)).map(vaultOut) });
        },
      } as any),
      registerApiRoute('/vault', {
        method: 'POST',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const body: any = await c.req.json().catch(() => ({}));
          const { d, ready } = db();
          await ready;
          const r = await createVaultEntry(E, d, u.id, body, String(u.id));
          if ((r as any).error) return c.json({ error: (r as any).error }, 400);
          return c.json({ entry: vaultOut(r) }, 201);
        },
      } as any),
      registerApiRoute('/vault/:id', {
        method: 'DELETE',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const { d, ready } = db();
          await ready;
          const r = await deleteVaultEntry(E, d, u.id, String(c.req.param('id') ?? ''));
          return c.json(r, r.ok ? 200 : 404);
        },
      } as any),
      // 人格配置（S2.5）：登录可读写；persona 是数据不是代码
      registerApiRoute('/settings/persona', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const { d, ready } = db();
          await ready;
          return c.json({ persona: await getPersona(d) });
        },
      } as any),
      registerApiRoute('/settings/persona', {
        method: 'PUT',
        requiresAuth: false,
        handler: async (c: any) => {
          const u = await getSessionUser(c.req.raw ?? { headers: c.req.headers }, E as any);
          if (!u) return c.json({ error: 'unauthorized' }, 401);
          const body: any = await c.req.json().catch(() => ({}));
          const { d, ready } = db();
          await ready;
          const persona = await updatePersona(d, body ?? {}, String(u.id));
          await syncEngineCopy(persona);
          return c.json({ persona });
        },
      } as any),
      // L2 出站 PULL：原子领取一个 queued 任务 → working
      registerApiRoute('/l2-claim', {
        method: 'POST',
        requiresAuth: false,
        handler: async (c: any) => {
          if (!tokenOk(reqToken(c))) return c.json({ error: 'bad token' }, 401);
          const { d, ready } = db(); await ready;
          const row: any = await d.prepare(`UPDATE l2_tasks SET state='working', updated_at=?
            WHERE task_id=(SELECT task_id FROM l2_tasks WHERE state='queued' ORDER BY created_at LIMIT 1) AND state='queued'
            RETURNING task_id, prompt, runtime, thread_id`).bind(Date.now()).first();
          if (!row) return c.json({ task: null });
          console.log('[L1] claimed', JSON.stringify({ taskId: row.task_id }));
          return c.json({ task: { taskId: row.task_id, prompt: row.prompt ?? '', runtime: row.runtime ?? 'cloud', threadId: row.thread_id } });
        },
      } as any),
      // A2A push webhook（L2 → L1）。真实路径：/a2a-callback（无 /api 前缀）
      registerApiRoute('/a2a-callback', {
        method: 'POST',
        requiresAuth: false,
        handler: async (c: any) => {
          if (!tokenOk(reqToken(c))) { console.log('[L1] callback REJECTED bad token'); return c.json({ error: 'bad token' }, 401); }
          const task: any = await c.req.json().catch(() => null);
          if (!task?.id || !task?.status?.state) return c.json({ error: 'bad payload' }, 400);
          const { state, text } = extractTask(task);
          const f = await finalizeTask(String(task.id), state, text, 'callback');
          if (f.ignored) return c.json({ ok: true, ignored: f.ignored });
          if (f.compose) { try { c.executionCtx.waitUntil(f.compose); } catch { await f.compose; } }
          return c.json({ ok: true });
        },
      } as any),
      // 前端轮询：本 thread 已完成且未投递的后台结果（reply 优先，否则原始 result）
      registerApiRoute('/l2-results', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c: any) => {
          const thread = c.req.query('thread') ?? '';
          if (!/^[\w-]{3,64}$/.test(thread)) return c.json({ error: 'bad thread' }, 400);
          const { d, ready } = db(); await ready;
          const { results } = await d.prepare('SELECT task_id,state,result,reply,updated_at FROM l2_tasks WHERE thread_id=? AND delivered=0 ORDER BY created_at').bind(thread).all();
          const busy = results.some((r: any) => !TERMINAL.includes(r.state));
          const done = results.filter((r: any) => TERMINAL.includes(r.state) && (r.reply || Date.now() - r.updated_at > 60_000));
          for (const r of done as any[]) await d.prepare('UPDATE l2_tasks SET delivered=1 WHERE task_id=?').bind(r.task_id).run();
          return c.json({ busy, results: done.map((r: any) => ({ state: r.state, text: r.reply || (r.state === 'completed' ? `处理好了：${r.result ?? ''}` : '这次后台处理没成功，请稍后再试。') })) });
        },
      } as any),
      // rooms / messages / better-auth（多用户共享房间 + 邮箱密码登录）
      ...roomHandlers({
        E: E as any,
        chat: {
          stream: async (messages, opts) => {
            ensureOmInstalled();
            await syncEngineCopy();
            // 提示词装配（S2.3）：基座+身份走 Agent.instructions；语调+画像走消息级 system 前置。
            const msgs = await withThreadBlock(messages as any[], String((opts as any)?.memory?.thread ?? '') || undefined);
            const out = await orchestrator.stream(msgs, opts as any);
            // OM 周期走队列（S2.8）：流结束只入队，queue consumer 独立 invocation 跑 Observer/Reflector。
            // （fire-and-forget 在 Workers 会随响应结束被回收，实测观测永不落库。）
            const src = (out as any).textStream as ReadableStream<string>;
            const wrapped = src.pipeThrough(new TransformStream<string, string>({
              flush() {
                try {
                  const threadId = String((opts as any)?.memory?.thread ?? '');
                  const resourceId = String((opts as any)?.memory?.resource ?? '');
                  if (threadId && E.OM_QUEUE?.send) {
                    waitUntil(Promise.resolve(E.OM_QUEUE.send({ kind: 'observe', threadId, resourceId })).catch((e: any) => {
                      console.log('[OM] enqueue failed', String(e?.message ?? e).slice(0, 120));
                    }));
                  }
                } catch {}
              },
            }));
            return { textStream: wrapped };
          },
        },
        // 闹钟语义：唤醒对应房间的 RoomDO，推送内容由 DO 读 D1（S2.3）
        notifyRoom,
      }).map((h) => registerApiRoute(h.path as any, { method: h.method, requiresAuth: h.requiresAuth, handler: h.handler } as any)),
    ],
  },
});

// OM 周期消费者（S2.8）：队列独立 invocation 跑 Observer/Reflector，自带重试/DLQ。
// mastra build 只保留 mastra/default 导出，queue 出口由 worker-entry 经 globalThis 注册表转发。
const omQueueHandler = async (batch: any) => {
  console.log('[OM] cycle batch', JSON.stringify({ n: batch?.messages?.length ?? 0, bodies: (batch?.messages ?? []).map((m: any) => m?.body) }));
  for (const msg of batch?.messages ?? []) {
    const body: any = msg?.body ?? {};
    const threadId = String(body.threadId ?? '');
    const resourceId = String(body.resourceId || (threadId ? `room:${threadId}` : ''));
    if (!threadId) {
      try { msg.ack(); } catch {}
      continue;
    }
    try {
      ensureOmInstalled();
      await syncEngineCopy();
      // 构建器把 new Mastra(...) 改写成惰性工厂，fetch 里才实例化；queue 调用必须自己触发，
      // 否则 Memory 没注册、omEngine 解析为 null。
      const m: any = mastra;
      // 缓存 Mastra 实例：免费版 CPU 预算极小（约 10ms/次），每次重建整套 Mastra 太贵；
      // 实例只用于把 storage 注册进 Memory，跨调用复用安全（memoryRef/orchestrator 本就是模块级单例）。
      let _mastraInst: any = (globalThis as any).__omMastraInst;
      if (!_mastraInst) {
        _mastraInst = typeof m === 'function' ? m() : m;
        (globalThis as any).__omMastraInst = _mastraInst;
      }
      const inst: any = _mastraInst;
      // 注册是懒的（generate 的 memory 解析流程里才 setStorage）；queue 路径手动补：
      // __registerMastra 只挂 mastra/logger，storage 要单独 setStorage，否则 omEngine 抛「requires a storage provider」。
      try {
        (memoryRef as any).__registerMastra?.(inst);
        const st: any = inst?.getStorage?.();
        if (st && !(memoryRef as any).hasOwnStorage) (memoryRef as any).setStorage?.(st);
      } catch {}
      const mem: any = memoryRef ?? (orchestrator as any).memory ?? inst?.getAgent?.('orchestrator')?.memory;
      const engine = await mem?.omEngine;
      if (!engine) {
        let dom: any = null; let domErr = '';
        try { dom = getStore().stores?.memory; } catch (e: any) { domErr = String(e?.message ?? e).slice(0, 80); }
        throw new Error(`omEngine unavailable mem=${!!mem} mastraFn=${typeof m} dom=${!!dom} flag=${dom?.supportsObservationalMemory} domErr=${domErr}`);
      }
      if (body.kind === 'reflect' && typeof engine.reflect === 'function') {
        // reflect 是位置参数（threadId, resourceId, prompt?），不是 opts 对象
        await engine.reflect(threadId, resourceId);
      } else {
        const res: any = await engine.observe({ threadId, resourceId, force: true });
        console.log('[OM] observe result', JSON.stringify(res ?? null).slice(0, 300));
      }
      try { await mem?.settled?.(); } catch {}
      // 消息向量幂等索引（memory-recall-search S2.2）：OM 不做消息嵌入，自建补上
      try {
        const n = await indexThreadMessages({ store: getStore().stores?.memory, vector: vectorStore, aiBinding: () => E.AI, threadId, resourceId });
        console.log('[OM] message-index', JSON.stringify({ threadId, n }));
      } catch (e: any) {
        console.log('[OM] message-index failed', String(e?.message ?? e).slice(0, 140));
      }
      console.log('[OM] cycle done', JSON.stringify({ kind: body.kind ?? 'observe', threadId }));
      try { msg.ack(); } catch {}
    } catch (e: any) {
      console.log('[OM] cycle failed', JSON.stringify({ threadId, error: String(e?.message ?? e).slice(0, 160) }));
      // omEngine 初始化失败会被缓存成拒绝态，清掉让下条消息重试
      try { (memoryRef as any)._omEngine = null; (memoryRef as any)._omEngineInstance = null; } catch {}
      try { msg.retry(); } catch {}
    }
  }
};
(globalThis as any).__omQueueHandler = omQueueHandler;

// 定时任务执行（schedules-secrets S2.1）：Workers cron 每分钟 tick → 扫到期例程 →
// 以 prompt 驱动秘书向目标房间发言（复用 compose 落消息 + RoomDO WS 通知）→ 记 runs、推 next_run_at。
const schedulesTick = async () => {
  try {
    ensureOmInstalled();
    await syncEngineCopy();
    // scheduled 路径不经过 fetch 的 mastra() 工厂——同队列消费者的接线：显式注册 Memory（否则 generate 抛 storage provider）
    const m0: any = mastra;
    const inst0: any = typeof m0 === 'function' ? m0() : m0;
    try {
      (memoryRef as any).__registerMastra?.(inst0);
      const st0: any = inst0?.getStorage?.();
      if (st0 && !(memoryRef as any).hasOwnStorage) (memoryRef as any).setStorage?.(st0);
    } catch {}
    const { d, ready } = db();
    await ready;
    try { await purgeExpiredVault(E, d); } catch {}
    const due = await dueSchedules(d, Date.now());
    for (const rec of due as any[]) {
      try {
        const threadId = String(rec.target_id ?? '');
        const prompt = `【定时任务：${rec.name}】${rec.prompt}`;
        const msgs = await withThreadBlock([{ role: 'user', content: prompt }], threadId);
        const res: any = await orchestrator.generate(msgs, {
          memory: { thread: threadId, resource: `room:${threadId}` }, maxSteps: 1,
        } as any);
        const reply = String(res?.text ?? '').slice(0, 8000);
        const content = reply || `定时任务「${rec.name}」执行完毕。`;
        const msgId = `msg-${crypto.randomUUID()}`;
        await d.prepare('INSERT INTO messages (id,room_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)')
          .bind(msgId, threadId, null, 'assistant', content, Date.now()).run();
        await d.prepare('UPDATE rooms SET updated_at=? WHERE id=?').bind(Date.now(), threadId).run();
        try { await notifyRoom(threadId, { kind: 'message', messageId: msgId }); } catch {}
        await markRun(d, { scheduleId: rec.id, userId: rec.user_id, status: 'success', detail: content.slice(0, 200) });
      } catch (e: any) {
        try { await markRun(d, { scheduleId: rec.id, userId: rec.user_id, status: 'failed', detail: String(e?.message ?? e).slice(0, 200) }); } catch {}
      }
      try { await advanceSchedule(d, rec.id, Date.now()); } catch {}
    }
  } catch (e: any) {
    console.log('[schedules] tick failed', String(e?.message ?? e).slice(0, 160));
  }
};
(globalThis as any).__schedulesTick = schedulesTick;
