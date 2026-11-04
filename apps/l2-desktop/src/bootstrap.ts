/**
 * Desktop sidecar bootstrap (macOS): Node fetch ignores system proxy. If the Mac has an
 * HTTPS system proxy (scutil --proxy) and no HTTPS_PROXY env, re-exec this process with
 * HTTPS_PROXY + NODE_USE_ENV_PROXY=1 (Node ≥24). Also loads package .env when present
 * (Tauri spawn does not pass --env-file). Returns true if the caller should stop (child owns run).
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export function bootstrap(): boolean {
  try { if (existsSync('.env')) (process as any).loadEnvFile?.('.env'); } catch {}
  if (process.env.L2_BOOTSTRAPPED === '1') return false;
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy && process.platform === 'darwin') {
    try {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 });
      const en = /HTTPSEnable\s*:\s*1/.test(out);
      const host = out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (en && host && port) {
        const url = `http://${host}:${port}`;
        const env = { ...process.env, HTTPS_PROXY: url, HTTP_PROXY: url, NODE_USE_ENV_PROXY: '1', L2_BOOTSTRAPPED: '1' };
        console.log('[l2-desktop] system proxy detected →', url, '(re-exec with NODE_USE_ENV_PROXY)');
        const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { env, stdio: 'inherit' });
        for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => child.kill(s));
        child.on('exit', (code) => process.exit(code ?? 0));
        return true;
      }
    } catch {}
  }
  if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
    const env = { ...process.env, NODE_USE_ENV_PROXY: '1', L2_BOOTSTRAPPED: '1' };
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { env, stdio: 'inherit' });
    for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => child.kill(s));
    child.on('exit', (code) => process.exit(code ?? 0));
    return true;
  }
  return false;
}
