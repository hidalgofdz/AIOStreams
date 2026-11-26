#!/usr/bin/env node
/**
 * Throwaway mock Stremio addon for the Infuse exact-total test bed.
 *
 *   node testbed/mock-addon.mjs [--port 3999] [--scenarios testbed/scenarios.json]
 *
 * Every catalog in the scenarios file becomes one catalog of the manifest.
 * The first path segment is a free-form namespace, so two AIOStreams servers
 * (main and the PR branch) can share one mock and keep separate request logs:
 *
 *   http://localhost:3999/<ns>/manifest.json
 *   http://localhost:3999/<ns>/catalog/<type>/<id>[/<extras>].json
 *   http://localhost:3999/<ns>/meta/<type>/<id>.json
 *
 * Control endpoints (no namespace):
 *
 *   GET  /__stats[?ns=<ns>]   request counts, peak concurrency and the raw log
 *   POST /__reset[?ns=<ns>]   clear the log
 *   GET  /__scenarios         the loaded scenarios
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('port', process.env.MOCK_PORT ?? 3999));
const SCENARIOS_FILE = arg('scenarios', path.join(here, 'scenarios.json'));

/**
 * Scenario fields (all but `id` optional):
 *   id          catalog id
 *   name        catalog name (defaults to id)
 *   type        'movie' | 'series' (catalog type; default 'movie')
 *   size        number of distinct entries (default 100)
 *   pageSize    number, or an array cycled per page for variable pages (default 20)
 *   delayMs     delay before every catalog page answers (default 0)
 *   skip        false = the catalog does not declare or honour `skip` (default true)
 *   mixEvery    every Nth entry is the other type (movie<->series); 0 = never
 *   dupEvery    every Nth entry of a page repeats an entry from an earlier page; 0 = never
 *   genres      list of genres; entry i belongs to genres[i % genres.length]
 *   genreRequired  true = the genre extra is required
 *   search      true = the catalog supports the `search` extra (matches on name)
 *   maxConcurrent  answer 429 when more than this many catalog requests are in flight
 *   maxPerSecond   answer 429 when more than this many catalog requests arrive in one second
 *   failEvery   every Nth catalog request answers 500; 0 = never
 *   collection  every entry is a collection with this block (sources name catalogs of this addon)
 */
const scenarios = JSON.parse(fs.readFileSync(SCENARIOS_FILE, 'utf8')).map(
  (s) => ({
    name: s.id,
    type: 'movie',
    size: 100,
    pageSize: 20,
    delayMs: 0,
    skip: true,
    mixEvery: 0,
    dupEvery: 0,
    genres: [],
    genreRequired: false,
    search: false,
    maxConcurrent: 0,
    maxPerSecond: 0,
    failEvery: 0,
    collection: null,
    ...s,
  })
);
const byId = new Map(scenarios.map((s) => [`${s.type}|${s.id}`, s]));

const other = (t) => (t === 'movie' ? 'series' : 'movie');

function entry(s, i) {
  const type = s.mixEvery && (i + 1) % s.mixEvery === 0 ? other(s.type) : s.type;
  const n = String(i).padStart(5, '0');
  return {
    id: `mock:${s.id}:${n}`,
    type,
    name: `${s.name} ${n}`,
    poster: `http://localhost:${PORT}/poster.png`,
    genres: s.genres.length ? [s.genres[i % s.genres.length]] : undefined,
    releaseInfo: String(1950 + (i % 75)),
    collection: s.collection ?? undefined,
  };
}

function allEntries(s, extras) {
  let list = Array.from({ length: s.size }, (_, i) => entry(s, i));
  if (extras.genre) list = list.filter((e) => e.genres?.includes(extras.genre));
  if (extras.search) {
    const q = extras.search.toLowerCase();
    list = list.filter((e) => e.name.toLowerCase().includes(q));
  }
  return list;
}

/** Page boundaries: [start, end) of the page that begins at `skip`. */
function pageAt(s, list, skip) {
  const sizes = Array.isArray(s.pageSize) ? s.pageSize : [s.pageSize];
  if (!s.skip) return list.slice(0, sizes[0]);
  // Variable pages: the size depends on which page (by position) this skip lands in.
  let start = 0;
  let page = 0;
  while (start + sizes[page % sizes.length] <= skip) {
    start += sizes[page % sizes.length];
    page++;
  }
  // A skip that is not on a boundary is honoured literally, like a real addon would.
  const size = sizes[page % sizes.length];
  const out = list.slice(skip, skip + size);
  if (s.dupEvery && skip > 0) {
    for (let i = s.dupEvery - 1; i < out.length; i += s.dupEvery) {
      // Repeat an entry from before this page instead of a new one.
      out[i] = list[(skip + i) % Math.max(1, Math.min(skip, sizes[0]))];
    }
  }
  return out;
}

function parseExtras(raw) {
  const out = {};
  if (!raw) return out;
  for (const part of raw.split('&')) {
    const [k, v = ''] = part.split('=');
    out[k] = decodeURIComponent(v);
  }
  return out;
}

/* ---- request log ---- */
const log = []; // { ns, catalog, extras, skip, start, end, status, returned }
const inFlight = new Map(); // `${ns}|${catalog}` -> count
const perSecond = new Map(); // `${ns}|${catalog}|${second}` -> count
const seq = new Map(); // `${ns}|${catalog}` -> request ordinal

function stats(ns) {
  const rows = ns ? log.filter((r) => r.ns === ns) : log;
  const groups = {};
  for (const r of rows) {
    const key = `${r.ns}|${r.catalog}`;
    const g = (groups[key] ??= {
      ns: r.ns,
      catalog: r.catalog,
      requests: 0,
      errors: 0,
      rateLimited: 0,
      peakConcurrency: 0,
      firstStart: r.start,
      lastEnd: r.end,
      skips: [],
    });
    g.requests++;
    if (r.status === 429) g.rateLimited++;
    else if (r.status >= 400) g.errors++;
    g.peakConcurrency = Math.max(g.peakConcurrency, r.concurrency);
    g.firstStart = Math.min(g.firstStart, r.start);
    g.lastEnd = Math.max(g.lastEnd, r.end ?? r.start);
    g.skips.push(r.skip);
  }
  for (const g of Object.values(groups)) g.spanMs = g.lastEnd - g.firstStart;
  return {
    total: rows.length,
    catalogs: Object.values(groups),
    log: rows,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

function manifest(ns) {
  return {
    id: `testbed.mock.${ns}`,
    version: '1.0.0',
    name: `Mock (${ns})`,
    description: 'Throwaway mock addon for the Infuse exact-total test bed',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series'],
    idPrefixes: ['mock:'],
    catalogs: scenarios.map((s) => ({
      type: s.type,
      id: s.id,
      name: s.name,
      extra: [
        ...(s.skip ? [{ name: 'skip' }] : []),
        ...(s.genres.length
          ? [{ name: 'genre', options: s.genres, isRequired: s.genreRequired }]
          : []),
        ...(s.search ? [{ name: 'search' }] : []),
      ],
    })),
  };
}

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (url.pathname === '/__stats')
    return json(res, 200, stats(url.searchParams.get('ns')));
  if (url.pathname === '/__scenarios') return json(res, 200, scenarios);
  if (url.pathname === '/__reset') {
    const ns = url.searchParams.get('ns');
    for (let i = log.length - 1; i >= 0; i--)
      if (!ns || log[i].ns === ns) log.splice(i, 1);
    for (const k of [...seq.keys()])
      if (!ns || k.startsWith(`${ns}|`)) seq.delete(k);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/poster.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(PNG);
  }

  const [ns, resource, type, ...rest] = parts;
  if (resource === 'manifest.json') return json(res, 200, manifest(ns));

  if (resource === 'meta' && rest.length === 1) {
    const id = rest[0].replace(/\.json$/, '');
    const [, cid, n] = id.split(':');
    const s = scenarios.find((x) => x.id === cid);
    if (!s) return json(res, 404, { err: 'not found' });
    const e = entry(s, Number(n));
    return json(res, 200, {
      meta: {
        ...e,
        type,
        description: `Mock entry ${n} of ${s.name}`,
        videos:
          type === 'series'
            ? [1, 2, 3].map((ep) => ({
                id: `${id}:1:${ep}`,
                title: `Episode ${ep}`,
                season: 1,
                episode: ep,
                released: '2020-01-01T00:00:00.000Z',
              }))
            : undefined,
      },
    });
  }

  if (resource === 'catalog' && rest.length >= 1) {
    const last = rest[rest.length - 1].replace(/\.json$/, '');
    const id = rest.length === 1 ? last : rest[0];
    const extras = rest.length === 1 ? {} : parseExtras(last);
    const s = byId.get(`${type}|${id}`);
    if (!s) return json(res, 404, { err: 'unknown catalog' });

    const key = `${ns}|${id}`;
    const now = Date.now();
    const concurrency = (inFlight.get(key) ?? 0) + 1;
    inFlight.set(key, concurrency);
    const secKey = `${key}|${Math.floor(now / 1000)}`;
    const thisSecond = (perSecond.get(secKey) ?? 0) + 1;
    perSecond.set(secKey, thisSecond);
    const ordinal = (seq.get(key) ?? 0) + 1;
    seq.set(key, ordinal);

    const row = {
      ns,
      catalog: id,
      extras,
      skip: Number(extras.skip ?? 0),
      start: now,
      concurrency,
    };
    log.push(row);
    const finish = (status, body, returned = 0) => {
      inFlight.set(key, (inFlight.get(key) ?? 1) - 1);
      row.end = Date.now();
      row.status = status;
      row.returned = returned;
      json(res, status, body);
    };

    if (
      (s.maxConcurrent && concurrency > s.maxConcurrent) ||
      (s.maxPerSecond && thisSecond > s.maxPerSecond)
    )
      return finish(429, { err: 'rate limited' });
    if (s.failEvery && ordinal % s.failEvery === 0)
      return finish(500, { err: 'mock failure' });

    if (s.delayMs) await sleep(s.delayMs);
    const metas = pageAt(s, allEntries(s, extras), row.skip);
    return finish(200, { metas }, metas.length);
  }

  json(res, 404, { err: 'not found' });
});

server.listen(PORT, () => {
  console.log(
    `mock addon on http://localhost:${PORT} with ${scenarios.length} catalogs from ${SCENARIOS_FILE}`
  );
});
