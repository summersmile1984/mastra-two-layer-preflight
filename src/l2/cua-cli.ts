/**
 * Real trycua `cua` CLI computer-use for L2.
 * Shared by apps/l2-desktop and src/l2-pull-worker (Mac Node claim without Tauri).
 *
 * Env:
 *   CUA_BIN          absolute path or name of cua (default: cua / ~/.local/bin/cua)
 *   CUA_DO_TARGET    switch target (default: host)
 *   CUA_WORKDIR      dir for task screenshots (default: os.tmpdir()/cua-l2)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type CuaAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'done'; summary: string };

export interface CuaComputer {
  screenshot(savePath?: string): Promise<Uint8Array>;
  act(action: Exclude<CuaAction, { type: 'done' }>): Promise<void>;
  shell?(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export type CuaTaskLike = {
  taskId: string;
  prompt: string;
  runtime?: string;
  kind?: string;
};

function resolveCuaBin(): string {
  const fromEnv = process.env.CUA_BIN?.trim();
  if (fromEnv) return fromEnv;
  const local = join(homedir(), '.local', 'bin', 'cua');
  if (existsSync(local)) return local;
  return 'cua';
}

function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...opts.env, PATH: `${join(homedir(), '.local', 'bin')}:${process.env.PATH || ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cua timed out after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Fail clearly if cua missing or spacesd unreachable. */
export async function assertCuaReady(bin = resolveCuaBin()): Promise<void> {
  let probe: { code: number; stdout: string; stderr: string };
  try {
    probe = await run(bin, ['--version'], { timeoutMs: 8_000 });
  } catch (e: any) {
    throw new Error(`cua binary missing or not runnable (${bin}): ${String(e?.message ?? e)}`);
  }
  if (probe.code !== 0) {
    throw new Error(`cua --version failed (code ${probe.code}): ${(probe.stderr || probe.stdout).slice(0, 300)}`);
  }
  // Prefer host status when available (spacesd listen check)
  try {
    const st = await run(bin, ['host', 'status'], { timeoutMs: 10_000 });
    const out = `${st.stdout}\n${st.stderr}`;
    if (st.code !== 0 && /not running|connection refused|No such file/i.test(out)) {
      throw new Error(`cua-spacesd down: ${out.slice(0, 400)}`);
    }
    if (/launchd.*not|service:.*stopped|connection refused/i.test(out)) {
      throw new Error(`cua-spacesd not healthy: ${out.slice(0, 400)}`);
    }
  } catch (e: any) {
    if (String(e?.message ?? e).includes('cua-spacesd')) throw e;
    // older cua without host status — continue; switch will fail later if dead
  }
}

export class CuaCliComputer implements CuaComputer {
  readonly bin: string;
  readonly target: string;
  private switched = false;

  constructor(opts?: { bin?: string; target?: string }) {
    this.bin = opts?.bin ?? resolveCuaBin();
    this.target = opts?.target ?? (process.env.CUA_DO_TARGET?.trim() || 'host');
  }

  private async cua(args: string[], timeoutMs = 60_000) {
    const r = await run(this.bin, ['do', ...args], { timeoutMs });
    if (r.code !== 0) {
      throw new Error(`cua do ${args.join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 500)}`);
    }
    return r;
  }

  async ensureTarget(): Promise<void> {
    if (this.switched) return;
    await this.cua(['switch', this.target], 30_000);
    this.switched = true;
  }

  async screenshot(savePath?: string): Promise<Uint8Array> {
    await this.ensureTarget();
    const path = savePath || join(tmpdir(), `cua-shot-${Date.now()}.png`);
    mkdirSync(dirname(path), { recursive: true });
    await this.cua(['screenshot', '--save', path], 45_000);
    if (!existsSync(path)) throw new Error(`cua screenshot did not write ${path}`);
    const buf = readFileSync(path);
    return new Uint8Array(buf);
  }

  async act(action: Exclude<CuaAction, { type: 'done' }>): Promise<void> {
    await this.ensureTarget();
    if (action.type === 'click') {
      await this.cua(['click', String(Math.round(action.x)), String(Math.round(action.y))], 30_000);
      return;
    }
    if (action.type === 'type') {
      await this.cua(['type', action.text], 60_000);
      return;
    }
    if (action.type === 'key') {
      await this.cua(['key', action.key], 20_000);
      return;
    }
  }

  async shell(cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
    await this.ensureTarget();
    // Prefer login shell so PATH matches interactive Mac user
    const r = await run(this.bin, ['do', 'shell', '--', '/bin/bash', '-lc', cmd], {
      timeoutMs: 120_000,
    });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  }
}

function workDir(): string {
  const d = process.env.CUA_WORKDIR?.trim() || join(tmpdir(), 'cua-l2');
  mkdirSync(d, { recursive: true });
  return d;
}

function extractToken(prompt: string): string | null {
  const m = prompt.match(/\b(CUA_REAL_\d+)\b/) || prompt.match(/\b([A-Z]{2,}_REAL_\d+)\b/);
  return m?.[1] ?? null;
}

function parseClick(prompt: string): { x: number; y: number } | null {
  const m = prompt.match(/click\s+(?:at\s+)?(\d+)\s*[, ]\s*(\d+)/i)
    || prompt.match(/点击\s*[（(]?(\d+)\s*[,，]\s*(\d+)/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

function parseType(prompt: string): string | null {
  const m = prompt.match(/type\s+["'「](.+?)["'」]/i)
    || prompt.match(/输入\s*["'「](.+?)["'」]/);
  return m?.[1] ?? null;
}

function parseKey(prompt: string): string | null {
  const m = prompt.match(/\bkey\s+(\w+)\b/i) || prompt.match(/按键\s+(\w+)/);
  return m?.[1] ?? null;
}

function wantsHostname(prompt: string): boolean {
  return /hostname|主机名/i.test(prompt);
}

function wantsScreenshot(prompt: string): boolean {
  return /screenshot|截图|屏幕/i.test(prompt) || true; // always screenshot in MVP
}

/** Extract "write TOKEN to PATH" style instructions for shell. */
function parseWriteFile(prompt: string): { path: string; content: string } | null {
  const token = extractToken(prompt);
  // English: write … to ~/Downloads/...
  let m = prompt.match(/write\s+(?:token\s+)?[`'"]?(\S+?)[`'"]?\s+to\s+([~/][^\s,，]+)/i);
  if (m) return { content: m[1], path: m[2] };
  m = prompt.match(/写入\s*(?:文件\s*)?([~/][^\s,，]+).*?(?:内容|为)[：:\s]*[`'"]?(\S+?)[`'"]?/i);
  if (m) return { path: m[1], content: m[2] };
  m = prompt.match(/(?:文件|file)\s+([~/][^\s,，]+).*?(CUA_REAL_\d+)/i);
  if (m) return { path: m[1], content: m[2] };
  m = prompt.match(/(CUA_REAL_\d+).*?(?:写入|write).*?([~/][^\s,，]+)/i);
  if (m) return { content: m[1], path: m[2] };
  // Common E2E shape: path + token both present
  const pathM = prompt.match(/((?:~\/|\/Users\/)[^\s,，]+\.txt)/);
  if (pathM && token) return { path: pathM[1], content: token };
  return null;
}

function parseShellCommand(prompt: string): string | null {
  const m = prompt.match(/cua do shell\s+--\s+(.+)$/im)
    || prompt.match(/shell\s*[：:]\s*`([^`]+)`/i)
    || prompt.match(/运行命令\s*[：:]\s*`([^`]+)`/);
  return m?.[1]?.trim() || null;
}

/**
 * MVP CUA loop (bounded, pragmatic — not a full VLM agent):
 * switch host → screenshot → optional shell/hostname/file → optional click/type/key → text report.
 */
export async function runCuaTask(
  task: CuaTaskLike,
  computer: CuaCliComputer = new CuaCliComputer(),
): Promise<{ ok: true; text: string; screenshotPath?: string; screenshotBytes?: number }> {
  await assertCuaReady(computer.bin);
  const actions: string[] = [];
  const prompt = String(task.prompt || '');
  const token = extractToken(prompt);

  const shotPath = join(workDir(), `${task.taskId.replace(/[^\w-]/g, '_')}.png`);
  let shotBytes = 0;
  let hostname = '';
  let shellOut = '';
  let fileProof = '';

  await computer.ensureTarget();
  actions.push(`switch ${computer.target}`);

  if (wantsScreenshot(prompt)) {
    const bytes = await computer.screenshot(shotPath);
    shotBytes = bytes.byteLength;
    actions.push(`screenshot → ${shotPath} (${shotBytes} bytes)`);
  }

  const write = parseWriteFile(prompt);
  const explicitShell = parseShellCommand(prompt);
  const needHost = wantsHostname(prompt) || !!token || !!write;

  if (write) {
    const expanded = write.path.replace(/^~(?=$|\/)/, homedir());
    const dir = expanded.includes('/') ? expanded.slice(0, expanded.lastIndexOf('/')) : '.';
    const cmd = `mkdir -p ${JSON.stringify(dir)} && printf '%s\\n' ${JSON.stringify(write.content)} > ${JSON.stringify(expanded)} && hostname && cat ${JSON.stringify(expanded)} && wc -c ${JSON.stringify(expanded)}`;
    const r = await computer.shell!(cmd);
    shellOut = (r.stdout || r.stderr).trim();
    actions.push(`shell write ${expanded} (code ${r.code})`);
    if (r.code !== 0) throw new Error(`cua shell write failed: ${shellOut.slice(0, 400)}`);
    const hm = shellOut.match(/^([^\n]+)/);
    if (hm) hostname = hm[1].trim();
    fileProof = expanded;
  } else if (explicitShell) {
    const r = await computer.shell!(explicitShell);
    shellOut = (r.stdout || r.stderr).trim();
    actions.push(`shell: ${explicitShell.slice(0, 80)} (code ${r.code})`);
    if (r.code !== 0) throw new Error(`cua shell failed: ${shellOut.slice(0, 400)}`);
  } else if (needHost) {
    const r = await computer.shell!('hostname');
    hostname = (r.stdout || r.stderr).trim().split('\n')[0]?.trim() || '';
    actions.push(`shell hostname → ${hostname}`);
    if (r.code !== 0) throw new Error(`cua hostname failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  }

  const click = parseClick(prompt);
  if (click) {
    await computer.act({ type: 'click', x: click.x, y: click.y });
    actions.push(`click ${click.x},${click.y}`);
  }
  const typeText = parseType(prompt);
  if (typeText) {
    await computer.act({ type: 'type', text: typeText });
    actions.push(`type ${typeText.slice(0, 40)}`);
  }
  const key = parseKey(prompt);
  if (key) {
    await computer.act({ type: 'key', key });
    actions.push(`key ${key}`);
  }

  const lines = [
    `CUA real (trycua CLI) completed for ${task.taskId}`,
    hostname ? `hostname: ${hostname}` : null,
    token ? `token: ${token}` : null,
    shotPath ? `screenshot: ${shotPath} (${shotBytes} bytes)` : null,
    fileProof ? `file: ${fileProof}` : null,
    `actions: ${actions.join(' | ')}`,
    shellOut ? `shell_output:\n${shellOut.slice(0, 1500)}` : null,
  ].filter(Boolean);

  const text = lines.join('\n');
  if (/\[cua-stub\]/i.test(text)) throw new Error('internal error: stub text leaked');
  return { ok: true, text, screenshotPath: shotPath, screenshotBytes: shotBytes };
}

/** Keep StubComputer only for unit tests; never the default path. */
export class StubComputer implements CuaComputer {
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  }
  async act(): Promise<void> {}
}
