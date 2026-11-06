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
  resourceId?: string | null;
  expertId?: string | null;
  /** Expert system instructions when kind=expert (catalog / agent_defs). */
  instructions?: string | null;
  /** Expert model override from agent_defs (claim-time lookup). */
  model?: string | null;
  /** Full agent_defs snapshot (expert-forge S2.1) for JIT agent construction. */
  def?: ExpertDefSnapshot | null;
};

/** Snapshot of an agent_defs row carried on expert tasks (JSON fields as stored). */
export type ExpertDefSnapshot = {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  model?: string | null;
  tools_json?: string | null;
  mcp_json?: string | null;
  skills_json?: string | null;
  memory_json?: string | null;
  updated_at?: number | null;
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
