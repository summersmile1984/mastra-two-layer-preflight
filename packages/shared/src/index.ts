/** Thin shared types between L1 claim API and L2 desktop runtime. */

export type TaskKind = 'acp' | 'cua' | string;

export type ClaimTask = {
  taskId: string;
  prompt: string;
  /** L1 historically uses runtime local|cloud; map to kind via dispatch. */
  runtime?: 'local' | 'cloud' | string;
  kind?: TaskKind;
  threadId?: string;
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
