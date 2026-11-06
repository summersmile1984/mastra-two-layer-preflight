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
  '--remote-debugging-port=9344', '--window-size=1200,900',
  '--user-data-dir=/tmp/mvp-chrome', 'about:blank',
], { stdio: 'ignore' });

await new Promise(r => setTimeout(r, 2500));
const tabs = await (await fetch('http://127.0.0.1:9344/json')).json();
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

// (a) butler DM
await nav(`${BASE}/app`);
await new Promise(r => setTimeout(r, 2000));
// ensure butler selected
await evalJs(`(async()=>{
  if (typeof selectButler==='function') selectButler();
  else if (typeof showButler==='function') showButler();
  else {
    const b=[...document.querySelectorAll('button,a,.item,.room')].find(el=>/管家|小助手|butler|私聊/i.test(el.textContent||''));
    b?.click();
  }
  await new Promise(r=>setTimeout(r,800));
})()`);
await new Promise(r => setTimeout(r, 1500));
await shot('mvp-a-butler-dm.png');

// (b) room with agents
await evalJs(`(async()=>{
  if (typeof selectRoom==='function') selectRoom('${RID}');
  else {
    const el=[...document.querySelectorAll('button,a,.item,.room,li')].find(e=>/MVP 专家房|专家房/.test(e.textContent||''));
    el?.click();
  }
  await new Promise(r=>setTimeout(r,1200));
})()`);
await new Promise(r => setTimeout(r, 2000));
await shot('mvp-b-room-agents.png');

// (c) connections
await evalJs(`(async()=>{
  if (typeof openConnections==='function') openConnections();
  else document.querySelector('button')?.closest('body');
  const btn=[...document.querySelectorAll('button')].find(b=>/连接应用/.test(b.textContent||''));
  btn?.click();
  await new Promise(r=>setTimeout(r,1200));
})()`);
await new Promise(r => setTimeout(r, 1500));
await shot('mvp-c-connections.png');
await evalJs(`typeof closeConnections==='function' && closeConnections()`);

// (d) settings general + rename
await evalJs(`(async()=>{
  if (typeof openSettings==='function') openSettings('general');
  else [...document.querySelectorAll('button')].find(b=>/设置/.test(b.textContent||''))?.click();
  await new Promise(r=>setTimeout(r,800));
  const inp=document.querySelector('#butlerName,input[name=display_name],#display_name');
  if(inp){inp.focus(); inp.value='小助手MVP'; inp.dispatchEvent(new Event('input',{bubbles:true}));}
})()`);
await new Promise(r => setTimeout(r, 1200));
await shot('mvp-d-settings-general.png');

// (e) settings computer
await evalJs(`(async()=>{
  if (typeof openSettings==='function') openSettings('device');
  else if (typeof openSettings==='function') openSettings('computer');
  const tab=[...document.querySelectorAll('button,a,[role=tab],.tab')].find(el=>/电脑/.test(el.textContent||''));
  tab?.click();
  await new Promise(r=>setTimeout(r,1000));
})()`);
await new Promise(r => setTimeout(r, 1500));
await shot('mvp-e-settings-device.png');

ws.close();
ch.kill();
process.exit(0);
