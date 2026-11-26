// Logging pass-through for a real client (Infuse) in front of one AIOStreams server.
//
//   LISTEN=3111 UPSTREAM=3112 LOG=testbed/.state/real/capture.jsonl node testbed/capture-proxy.mjs
//
// One JSON line per request: when it started, the client name and version from
// the authorization header (never the token), the user agent, the paging
// parameters, the status, time to first byte, total time, and for a JSON list
// reply the item count and TotalRecordCount. `aborted: true` means the client
// hung up before the reply was complete, with `ms` the time it waited.
// Replies are streamed through untouched.
import http from 'node:http';
import fs from 'node:fs';

const LISTEN = Number(process.env.LISTEN || 3111);
const UP = Number(process.env.UPSTREAM || 3112);
const LOG = process.env.LOG || 'capture.jsonl';

const redact = (url) => url.replace(/((?:api_key|ApiKey|token)=)[^&]+/gi, '$1…');
const authFields = (h) => {
  const raw = h['authorization'] || h['x-emby-authorization'] || '';
  const out = {};
  for (const m of String(raw).matchAll(/(\w+)="([^"]*)"/g)) {
    if (/^(client|device|version)$/i.test(m[1])) out[m[1].toLowerCase()] = m[2];
  }
  out.header = h['authorization'] ? 'authorization' : h['x-emby-authorization'] ? 'x-emby-authorization' : h['x-emby-token'] || h['x-mediabrowser-token'] ? 'token-header' : 'none';
  return out;
};
const pick = (q, ...names) => {
  for (const [k, v] of q) if (names.includes(k.toLowerCase())) return v;
};

http
  .createServer((req, res) => {
    const t0 = Date.now();
    const chunks = [];
    const q = new URL(req.url, 'http://x').searchParams;
    const entry = {
      t: new Date(t0).toISOString(),
      method: req.method,
      path: redact(req.url),
      ua: req.headers['user-agent'],
      ...authFields(req.headers),
      parentId: pick(q, 'parentid'),
      start: pick(q, 'startindex'),
      limit: pick(q, 'limit'),
      wantsTotal: pick(q, 'enabletotalrecordcount'),
    };
    let logged = false;
    const write = (extra) => {
      if (logged) return;
      logged = true;
      fs.appendFileSync(LOG, JSON.stringify({ ...entry, ...extra, ms: Date.now() - t0 }) + '\n');
    };
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, host: '127.0.0.1:' + UP };
      delete headers['accept-encoding'];
      const up = http.request(
        { host: '127.0.0.1', port: UP, method: req.method, path: req.url, headers },
        (ur) => {
          entry.status = ur.statusCode;
          entry.ttfb = Date.now() - t0;
          const isJson = String(ur.headers['content-type']).includes('json');
          const out = [];
          res.writeHead(ur.statusCode, ur.headers);
          ur.on('data', (c) => {
            if (isJson) out.push(c);
            res.write(c);
          });
          ur.on('end', () => {
            res.end();
            const extra = {};
            if (isJson) {
              try {
                const j = JSON.parse(Buffer.concat(out).toString('utf8'));
                const items = Array.isArray(j) ? j : j?.Items;
                if (Array.isArray(items)) {
                  extra.count = items.length;
                  extra.total = j.TotalRecordCount;
                  extra.first = items[0]?.Name;
                  extra.types = [...new Set(items.map((i) => i?.Type))].join(',');
                }
              } catch {
                extra.reply = 'unparsed json';
              }
            }
            write(extra);
          });
        },
      );
      up.on('error', (e) => {
        if (!res.headersSent) res.writeHead(502);
        res.end(String(e));
        write({ error: String(e) });
      });
      res.on('close', () => {
        if (!res.writableEnded) {
          up.destroy();
          write({ aborted: true });
        }
      });
      up.end(body);
    });
  })
  .listen(LISTEN, '0.0.0.0', () => console.log(`capture proxy :${LISTEN} -> :${UP}, log ${LOG}`));
