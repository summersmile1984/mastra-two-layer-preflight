// Probe: Mastra's DEFAULT A2A push sender with a loopback callback URL.
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { getAgentExecutionHandler } from '@mastra/server/handlers/a2a';
import { InMemoryTaskStore } from '@mastra/server/a2a/store';
import { createScriptedModel } from '../src/model/scripted-model';
const agent = new Agent({ id: 'echo', name: 'echo', instructions: 'echo', model: createScriptedModel('echo', () => ({ text: 'done' })) });
const mastra = new Mastra({ logger: false, agents: { echo: agent } });
const taskStore = new InMemoryTaskStore();
for (const url of ['http://127.0.0.1:4120/api/a2a-callback', 'http://localhost:4120/api/a2a-callback']) {
  const logger: any = { error: (m: string, e: any) => console.log('  logger.error:', m, '→', e?.message ?? e), warn() {}, info() {}, debug() {} };
  const r: any = await getAgentExecutionHandler({ requestId: '1', mastra, agentId: 'echo', method: 'message/send', taskStore, logger,
    params: { message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text: 'hi' }] }, configuration: { blocking: true, pushNotificationConfig: { url, token: 't' } } } } as any);
  console.log(url, 'task state =', r.result?.status?.state);
  await new Promise(r => setTimeout(r, 300));
}
