/**
 * Room expert catalog — allowlist + specialist instructions for **L2**.
 *
 * Product model:
 *   L1 = only butler / secretary / orchestrator
 *   L2 = everything else (researcher, coder, future experts) + PC ACP/CUA sandbox
 *
 * Flow (same as sandbox): butler/room turn **enqueues** into l2_tasks (expert_id set) →
 * L2 claims/runs with these instructions → pushes `[agent:<id>] …` back into the room thread.
 *
 * NOT AgentController.subagents[] (sync tool-style delegation). Catalog is allowlist only.
 */
export type ExpertDef = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** Optional tool ids an L2 expert runner may expose (empty = none). */
  allowedControllerTools: string[];
};

export const EXPERT_CATALOG: ExpertDef[] = [
  {
    id: 'researcher',
    name: '调研专家',
    description: '调研、对比分析、归纳要点；适合资料梳理与结论提炼。',
    instructions: `你是「调研专家」(researcher)。擅长资料梳理、对比分析、归纳要点。
回复简短、用中文；不要替其他 agent 说话；开头不要加 [agent:…] 标记。
没有检索工具时，基于常识与用户给定材料给出结构化要点。`,
    allowedControllerTools: ['job_status'],
  },
  {
    id: 'coder',
    name: '工程师',
    description: '编程、排错、技术方案；给最小可用示例。',
    instructions: `你是「工程师」(coder)。擅长写代码、排查 bug、解释技术方案；代码给最小可用示例。
回复简短、用中文；不要替其他 agent 说话；开头不要加 [agent:…] 标记。
需要跑命令或改文件时说明步骤，由管家决定是否派发后台执行。`,
    allowedControllerTools: ['job_status'],
  },
];

export const EXPERT_IDS = EXPERT_CATALOG.map(e => e.id) as [string, ...string[]];

/** Public list for GET /api/agents (includes non-removable orchestrator = L1). */
export const AGENT_CATALOG = [
  { id: 'orchestrator', name: '管家 Orchestrator', desc: 'L1 管家：闲聊、派发 L2 专家/沙箱任务' },
  ...EXPERT_CATALOG.map(e => ({ id: e.id, name: e.name, desc: `L2 · ${e.description}` })),
];

export function isExpertId(id: string): boolean {
  return EXPERT_CATALOG.some(e => e.id === id);
}
