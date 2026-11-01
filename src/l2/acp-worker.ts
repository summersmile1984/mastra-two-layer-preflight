/**
 * L2：真实 ACP harness worker（不再模拟）。
 * 每个 job 用 @mastra/acp 的 AcpAgent 拉起一个用户安装的 harness 进程（默认 `dsh --profile acp`），
 * 通过 ACP stdio JSON-RPC：initialize → session/new → session/prompt，session/update 实时转成进度事件。
 * 追加要求（follow_up）在同一 ACP session 里作为下一轮 session/prompt 发送；取消 → session/cancel。
 *
 * 配置（runtime=cloud|local 只是“用哪个 ACP 配置”的标签）：
 *   ACP_COMMAND / ACP_ARGS / ACP_CWD              默认配置（dsh / "--profile acp" / ./workspace-l2）
 *   ACP_LOCAL_COMMAND / ACP_LOCAL_ARGS / ACP_LOCAL_CWD   local 覆盖
 *   ACP_CLOUD_COMMAND / ACP_CLOUD_ARGS / ACP_CLOUD_CWD   cloud 覆盖（如远端 ssh/容器里的 harness）
 *   ACP_MODEL  可选，session/set_model
 *   ACP_DRY_RUN=1  仅最后手段：不拉进程，回显 prompt（结果明确标注 DRY-RUN）
 */
import { AcpAgent } from '@mastra/acp';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Job, Runtime } from '../protocol';
import type { JobQueue } from './queue';

export interface AcpProfile { command: string; args: string[]; cwd: string; model?: string }
const splitArgs = (s?: string) => (s ?? '').match(/"[^"]*"|\S+/g)?.map(a => a.replace(/^"|"$/g, '')) ?? [];

export function acpProfile(runtime: Runtime): AcpProfile {
  const R = runtime.toUpperCase();
  const e = process.env;
  const command = e[`ACP_${R}_COMMAND`] ?? e.ACP_COMMAND ?? 'dsh';
  const args = splitArgs(e[`ACP_${R}_ARGS`] ?? e.ACP_ARGS ?? (command === 'dsh' ? '--profile acp' : ''));
  const cwd = resolve(e[`ACP_${R}_CWD`] ?? e.ACP_CWD ?? `./workspace-l2/${runtime}`);
  return { command, args, cwd, model: e.ACP_MODEL };
}

/** 把一条 ACP session/update 转成一行中文进度（给聊天气泡用） */
function describe(u: any): string | null {
  switch (u.sessionUpdate) {
    case 'tool_call': return `🔧 ${u.title ?? u.kind ?? '工具调用'}${u.rawInput?.command ? `：${String(u.rawInput.command).slice(0, 80)}` : ''}`;
    case 'tool_call_update': return u.status ? `${u.status === 'completed' ? '✓' : u.status === 'failed' ? '✗' : '…'} 工具 ${u.status}` : null;
    case 'plan': return `📋 计划：${(u.entries ?? []).map((x: any) => x.content).join(' / ').slice(0, 120)}`;
    case 'agent_thought_chunk': return null; // 思考流太碎，单独聚合
    default: return null;
  }
}

async function runJob(q: JobQueue, job: Job) {
  const prof = acpProfile(job.runtime);
  job.status = 'running';
  (job as any).acp = { command: prof.command, args: prof.args, cwd: prof.cwd };
  const tick = (msg: string, kind = 'step') => { const t = { at: new Date().toISOString(), pct: -1, msg, kind } as any; job.progress.push(t); q.emitEv({ type: 'progress', job, tick: t }); };

  if (process.env.ACP_DRY_RUN === '1') {
    tick('⚠️ DRY-RUN：未启动 ACP 进程');
    job.result = `[DRY-RUN，非真实执行] ${job.prompt}`; job.status = 'done'; job.finishedAt = new Date().toISOString();
    q.emitEv({ type: 'result', job }); return;
  }
  mkdirSync(prof.cwd, { recursive: true });
  const agent = new AcpAgent({
    id: `l2-${job.id}`, name: 'L2 Harness', description: 'User-installed ACP harness',
    command: prof.command, args: prof.args, cwd: prof.cwd, model: prof.model as any,
    persistSession: true, // 同一 job 内 follow-up 复用 session，结束后 disconnect
    async onPermissionRequest(req: any) {
      const opt = req.options.find((o: any) => /allow/i.test(o.kind ?? o.name)) ?? req.options[0];
      tick(`🔐 权限请求「${req.toolCall?.title ?? ''}」→ ${opt?.name ?? '取消'}`);
      return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } };
    },
  });
  (job as any).cancelAcp = () => agent.connection.cancel().catch(() => {});
  tick(`🚀 启动 ${prof.command} ${prof.args.join(' ')}（cwd ${prof.cwd}）`, 'spawn');

  let answer = '', thought = '';
  let prompt = job.prompt, seen = 0;
  try {
    for (;;) {
      let turn = '';
      for await (const ev of agent.connection.promptStream(prompt)) {
        if (job.status === 'cancelled') break;
        if (ev.type === 'text') { turn += ev.text; q.emitEv({ type: 'progress', job, tick: { at: new Date().toISOString(), pct: -1, msg: ev.text, kind: 'text' } as any }); continue; }
        const u: any = ev.update;
        if (u.sessionUpdate === 'agent_thought_chunk') { thought += u.content?.text ?? ''; if (thought.length > 60) { tick(`💭 ${thought.replace(/\s+/g, ' ').slice(0, 100)}`, 'thought'); thought = ''; } continue; }
        const m = describe(u); if (m) tick(m);
      }
      answer += (answer ? '\n\n' : '') + turn;
      if (job.status === 'cancelled') return;
      if (job.followUps.length > seen) { prompt = `用户追加要求（请在本 session 继续完成）：${job.followUps.slice(seen).join('；')}`; seen = job.followUps.length; tick(`➕ 追加一轮 prompt：${prompt}`); continue; }
      break;
    }
    job.status = 'done';
    job.result = answer.trim() || '(harness 无文本输出)';
  } catch (e: any) {
    job.status = 'failed';
    job.result = `ACP 调用失败：${String(e?.message ?? e).slice(0, 600)}`;
  } finally {
    agent.connection.disconnect();
  }
  job.finishedAt = new Date().toISOString();
  q.emitEv({ type: 'result', job });
}

/** 每个 runtime 一个并发上限（ACP_CONCURRENCY，默认 2） */
export function startAcpWorker(q: JobQueue, runtime: Runtime) {
  const n = Number(process.env.ACP_CONCURRENCY ?? 2);
  for (let i = 0; i < n; i++) (async () => {
    for (;;) {
      const job = await q.pull(runtime);
      if (job.status === 'cancelled') continue;
      await runJob(q, job).catch(e => { job.status = 'failed'; job.result = String(e); q.emitEv({ type: 'result', job }); });
    }
  })();
}
