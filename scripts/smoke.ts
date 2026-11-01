// 冒烟：模拟浏览器标签页，经 HTTP+SSE 走完验收场景，打印带时间戳的事件
const BASE = process.env.BASE ?? 'http://localhost:4120';
const sid = 'smoke-' + Math.random().toString(36).slice(2, 6);
const t0 = Date.now();
const ts = () => `${new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })} +${((Date.now() - t0) / 1000).toFixed(2)}s`;
const post = (p: string, b: any) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
await post('/api/session', { sessionId: sid });
const res = await fetch(`${BASE}/api/events?sessionId=${sid}`);
const results: string[] = [];
(async () => {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body as any) {
    buf += dec.decode(chunk);
    let i; while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = raw.split('\n').find(l => l.startsWith('data:')); if (!line || line === 'data: ') continue;
      const e = JSON.parse(line.slice(5));
      if (e.kind === 'l2' && e.tick?.kind === 'text') continue;
      if (e.kind === 'l1') console.log(ts(), 'L1 >', e.text);
      else if (e.kind === 'l1_tool') console.log(ts(), 'L1 tool', e.tool, JSON.stringify(e.args));
      else if (e.kind === 'l2') { const lab = e.job.runtime === 'local' ? '本地' : '云端'; console.log(ts(), `L2 [${lab}] ${e.type}`, e.job.id, e.tick ? (e.tick.kind === 'text' ? '' : e.tick.msg) : e.text ?? e.job.result ?? ''); if (e.type === 'result') results.push(e.job.id); }
      else console.log(ts(), e.kind, e.text ?? '');
    }
  }
})();
const say = (t: string) => { console.log(ts(), 'USER >', t); return post('/api/message', { sessionId: sid, text: t }); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
await sleep(300);
await say('帮我统计当前目录有多少文件，然后写一个 hello.txt，内容是“来自 ACP harness”');
await sleep(3000);
await say('你好，现在还在吗？');
await sleep(2000);
await say('补充: 最后告诉我 hello.txt 的字节数');
await sleep(2000);
await say('查进度');
await sleep(2000);
await say('在本地跑：输出 node -v 的结果');
const dl = Date.now() + 240000;
while (results.length < 2 && Date.now() < dl) await sleep(500);
await sleep(8000);
console.log(ts(), 'DONE results=', results.length);
process.exit(0);
