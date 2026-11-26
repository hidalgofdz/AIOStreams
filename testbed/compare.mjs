#!/usr/bin/env node
/**
 * Diffs two result files written by `replay.mjs --out`.
 *
 *   node testbed/compare.mjs results/main.jsonl results/pr.jsonl
 *
 * Results are matched on client, client name, user agent, options and library,
 * in file order. For each pair it compares, request by request, the start
 * index, limit, status, items returned, total and the ordered item ids, plus
 * the upstream request count per library. Timing is never compared.
 * Exits 1 when anything differs.
 */
import fs from 'node:fs';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: compare.mjs <a.jsonl> <b.jsonl>');
  process.exit(2);
}
const load = (f) =>
  fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const keyOf = (r, lib) =>
  JSON.stringify([r.client, r.clientName, r.userAgent, r.page, r.options, lib, r.label]);

function index(results) {
  const map = new Map();
  for (const r of results)
    for (const run of r.runs)
      for (const lib of run.libraries) {
        const k = keyOf(r, lib.library);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ r, run: run.run, lib });
      }
  return map;
}

const A = index(load(a));
const B = index(load(b));
let differences = 0;
let compared = 0;

for (const [k, listA] of A) {
  const listB = B.get(k);
  const [client, clientName, userAgent, , options, library, label] = JSON.parse(k);
  const name = `${client} name="${clientName}" ua="${userAgent}" ${library}${label ? ` [${label}]` : ''} ${JSON.stringify(options)}`;
  if (!listB) {
    console.log(`ONLY IN ${a}: ${name}`);
    differences++;
    continue;
  }
  for (let i = 0; i < Math.min(listA.length, listB.length); i++) {
    compared++;
    const x = listA[i].lib;
    const y = listB[i].lib;
    const diffs = [];
    if (x.rows.length !== y.rows.length)
      diffs.push(`requests ${x.rows.length} vs ${y.rows.length}`);
    for (let j = 0; j < Math.min(x.rows.length, y.rows.length); j++) {
      for (const f of ['startIndex', 'limit', 'status', 'returned', 'total', 'idsHash'])
        if (x.rows[j][f] !== y.rows[j][f])
          diffs.push(`request ${j + 1} (start ${x.rows[j].startIndex}) ${f}: ${x.rows[j][f]} vs ${y.rows[j][f]}`);
    }
    if ((x.upstream.requests ?? 0) !== (y.upstream.requests ?? 0))
      diffs.push(`upstream requests ${x.upstream.requests} vs ${y.upstream.requests}`);
    if (diffs.length) {
      differences++;
      console.log(`DIFF ${name}`);
      for (const d of diffs) console.log(`  ${d}`);
    } else {
      console.log(`same ${name}`);
    }
  }
}
for (const k of B.keys())
  if (!A.has(k)) {
    console.log(`ONLY IN ${b}: ${k}`);
    differences++;
  }

console.log(`\n${compared} compared, ${differences} with differences`);
process.exit(differences ? 1 : 0);
