/**
 * L2 as a Mastra Agent exposed over A2A (v0.3 JSON-RPC), served by @mastra/server's
 * real A2A handler (getAgentExecutionHandler + InMemoryTaskStore).
 *
 * Completion notify path (A2A push notification):
 *   L1 tool → POST /api/a2a/l2-worker  message/send { configuration:{ blocking:false, pushNotificationConfig:{url,token} } }
 *   → task "working" returned immediately → L2 agent runs (tool run_harness → ACP `dsh --profile acp`)
 *   → task "completed|failed" → pushNotificationSender.sendNotifications(task snapshot)
 *   → HTTP POST to callback /api/a2a-callback (token checked) → session.sendSignal → L1 replies on its own.
 *
 * Why a custom sender: Mastra's DefaultPushNotificationSender hard-blocks localhost / 127.x / 10.x /
 * 192.168.x / dotless hosts (SSRF guard; `allowedHosts` only narrows, can't re-allow loopback).
 * So we plug in a sender that POSTs ONLY to an exact allowlisted callback URL (our own server),
 * keeping the same A2A task-snapshot payload + X-A2A-Notification-Token header.
 */
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { AcpAgent } from '@mastra/acp';
import { getAgentExecutionHandler, getAgentCardByIdHandler } from '@mastra/server/handlers/a2a';
import { InMemoryTaskStore } from '@mastra/server/a2a/store';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';

export function commandExists(cmd: string): boolean {
  if (isAbsolute(cmd)) return existsSync(cmd);
  return (process.env.PATH ?? '').split(delimiter).some(d => existsSync(join(d, cmd)));
}
import { z } from 'zod';
import { createScriptedModel } from '../model/scripted-model';
import { acpProfile } from './acp-worker';
import { takeTaskSecrets, releaseTaskSecrets, redactKnownSecrets } from '../secrets';
import type { Runtime } from '../protocol';

export const L2_AGENT_ID = 'l2-worker';
export const a2aLog: any[] = [];
export const log = (msg: string, extra: any = {}) => { const x = JSON.parse(redactKnownSecrets(JSON.stringify(extra))); const e = { at: new Date().toISOString(), msg, ...x }; a2aLog.push(e); if (a2aLog.length > 500) a2aLog.shift(); console.log('[A2A]', msg, JSON.stringify(x).slice(0, 300)); };

/** Run one real prompt through the ACP harness (dsh) and return its final text. */
export async function runAcpPrompt(prompt: string, runtime: Runtime): Promise<string> {
  const prof = acpProfile(runtime);
  if (process.env.ACP_DRY_RUN === '1') return `[DRY-RUN，非真实执行] ${prompt}`;
  if (!commandExists(prof.command)) throw new Error(`ACP harness 命令不存在：${prof.command}（检查 PATH / ACP_COMMAND；或临时 ACP_DRY_RUN=1）`);
  mkdirSync(prof.cwd, { recursive: true });
  // secretRef 注入：明文只进本次 ACP 子进程 env，任务结束即释放
  const sec = takeTaskSecrets(prompt);
  if (sec.env) log('secret env bound for this task', { vars: Object.keys(sec.env) });
  // dsh 的 bash 工具会清洗环境变量 → 同时写一次性 0600 文件（仅本任务目录，任务结束删除）
  const secDir = sec.env ? join(prof.cwd, '.l2secret', sec.bindingId!) : '';
  if (sec.env) { mkdirSync(secDir, { recursive: true, mode: 0o700 }); for (const [k, v] of Object.entries(sec.env)) writeFileSync(join(secDir, k), v, { mode: 0o600 });
    prompt += `\n（若环境变量读不到，敏感值在文件 ./.l2secret/${sec.bindingId}/<变量名> 中；只能用 $(cat 文件) 引用，绝不打印或写出其内容）`; }
  const agent = new AcpAgent({
    id: `l2-a2a-${Date.now()}`, name: 'L2 Harness', description: 'ACP harness',
    command: prof.command, args: prof.args, cwd: prof.cwd, model: prof.model as any, ...(sec.env ? { env: sec.env } : {}),
    async onPermissionRequest(req: any) { const o = req.options.find((x: any) => /allow/i.test(x.kind ?? x.name)) ?? req.options[0]; return o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } }; },
  } as any);
  let out = '';
  // 超时保护：ACP_TIMEOUT_MS（默认 15 分钟）后 session/cancel + 断开，任务以 failed 推送给 L1
  const ms = Number(process.env.ACP_TIMEOUT_MS ?? 15 * 60_000);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; (agent as any).connection.cancel?.().catch(() => {}); setTimeout(() => (agent as any).connection.disconnect(), 3000); }, ms);
  try {
    for await (const ev of (agent as any).connection.promptStream(prompt)) {
      if (timedOut) break;
      if (ev.type === 'text') out += ev.text;
      else if (ev.update?.sessionUpdate === 'tool_call') log('harness tool_call', { title: ev.update.title });
    }
  } finally { clearTimeout(timer); try { (agent as any).connection.disconnect(); } catch {} out = redactKnownSecrets(out); releaseTaskSecrets(sec.bindingId); if (secDir) rmSync(secDir, { recursive: true, force: true }); }
  if (timedOut) throw new Error(`ACP harness 超时（${Math.round(ms / 1000)}s），已取消`);
  return redactKnownSecrets(out.trim()) || '(harness 无文本输出)';
}

/** L2 Mastra agent. Planner is deterministic (scripted): always run_harness once, then return its text. */
export function buildL2Agent() {
  const run_harness = createTool({
    id: 'run_harness', description: 'Run the task in the ACP harness (dsh) and return its answer.',
    inputSchema: z.object({ prompt: z.string(), runtime: z.enum(['cloud', 'local']) }),
    // 错误不抛给 A2A（否则 task 卡 failed 且无文本）；转成带前缀的 answer，callback 侧识别为失败
    execute: async ({ prompt, runtime }) => { try { return { answer: await runAcpPrompt(prompt, runtime) }; } catch (e: any) { log('harness error', { err: String(e?.message ?? e).slice(0, 200) }); return { answer: `【L2失败】${String(e?.message ?? e).slice(0, 400)}` }; } },
  });
  const model = createScriptedModel(L2_AGENT_ID, v => {
    const r = v.toolResultsSinceUser.at(-1);
    if (r) return { text: String((r.output as any)?.answer ?? JSON.stringify(r.output)) };
    const t = v.lastUserText;
    return { toolCalls: [{ toolName: 'run_harness', args: { prompt: t, runtime: /本地|route=local/i.test(t) ? 'local' : 'cloud' } }] };
  });
  return new Agent({ id: L2_AGENT_ID, name: 'L2 Worker', description: 'Runs real work via ACP harness (dsh).', instructions: 'Run the task via run_harness.', model, tools: { run_harness } });
}

/** In-memory push config store with the same shape as Mastra's InMemoryPushNotificationStore. */
class PushStore {
  m = new Map<string, Map<string, any>>();
  k = (a: string, t: string) => JSON.stringify([a, t]);
  set({ agentId, config }: any) { const c = { taskId: config.taskId, pushNotificationConfig: { ...config.pushNotificationConfig, id: config.pushNotificationConfig.id || config.taskId } }; const s = this.m.get(this.k(agentId, c.taskId)) ?? new Map(); s.set(c.pushNotificationConfig.id, structuredClone(c)); this.m.set(this.k(agentId, c.taskId), s); return structuredClone(c); }
  get({ agentId, params }: any) { return structuredClone(this.m.get(this.k(agentId, params.id))?.get(params.pushNotificationConfigId || params.id) ?? null); }
  list({ agentId, params }: any) { return [...(this.m.get(this.k(agentId, params.id))?.values() ?? [])].map(c => structuredClone(c)); }
  delete({ agentId, params }: any) { return this.m.get(this.k(agentId, params.id))?.delete(params.pushNotificationConfigId) ?? false; }
}

/** Push sender that only allows exact allowlisted callback URLs (loopback OK because it's our own server). */
export class AllowlistedPushSender {
  store = new PushStore();
  constructor(private allowed: string[]) {}
  getStore() { return this.store; }
  async sendNotifications({ agentId, task }: any) {
    for (const cfg of this.store.list({ agentId, params: { id: task.id } })) {
      const url = cfg.pushNotificationConfig.url;
      if (!this.allowed.includes(url)) { log('push REJECTED (not allowlisted)', { url }); continue; }
      log('push POST', { taskId: task.id, state: task.status.state, url });
      try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.pushNotificationConfig.token ? { 'X-A2A-Notification-Token': cfg.pushNotificationConfig.token } : {}) }, body: JSON.stringify(task), signal: AbortSignal.timeout(5000) });
      log('push delivered', { status: res.status });
      } catch (e: any) { log('push FAILED', { url, err: String(e?.message ?? e).slice(0, 120) }); }
    }
  }
}

/** 公网回调：用 Mastra 官方 DefaultPushNotificationSender（带 SSRF 防护）。本地/同机：AllowlistedPushSender。 */
export function makeA2ARoutes(app: any, mastra: any, sender: AllowlistedPushSender | any, baseUrl: string) {
  const taskStore = new InMemoryTaskStore();
  app.get(`/api/.well-known/${L2_AGENT_ID}/agent-card.json`, async (c: any) => {
    const card: any = await getAgentCardByIdHandler({ mastra, agentId: L2_AGENT_ID, executionUrl: `${baseUrl}/api/a2a/${L2_AGENT_ID}`, pushNotifications: true } as any);
    return c.json(card);
  });
  app.post(`/api/a2a/${L2_AGENT_ID}`, async (c: any) => {
    const body = await c.req.json();
    const res = await getAgentExecutionHandler({ requestId: body.id, mastra, agentId: L2_AGENT_ID, method: body.method, params: body.params, taskStore, pushNotificationSender: sender, logger: { error: (...a: any[]) => log('server error', { a: String(a[0]) + ' ' + String(a[1]?.message ?? '') }), warn() {}, info() {}, debug() {} } as any } as any);
    return c.json(res);
  });
  return taskStore;
}

/** Minimal A2A v0.3 JSON-RPC client call: non-blocking message/send with push config. */
export async function a2aSendNonBlocking(execUrl: string, text: string, push: { url: string; token: string }) {
  const r = await fetch(execUrl, { signal: AbortSignal.timeout(15000), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text }] }, configuration: { blocking: false, pushNotificationConfig: push } },
  }) });
  const j: any = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result; // Task snapshot (state: working)
}
