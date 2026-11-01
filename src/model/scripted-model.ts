/**
 * A deterministic, offline LanguageModelV2 used when no LLM API key is present.
 * It lets the whole orchestration (tool calls, approvals, background jobs,
 * memory, signals) run end-to-end without network access.
 *
 * Set MODEL=openai/gpt-5-mini (plus OPENAI_API_KEY) or any Mastra model-router
 * string to use a real model instead. See src/model/index.ts.
 */
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider-v5';

export type ScriptDecision =
  | { text: string }
  | { toolCalls: Array<{ toolName: string; args: Record<string, unknown> }> };

export interface ScriptView {
  /** Text of the most recent user-role message (signals arrive as user-role XML). */
  lastUserText: string;
  /** Tool results produced since the last user message (most recent last). */
  toolResultsSinceUser: Array<{ toolName: string; output: unknown }>;
  /** Full system prompt (instructions). */
  system: string;
  /** Names of the tools exposed to the model on this call. */
  toolNames: string[];
  /** All user-role texts in the prompt (oldest first), useful to show memory recall. */
  allUserTexts: string[];
  /** User-role texts after the last assistant *text* reply (several can pile up when signals/messages are delivered together). */
  pendingUserTexts: string[];
  /** User-role texts after the last assistant message of any kind (i.e. not yet acted on). */
  unhandledUserTexts: string[];
  /** Tool results after the last assistant text reply. */
  toolResultsSinceReply: Array<{ toolName: string; output: unknown }>;
  /** Flattened prompt, oldest first (user text, assistant text, tool calls, tool results). */
  timeline: TimelineEntry[];
}

export type TimelineEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool-call'; toolName: string; input: unknown }
  | { kind: 'tool-result'; toolName: string; output: unknown };

export type Script = (view: ScriptView) => ScriptDecision;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((p: any) => (p?.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  return '';
}

function buildView(options: LanguageModelV2CallOptions): ScriptView {
  const prompt = options.prompt;
  let lastUserIdx = -1;
  prompt.forEach((m, i) => {
    if (m.role === 'user') lastUserIdx = i;
  });
  const toolResultsSinceUser: ScriptView['toolResultsSinceUser'] = [];
  for (let i = lastUserIdx + 1; i < prompt.length; i++) {
    const m = prompt[i]!;
    if (m.role === 'tool') {
      for (const part of m.content as any[]) {
        if (part.type === 'tool-result') {
          const out = part.output;
          toolResultsSinceUser.push({ toolName: part.toolName, output: out?.value ?? out });
        }
      }
    }
  }
  let lastAssistantTextIdx = -1;
  prompt.forEach((m, i) => {
    if (m.role === 'assistant' && (m.content as any[]).some((p: any) => p.type === 'text' && p.text?.trim())) lastAssistantTextIdx = i;
  });
  const pendingUserTexts = prompt
    .slice(lastAssistantTextIdx + 1)
    .filter(m => m.role === 'user')
    .map(m => textOf(m.content));
  let lastAssistantIdx = -1;
  prompt.forEach((m, i) => {
    if (m.role === 'assistant') lastAssistantIdx = i;
  });
  const unhandledUserTexts = prompt.slice(lastAssistantIdx + 1).filter(m => m.role === 'user').map(m => textOf(m.content));
  const toolResultsSinceReply: ScriptView['toolResultsSinceReply'] = [];
  for (const m of prompt.slice(lastAssistantTextIdx + 1)) {
    if (m.role !== 'tool') continue;
    for (const part of m.content as any[]) if (part.type === 'tool-result') toolResultsSinceReply.push({ toolName: part.toolName, output: part.output?.value ?? part.output });
  }
  const timeline: TimelineEntry[] = [];
  for (const m of prompt) {
    if (m.role === 'user') timeline.push({ kind: 'user', text: textOf(m.content) });
    else if (m.role === 'assistant')
      for (const p of m.content as any[]) {
        if (p.type === 'text' && p.text?.trim()) timeline.push({ kind: 'assistant', text: p.text });
        if (p.type === 'tool-call') timeline.push({ kind: 'tool-call', toolName: p.toolName, input: p.input });
      }
    else if (m.role === 'tool')
      for (const p of m.content as any[]) if (p.type === 'tool-result') timeline.push({ kind: 'tool-result', toolName: p.toolName, output: p.output?.value ?? p.output });
  }
  return {
    timeline,
    pendingUserTexts,
    unhandledUserTexts,
    toolResultsSinceReply,
    lastUserText: lastUserIdx >= 0 ? textOf(prompt[lastUserIdx]!.content) : '',
    toolResultsSinceUser,
    system: prompt.filter(m => m.role === 'system').map(m => textOf(m.content)).join('\n'),
    toolNames: (options.tools ?? []).map(t => t.name),
    allUserTexts: prompt.filter(m => m.role === 'user').map(m => textOf(m.content)),
  };
}

let callSeq = 0;
// Per-process prefix so tool-call ids stay unique across crash/recovery restarts.
const PROC = Math.random().toString(36).slice(2, 7);

export function createScriptedModel(id: string, script: Script): LanguageModelV2 {
  const decide = (options: LanguageModelV2CallOptions) => {
    const view = buildView(options);
    const decision = script(view);
    if (process.env.DEBUG_MODEL) console.log(`[model:${id}]`, JSON.stringify({ view, decision }, null, 2));
    return decision;
  };
  const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 };

  return {
    specificationVersion: 'v2',
    provider: 'scripted',
    modelId: id,
    supportedUrls: {},
    async doGenerate(options) {
      const d = decide(options);
      const content: LanguageModelV2Content[] =
        'text' in d
          ? [{ type: 'text', text: d.text }]
          : d.toolCalls.map(tc => ({
              type: 'tool-call' as const,
              toolCallId: `call_${id}_${PROC}_${++callSeq}`,
              toolName: tc.toolName,
              input: JSON.stringify(tc.args),
            }));
      return { content, finishReason: 'text' in d ? 'stop' : 'tool-calls', usage, warnings: [] };
    },
    async doStream(options) {
      const d = decide(options);
      const parts: LanguageModelV2StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: `resp_${++callSeq}`, modelId: id, timestamp: new Date() },
      ];
      if ('text' in d) {
        const tid = `t${callSeq}`;
        parts.push({ type: 'text-start', id: tid }, { type: 'text-delta', id: tid, delta: d.text }, { type: 'text-end', id: tid });
      } else {
        for (const tc of d.toolCalls) {
          parts.push({ type: 'tool-call', toolCallId: `call_${id}_${PROC}_${++callSeq}`, toolName: tc.toolName, input: JSON.stringify(tc.args) });
        }
      }
      parts.push({ type: 'finish', finishReason: 'text' in d ? 'stop' : 'tool-calls', usage });
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      });
      return { stream };
    },
  };
}
