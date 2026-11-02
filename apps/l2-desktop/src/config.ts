/**
 * L1 pull URL + device token.
 * Prefer env; optional local file ~/.config/mastra-l2/device.json { "l1Url", "token", "intervalMs" }.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type L2Config = {
  l1Url: string;
  token: string;
  intervalMs: number;
};

export function devicePath() {
  return join(homedir(), '.config', 'mastra-l2', 'device.json');
}

function fromFile(): Partial<L2Config> {
  const p = devicePath();
  if (!existsSync(p)) return {};
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    return {
      l1Url: typeof j.l1Url === 'string' ? j.l1Url : undefined,
      token: typeof j.token === 'string' ? j.token : undefined,
      intervalMs: typeof j.intervalMs === 'number' ? j.intervalMs : undefined,
    };
  } catch {
    return {};
  }
}

export function loadConfig(): L2Config {
  const file = fromFile();
  const l1Url = String(process.env.L1_PULL_URL || file.l1Url || 'https://mastra-l1.summersmile1984.workers.dev').replace(/\/$/, '');
  const token = String(process.env.PUSH_TOKEN || process.env.L2_DEVICE_TOKEN || file.token || '');
  const intervalMs = Number(process.env.L2_PULL_INTERVAL_MS || file.intervalMs || 2000);
  if (!token) throw new Error('Missing PUSH_TOKEN / L2_DEVICE_TOKEN (or ~/.config/mastra-l2/device.json token)');
  return { l1Url, token, intervalMs };
}

export function saveConfig(cfg: L2Config) {
  const dir = join(homedir(), '.config', 'mastra-l2');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(devicePath(), JSON.stringify({ l1Url: cfg.l1Url, token: cfg.token, intervalMs: cfg.intervalMs }, null, 2), {
    mode: 0o600,
  });
}
