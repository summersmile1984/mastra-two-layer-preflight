import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';


const BASE = 'https://mastra-l1.summersmile1984.workers.dev';
const OUT = '/workspace/shots';
const SHOTS = '/workspace/shots';
mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const token = readFileSync('/tmp/mvp-tok-decoded.txt', 'utf8').trim();


const ch = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=9355', '--window-size=1280,900',
  '--user-data-dir=/tmp/mem-chrome', 'about:blank',
], { stdio: 'ignore' });

await new Promise(r => setTimeout(r, 2500));
const tabs = await (await fetch('http://127.0.0.1:9355/json')).json();
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


const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const click=(re,sel)=>evalJs(`(()=>{const e=[...document.querySelectorAll('${sel}')].reverse().find(x=>${re}.test(x.textContent));if(e){e.click();return true}return false})()`);
const RID = readFileSync('/tmp/rid','utf8').trim();
await nav(`${BASE}/app`); await sleep(4000);
await shot('mem-dm.png');
await click('/mem-e2e-room/', 'button, a, li, div[role=button]'); await sleep(3000);
await shot('mem-room.png');
await nav(`${BASE}/api/memory`); await sleep(1500); await shot('mem-api.png');
const del = await evalJs(`fetch('/api/rooms/${RID}',{method:'DELETE'}).then(r=>r.json())`);
console.log('DELETE', JSON.stringify(del));
writeFileSync('/tmp/del.json', JSON.stringify(del));
await nav(`${BASE}/app`); await sleep(4000); await shot('mem-dissolved.png');
const after = await evalJs(`fetch('/api/rooms/${RID}/messages').then(r=>r.status)`);
console.log('room GET after delete', after);
ch.kill(); process.exit(0);
