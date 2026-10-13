#!/usr/bin/env node
'use strict';
// Expand objects by snapshot id to see what they hold, or list who retains them.
//
// Usage:
//   node --max-old-space-size=16000 inspect.js <snapshot> <id> [<id> ...] [--depth 2] [--edges 12] [--retainers]
const { loadSnapshot } = require('./snapshot');

const argv = process.argv.slice(2);
let depth = 2, maxEdges = 12, retainers = false;
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--depth') depth = Number(argv[++i]);
  else if (argv[i] === '--edges') maxEdges = Number(argv[++i]);
  else if (argv[i] === '--retainers') retainers = true;
  else pos.push(argv[i]);
}
if (pos.length < 2) {
  console.error('usage: inspect.js <snapshot> <id> [<id> ...] [--depth N] [--edges N] [--retainers]');
  process.exit(1);
}
const s = loadSnapshot(pos[0]);
const index = s.idIndex();
const label = (k) => `${s.label(k)} self=${s.self(k)}`;

function dump(k, d, indent) {
  console.log(indent + label(k));
  if (d === 0) return;
  let c = 0;
  for (let e = s.firstEdge[k]; e < s.firstEdge[k + 1]; e += s.EF) {
    if (!s.isStrong(e)) continue;
    const name = s.edgeName(e);
    if (name === 'map' || name === '__proto__') continue;
    if (c++ >= maxEdges) { console.log(indent + '  …'); break; }
    process.stdout.write(`${indent}  .${name} (${s.edgeType(e)}) -> `);
    dump(s.edgeTarget(e), d - 1, indent + '    ');
  }
}

function listRetainers(k) {
  console.log(label(k));
  let c = 0;
  for (let v = 0; v < s.nodeCount; v++) {
    for (let e = s.firstEdge[v]; e < s.firstEdge[v + 1]; e += s.EF) {
      if (s.edgeTarget(e) !== k) continue;
      console.log(`  <-[${s.edgeName(e)}] (${s.edgeType(e)}) ${s.label(v)}`);
      if (++c >= maxEdges) { console.log('  …'); return; }
    }
  }
}

for (const id of pos.slice(1).map(Number)) {
  const k = index.get(id);
  console.log(`\n###### @${id}`);
  if (k === undefined) { console.log('not found'); continue; }
  if (retainers) listRetainers(k); else dump(k, depth, '');
}
