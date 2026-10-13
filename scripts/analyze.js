#!/usr/bin/env node
'use strict';
// Compare two V8 heap snapshots and emit raw leak findings as Markdown.
//
// Usage:
//   node --max-old-space-size=16000 analyze.js <before.heapsnapshot> <after.heapsnapshot> [--out findings.md] [--top 15]
const fs = require('fs');
const { loadSnapshot, mb } = require('./snapshot');

function parseArgs(argv) {
  const args = { files: [], out: 'heap-diff-findings.md', top: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--top') args.top = Number(argv[++i]);
    else args.files.push(a);
  }
  if (args.files.length !== 2) {
    console.error('usage: node --max-old-space-size=16000 analyze.js <before> <after> [--out file.md] [--top N]');
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const out = [];
const w = (s = '') => out.push(s);
const log = (s) => process.stderr.write(s + '\n');
const t0 = Date.now();

function summarize(s) {
  const map = new Map();
  let total = 0;
  for (let k = 0; k < s.nodeCount; k++) {
    const key = s.groupKey(k);
    const size = s.self(k);
    total += size;
    let e = map.get(key);
    if (!e) { e = { count: 0, size: 0 }; map.set(key, e); }
    e.count++; e.size += size;
  }
  return { map, total };
}

log(`loading ${args.files[0]} ...`);
const B = loadSnapshot(args.files[0]);
log(`loading ${args.files[1]} ...`);
const A = loadSnapshot(args.files[1]);
const sumB = summarize(B), sumA = summarize(A);
const beforeMaxId = B.maxId();

// Are object ids comparable (same process, after taken later)?
// Sample old-looking ids in `after` and check they exist in `before` with the same name.
const bIndex = B.idIndex();
let sampled = 0, matched = 0;
for (let k = 0; k < A.nodeCount && sampled < 20000; k += 97) {
  const id = A.id(k);
  if (id > beforeMaxId) continue;
  sampled++;
  const bk = bIndex.get(id);
  if (bk !== undefined && B.name(bk) === A.name(k) && B.type(bk) === A.type(k)) matched++;
}
const comparable = sampled > 0 && matched / sampled > 0.6;
const isNew = comparable ? (k) => A.id(k) > beforeMaxId : () => false;
const isOldInBefore = (k) => {
  if (!comparable || isNew(k)) return false;
  const bk = bIndex.get(A.id(k));
  return bk !== undefined && B.name(bk) === A.name(k) && B.type(bk) === A.type(k);
};

log('computing dominators ...');
B.computeDominators(); B.computeRetained(null);
A.computeDominators(); A.computeRetained(comparable ? isNew : null);
A.computeBfsTree();
const score = comparable ? A.retainedF : A.retained;

// ---------------- header ----------------
w('# Heap snapshot diff: raw findings');
w();
w(`- before: \`${args.files[0]}\` — ${B.nodeCount.toLocaleString()} nodes, ${mb(sumB.total)}`);
w(`- after:  \`${args.files[1]}\` — ${A.nodeCount.toLocaleString()} nodes, ${mb(sumA.total)}`);
w(`- growth: **${mb(sumA.total - sumB.total)}** (${((sumA.total / sumB.total - 1) * 100).toFixed(1)}%)`);
w(`- object ids comparable: **${comparable ? 'yes' : 'no'}** (${matched}/${sampled} sampled old ids matched by id+name)`);
if (comparable) {
  w(`  - "new" = id > before max id (${beforeMaxId}); new objects reachable in after retain **${mb(A.retainedF[0])}**`);
  w('  - nodes marked `*` below are new (allocated after the before snapshot)');
} else {
  w('  - snapshots look like different processes; new-object analysis is disabled, accumulators are ranked by total retained size and matched to before by retainer path');
}
w();

// ---------------- type diff ----------------
const rows = [];
for (const [k, v] of sumA.map) {
  const p = sumB.map.get(k) || { count: 0, size: 0 };
  rows.push({ k, dc: v.count - p.count, ds: v.size - p.size, bc: p.count, ac: v.count, as: v.size });
}
for (const [k, p] of sumB.map) if (!sumA.map.has(k)) rows.push({ k, dc: -p.count, ds: -p.size, bc: p.count, ac: 0, as: 0 });
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/`/g, "'");

w('## 1. Growth by type (self size)');
w();
w('| Δ size | Δ count | before count | after count | after size | type |');
w('|---:|---:|---:|---:|---:|---|');
rows.sort((x, y) => y.ds - x.ds);
for (const r of rows.slice(0, 25)) w(`| ${mb(r.ds)} | ${r.dc} | ${r.bc} | ${r.ac} | ${mb(r.as)} | \`${esc(r.k)}\` |`);
w();
w('### Growth by count');
w();
w('| Δ count | Δ size | type |');
w('|---:|---:|---|');
rows.sort((x, y) => y.dc - x.dc);
for (const r of rows.slice(0, 15)) w(`| ${r.dc} | ${mb(r.ds)} | \`${esc(r.k)}\` |`);
w();

// ---------------- accumulators ----------------
const growth = Math.max(sumA.total - sumB.total, 0);
const threshold = Math.max(1048576, growth * 0.01);
const childMax = new Float64Array(A.nodeCount);
for (let i = 1; i < A.reachable; i++) {
  const n = A.dfsOrder[i];
  const d = A.idom[n];
  if (score[n] > childMax[d]) childMax[d] = score[n];
}
const isSynthetic = (k) => k === 0 || A.type(k) === 'synthetic';
const accum = [];
const bigLeaves = [];
for (let i = 1; i < A.reachable; i++) {
  const n = A.dfsOrder[i];
  if (isSynthetic(n) || score[n] < threshold) continue;
  if (childMax[n] >= 0.5 * score[n]) continue;
  if (A.domChildren[n] >= 10) accum.push(n); else bigLeaves.push(n);
}

function chainNames(k, stopAt) {
  // edge names from an ancestor (where stopAt returns true, or root) down to k
  const names = [];
  let v = k;
  while (v !== 0) {
    if (stopAt && v !== k && stopAt(v)) return { anchor: v, names: names.reverse() };
    const p = A.bfsParent[v];
    if (p === -1) return null;
    names.push(A.edgeName(A.bfsEdge[v]));
    v = p;
  }
  return { anchor: 0, names: names.reverse() };
}

function locateInBefore(k) {
  if (isOldInBefore(k)) return { node: bIndex.get(A.id(k)), how: 'same object id' };
  const c = chainNames(k, comparable ? isOldInBefore : null);
  if (!c) return null;
  const start = c.anchor === 0 ? 0 : bIndex.get(A.id(c.anchor));
  const node = B.followPath(start, c.names);
  if (node < 0) return null;
  return { node, how: c.anchor === 0 ? 'same retainer path from root' : `same path from old ancestor @${A.id(c.anchor)} via .${c.names.join('.')}` };
}

function signature(k) {
  // structural signature to collapse many similar accumulators (e.g. one per in-flight request)
  const parts = [`${A.type(k)}:${A.name(k).slice(0, 40)}`];
  let v = k;
  for (let i = 0; i < 3 && v !== 0; i++) {
    const p = A.bfsParent[v];
    if (p < 0) break;
    parts.push(`${A.edgeName(A.bfsEdge[v]).replace(/^\[\d+\]$/, '[n]')}<${A.type(p)}:${A.name(p).slice(0, 40)}`);
    v = p;
  }
  return parts.join(' ');
}

const groups = new Map();
for (const n of accum) {
  const sig = signature(n);
  let g = groups.get(sig);
  if (!g) { g = { members: [], total: 0 }; groups.set(sig, g); }
  g.members.push(n); g.total += score[n];
}
const groupList = [...groups.values()].sort((a, b) => b.total - a.total).slice(0, args.top);

w('## 2. Accumulators');
w();
w(`Objects that retain more than ${mb(threshold)} of ${comparable ? 'new ' : ''}memory spread over many children (Maps, caches, arrays, plain objects used as dictionaries). These are the prime leak suspects. Similar objects are collapsed into one group.`);
w();
groupList.forEach((g, gi) => {
  const n = g.members.sort((a, b) => score[b] - score[a])[0];
  const lbl = A.label(n, isNew);
  w(`### 2.${gi + 1} \`${esc(lbl)}\`${g.members.length > 1 ? ` (+${g.members.length - 1} similar, group total ${mb(g.total)})` : ''}`);
  w();
  w(`- retained: **${mb(A.retained[n])}**${comparable ? `, of which new: **${mb(A.retainedF[n])}**` : ''}`);
  w(`- dominated children: ${A.domChildren[n]}, outgoing edges: ${(A.firstEdge[n + 1] - A.firstEdge[n]) / A.EF}`);
  const loc = locateInBefore(n);
  if (loc) {
    const b = loc.node;
    const bc = B.domChildren[b], ac = A.domChildren[n];
    const verdict = A.retained[n] > 2 * B.retained[b] + threshold / 2 || ac > 2 * bc + 50 ? 'GROWING' : 'stable';
    w(`- in before (${loc.how}): retained ${mb(B.retained[b])}, dominated children ${bc}, edges ${(B.firstEdge[b + 1] - B.firstEdge[b]) / B.EF} → **${verdict}**`);
  } else {
    w('- in before: not found (container created after the before snapshot, or path changed)');
  }
  w('- retainer chain (shortest path to GC root):');
  w('```');
  w(lbl);
  for (const { edge, from } of A.retainerChain(n, 22)) {
    if (from < 0) { w('  <- (unreachable)'); break; }
    w(`  <-[${A.edgeName(edge)}]- ${A.label(from, isNew)}`);
  }
  w('```');
  const agg = new Map();
  for (let e = A.firstEdge[n]; e < A.firstEdge[n + 1]; e += A.EF) {
    if (!A.isStrong(e)) continue;
    const c = A.edgeTarget(e);
    if (A.idom[c] !== n) continue;
    const key = `${A.type(c)}:${A.name(c).slice(0, 50)}`;
    let a = agg.get(key);
    if (!a) { a = { c: 0, r: 0, rn: 0, ex: [], exNode: c }; agg.set(key, a); }
    a.c++; a.r += A.retained[c]; a.rn += comparable ? A.retainedF[c] : 0;
    if (a.ex.length < 4) a.ex.push(A.edgeName(e));
  }
  const top = [...agg.entries()].sort((x, y) => y[1].r - x[1].r).slice(0, 5);
  if (top.length) {
    w('- children (grouped):');
    w();
    w('| count | retained | new | child type | example keys | example child |');
    w('|---:|---:|---:|---|---|---|');
    for (const [k, a] of top) {
      w(`| ${a.c} | ${mb(a.r)} | ${mb(a.rn)} | \`${esc(k)}\` | ${esc(a.ex.map((x) => x.slice(0, 40)).join(', '))} | @${A.id(a.exNode)} |`);
    }
  }
  if (g.members.length > 1) {
    w(`- other members: ${g.members.slice(1, 8).map((m) => `@${A.id(m)} (${mb(score[m])})`).join(', ')}${g.members.length > 8 ? ', …' : ''}`);
  }
  w();
});

bigLeaves.sort((a, b) => score[b] - score[a]);
if (bigLeaves.length) {
  w('## 3. Large single objects');
  w();
  w('| retained | object | retained via |');
  w('|---:|---|---|');
  for (const n of bigLeaves.slice(0, 10)) {
    const ch = A.retainerChain(n, 3).filter((x) => x.from >= 0).map((x) => `.${A.edgeName(x.edge)} ← ${A.type(x.from)}:${A.name(x.from).slice(0, 30)}`).join(' ');
    w(`| ${mb(score[n])} | \`${esc(A.label(n, isNew))}\` | ${esc(ch)} |`);
  }
  w();
}

// ---------------- strings ----------------
if (comparable) {
  const strAgg = new Map();
  const largest = [];
  for (let k = 0; k < A.nodeCount; k++) {
    const t = A.type(k);
    if (!isNew(k) || !(t === 'string' || t === 'concatenated string' || t === 'sliced string')) continue;
    const r0 = A.revStart ? A.revStart[k] : 0;
    let key = '(unreachable)';
    if (A.revStart && r0 < A.revStart[k + 1]) {
      const from = A.revFrom[r0];
      key = `${A.type(from)}:${A.name(from).slice(0, 30)} .${A.edgeName(A.revEdge[r0]).slice(0, 40)}`;
    }
    let a = strAgg.get(key);
    if (!a) { a = { c: 0, s: 0 }; strAgg.set(key, a); }
    a.c++; a.s += A.self(k);
    if (A.self(k) > 50000) largest.push(k);
  }
  w('## 4. New strings grouped by retainer');
  w();
  w('The property names here usually reveal what data is piling up.');
  w();
  w('| size | count | first retainer .property |');
  w('|---:|---:|---|');
  for (const [k, a] of [...strAgg.entries()].sort((x, y) => y[1].s - x[1].s).slice(0, 20)) w(`| ${mb(a.s)} | ${a.c} | \`${esc(k)}\` |`);
  w();
  largest.sort((a, b) => A.self(b) - A.self(a));
  if (largest.length) {
    w('Largest new strings (content is truncated by V8 in snapshots):');
    w();
    for (const k of largest.slice(0, 8)) w(`- ${mb(A.self(k))} @${A.id(k)}: \`${esc(A.name(k).slice(0, 120).replace(/\s+/g, ' '))}\``);
    w();
  }
}

// ---------------- top retainers ----------------
w('## 5. Top retained objects in after (context)');
w();
w('| retained | new | object | immediate dominator |');
w('|---:|---:|---|---|');
const topR = [];
for (let i = 1; i < A.reachable; i++) {
  const n = A.dfsOrder[i];
  if (!isSynthetic(n) && A.retained[n] > threshold) topR.push(n);
}
topR.sort((a, b) => A.retained[b] - A.retained[a]);
for (const n of topR.slice(0, 20)) {
  w(`| ${mb(A.retained[n])} | ${comparable ? mb(A.retainedF[n]) : '-'} | \`${esc(A.label(n, isNew))}\` | \`${esc(A.label(A.idom[n], isNew))}\` |`);
}
w();
w(`_Generated in ${((Date.now() - t0) / 1000).toFixed(1)}s. Inspect any object with \`node scripts/inspect.js <after> <id>\`._`);

fs.writeFileSync(args.out, out.join('\n') + '\n');
log(`wrote ${args.out}`);
