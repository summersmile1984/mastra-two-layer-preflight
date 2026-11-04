/** Thin shared types between L1 claim API and L2 desktop runtime. */

export type TaskKind = 'acp' | 'cua' | 'expert' | string;

export type ClaimTask = {
  taskId: string;
  prompt: string;
  /** L1: cloud | local | cua | expert. */
  runtime?: 'local' | 'cloud' | 'cua' | 'expert' | string;
  /** Derived on claim: expert | cua | acp. */
  kind?: TaskKind;
  threadId?: string;
  expertId?: string | null;
  /** Expert system instructions when kind=expert (catalog / agent_defs). */
  instructions?: string | null;
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
