/**
 * Smoke: L1 butler has NO controller.subagents; experts are L2 catalog + dispatch_to_expert tool.
 */
import { AGENT_CATALOG, EXPERT_CATALOG } from '../src/l1/experts.ts';
import { JobQueue } from '../src/l2/queue.ts';
import { buildL1 } from '../src/l1/controller.ts';

async function main() {
  console.log('catalog', AGENT_CATALOG.map(a => a.id));
  console.log('l2Experts', EXPERT_CATALOG.map(s => ({ id: s.id, name: s.name })));
  const q = new JobQueue();
  const l1 = await buildL1(q, './data-scripted');
  console.log('ok', l1.modelKind, 'expertIds', l1.expertIds);
  if ((l1 as any).subagentIds) throw new Error('subagentIds should be removed');
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
