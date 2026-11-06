// L1 <-> L2 最小协议。两层的边界就是这里：job 队列 + 事件，而不是进程数。
export type Runtime = 'cloud' | 'local' | 'cua';
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

/** 路由：桌面/截图/点击/GUI → cua；含“本地”或 route=local → local；否则 cloud */
export function chooseRuntime(text: string): Runtime {
  if (/route=cua|runtime=cua|电脑使用|computer[- ]?use|截图|screenshot|点击|click\b|GUI|屏幕|鼠标/i.test(text)) return 'cua';
  if (/本地|route=local/i.test(text)) return 'local';
  return 'cloud';
}
