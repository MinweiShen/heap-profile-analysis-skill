# heap-profile-analysis-skill

An agent skill that finds the root cause of JavaScript memory leaks by diffing two V8 heap snapshots (before / after) and producing a leak report.

It works with `.heapsnapshot` files from Node.js (`v8.writeHeapSnapshot()`, `--heapsnapshot-signal`, `node --inspect`) and Chrome DevTools, including multi-GB snapshots and `.gz` files.

## What it does

1. Streams both snapshots into typed arrays (no `JSON.parse` size limit).
2. Diffs object counts and sizes by type.
3. Builds the dominator tree of the after snapshot and computes retained size of objects allocated after the before snapshot.
4. Finds **accumulators**: containers (Maps, dictionary objects, arrays) holding lots of new memory across many children, prints their retainer chains, and checks whether the same container actually grew since the before snapshot.
5. The agent then inspects suspects, matches them against known leak patterns, and writes a report with evidence, mechanism and fix.

## Install

Copy or clone this repository into your agent's skills directory, e.g.:

```bash
git clone https://github.com/MinweiShen/heap-profile-analysis-skill.git ~/.cursor/skills/heap-profile-analysis
# or ~/.claude/skills/heap-profile-analysis
```

Then ask the agent something like: "Here are before/after heap snapshots, tell me why memory is leaking."

## Use the scripts directly

Requires Node.js ≥ 16.

```bash
node --max-old-space-size=16000 scripts/analyze.js before.heapsnapshot after.heapsnapshot --out findings.md
node --max-old-space-size=16000 scripts/inspect.js after.heapsnapshot <object-id> --depth 3
node --max-old-space-size=16000 scripts/inspect.js after.heapsnapshot <object-id> --retainers
```

A pair of ~500MB / ~860MB snapshots takes about 20 seconds and ~3GB of RAM.

## Layout

```
SKILL.md                     workflow and report template for the agent
scripts/snapshot.js          streaming parser, dominator tree, retained size, retainer paths
scripts/analyze.js           before/after diff → Markdown findings
scripts/inspect.js           expand an object or list its retainers by id
references/leak-patterns.md  common leak mechanisms, their snapshot signatures and fixes
references/methodology.md    how the analysis works
```
