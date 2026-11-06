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
  '--user-data-dir=/tmp/spa-chrome', 'about:blank',
], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 3000));
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
await cmd('Runtime.enable');

const setSession = async () => {
  const r = await cmd('Network.setCookie', {
    name: '__Secure-better-auth.session_token',
    value: token,
    url: BASE + '/',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  });
  console.log('setCookie', r);
};

const clearSession = async () => {
  await cmd('Network.deleteCookies', {
    name: '__Secure-better-auth.session_token',
    url: BASE + '/',
  }).catch(() => {});
  await cmd('Network.deleteCookies', {
    name: '__Secure-better-auth.session_token',
    domain: 'mastra-l1.summersmile1984.workers.dev',
    path: '/',
  }).catch(() => {});
};

const shot = async (name) => {
  const r = await cmd('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const path = `${OUT}/${name}`;
  writeFileSync(path, Buffer.from(r.data, 'base64'));
  copyFileSync(path, `${SHOTS}/${name}`);
  console.log('saved', path, Buffer.from(r.data, 'base64').length);
};

const nav = async (url) => {
  const p = cmd('Page.navigate', { url });
  await p;
  // wait for network idle-ish
  await new Promise(r => setTimeout(r, 3500));
};

const evalJs = async (expression) => {
  const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) console.error('eval err', JSON.stringify(r.exceptionDetails));
  return r?.result?.value;
};

// --- auth (logged out) ---
await clearSession();
await nav(`${BASE}/app`);
await evalJs(`await new Promise(r=>setTimeout(r,800))`);
let state = await evalJs(`document.body.innerText.slice(0,120)`);
console.log('auth state:', state);
await shot('ui-light-auth.png');

// --- logged in ---
await setSession();
await nav(`${BASE}/app#dm`);
await evalJs(`await new Promise(r=>setTimeout(r,2500))`);
state = await evalJs(`({text:document.body.innerText.slice(0,200), hasRoot:!!document.querySelector('#root'), me:!!document.body.innerText.includes('MVP')})`);
console.log('dm state:', state);
// force click butler if needed
await evalJs(`(async()=>{
  const b=[...document.querySelectorAll('button')].find(el=>/小助手|管家 Orchestrator|管家/.test(el.textContent||'') && el.textContent.length<40);
  b?.click();
  await new Promise(r=>setTimeout(r,1500));
})()`);
await shot('ui-light-dm.png');

await evalJs(`(async()=>{
  const el=[...document.querySelectorAll('button')].find(e=>/MVP 专家房|专家房/.test(e.textContent||''));
  console.log('room btn', !!el);
  el?.click();
  await new Promise(r=>setTimeout(r,2000));
})()`);
state = await evalJs(`document.body.innerText.slice(0,250)`);
console.log('room state:', state);
await shot('ui-light-room.png');

await evalJs(`(async()=>{
  const btn=[...document.querySelectorAll('button')].find(b=>/设置/.test(b.textContent||''));
  btn?.click();
  await new Promise(r=>setTimeout(r,1500));
})()`);
state = await evalJs(`document.body.innerText.slice(0,250)`);
console.log('settings state:', state);
await shot('ui-light-settings.png');

ws.close();
ch.kill();
process.exit(0);
