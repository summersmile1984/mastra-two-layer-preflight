/**
 * Shared status file for Tauri UI ↔ claim loop.
 * Path: ~/.config/mastra-l2/status.json
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type LoopStatusFile = {
  running: boolean;
  online: boolean;
  lastClaimAt: string | null;
  lastTaskId: string | null;
  lastKind: string | null;
  lastState: string | null;
  lastSummary: string | null;
  queueHint: string | null;
  error: string | null;
  pid: number | null;
  updatedAt: string;
};

const dir = () => join(homedir(), '.config', 'mastra-l2');
export const statusPath = () => join(dir(), 'status.json');

export function writeStatus(partial: Partial<LoopStatusFile>) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const prev = readStatus();
  const next: LoopStatusFile = {
    running: partial.running ?? prev?.running ?? true,
    online: partial.online ?? prev?.online ?? true,
    lastClaimAt: partial.lastClaimAt !== undefined ? partial.lastClaimAt : prev?.lastClaimAt ?? null,
    lastTaskId: partial.lastTaskId !== undefined ? partial.lastTaskId : prev?.lastTaskId ?? null,
    lastKind: partial.lastKind !== undefined ? partial.lastKind : prev?.lastKind ?? null,
    lastState: partial.lastState !== undefined ? partial.lastState : prev?.lastState ?? null,
    lastSummary: partial.lastSummary !== undefined ? partial.lastSummary : prev?.lastSummary ?? null,
    queueHint: partial.queueHint !== undefined ? partial.queueHint : prev?.queueHint ?? null,
    error: partial.error !== undefined ? partial.error : prev?.error ?? null,
    pid: partial.pid !== undefined ? partial.pid : prev?.pid ?? process.pid,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(statusPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function readStatus(): LoopStatusFile | null {
  const p = statusPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LoopStatusFile;
  } catch {
    return null;
  }
}
