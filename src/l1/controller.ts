/**
 * L1：Mastra AgentController（常驻控制面）— **only the butler / orchestrator**.
 * 工具只往 L2 队列投递 / 查询（沙箱 ACP 或专家 expert_id），毫秒级返回；
 * L2 完成后通过 session.sendSignal 唤醒 L1。
 * 房间专家不是 controller.subagents[]，而是 L2 任务（与沙箱同管线）。
 */
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { AgentController, type Session } from '@mastra/core/agent-controller';
import { createTool } from '@mastra/core/tools';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createScriptedModel, type ScriptView } from '../model/scripted-model';
import { chooseRuntime, type L2Event } from '../protocol';
import type { JobQueue } from '../l2/queue';
import { EXPERT_CATALOG, EXPERT_IDS, isExpertId } from './experts';

const label = (r: string) => (r === 'local' ? '本地' : r === 'cua' ? '电脑' : '云端');
const WORK = /帮我|分析|跑|测试|执行|生成|构建|部署|route=/;
const expertName = (id: string) => EXPERT_CATALOG.find(e => e.id === id)?.name ?? id;

/** 离线脚本模型：模拟 LLM 的决策（真实模型时由 instructions 驱动同样行为） */
function l1Script(v: ScriptView) {
  const fresh = v.unhandledUserTexts.at(-1) ?? '';
  const signals = v.pendingUserTexts.filter(t => t.includes('sandbox-result') || t.includes('expert-result'));
  // 1) 工具刚返回 → 立即回复用户
  if (v.toolResultsSinceUser.length) {
    const r = v.toolResultsSinceUser.at(-1)!; const o: any = r.output;
    if (r.toolName === 'dispatch_to_sandbox') return { text: `好的，已派发到【${label(o.runtime)}】后台（${o.jobId}）。进度会实时推送，你可以继续跟我聊。` };
    if (r.toolName === 'dispatch_to_expert') return { text: o.ok ? `已派给【${expertName(o.expertId)}】处理（${o.jobId}），好了会推回来。` : `派发专家失败：${o.reason ?? '未知'}` };
    if (r.toolName === 'follow_up_job') return { text: o.ok ? `已把补充要求转给 ${o.jobId}，L2 下一步会纳入。` : '当前没有运行中的任务可以补充。' };
    if (r.toolName === 'job_status') return { text: o.jobs.length ? `运行中：${o.jobs.map((j: any) => `${j.id}[${label(j.runtime)}] ${j.last}`).join('，')}` : '目前没有运行中的任务。' };
    if (r.toolName === 'request_secret') return { text: o.ok ? `已安全收到（${o.secretRef}），不会在对话里显示。` : `未收到：${o.reason ?? '已取消'}` };
    if (r.toolName === 'cancel_job') return { text: o.ok ? `已取消 ${o.jobId}。` : '没有可取消的任务。' };
  }
  // 2) L2 结果信号唤醒（沙箱或专家）
  if (signals.length && (fresh.includes('sandbox-result') || fresh.includes('expert-result'))) {
    const body = signals.at(-1)!.replace(/<[^>]+>/g, '').trim();
    if (fresh.includes('expert-result')) return { text: `✅ 专家完成：${body}` };
    return { text: `✅ 后台任务完成：${body}` };
  }
  // 3) 新用户消息
  if (/^(补充|追加)[:：]/.test(fresh)) return { toolCalls: [{ toolName: 'follow_up_job', args: { text: fresh.replace(/^(补充|追加)[:：]\s*/, '') } }] };
  if (/进度|状态/.test(fresh)) return { toolCalls: [{ toolName: 'job_status', args: {} }] };
  if (/密码|令牌|token/i.test(fresh) && !WORK.test(fresh)) return { toolCalls: [{ toolName: 'request_secret', args: { label: '密码', purpose: fresh.slice(0, 60) } }] };
  if (/^取消/.test(fresh)) return { toolCalls: [{ toolName: 'cancel_job', args: {} }] };
  if (/调研|对比|归纳|资料/.test(fresh)) return { toolCalls: [{ toolName: 'dispatch_to_expert', args: { expertId: 'researcher', prompt: fresh } }] };
  if (/代码|编程|bug|排错|实现/.test(fresh)) return { toolCalls: [{ toolName: 'dispatch_to_expert', args: { expertId: 'coder', prompt: fresh } }] };
  if (WORK.test(fresh)) return { toolCalls: [{ toolName: 'dispatch_to_sandbox', args: { prompt: fresh, runtime: chooseRuntime(fresh) } }] };
  return { text: `收到「${fresh.slice(0, 40)}」。我是 L1 管家，随时在线；专家与沙箱都在 L2，不会阻塞我。` };
}

const INSTRUCTIONS = `你是 L1 管家（orchestrator / 秘书）。必须立即回复用户，绝不等待长任务。
慢任务（读写文件、跑命令、做网页等）调用 dispatch_to_sandbox 交给 L2 沙箱（用户本机 ACP harness）。
调研/对比/归纳类调用 dispatch_to_expert(expertId=researcher)；编程/排错类调用 dispatch_to_expert(expertId=coder)。
专家与沙箱同属 L2：enqueue 后立即返回；完成后会以信号唤醒你。对用户只用自然语言说“我来处理/已派给专家/处理好了”，绝不提 L2、harness、ACP、沙箱、jobId、subagent 等内部细节。
桌面/截图/点击/GUI 选 cua；含“本地”或 route=local 选 local；否则 cloud。用户以“补充:”开头时调用 follow_up_job。
收到 <sandbox-result> / <expert-result> 时主动简要汇报。用户问进度时调用 job_status。
需要密码/令牌时调用 request_secret；只有工具返回 ok:true 后才能说已收到。
不要反问澄清；闲聊直接一句话回复。回复简短，用中文。`;

export type Dispatcher = (a: { sessionId: string; prompt: string; runtime: 'cloud' | 'local' | 'cua'; expertId?: string }) => Promise<{ jobId: string; runtime: string; status: string; expertId?: string }>;
/** A2A 模式下的任务查询（只读 L1 本地 registry，不打断 L2） */
export type StatusFn = (sessionId: string) => { id: string; runtime: string; status: string; last: string }[];
/** HITL 收密：只返回句柄，明文留在服务端 vault，绝不进模型上下文 */
export interface L1Hooks { dispatch?: Dispatcher; status?: StatusFn }
export async function buildL1(queue: JobQueue, dataDir: string, hooksOrDispatch?: Dispatcher | L1Hooks) {
  const hooks: L1Hooks = typeof hooksOrDispatch === 'function' ? { dispatch: hooksOrDispatch } : (hooksOrDispatch ?? {});
  const dispatch = hooks.dispatch;
  mkdirSync(dataDir, { recursive: true });
  const storage = new LibSQLStore({ id: 'preflight', url: `file:${resolve(dataDir, 'mastra.db')}` });
  const sid = (ctx: any): string => ctx?.requestContext?.get('controller')?.resourceId;

  // In-process L2 expert runners (Node MVP): peer Agents used only by background jobs — not controller.subagents.
  const expertAgents = new Map<string, Agent>();
  const getExpertAgent = (id: string, model: any) => {
    let a = expertAgents.get(id);
    if (!a) {
      const def = EXPERT_CATALOG.find(e => e.id === id)!;
      a = new Agent({ id: def.id, name: def.name, instructions: def.instructions, model });
      expertAgents.set(id, a);
    }
    return a;
  };

  /** Fire-and-forget L2 expert job for Node: generate then sendSignal expert-result. */
  const expertJobs = new Map<string, { expertId: string; status: string; result?: string }>();
  const runExpertBg = async (jobId: string, expertId: string, prompt: string, session: Session<any> | undefined, model: any) => {
    expertJobs.set(jobId, { expertId, status: 'running' });
    try {
      const a = getExpertAgent(expertId, model);
      const res: any = await a.generate(prompt, { maxSteps: 3 } as any);
      const reply = String(res?.text ?? '').replace(/^\s*\[agent:[\w-]+\]\s*/, '').trim();
      expertJobs.set(jobId, { expertId, status: 'completed', result: reply });
      session?.sendSignal({
        type: 'notification', tagName: 'expert-result', contents: reply,
        attributes: { expertId, jobId },
      } as any);
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 500);
      expertJobs.set(jobId, { expertId, status: 'failed', result: msg });
      session?.sendSignal({
        type: 'notification', tagName: 'expert-result', contents: `【失败】${msg}`,
        attributes: { expertId, jobId, state: 'failed' },
      } as any);
    }
  };

  const tools = {
    dispatch_to_sandbox: createTool({
      id: 'dispatch_to_sandbox',
      description: '把慢任务投递到 L2 沙箱队列，立即返回 jobId（不等待结果）。',
      inputSchema: z.object({ prompt: z.string(), runtime: z.enum(['cloud', 'local', 'cua']) }),
      execute: async ({ prompt, runtime }, ctx) => {
        if (dispatch) return dispatch({ sessionId: sid(ctx), prompt, runtime });
        const job = queue.assign({ sessionId: sid(ctx), prompt, runtime });
        return { jobId: job.id, runtime, status: job.status };
      },
    }),
    dispatch_to_expert: createTool({
      id: 'dispatch_to_expert',
      description: '把专家任务投递到 L2（与沙箱同管线），立即返回 jobId；完成后专家结果会推回。',
      inputSchema: z.object({
        expertId: z.enum(EXPERT_IDS as [string, ...string[]]),
        prompt: z.string(),
      }),
      execute: async ({ expertId, prompt }, ctx) => {
        if (!isExpertId(expertId)) return { ok: false, reason: 'unknown expert' };
        const sessionId = sid(ctx);
        if (dispatch) {
          const r = await dispatch({ sessionId, prompt, runtime: 'cloud', expertId });
          return { ok: true, jobId: r.jobId, expertId, status: r.status };
        }
        // Node MVP: enqueue locally + background L2 expert runner (not subagent tool).
        const jobId = `e-${crypto.randomUUID()}`;
        expertJobs.set(jobId, { expertId, status: 'queued' });
        const session = sessions.get(sessionId);
        const model = modelKind === 'real' ? (realId as any) : createScriptedModel(expertId, () => ({
          text: `（脚本）【${expertName(expertId)}】已处理：${prompt.slice(0, 80)}`,
        }));
        void runExpertBg(jobId, expertId, prompt, session, model);
        return { ok: true, jobId, expertId, status: 'queued' };
      },
    }),
    follow_up_job: createTool({
      id: 'follow_up_job',
      description: '给当前会话最近一个运行中的 L2 任务追加要求。',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }, ctx) => {
        if (dispatch) return { ok: false, reason: 'A2A 模式暂不支持运行中追加；请在完成后再发一条新任务' };
        const j = queue.activeFor(sid(ctx)).at(-1);
        return { ok: !!j && queue.followUp(j.id, text), jobId: j?.id };
      },
    }),
    job_status: createTool({
      id: 'job_status', description: '查询当前会话的 L2 任务进度。', inputSchema: z.object({}),
      execute: async (_i, ctx) => {
        if (hooks.status) return { jobs: hooks.status(sid(ctx)) };
        const sandbox = queue.activeFor(sid(ctx)).map(j => ({ id: j.id, runtime: j.runtime, status: j.status, last: j.progress.filter(p => (p as any).kind !== 'text').at(-1)?.msg ?? '' }));
        const experts = [...expertJobs.entries()].filter(([, j]) => j.status === 'queued' || j.status === 'running')
          .map(([id, j]) => ({ id: id.slice(0, 8), runtime: 'expert', status: j.status, last: expertName(j.expertId) }));
        return { jobs: [...sandbox, ...experts] };
      },
    }),
    cancel_job: createTool({
      id: 'cancel_job', description: '取消当前会话最近一个运行中的任务。', inputSchema: z.object({}),
      execute: async (_i, ctx) => { const j = queue.activeFor(sid(ctx)).at(-1); return { ok: !!j && queue.cancel(j.id), jobId: j?.id }; },
    }),
    request_secret: createTool({
      id: 'request_secret',
      description: '需要密码/令牌等敏感信息时调用：挂起并向用户弹出安全表单，用户提交后返回 secretRef 句柄（不含明文）。把 secretRef 原样写进 dispatch_to_sandbox 的 prompt，后台会自动注入。禁止让用户在聊天里直接发密码。',
      inputSchema: z.object({ label: z.string().describe('例如 “GitHub 令牌”'), purpose: z.string() }),
      suspendSchema: z.object({ label: z.string(), purpose: z.string() }),
      resumeSchema: z.object({ secretRef: z.string().optional(), cancelled: z.boolean().optional() }),
      outputSchema: z.object({ ok: z.boolean(), secretRef: z.string().optional(), reason: z.string().optional() }),
      execute: async ({ label, purpose }, ctx: any) => {
        const resume = ctx?.agent?.resumeData ?? ctx?.resumeData;
        if (resume) return resume.secretRef ? { ok: true, secretRef: resume.secretRef } : { ok: false, reason: '用户取消' };
        const suspend = ctx?.agent?.suspend ?? ctx?.suspend;
        if (!suspend) return { ok: false, reason: '当前运行不支持挂起' };
        await suspend({ label, purpose });
        return { ok: false, reason: 'suspended' };
      },
    }),
  };

  const realId = process.env.REAL_MODEL ?? 'deepseek/deepseek-chat';
  const scripted = createScriptedModel('orchestrator', l1Script);
  let modelKind: 'real' | 'scripted' = 'scripted';
  if (process.env.DEEPSEEK_API_KEY && process.env.USE_SCRIPTED !== '1') {
    try {
      const probe = new Agent({ id: 'probe', name: 'probe', instructions: '回答 ok', model: realId as any });
      await probe.generate('ping', { maxSteps: 1 } as any);
      modelKind = 'real';
    } catch (e: any) { console.warn('[L1] 真实模型探测失败，回退脚本模型:', String(e?.message ?? e).slice(0, 160)); }
  }
  console.log(`[L1] model = ${modelKind === 'real' ? realId : 'scripted/orchestrator'}`);
  const agent = new Agent({
    id: 'orchestrator', name: 'Orchestrator', instructions: INSTRUCTIONS,
    model: modelKind === 'real' ? (realId as any) : scripted,
  });
  const modelId = modelKind === 'real' ? realId : 'scripted/orchestrator';
  console.log(`[L1] experts = L2 catalog ${EXPERT_CATALOG.map(e => e.id).join(',')} (NOT controller.subagents)`);
  const controller = new AgentController({
    id: 'orchestrator', agent, storage,
    memory: new Memory({ storage, options: { lastMessages: 30 } }),
    tools,
    // No subagents — experts are L2 jobs via dispatch_to_expert.
    modes: [{ id: 'default', name: 'Default', default: true, availableTools: ['dispatch_to_sandbox', 'dispatch_to_expert', 'follow_up_job', 'job_status', 'cancel_job', 'request_secret'], defaultModelId: modelId }],
    toolCategoryResolver: () => 'read',
  });
  const mastra = new Mastra({ storage, logger: false, agentControllers: { orchestrator: controller } });
  await controller.init();

  const sessions = new Map<string, Session<any>>();
  async function getSession(sessionId: string) {
    let s = sessions.get(sessionId);
    if (!s) {
      s = await controller.createSession({ resourceId: sessionId, threadId: `thread-${sessionId}` });
      await s.permissions.setForCategory({ category: 'read', policy: 'allow' });
      sessions.set(sessionId, s);
    }
    return s;
  }

  // L2 → L1：结果/取消时唤醒对应会话
  queue.on('event', async (e: L2Event) => {
    if (e.type !== 'result') return;
    const s = sessions.get(e.job.sessionId);
    s?.sendSignal({ type: 'notification', tagName: 'sandbox-result', contents: e.job.result ?? '', attributes: { jobId: e.job.id, runtime: e.job.runtime } } as any);
  });

  return {
    mastra, controller, getSession,
    peekSession: (id: string) => sessions.get(id),
    modelKind: modelKind === 'real' ? realId : 'scripted',
    expertIds: EXPERT_CATALOG.map(e => e.id),
  };
}
