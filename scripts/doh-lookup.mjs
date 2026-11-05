// DoH（HTTP 调 DNS）解析器 —— 系统 DNS 被污染/劫持时的标准解析方式。
// 用法一（undici/net）：import { dohLookup } from './doh-lookup.mjs'，配到 Agent 的 connect.lookup。
// 用法二（node 进程整体改写，含 wrangler）：NODE_OPTIONS=--import=<本文件绝对路径> <cmd>
//   —— 预加载时会把 dns.lookup / dns.promises.lookup 换成 DoH 实现。
// 用法三（curl）：curl --doh-url https://dns.google/dns-query <url>（等价，无需本文件）。
// 引导防递归：DoH 服务端点用固定 anycast IP + 正确 servername（证书校验仍按域名）。
import https from 'node:https';
import dns from 'node:dns';

const BOOTSTRAP = [
  { host: '8.8.8.8', servername: 'dns.google', path: 'https://dns.google/resolve' },
  { host: '1.1.1.1', servername: 'cloudflare-dns.com', path: 'https://cloudflare-dns.com/dns-query' },
];

function queryOne(boot, name, type) {
  return new Promise((resolve, reject) => {
    const url = new URL(boot.path);
    const path = `${url.pathname}?name=${encodeURIComponent(name)}&type=${type}`;
    const req = https.request(
      {
        host: boot.host,
        servername: boot.servername,
        method: 'GET',
        path,
        headers: { host: boot.servername, accept: boot.servername === 'dns.google' ? 'application/dns-json' : 'application/dns-json' },
        timeout: 4000,
      },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          try {
            const j = JSON.parse(b);
            const addrs = (j.Answer || [])
              .filter((a) => a.type === 1 || a.type === 28)
              .map((a) => a.data);
            resolve(addrs);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('DoH timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function dohResolve(name) {
  for (const boot of BOOTSTRAP) {
    try {
      const v4 = await queryOne(boot, name, 'A');
      if (v4.length) return v4;
    } catch {}
  }
  throw new Error(`DoH resolve failed for ${name}`);
}

/** net/tls 兼容的 lookup（callback 风格，支持 options.all）。 */
export function dohLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : (options || {});
  dohResolve(hostname)
    .then((addrs) => {
      if (opts.all) cb(null, addrs.map((address) => ({ address, family: 4 })));
      else cb(null, addrs[0], 4);
    })
    .catch((e) => cb(e));
}

// 预加载模式：改写整个 node 进程的 DNS 解析（wrangler / mastra / 任意 node 工具）
dns.lookup = dohLookup;
if (dns.promises) {
  dns.promises.lookup = (hostname, options) =>
    new Promise((resolve, reject) => {
      dohLookup(hostname, options || {}, (err, address, family) => {
        if (err) return reject(err);
        if (options && typeof options === 'object' && options.all) return resolve(address);
        resolve({ address, family });
      });
    });
}
