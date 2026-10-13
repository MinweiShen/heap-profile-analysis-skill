'use strict';
// Streaming loader and graph utilities for V8 .heapsnapshot files.
// Snapshots larger than ~512MB cannot be JSON.parse'd (V8 max string length),
// so nodes/edges are parsed byte-by-byte into typed arrays.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

function ensureUncompressed(file) {
  if (!file.endsWith('.gz')) return file;
  const out = path.join(os.tmpdir(), `${path.basename(file, '.gz')}.${process.pid}.${Date.now()}`);
  const data = zlib.gunzipSync(fs.readFileSync(file));
  fs.writeFileSync(out, data);
  return out;
}

function loadSnapshot(inputFile) {
  const file = ensureUncompressed(inputFile);
  const fd = fs.openSync(file, 'r');
  const CHUNK = 64 * 1024 * 1024;
  const buf = Buffer.allocUnsafe(CHUNK);

  const headBuf = Buffer.alloc(16384);
  fs.readSync(fd, headBuf, 0, headBuf.length, 0);
  const headStr = headBuf.toString('latin1');
  const nodesIdx = headStr.indexOf('"nodes":[');
  if (nodesIdx < 0) throw new Error(`${inputFile}: not a V8 heap snapshot (no "nodes" array in header)`);
  const header = JSON.parse(headStr.slice(0, nodesIdx).replace(/,\s*$/, '') + '}');
  const meta = header.snapshot.meta;
  const nodeCount = header.snapshot.node_count;
  const edgeCount = header.snapshot.edge_count;
  const NF = meta.node_fields.length;
  const EF = meta.edge_fields.length;

  const nodes = new Float64Array(nodeCount * NF);
  const edges = new Uint32Array(edgeCount * EF);
  const strings = [];

  let pos = nodesIdx + '"nodes":['.length;
  // 0 nodes ints, 1 seek edges, 2 edges ints, 3 seek strings, 4 strings, 5 done
  let state = 0;
  let num = 0, inNum = false, ni = 0, ei = 0;
  let seekTarget = '"edges":[';
  let seekMatch = 0;
  let inStr = false, esc = false, hasEsc = false, strParts = [], strStart = -1;

  while (state !== 5) {
    const n = fs.readSync(fd, buf, 0, CHUNK, pos);
    if (n === 0) break;
    pos += n;
    let i = 0;
    while (i < n && state !== 5) {
      if (state === 0 || state === 2) {
        const arr = state === 0 ? nodes : edges;
        for (; i < n; i++) {
          const c = buf[i];
          if (c >= 48 && c <= 57) { num = num * 10 + (c - 48); inNum = true; }
          else {
            if (inNum) {
              if (state === 0) arr[ni++] = num; else arr[ei++] = num;
              num = 0; inNum = false;
            }
            if (c === 93) {
              i++;
              if (state === 0) { state = 1; seekTarget = '"edges":['; }
              else { state = 3; seekTarget = '"strings":['; }
              seekMatch = 0;
              break;
            }
          }
        }
      } else if (state === 1 || state === 3) {
        for (; i < n; i++) {
          const c = buf[i];
          if (c === seekTarget.charCodeAt(seekMatch)) {
            seekMatch++;
            if (seekMatch === seekTarget.length) { i++; state = state === 1 ? 2 : 4; break; }
          } else {
            seekMatch = c === seekTarget.charCodeAt(0) ? 1 : 0;
          }
        }
      } else if (state === 4) {
        for (; i < n; i++) {
          const c = buf[i];
          if (inStr) {
            if (esc) { esc = false; continue; }
            if (c === 92) { esc = true; hasEsc = true; continue; }
            if (c === 34) {
              strParts.push(Buffer.from(buf.subarray(strStart, i)));
              const raw = strParts.length === 1 ? strParts[0] : Buffer.concat(strParts);
              let s = raw.toString('utf8');
              if (hasEsc) { try { s = JSON.parse('"' + s + '"'); } catch (e) { /* keep raw */ } }
              strings.push(s);
              inStr = false; strParts = []; hasEsc = false;
            }
          } else if (c === 34) { inStr = true; strStart = i + 1; }
          else if (c === 93) { state = 5; break; }
        }
        if (inStr && state === 4) {
          strParts.push(Buffer.from(buf.subarray(strStart, n)));
          strStart = 0;
        }
      }
    }
  }
  fs.closeSync(fd);
  if (file !== inputFile) fs.unlinkSync(file);
  if (ni !== nodes.length || ei !== edges.length) {
    throw new Error(`${inputFile}: parse mismatch nodes ${ni}/${nodes.length} edges ${ei}/${edges.length}`);
  }

  const firstEdge = new Uint32Array(nodeCount + 1);
  const ecOff = meta.node_fields.indexOf('edge_count');
  for (let k = 0, e = 0; k < nodeCount; k++) {
    firstEdge[k] = e;
    e += nodes[k * NF + ecOff] * EF;
  }
  firstEdge[nodeCount] = edges.length;

  return new Snapshot({ file: inputFile, meta, nodeCount, edgeCount, NF, EF, nodes, edges, strings, firstEdge });
}

class Snapshot {
  constructor(o) {
    Object.assign(this, o);
    this.ntypes = o.meta.node_types[0];
    this.etypes = o.meta.edge_types[0];
    this.WEAK = this.etypes.indexOf('weak');
    this.SHORTCUT = this.etypes.indexOf('shortcut');
    this.F_TYPE = o.meta.node_fields.indexOf('type');
    this.F_NAME = o.meta.node_fields.indexOf('name');
    this.F_ID = o.meta.node_fields.indexOf('id');
    this.F_SIZE = o.meta.node_fields.indexOf('self_size');
  }
  type(k) { return this.ntypes[this.nodes[k * this.NF + this.F_TYPE]]; }
  name(k) { return this.strings[this.nodes[k * this.NF + this.F_NAME]] || ''; }
  id(k) { return this.nodes[k * this.NF + this.F_ID]; }
  self(k) { return this.nodes[k * this.NF + this.F_SIZE]; }
  edgeTarget(e) { return this.edges[e + 2] / this.NF; }
  edgeType(e) { return this.etypes[this.edges[e]]; }
  edgeName(e) {
    const t = this.etypes[this.edges[e]];
    const n = this.edges[e + 1];
    return t === 'element' || t === 'hidden' ? `[${n}]` : this.strings[n];
  }
  isStrong(e) { const t = this.edges[e]; return t !== this.WEAK && t !== this.SHORTCUT; }

  maxId() {
    let m = 0;
    for (let k = 0; k < this.nodeCount; k++) { const v = this.id(k); if (v > m) m = v; }
    return m;
  }

  idIndex() {
    if (!this._idIndex) {
      const m = new Map();
      for (let k = 0; k < this.nodeCount; k++) m.set(this.id(k), k);
      this._idIndex = m;
    }
    return this._idIndex;
  }

  // Grouping key used for the per-constructor diff.
  groupKey(k) {
    const t = this.type(k);
    const name = this.name(k);
    switch (t) {
      case 'string': case 'concatenated string': case 'sliced string': return '(string)';
      case 'code': return '(code)';
      case 'number': return '(number)';
      case 'array': return '(array) ' + name.slice(0, 60);
      case 'hidden': case 'object shape': return `(${t}) ` + name.slice(0, 60);
      case 'closure': return '(closure) ' + (name.slice(0, 60) || '<anonymous>');
      default: return `${t}:${name.slice(0, 80)}`;
    }
  }

  label(k, isNew) {
    let n = this.name(k).replace(/\s+/g, ' ');
    if (n.length > 100) n = n.slice(0, 100) + '…';
    return `${this.type(k)}:${n} @${this.id(k)}${isNew && isNew(k) ? '*' : ''}`;
  }

  // Lengauer-Tarjan dominator tree from root node 0, ignoring weak/shortcut edges.
  computeDominators() {
    const N = this.nodeCount, NF = this.NF, EF = this.EF, edges = this.edges, firstEdge = this.firstEdge;
    const WEAK = this.WEAK, SHORTCUT = this.SHORTCUT;
    const dfnum = new Int32Array(N).fill(-1);
    const vertex = new Int32Array(N);
    const parent = new Int32Array(N).fill(-1);
    let cnt = 0;
    {
      const stackNode = new Int32Array(N);
      const stackEdge = new Uint32Array(N);
      let sp = 1;
      stackNode[0] = 0; stackEdge[0] = firstEdge[0];
      dfnum[0] = cnt; vertex[cnt++] = 0;
      while (sp > 0) {
        const v = stackNode[sp - 1];
        let e = stackEdge[sp - 1];
        const end = firstEdge[v + 1];
        let pushed = false;
        while (e < end) {
          const t = edges[e];
          const w = edges[e + 2] / NF;
          e += EF;
          if (t === WEAK || t === SHORTCUT) continue;
          if (dfnum[w] === -1) {
            stackEdge[sp - 1] = e;
            dfnum[w] = cnt; vertex[cnt++] = w; parent[w] = v;
            stackNode[sp] = w; stackEdge[sp] = firstEdge[w]; sp++;
            pushed = true;
            break;
          }
        }
        if (!pushed) sp--;
      }
    }
    const revStart = new Uint32Array(N + 1);
    for (let v = 0; v < N; v++) {
      if (dfnum[v] === -1) continue;
      for (let e = firstEdge[v]; e < firstEdge[v + 1]; e += EF) {
        const t = edges[e];
        if (t === WEAK || t === SHORTCUT) continue;
        revStart[edges[e + 2] / NF + 1]++;
      }
    }
    for (let i = 0; i < N; i++) revStart[i + 1] += revStart[i];
    const revFrom = new Uint32Array(revStart[N]);
    const revEdge = new Uint32Array(revStart[N]);
    {
      const fill = revStart.slice();
      for (let v = 0; v < N; v++) {
        if (dfnum[v] === -1) continue;
        for (let e = firstEdge[v]; e < firstEdge[v + 1]; e += EF) {
          const t = edges[e];
          if (t === WEAK || t === SHORTCUT) continue;
          const p = fill[edges[e + 2] / NF]++;
          revFrom[p] = v; revEdge[p] = e;
        }
      }
    }
    const semi = new Int32Array(N);
    const ancestor = new Int32Array(N).fill(-1);
    const best = new Int32Array(N);
    const idom = new Int32Array(N).fill(-1);
    const samedom = new Int32Array(N).fill(-1);
    const bucketHead = new Int32Array(N).fill(-1);
    const bucketNext = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++) { semi[i] = dfnum[i]; best[i] = i; }
    const pcStack = new Int32Array(N);
    const evalNode = (v) => {
      let sp = 0, a = v;
      while (ancestor[a] !== -1 && ancestor[ancestor[a]] !== -1) { pcStack[sp++] = a; a = ancestor[a]; }
      while (sp > 0) {
        const x = pcStack[--sp];
        const ax = ancestor[x];
        if (semi[best[ax]] < semi[best[x]]) best[x] = best[ax];
        ancestor[x] = ancestor[ax];
      }
      return best[v];
    };
    for (let i = cnt - 1; i > 0; i--) {
      const n = vertex[i];
      const p = parent[n];
      let s0 = p;
      for (let r = revStart[n]; r < revStart[n + 1]; r++) {
        const v = revFrom[r];
        const s1 = dfnum[v] <= dfnum[n] ? v : vertex[semi[evalNode(v)]];
        if (dfnum[s1] < dfnum[s0]) s0 = s1;
      }
      semi[n] = dfnum[s0];
      bucketNext[n] = bucketHead[s0]; bucketHead[s0] = n;
      ancestor[n] = p;
      for (let v = bucketHead[p]; v !== -1; v = bucketNext[v]) {
        const y = evalNode(v);
        if (semi[y] === semi[v]) idom[v] = p; else samedom[v] = y;
      }
      bucketHead[p] = -1;
    }
    for (let i = 1; i < cnt; i++) {
      const n = vertex[i];
      if (samedom[n] !== -1) idom[n] = idom[samedom[n]];
    }
    idom[0] = 0;
    Object.assign(this, { idom, dfsOrder: vertex, reachable: cnt, revStart, revFrom, revEdge });
    return idom;
  }

  // Retained size, plus retained size restricted to nodes matching `filter`.
  computeRetained(filter) {
    const N = this.nodeCount, idom = this.idom, order = this.dfsOrder;
    const retained = new Float64Array(N);
    const retainedF = filter ? new Float64Array(N) : null;
    const domChildren = new Uint32Array(N);
    for (let i = 0; i < N; i++) {
      retained[i] = this.self(i);
      if (filter && filter(i)) retainedF[i] = retained[i];
    }
    for (let i = this.reachable - 1; i > 0; i--) {
      const n = order[i];
      const d = idom[n];
      retained[d] += retained[n];
      if (retainedF) retainedF[d] += retainedF[n];
      domChildren[d]++;
    }
    Object.assign(this, { retained, retainedF, domChildren });
  }

  // BFS shortest strong path from root, for readable retainer chains.
  computeBfsTree() {
    const N = this.nodeCount, EF = this.EF, firstEdge = this.firstEdge;
    const bfsParent = new Int32Array(N).fill(-1);
    const bfsEdge = new Int32Array(N).fill(-1);
    const q = new Int32Array(N);
    let h = 0, t = 0;
    q[t++] = 0; bfsParent[0] = 0;
    while (h < t) {
      const v = q[h++];
      for (let e = firstEdge[v]; e < firstEdge[v + 1]; e += EF) {
        if (!this.isStrong(e)) continue;
        const w = this.edgeTarget(e);
        if (bfsParent[w] === -1) { bfsParent[w] = v; bfsEdge[w] = e; q[t++] = w; }
      }
    }
    Object.assign(this, { bfsParent, bfsEdge });
  }

  // [{edge, from}] from k up to root.
  retainerChain(k, max = 30) {
    const out = [];
    let v = k;
    while (v !== 0 && out.length < max) {
      const p = this.bfsParent[v];
      if (p === -1) { out.push({ edge: null, from: -1 }); break; }
      out.push({ edge: this.bfsEdge[v], from: p });
      v = p;
    }
    return out;
  }

  findEdge(k, name) {
    for (let e = this.firstEdge[k]; e < this.firstEdge[k + 1]; e += this.EF) {
      if (this.isStrong(e) && this.edgeName(e) === name) return this.edgeTarget(e);
    }
    return -1;
  }

  followPath(start, names) {
    let v = start;
    for (const n of names) { v = this.findEdge(v, n); if (v < 0) return -1; }
    return v;
  }
}

const mb = (x) => (x / 1048576).toFixed(1) + 'MB';

module.exports = { loadSnapshot, Snapshot, mb };
