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
    (j as any).cancelAcp?.();
    this.emitEv({ type: 'cancel', job: j });
    return true;
  }
  activeFor(sessionId: string) { return [...this.jobs.values()].filter(j => j.sessionId === sessionId && (j.status === 'running' || j.status === 'queued')); }
  emitEv(e: L2Event) { this.emit('event', e); }
}

