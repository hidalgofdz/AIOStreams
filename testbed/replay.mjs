#!/usr/bin/env node
/**
 * Replays client-shaped Jellyfin `/Items` requests against a test-bed server
 * and records the totals, the items, the timing and the upstream requests.
 *
 *   node testbed/replay.mjs --server pr --client infuse-direct --library "Above Cap"
 *
 * Run with --help for every option. See README.md for the client shapes.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(here, '.state');
const PASSWORD = 'testbed-pass';

const HELP = `
replay.mjs --server <name> --client <shape> --library <name>[,<name>...] [options]

  --server <name>        test-bed server started with server.sh (main, pr, ...)
  --client <shape>       ${'infuse-direct | infuse-direct-jump | infuse-library | infuse-library-assumed | kodi | jellycon | web | findroid'}
  --library <names>      library (catalog) names, comma separated; several run at once
  --parent-id <id>       raw ParentId instead of --library (collections, folders)
  --child-of <name>      use the first item of this library as the parent (a collection)
  --mock <url>           mock addon base (default http://localhost:3999)

Shape overrides
  --client-name <s>      Client= value of the authorization header
  --user-agent <s>       User-Agent header ("none" sends no explicit one)
  --page <n>             page size
  --types <s>            IncludeItemTypes (default: from the library's CollectionType; "none" omits)
  --param k=v            extra query parameter, repeatable (Genres=Action, searchTerm=foo, ...)
  --no-total             send EnableTotalRecordCount=false on every request
  --first-only           send only the first request of the shape
  --max-pages <n>        infuse-library: stop after this many pages (default 40)
  --stop fetched         infuse-library: page while items received < latest total
                         (default: while the next start index < latest total)
  --start <n>            send one request at this start index and stop
  --abort-after <ms>     disconnect the first request after this many ms

Checks and output
  --exhaust              afterwards page (as the same client) until an empty page and
                         compare the reachable item count with the first total
  --cold                 use a fresh configuration and mock namespace, so run 1 hits
                         no catalog cache and no walk trail (default: reuse, warm
                         for 5 minutes after the first read)
  --repeat <n>           run the whole shape n times; with --cold, run 1 is cold
                         and the rest are warm
  --label <s>            free text copied into the result
  --out <file>           append the result as one JSON line
  --json                 print the full JSON result instead of the summary
`;

/* ---------- args ---------- */
const argv = process.argv.slice(2);
const opts = { param: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const flag = ['no-total', 'first-only', 'exhaust', 'json', 'help', 'cold'].includes(key);
  const val = flag ? true : argv[++i];
  if (key === 'param') opts.param.push(val);
  else opts[key] = val;
}
if (opts.help || !opts.server || !opts.client) {
  console.log(HELP);
  process.exit(opts.help ? 0 : 1);
}

/* ---------- client shapes ---------- */
const UA_BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * strategy:
 *   once      read the total from the first page, then fetch every window up to it
 *   jump      read the total from the first page, then fetch only the last two windows
 *   probe     Limit=1 probe for the total, then pages `parallel` at a time without totals
 *   reread    keep paging while startIndex + limit < the latest total
 *   untilEmpty  ignore totals, page until an empty page
 */
const SHAPES = {
  'infuse-direct': {
    clientName: 'Infuse-Direct',
    userAgent: 'Infuse-Direct/8.5.11',
    version: '8.5.11',
    device: 'Mac',
    route: 'items',
    casing: 'camel',
    page: 50,
    strategy: 'once',
    extra: {
      fields:
        'Path,Etag,ProviderIds,MediaSources,ExternalUrls,MediaStreams,ParentId,DateCreated,Overview,Genres,Tags,People,Studios',
      excludeLocationTypes: 'Virtual',
      recursive: 'true',
      sortBy: 'SortName',
      sortOrder: 'Ascending',
    },
  },
  // From the real Infuse 8.5.11 capture (issue 12): a limit=0 count probe, then
  // pages of 200 stepping by the 200 asked for, while the latest total is ahead.
  'infuse-library': {
    clientName: 'Infuse-Library',
    userAgent: 'Infuse-Library/8.5.11',
    version: '8.5.11',
    device: 'iPad',
    route: 'items',
    casing: 'camel',
    page: 200,
    strategy: 'countProbe',
    extra: {
      excludeLocationTypes: 'Virtual',
      collapseBoxSetItems: 'false',
      fields:
        'DateCreated,Etag,Genres,MediaSources,AlternateMediaSources,Overview,ParentId,Path,ProviderIds,SortName,RecursiveItemCount,ChildCount',
      recursive: 'true',
    },
  },
  // The shape the test bed assumed before the real capture; kept for old results.
  'infuse-library-assumed': {
    clientName: 'Infuse-Library',
    userAgent: 'Infuse-Library/8.5.11',
    version: '8.5.11',
    device: 'Apple TV',
    route: 'userItems',
    casing: 'pascal',
    page: 200,
    strategy: 'once',
    extra: {
      Fields: 'Path,Etag,ProviderIds,MediaSources,MediaStreams,DateCreated',
      ExcludeLocationTypes: 'Virtual',
      Recursive: 'true',
    },
  },
  kodi: {
    clientName: 'Kodi',
    userAgent: 'Jellyfin-Kodi/1.0.6',
    version: '1.0.6',
    device: 'Kodi',
    route: 'userItems',
    casing: 'pascal',
    page: 50,
    parallel: 3,
    strategy: 'probe',
    extra: {
      Recursive: 'true',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Fields: 'Path,Genres,SortName,Studios,Writer,Taglines,Overview,ProviderIds,DateCreated,MediaStreams,People',
      EnableUserData: 'true',
    },
  },
  jellycon: {
    clientName: 'Kodi JellyCon',
    userAgent: 'python-requests/2.31.0',
    version: '0.8.3',
    device: 'Kodi',
    route: 'userItems',
    casing: 'pascal',
    page: 50,
    strategy: 'reread',
    extra: {
      Recursive: 'true',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Fields: 'DateCreated,EpisodeCount,SeasonCount,Path,Genres,Studios,Etag,Taglines,SortName,Overview,ProviderIds',
      ImageTypeLimit: '1',
    },
  },
  web: {
    clientName: 'Jellyfin Web',
    userAgent: UA_BROWSER,
    version: '10.11.0',
    device: 'Chrome',
    route: 'items',
    casing: 'pascal',
    page: 100,
    strategy: 'reread',
    extra: {
      Recursive: 'true',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Fields: 'PrimaryImageAspectRatio,MediaSourceCount',
      ImageTypeLimit: '1',
      EnableImageTypes: 'Primary,Backdrop,Banner,Thumb',
    },
  },
  findroid: {
    clientName: 'Findroid',
    userAgent: 'okhttp/4.12.0',
    version: '0.15.0',
    device: 'Pixel',
    route: 'items',
    casing: 'camel',
    page: 100,
    strategy: 'untilEmpty',
    extra: { recursive: 'true', sortBy: 'SortName', sortOrder: 'Ascending' },
  },
};
SHAPES['infuse-direct-jump'] = { ...SHAPES['infuse-direct'], strategy: 'jump' };

const base = SHAPES[opts.client];
if (!base) {
  console.error(`unknown client ${opts.client}\n${HELP}`);
  process.exit(1);
}
const shape = {
  ...base,
  ...(opts['client-name'] ? { clientName: opts['client-name'] } : {}),
  ...(opts['user-agent'] ? { userAgent: opts['user-agent'] } : {}),
  ...(opts.page ? { page: Number(opts.page) } : {}),
};

/* ---------- server + configuration ---------- */
const serverState = path.join(STATE, opts.server);
const port = fs.readFileSync(path.join(serverState, 'port'), 'utf8').trim();
const BASE = `http://localhost:${port}`;
const MOCK = opts.mock ?? 'http://localhost:3999';
// --cold: a fresh configuration on a fresh mock namespace, so neither the
// catalog cache nor the walk trail has seen any of its URLs.
const NS = opts.cold
  ? `${opts.server}~${crypto.randomBytes(4).toString('hex')}`
  : opts.server;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureConfig() {
  const file = path.join(serverState, 'config.json');
  if (!opts.cold && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(`${BASE}/api/v1/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      password: PASSWORD,
      config: {
        sortCriteria: { global: [] },
        formatter: { id: 'gdrive' },
        presets: [
          {
            type: 'custom',
            instanceId: 'mock',
            enabled: true,
            options: {
              name: 'Mock',
              manifestUrl: `${MOCK}/${NS}/manifest.json`,
              timeout: 30000,
            },
          },
        ],
      },
    }),
  });
  const body = await res.json();
  if (!body.success) throw new Error(`config create failed: ${JSON.stringify(body.error)}`);
  if (!opts.cold) fs.writeFileSync(file, JSON.stringify(body.data));
  return body.data;
}

function headers(token) {
  const h = {
    'X-Emby-Authorization':
      `MediaBrowser Client="${shape.clientName}", Device="${shape.device}", ` +
      `DeviceId="testbed-${opts.client}", Version="${shape.version}"` +
      (token ? `, Token="${token}"` : ''),
    Accept: 'application/json',
  };
  if (shape.userAgent !== 'none') h['User-Agent'] = shape.userAgent;
  return h;
}

async function signIn(uuid) {
  const res = await fetch(`${BASE}/jellyfin/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ Username: uuid, Pw: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { token: body.AccessToken, userId: body.User.Id };
}

async function views(session) {
  const res = await fetch(`${BASE}/jellyfin/UserViews?userId=${session.userId}`, {
    headers: headers(session.token),
  });
  return (await res.json()).Items;
}

/* ---------- one /Items request ---------- */
const cased = (name) =>
  shape.casing === 'camel' ? name[0].toLowerCase() + name.slice(1) : name;

function itemsUrl(session, lib, startIndex, limit, more = {}) {
  const q = new URLSearchParams();
  if (shape.route === 'items') q.set(cased('UserId'), session.userId);
  q.set(cased('ParentId'), lib.id);
  q.set(cased('StartIndex'), String(startIndex));
  q.set(cased('Limit'), String(limit));
  if (lib.types) q.set(cased('IncludeItemTypes'), lib.types);
  for (const [k, v] of Object.entries(shape.extra)) q.set(k, v);
  if (opts['no-total']) q.set(cased('EnableTotalRecordCount'), 'false');
  for (const [k, v] of Object.entries(more)) q.set(k, v);
  for (const p of opts.param) {
    const i = p.indexOf('=');
    q.set(p.slice(0, i), p.slice(i + 1));
  }
  const route =
    shape.route === 'items' ? '/Items' : `/Users/${session.userId}/Items`;
  return `${BASE}/jellyfin${route}?${q}`;
}

async function request(session, lib, startIndex, limit, more, abortAfter) {
  const url = itemsUrl(session, lib, startIndex, limit, more);
  const ctrl = new AbortController();
  const timer = abortAfter ? setTimeout(() => ctrl.abort(), abortAfter) : null;
  const t0 = performance.now();
  const row = { startIndex, limit, url: url.replace(BASE, '') };
  try {
    const res = await fetch(url, { headers: headers(session.token), signal: ctrl.signal });
    row.status = res.status;
    const text = await res.text();
    row.ms = Math.round(performance.now() - t0);
    row.bytes = text.length;
    try {
      const body = JSON.parse(text);
      row.total = body.TotalRecordCount;
      row.returned = body.Items?.length ?? 0;
      row.ids = (body.Items ?? []).map((i) => i.Id);
      row.itemTypes = [...new Set((body.Items ?? []).map((i) => i.Type))];
      row.bodyHash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
    } catch {
      row.error = text.slice(0, 200);
    }
  } catch (e) {
    row.ms = Math.round(performance.now() - t0);
    row.aborted = e.name === 'AbortError';
    row.error = String(e.message ?? e);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return row;
}

/* ---------- strategies ---------- */
async function runShape(session, lib) {
  const rows = [];
  const page = shape.page;
  const abortAfter = opts['abort-after'] ? Number(opts['abort-after']) : 0;
  const send = async (start, limit, more, abort) => {
    const row = await request(session, lib, start, limit, more, abort);
    rows.push(row);
    return row;
  };

  if (opts.start !== undefined) {
    await send(Number(opts.start), page, undefined, abortAfter);
    return rows;
  }

  if (shape.strategy === 'probe') {
    const probe = await send(0, 1, { EnableTotalRecordCount: 'true' }, abortAfter);
    if (opts['first-only'] || probe.total === undefined) return rows;
    const starts = [];
    for (let s = 0; s < probe.total; s += page) starts.push(s);
    for (let i = 0; i < starts.length; i += shape.parallel) {
      const batch = await Promise.all(
        starts
          .slice(i, i + shape.parallel)
          .map((s) => request(session, lib, s, page, { EnableTotalRecordCount: 'false' }))
      );
      rows.push(...batch);
    }
    return rows;
  }

  if (shape.strategy === 'countProbe') {
    const probe = await send(0, 0, undefined, abortAfter);
    if (opts['first-only'] || probe.total === undefined) return rows;
    const maxPages = Number(opts['max-pages'] ?? 40);
    let total = probe.total;
    // Steps by the size asked for, not by what came back, and follows the
    // latest total. Stops on an empty page too (not seen from real Infuse).
    // --stop fetched: the other reading of the capture, keep going while the
    // items received are fewer than the latest total.
    let fetched = 0;
    const more = (s) => (opts.stop === 'fetched' ? fetched < total : s < total);
    for (let s = 0, n = 0; more(s) && n < maxPages; s += page, n++) {
      const row = await send(s, page);
      if (row.total === undefined || !row.returned) break;
      total = row.total;
      fetched += row.returned;
    }
    return rows;
  }

  const first = await send(0, page, undefined, abortAfter);
  if (opts['first-only'] || first.total === undefined) return rows;

  if (shape.strategy === 'once') {
    // The last window is shortened to what the first total says is left.
    for (let s = page; s < first.total; s += page)
      await send(s, Math.min(page, first.total - s));
  } else if (shape.strategy === 'jump') {
    const starts = [];
    for (let s = page; s < first.total; s += page) starts.push(s);
    for (const s of starts.slice(-2))
      await send(s, Math.min(page, first.total - s));
  } else if (shape.strategy === 'reread') {
    let last = first;
    let s = 0;
    while (last.total !== undefined && s + page < last.total && last.returned > 0) {
      s += page;
      last = await send(s, page);
    }
  } else if (shape.strategy === 'untilEmpty') {
    let last = first;
    let s = 0;
    while (last.returned > 0 && rows.length < 200) {
      s += last.returned;
      last = await send(s, page);
    }
  }
  return rows;
}

/** Ground truth: page as the same client until an empty page, whatever the totals say. */
async function exhaust(session, lib) {
  const ids = [];
  let s = 0;
  for (let i = 0; i < 400; i++) {
    const row = await request(session, lib, s, shape.page);
    if (!row.returned) break;
    ids.push(...row.ids);
    s += row.returned;
  }
  return ids;
}

async function mockStats() {
  const res = await fetch(`${MOCK}/__stats?ns=${NS}`);
  return res.json();
}

function summarise(lib, rows, upstream, reachable) {
  const ok = rows.filter((r) => r.ids);
  const ids = ok.flatMap((r) => r.ids);
  const unique = new Set(ids);
  const totals = ok.map((r) => r.total);
  const firstTotal = rows[0]?.total;
  const out = {
    library: lib.name,
    firstTotal,
    totalsSeen: [...new Set(totals)],
    requests: rows.length,
    itemsReturned: ids.length,
    uniqueItems: unique.size,
    duplicateItems: ids.length - unique.size,
    firstMs: rows[0]?.ms,
    laterMsMax: rows.length > 1 ? Math.max(...rows.slice(1).map((r) => r.ms)) : null,
    totalMs: rows.reduce((a, r) => a + (r.ms ?? 0), 0),
    statuses: [...new Set(rows.map((r) => r.status ?? (r.aborted ? 'aborted' : 'error')))],
    upstream: upstream
      ? {
          requests: upstream.requests,
          peakConcurrency: upstream.peakConcurrency,
          rateLimited: upstream.rateLimited,
          errors: upstream.errors,
          spanMs: upstream.spanMs,
          skips: upstream.skips,
        }
      : { requests: 0 },
  };
  if (reachable) {
    out.reachableItems = new Set(reachable).size;
    out.totalMatchesReachable = firstTotal === out.reachableItems;
    out.shapeGotEverything = unique.size === out.reachableItems;
  }
  return out;
}

/* ---------- main ---------- */
const cfg = await ensureConfig();
const session = await signIn(cfg.uuid);
const allViews = await views(session);

const libs = [];
if (opts['parent-id']) {
  libs.push({ id: opts['parent-id'], name: opts['parent-id'], types: opts.types });
} else {
  for (const name of String(opts.library ?? '').split(',').filter(Boolean)) {
    const v = allViews.find((x) => x.Name.toLowerCase() === name.trim().toLowerCase());
    if (!v) {
      console.error(
        `no library "${name}". Libraries: ${allViews.map((x) => x.Name).join(', ')}`
      );
      process.exit(1);
    }
    const byView = v.CollectionType === 'tvshows' ? 'Series' : 'Movie';
    libs.push({
      id: v.Id,
      name: v.Name,
      catalog: null,
      types: opts.types === 'none' ? undefined : (opts.types ?? byView),
    });
  }
}
if (opts['child-of']) {
  const v = allViews.find((x) => x.Name.toLowerCase() === opts['child-of'].toLowerCase());
  if (!v) { console.error(`no library "${opts['child-of']}"`); process.exit(1); }
  const res = await fetch(
    `${BASE}/jellyfin/Items?userId=${session.userId}&parentId=${v.Id}&startIndex=0&limit=5`,
    { headers: headers(session.token) }
  );
  const first = (await res.json()).Items?.[0];
  if (!first) { console.error(`library "${opts['child-of']}" is empty`); process.exit(1); }
  console.error(`parent: ${first.Name} (${first.Type}) ${first.Id}`);
  libs.length = 0;
  libs.push({ id: first.Id, name: `${v.Name} > ${first.Name}`, types: opts.types === 'none' ? undefined : (opts.types ?? 'Movie') });
}
if (!libs.length) {
  console.error('give --library, --parent-id or --child-of');
  process.exit(1);
}

// Map library names back to mock catalog ids for the upstream counts.
const scenarios = await fetch(`${MOCK}/__scenarios`).then((r) => r.json()).catch(() => []);
for (const lib of libs)
  lib.catalog = scenarios.find((s) => (s.name ?? s.id) === lib.name)?.id ?? null;

const result = {
  at: new Date().toISOString(),
  label: opts.label ?? null,
  server: opts.server,
  branch: fs.readFileSync(path.join(serverState, 'branch'), 'utf8').trim(),
  commit: fs.readFileSync(path.join(serverState, 'commit'), 'utf8').trim(),
  client: opts.client,
  clientName: shape.clientName,
  userAgent: shape.userAgent,
  strategy: shape.strategy,
  page: shape.page,
  options: {
    noTotal: !!opts['no-total'],
    firstOnly: !!opts['first-only'],
    cold: !!opts.cold,
    start: opts.start ?? null,
    abortAfter: opts['abort-after'] ?? null,
    params: opts.param,
    ...(opts.stop ? { stop: opts.stop } : {}),
  },
  runs: [],
};

const repeat = Number(opts.repeat ?? 1);
for (let n = 0; n < repeat; n++) {
  await fetch(`${MOCK}/__reset?ns=${NS}`, { method: 'POST' });
  const t0 = performance.now();
  const all = await Promise.all(libs.map((lib) => runShape(session, lib)));
  const wallMs = Math.round(performance.now() - t0);
  // An aborted walk may still be finishing upstream; let it settle before counting.
  await sleep(opts['abort-after'] ? 1500 : 150);
  const stats = await mockStats();
  const run = { run: n + 1, wallMs, upstreamTotal: stats.total, libraries: [] };
  for (let i = 0; i < libs.length; i++) {
    const lib = libs[i];
    const up = stats.catalogs.find((c) => c.catalog === lib.catalog);
    const reachable = opts.exhaust ? await exhaust(session, lib) : null;
    run.libraries.push({
      ...summarise(lib, all[i], up, reachable),
      rows: all[i].map(({ ids, ...r }) => ({ ...r, idsHash: ids ? crypto.createHash('sha1').update(ids.join(',')).digest('hex').slice(0, 12) : null })),
    });
  }
  result.runs.push(run);
}

if (opts.out) fs.appendFileSync(opts.out, JSON.stringify(result) + '\n');

if (opts.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    `${result.server} (${result.branch}@${result.commit})  client=${result.client} ` +
      `name="${result.clientName}" ua="${result.userAgent}" strategy=${result.strategy} page=${result.page}`
  );
  for (const run of result.runs) {
    console.log(`run ${run.run}: wall ${run.wallMs} ms, upstream requests ${run.upstreamTotal}`);
    for (const l of run.libraries) {
      console.log(
        `  ${l.library}: firstTotal=${l.firstTotal} totalsSeen=[${l.totalsSeen}] ` +
          `requests=${l.requests} items=${l.itemsReturned} unique=${l.uniqueItems} ` +
          `firstMs=${l.firstMs} laterMsMax=${l.laterMsMax} status=[${l.statuses}] ` +
          `upstream=${l.upstream.requests} peak=${l.upstream.peakConcurrency ?? '-'} ` +
          `429=${l.upstream.rateLimited ?? 0}` +
          (l.reachableItems !== undefined
            ? ` reachable=${l.reachableItems} totalMatches=${l.totalMatchesReachable} gotAll=${l.shapeGotEverything}`
            : '')
      );
      for (const r of l.rows)
        console.log(
          `    start=${r.startIndex} limit=${r.limit} -> ${r.status ?? r.error} ` +
            `returned=${r.returned ?? '-'} total=${r.total ?? '-'} ${r.ms} ms`
        );
    }
  }
}
