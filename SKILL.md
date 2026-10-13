---
name: heap-profile-analysis
description: Find the root cause of a JavaScript memory leak by diffing two V8 heap snapshots (before/after .heapsnapshot files from Node.js or Chrome DevTools) and writing a leak report. Use this whenever the user has two heap snapshots, heap dumps or heap profiles and asks why memory grows, what is leaking, or to compare them — including phrasings like "内存泄漏", "heap profile 对比", "before/after heapsnapshot", "OOM", "RSS keeps growing", even if they don't say "leak". Handles multi-GB snapshots that DevTools and JSON.parse choke on.
---

# Heap Profile Leak Analysis

Given a **before** and an **after** V8 heap snapshot, find which objects keep accumulating, who holds them, and why — then write a report a developer can act on.

The bundled scripts do the heavy, deterministic work (parsing, dominator tree, retained sizes, growth checks). Your job is to read their output, dig into the suspects, and turn structural evidence into an explanation in terms of the user's code.

## Workflow

### 1. Locate inputs

Identify the before/after pair (`.heapsnapshot` or `.heapsnapshot.gz`). If there are several pairs (e.g. `f1/`, `f2/` from different instances), analyze each — agreement across pairs is strong evidence. If it's unclear which file is "before", the one with the smaller node count / earlier mtime usually is; confirm with the user if still ambiguous.

### 2. Run the diff

```bash
node --max-old-space-size=16000 <skill-dir>/scripts/analyze.js <before> <after> --out <workdir>/heap-diff-findings.md
```

- Needs Node ≥ 16. Memory use is roughly 3× the larger snapshot's file size; lower `--max-old-space-size` on small machines.
- An 860MB snapshot pair takes ~20s. Run multiple pairs in parallel if RAM allows.
- Write outputs into the user's workspace, not the skill directory.

Then read the findings file. It contains:

1. **Growth by type** — which constructors/types grew. Tells you *what* grew, not *why*.
2. **Accumulators** — the key section. Objects that retain lots of (new) memory spread across many children: Maps, caches, arrays, objects used as dictionaries. Each comes with retained size, its retainer chain to a GC root, grouped children with example keys, and a **GROWING / stable** verdict from comparing the same container in the before snapshot.
3. **Large single objects** — big leaves (huge strings, buffers).
4. **New strings grouped by retainer** — property names (`.desc`, `.playUrl`, `._body`) reveal what data is piling up.
5. **Top retained objects** — context.

"New" means the object's id is larger than the max id in before. This only works when both snapshots come from the same process; the header says whether ids are comparable. If not, the script falls back to retained-size ranking and path matching — be more cautious and lean on the before/after container comparison.

### 3. Investigate each GROWING accumulator

For each suspect, establish four things:

- **The container**: what the object is. Read the retainer chain bottom-up: module path (`webpack_module_cache` → `foo.atom.js`), closure variable names (context edges like `renderPhaseUpdates`), class names (`TimeoutMetricsPlugin._timeoutMap`).
- **The entries**: what each child is. Expand an example child:
  ```bash
  node --max-old-space-size=16000 <skill-dir>/scripts/inspect.js <after> <id> --depth 3 --edges 10
  node --max-old-space-size=16000 <skill-dir>/scripts/inspect.js <after> <id> --retainers   # who points at it
  ```
  Map entries live in the `table` array as key, value, key, value… (`system / Hole` = deleted slot; many holes mean deletion happens but some entries are missed).
- **Growth confirmation**: entry count before vs after. The verdict line gives retained size and child count in both snapshots; for Maps compare non-hole entries. A container that is large but not growing (e.g. in-flight request state, a bounded pool) is not a leak — say so explicitly in the report, because ruling things out is part of the answer.
- **The mechanism**: why entries are added and never removed. Match the shape against `references/leak-patterns.md` — read it when you have a suspect and need to name the mechanism and the fix.

Source code is usually not in the snapshot: V8 truncates long strings, so bundled sources show only their first ~1KB. If the user's repo is available, search it for the identifiers from the retainer chain (module path, variable names, debug labels) to pin the exact line. If not, state clearly that the faulty code is inferred from object structure.

### 4. Quantify

Attribute the total growth: how many MB each confirmed leak explains, and what is left (in-flight requests, JIT code, caches that are warming up). Cross-check with the type diff — e.g. if `native_bind` grew by 94k and a leaking Map holds 47k `{dispatch: bound fn}` entries, connect those numbers.

### 5. Write the report

Write the report in the user's language (if they wrote in Chinese, write it in Chinese) to a Markdown file in their workspace (e.g. `memory-leak-analysis.md`), and summarize the conclusion in chat. Use this structure:

```markdown
# 内存泄漏分析结论 / Memory leak analysis

## 总览 / Overview
Table: snapshot pair, before size, after size, growth. One paragraph: top growing types,
and a numbered list of root causes with MB each.

## 主因 / Root cause 1: <container> <mechanism>  (~N MB)
### 引用链 / Retainer chain      — the chain from GC root, trimmed to the meaningful part,
                                  with what each child entry looks like
### 规模变化 / Growth evidence   — entry counts before → after for every snapshot pair
### 原因推断 / Mechanism          — why entries are added and never removed; probable code shape
### 修复建议 / Fix                — concrete code-level fix + how to prevent recurrence

## 次因 / Root cause 2 … (same structure)

## 看起来像、但不是泄漏的 / Ruled out
Large retainers that are not growing, and why they're benign.

## 局限 / Limitations
What was inferred rather than seen (e.g. source code unavailable), what to verify.
```

Lead with the conclusion. Each root cause needs evidence (numbers before → after), not just a large retained size.

## Reference

- `references/leak-patterns.md` — common accumulation patterns in Node/browser apps (module-level caches, state-library initial values mutated in place, Maps never cleared, AsyncLocalStorage capture, timers, listeners, closures), with their snapshot signatures and fixes. Also lists common false positives.
- `references/methodology.md` — how the analysis works (snapshot format, dominators, retained size, "new" objects, accumulator detection). Read it if the output looks surprising or you need to explain the method to the user.
