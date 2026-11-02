/** Thin shared types between L1 claim API and L2 desktop runtime. */

export type TaskKind = 'acp' | 'cua' | string;

export type ClaimTask = {
  taskId: string;
  prompt: string;
  /** L1: cloud | local | cua (computer-use). */
  runtime?: 'local' | 'cloud' | 'cua' | string;
  /** Derived on claim: cua when runtime is cua/computer, else acp. */
  kind?: TaskKind;
  threadId?: string;
  expertId?: string | null;
};

export type ClaimResponse = {
  task: ClaimTask | null;
};

export type TaskResultState = 'completed' | 'failed';

export type CompletePayload = {
  id: string;
  kind: 'task';
  status: { state: TaskResultState; timestamp: string };
  artifacts: Array<{ artifactId: string; parts: Array<{ kind: 'text'; text: string }> }>;
};
