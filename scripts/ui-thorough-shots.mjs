// E2E: register → settings tour → rooms create/invite/members/@专家 (L2 async) → screenshots in /workspace/shots
import { spawn, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const BASE = 'https://mastra-l1.summersmile1984.workers.dev';
const SHOTS = '/workspace/shots';
const stamp = Date.now();
const A = { email: `ui-a-${stamp}@example.com`, name: 'Alex测试', pw: `Pw-${stamp}-xx` };
const B = { email: `ui-b-${stamp}@example.com`, name: '小B', pw: `Pw-${stamp}-yy` };
const log = []; const ok = (k, v, extra) => { log.push({ k, ok: !!v, ...(extra || {}) }); console.log(v ? 'PASS' : 'FAIL', k, extra ? JSON.stringify(extra).slice(0, 200) : ''); };

// user B via curl (cookie jar)
const jarB = `/tmp/jarB-${stamp}`;
const curlB = (path, body, method = 'POST') => JSON.parse(execSync(`curl -s -c ${jarB} -b ${jarB} -X ${method} -H 'content-type: application/json' -H 'origin: ${BASE}' ${body ? `-d '${JSON.stringify(body)}'` : ''} ${BASE}${path}`).toString() || '{}');
curlB('/api/auth/sign-up/email', { email: B.email, password: B.pw, name: B.name });

const ch = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9356', '--window-size=1366,900', `--user-data-dir=/tmp/ui-th-${stamp}`, 'about:blank'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 3000));
const tabs = await (await fetch('http://127.0.0.1:9356/json')).json();
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) pend.get(m.id)(m); };
const cmd = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) console.error('eval', JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; };
const shot = async (n) => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${SHOTS}/${n}`, Buffer.from(r.data, 'base64')); console.log('shot', n); };
const H = `
const setV=(el,v)=>{const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));};
const btn=(t,root=document)=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===t||b.textContent.includes(t));
const ph=(t)=>[...document.querySelectorAll('input,textarea')].find(i=>(i.placeholder||'').includes(t));
`;
const run = (body) => ev(H + body);
const wf = async (cond, ms = 40000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await run(cond)) return true; await sleep(700); } console.log('wait timeout', cond.slice(0, 80)); return false; };

await cmd('Page.navigate', { url: BASE + '/app' }); await wf(`return !!btn('注册')`);
await run(`btn('注册').click();`); await sleep(500);
await run(`setV(ph('you@example.com'),${JSON.stringify(A.email)});setV(ph('群里显示的名字'),${JSON.stringify(A.name)});setV(ph('至少 8 位'),${JSON.stringify(A.pw)});`);
await shot('ui-auth-register.png');
await run(`btn('注册并登录').click();`); await wf(`return !!btn('⚙ 设置')`);
ok('register+login', await run(`return !!btn('⚙ 设置')`));

// ---- Settings tour ----
await run(`btn('⚙ 设置').click();`); await wf(`return !!document.getElementById('butlerName')`);
await run(`setV(document.getElementById('butlerName'),'小蜜');btn('保存显示名').click();`); await sleep(2500);
await run(`setV(document.getElementById('acctName'),'Alex 改名');btn('保存昵称').click();`); await sleep(2500);
await shot('ui-settings-1-general.png');
const me = JSON.parse(await run(`return JSON.stringify((await (await fetch('/api/me')).json()))`));
ok('butler rename persisted', me.butler?.name === '小蜜', { butler: me.butler?.name });
ok('account name persisted', me.user?.name === 'Alex 改名', { name: me.user?.name });
const tabsList = [['computer', '2-computer'], ['permissions', '3-permissions'], ['schedules', '4-schedules'], ['vault', '5-vault'], ['usage', '6-usage'], ['update', '7-update']];
for (const [t, n] of tabsList) {
  await run(`document.querySelector('[data-tab="${t}"]').click();`); await sleep(2200);
  if (t === 'permissions') {
    const before = await run(`return (await (await fetch('/api/permissions')).json()).autoReview`);
    ok('permissions default-allow (autoReview on)', before === true, { autoReview: before });
  }
  if (t === 'vault') {
    await run(`const ins=[...document.querySelectorAll('[data-pane="vault"] input')];setV(ins[0],'demo-key');setV(ins.find(i=>i.type==='password')||ins[1],'sk-demo-not-real-123456');btn('保存',document.querySelector('[data-pane="vault"]'))?.click()||btn('添加',document.querySelector('[data-pane="vault"]'))?.click();`); await sleep(2500);
    const v = await run(`return (await (await fetch('/api/vault')).json())`);
    ok('vault add', JSON.stringify(v).includes('demo-key'));
  }
  if (t === 'schedules') {
    await run(`setV(ph('名称，例如'),'早间简报UI');setV(ph('触发时发给目标的提示词'),'用一句话问好');btn('创建定时任务').click();`); await sleep(3000);
    await run(`btn('运行记录')?.click();`); await sleep(1500);
  }
  await shot(`ui-settings-${n}.png`);
}
const sch = await run(`return (await (await fetch('/api/schedules')).json()).schedules.length`);
ok('schedule created via UI', sch >= 1, { n: sch });
await run(`document.querySelector('[role=dialog] button[aria-label], [aria-label="关闭"]')?.click(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`); await sleep(800);

// ---- Rooms ----
await cmd('Page.navigate', { url: BASE + '/app#dm' }); await wf(`return !!ph('新建群名称')`);
await run(`setV(ph('新建群名称'),'产品讨论群');btn('新建群').click();`); await wf(`return !!document.querySelector('[data-testid=room-settings]') && !!document.querySelector('aside select')`); await sleep(1500);
const rooms = await run(`return (await (await fetch('/api/rooms')).json()).rooms`);
const room = rooms.find(r => r.name === '产品讨论群'); ok('room create', !!room);
await shot('ui-rooms-1-created.png');
await wf(`return [...document.querySelectorAll('aside select option')].some(o=>o.value==='researcher')`); await run(`const s=[...document.querySelectorAll('aside select')][0];setV(s,'researcher');`); await sleep(400); await run(`btn('添加').click();`); await wf(`return document.body.innerText.includes('L2 专家')`); await sleep(1500);
await wf(`return [...document.querySelectorAll('aside select option')].some(o=>o.value==='coder')`); await run(`const s=[...document.querySelectorAll('aside select')][0];setV(s,'coder');`); await sleep(400); await run(`btn('添加').click();`); await wf(`return document.body.innerText.includes('L2 专家')`); await sleep(1500);
await run(`setV(ph('对方邮箱'),${JSON.stringify(B.email)});btn('发送邀请').click();`); await sleep(2500);
await shot('ui-rooms-2-agents-invite.png');
// B accepts via API
const bRooms = curlB('/api/rooms', null, 'GET'); const inv = (bRooms.invites || []).find(i => i.room_id === room.id);
ok('B sees invite', !!inv); if (inv) curlB(`/api/rooms/invites/${inv.id}/accept`, {});
await cmd('Page.navigate', { url: BASE + '/app?r=' + Date.now() + '#' + room.id }); await wf(`return !!document.querySelector('[data-testid=room-settings]')`); await sleep(2500);
const det = await run(`return (await (await fetch('/api/rooms/${room.id}')).json())`);
ok('member list has B', det.members.some(m => m.email === B.email), { members: det.members.length });
// promote B to admin via UI
await wf(`return !!btn('设为管理员')`); await run(`btn('设为管理员').click();`); await sleep(2500);
const det2 = await run(`return (await (await fetch('/api/rooms/${room.id}')).json())`);
ok('role change admin', det2.members.find(m => m.email === B.email)?.role === 'admin');
await run(`setV(ph('新群名'),'产品讨论群·v2');btn('改名').click();`); await sleep(2500);
await shot('ui-rooms-3-members-roles.png');
// @专家 via mention chip
await run(`document.querySelector('[data-testid="mention-researcher"]').click();`); await sleep(500); await run(`const t=document.querySelector('textarea');setV(t,t.value+'对比一下 SQLite 和 D1 的三条差异');`); await sleep(400);
const t0 = Date.now();
await run(`btn('发送').click();`);
await sleep(1500); await shot('ui-rooms-4-sending.png');
await sleep(4000);
const pending = await run(`return !!document.querySelector('[data-testid="expert-pending"]')`);
const tasks0 = await run(`return (await (await fetch('/api/rooms/${room.id}/tasks')).json()).tasks`);
ok('@专家 enqueued as L2 task (async)', tasks0.some(t => t.expert_id === 'researcher'), { states: tasks0.map(t => t.state), pendingChipShown: pending, ackMs: Date.now() - t0 });
await shot('ui-rooms-5-l2-pending.png');
let done = false;
for (let i = 0; i < 30 && !done; i++) { await sleep(4000); done = await run(`return [...document.querySelectorAll('.whitespace-pre-wrap')].length>=3 && document.body.innerText.split('🤖 调研专家').length>2`); }
const tasks1 = await run(`return (await (await fetch('/api/rooms/${room.id}/tasks')).json()).tasks`);
ok('L2 expert result bubble in room', done, { states: tasks1.map(t => t.state) });
await shot('ui-rooms-6-expert-reply.png');
// B leaves; owner revoke + delete flow on a 2nd room
curlB(`/api/rooms/${room.id}/leave`, {});
const det3 = await run(`return (await (await fetch('/api/rooms/${room.id}')).json())`);
ok('member leave', !det3.members.some(m => m.email === B.email));
await run(`setV(ph('新建群名称'),'临时群');btn('新建群').click();`); await sleep(4000);
await run(`setV(ph('对方邮箱'),'nobody-${stamp}@example.com');btn('发送邀请').click();`); await sleep(2500);
await run(`btn('撤销').click();`); await sleep(2500);
await shot('ui-rooms-7-revoke.png');
await run(`btn('解散群聊').click();`); await sleep(400); await run(`btn('再次点击确认解散').click();`); await sleep(3500);
const left = await run(`return (await (await fetch('/api/rooms')).json()).rooms.map(r=>r.name)`);
ok('room delete', !left.includes('临时群'), { rooms: left });
await shot('ui-rooms-8-after-delete.png');
// Desktop WebView viewport (narrower, as embedded in Mastra Desktop)
await cmd('Emulation.setDeviceMetricsOverride', { width: 1024, height: 720, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: BASE + '/app?embed=desktop#' + room.id }); await wf(`return !!document.querySelector('[data-testid=room-settings]')`); await sleep(2500);
await shot('ui-desktop-webview-room.png');
writeFileSync(`${SHOTS}/ui-thorough-summary.json`, JSON.stringify({ at: new Date().toISOString(), base: BASE, version: (await (await fetch(BASE + '/health-l1')).json()).version, results: log, pass: log.every(x => x.ok) }, null, 2));
ch.kill(); process.exit(0);
