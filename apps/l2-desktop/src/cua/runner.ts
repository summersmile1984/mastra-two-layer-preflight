import type { ClaimTask } from '@mastra-preflight/shared';

/** One CUA step: observe screen → decide act → apply. Stub until OS permissions + Tauri plugins. */
export type CuaAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'done'; summary: string };

export interface CuaComputer {
  screenshot(): Promise<Uint8Array>;
  act(action: Exclude<CuaAction, { type: 'done' }>): Promise<void>;
}

/** In-memory stub computer (no OS access). */
export class StubComputer implements CuaComputer {
  async screenshot(): Promise<Uint8Array> {
    console.log('[cua] stub screenshot');
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // fake PNG magic
  }
  async act(action: Exclude<CuaAction, { type: 'done' }>): Promise<void> {
    console.log('[cua] stub act', action);
  }
}

/**
 * CUA loop interface: screenshot → model decide → act → until done.
 * Stub: one fake iteration then done. Pending: Accessibility / Screen Recording on macOS, etc.
 */
export async function runCua(task: ClaimTask, computer: CuaComputer = new StubComputer()): Promise<{ ok: true; text: string }> {
  console.log('[cua] stub loop start', task.taskId);
  const shot = await computer.screenshot();
  console.log('[cua] got frame bytes', shot.byteLength);
  // Fake policy: no real model; immediately finish.
  const action: CuaAction = { type: 'done', summary: `Stub CUA finished for ${task.taskId}` };
  if (action.type !== 'done') await computer.act(action);
  return { ok: true, text: `[cua-stub] ${action.type === 'done' ? action.summary : 'ok'}` };
}
