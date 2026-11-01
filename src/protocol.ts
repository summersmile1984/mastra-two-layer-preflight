// L1 <-> L2 最小协议。两层的边界就是这里：job 队列 + 事件，而不是进程数。
export type Runtime = 'cloud' | 'local';
export type JobStatus = 'queued' | 'running' | 'done' | 'cancelled' | 'failed';
export interface ProgressTick { at: string; pct: number; msg: string; kind?: string }
export interface Job {
  id: string; sessionId: string; prompt: string; runtime: Runtime;
  status: JobStatus; progress: ProgressTick[]; followUps: string[]; result?: string;
  createdAt: string; finishedAt?: string;
}
export type L2Event =
  | { type: 'assign'; job: Job }
  | { type: 'progress'; job: Job; tick: ProgressTick }
  | { type: 'follow_up'; job: Job; text: string }
  | { type: 'result'; job: Job }
  | { type: 'cancel'; job: Job };

/** 路由规则：含“本地”或 route=local → local，否则 cloud */
export function chooseRuntime(text: string): Runtime {
  return /本地|route=local/i.test(text) ? 'local' : 'cloud';
}
