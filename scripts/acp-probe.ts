import { AcpAgent } from '@mastra/acp';
const a = new AcpAgent({ id: 'dsh', description: 'probe', command: process.env.ACP_COMMAND ?? 'dsh', args: (process.env.ACP_ARGS ?? '--profile acp').split(' ').filter(Boolean), cwd: process.env.ACP_CWD ?? '/workspace/acp-sandbox', persistSession: false });
const t0 = Date.now();
try {
  for await (const ev of a.connection.promptStream('用一句话回答：1+1 等于几？然后列出当前目录文件数。')) {
    if (ev.type === 'text') process.stdout.write(ev.text);
    else console.log('\n[update]', ev.update.sessionUpdate, JSON.stringify(ev.update).slice(0, 160));
  }
  console.log('\nOK sessionId', a.connection.sessionId, Date.now() - t0, 'ms');
} catch (e: any) { console.error('ERR', String(e?.message ?? e).slice(0, 800)); }
a.connection.disconnect(); process.exit(0);
