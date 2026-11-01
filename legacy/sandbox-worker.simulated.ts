/**
 * L2：沙箱/worker 运行时（本 preflight 为进程内模拟）。
 * 只通过 JobQueue（assign 入队）和 EventEmitter（progress/result）与 L1 交互，
 * L1 代码不会 import 这里的实现细节。换成真实沙箱时：
 *   - cloud: 在 runJob() 里调用 E2B / Daytona / Modal 等，或把队列换成 Redis Streams 由远端 worker 消费
 *   - local: 在用户机器上跑一个同协议的 worker 进程（拉同一个队列）
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Job, L2Event, Runtime } from '../protocol';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class JobQueue extends EventEmitter {
  jobs = new Map<string, Job>();
  private pending: Record<Runtime, Job[]> = { cloud: [], local: [] };
  private waiters: Record<Runtime, Array<(j: Job) => void>> = { cloud: [], local: [] };

  assign(input: { sessionId: string; prompt: string; runtime: Runtime }): Job {
    const job: Job = { id: 'job_' + randomUUID().slice(0, 6), ...input, status: 'queued', progress: [], followUps: [], createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    this.emitEv({ type: 'assign', job });
    const w = this.waiters[job.runtime].shift();
    if (w) w(job); else this.pending[job.runtime].push(job);
    return job;
  }
  /** worker 拉取下一个 job（阻塞等待） */
  pull(runtime: Runtime): Promise<Job> {
    const j = this.pending[runtime].shift();
    return j ? Promise.resolve(j) : new Promise(r => this.waiters[runtime].push(r));
  }
  followUp(jobId: string, text: string) {
    const j = this.jobs.get(jobId);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return false;
    j.followUps.push(text);
    this.emitEv({ type: 'follow_up', job: j, text });
    return true;
  }
  cancel(jobId: string) {
    const j = this.jobs.get(jobId);
    if (!j || j.status === 'done') return false;
    j.status = 'cancelled';
    this.emitEv({ type: 'cancel', job: j });
    return true;
  }
  activeFor(sessionId: string) { return [...this.jobs.values()].filter(j => j.sessionId === sessionId && (j.status === 'running' || j.status === 'queued')); }
  emitEv(e: L2Event) { this.emit('event', e); }
}

const STEPS: Record<Runtime, string[]> = {
  cloud: ['申请云端沙箱', '拉取代码/数据', '执行分析', '汇总中间结果', '生成报告', '清理沙箱'],
  local: ['连接本地 runner', '准备本地环境', '执行任务', '收集输出', '生成报告'],
};

async function runJob(q: JobQueue, job: Job, tickMs: number) {
  job.status = 'running';
  const steps = STEPS[job.runtime];
  let seenFollowUps = 0;
  for (let i = 0; i < steps.length; i++) {
    await sleep(tickMs);
    if (job.status === 'cancelled') return;
    let msg = steps[i]!;
    if (job.followUps.length > seenFollowUps) { msg += `（已纳入补充要求：${job.followUps.slice(seenFollowUps).join('；')}）`; seenFollowUps = job.followUps.length; }
    const tick = { at: new Date().toISOString(), pct: Math.round(((i + 1) / steps.length) * 100), msg };
    job.progress.push(tick);
    q.emitEv({ type: 'progress', job, tick });
  }
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
  const label = job.runtime === 'cloud' ? '云端' : '本地';
  job.result = `[${label}] 「${job.prompt}」完成：共 ${steps.length} 步，耗时 ${((Date.parse(job.finishedAt) - Date.parse(job.createdAt)) / 1000).toFixed(1)}s` +
    (job.followUps.length ? `；已处理补充：${job.followUps.join('；')}` : '') + '。（模拟结果）';
  q.emitEv({ type: 'result', job });
}

/** 启动一个 worker 循环：每个 runtime 可起多个，模拟并发沙箱 */
export function startSandboxWorker(q: JobQueue, runtime: Runtime, opts: { tickMs?: number } = {}) {
  const tickMs = opts.tickMs ?? Number(process.env.L2_TICK_MS ?? 1000);
  (async () => {
    for (;;) {
      const job = await q.pull(runtime);
      if (job.status === 'cancelled') continue;
      runJob(q, job, tickMs).catch(e => { job.status = 'failed'; job.result = String(e); q.emitEv({ type: 'result', job }); });
    }
  })();
}
