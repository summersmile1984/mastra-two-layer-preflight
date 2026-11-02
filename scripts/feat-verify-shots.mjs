import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';


const BASE = 'https://mastra-l1.summersmile1984.workers.dev';
const OUT = '/workspace/mastra-two-layer-preflight/verify-shots';
const SHOTS = '/workspace/shots';
mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const token = readFileSync('/tmp/mvp-tok-decoded.txt', 'utf8').trim();
const RID = '1e61c0c9-dcfb-4785-bc6b-cc04363dc1cf';

const ch = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=9345', '--window-size=1280,900',
  '--user-data-dir=/tmp/feat-chrome', 'about:blank',
], { stdio: 'ignore' });

await new Promise(r => setTimeout(r, 2500));
const tabs = await (await fetch('http://127.0.0.1:9345/json')).json();
const page = tabs.find(t => t.type === 'page') || tabs[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) pend.get(m.id)(m);
};
const cmd = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pend.set(i, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});

await cmd('Network.enable');
await cmd('Page.enable');
await cmd('Network.setCookie', {
  name: '__Secure-better-auth.session_token',
  value: token,
  domain: 'mastra-l1.summersmile1984.workers.dev',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
});

const shot = async (name) => {
  const r = await cmd('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const path = `${OUT}/${name}`;
  writeFileSync(path, Buffer.from(r.data, 'base64'));
  copyFileSync(path, `${SHOTS}/${name}`);
  console.log('saved', path);
};

const nav = async (url) => {
  await cmd('Page.navigate', { url });
  await cmd('Page.loadEventFired').catch(() => {});
  await new Promise(r => setTimeout(r, 2500));
};

const evalJs = async (expression) => {
  const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r?.result?.value;
};


const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const click = (re, sel = 'button') => evalJs(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(b=>${re}.test(b.textContent||''));b?.click();return !!b})()`);
const esc = () => cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).then(() => cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })).then(() => sleep(600));
await nav(`${BASE}/app`); await sleep(2500);
// settings tabs
for (const [tab, name] of [['permissions','settings-perms'],['vault','vault'],['usage','usage'],['update','update']]) {
  if (!(await evalJs(`!!document.querySelector('[data-tab]')`))) { await click('/设置/'); await sleep(1200); }
  await evalJs(`document.querySelector('[data-tab=${tab}]')?.click()`); await sleep(2200);
  await shot(`feat-${name}.png`);
}
await esc();
// connections (probe)
await click('/连接应用/'); await sleep(2500);
await click('/检测工具/'); await sleep(5000);
await shot('feat-connect.png'); await esc();
// builder: select first def
await click('/Agent Builder/'); await sleep(2000);
await evalJs(`(()=>{const b=[...document.querySelectorAll('[data-modal=builder] nav button')].find(b=>/法务顾问/.test(b.textContent||''));b?.click()})()`); await sleep(1000);
await shot('feat-builder.png'); await esc();
// templates
await click('/Bot 模板/'); await sleep(2500);
await shot('feat-templates.png'); await esc();
ws.close(); ch.kill(); process.exit(0);
