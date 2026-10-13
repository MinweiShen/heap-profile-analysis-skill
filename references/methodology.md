# Methodology

How `scripts/analyze.js` works, so you can interpret surprising output and explain the method.

## Snapshot format

A `.heapsnapshot` is JSON with:

- `snapshot.meta` — field layouts.
- `nodes` — flat int array, `node_fields` per node: type, name (string index), id, self_size, edge_count, trace_node_id, detachedness.
- `edges` — flat int array, `edge_fields` per edge: type, name_or_index, to_node (offset into `nodes`). A node's edges are contiguous and follow the order of nodes.
- `strings` — all names and string values. V8 truncates long string values, so bundled source code is not recoverable.

Large snapshots exceed V8's maximum string length (~512MB), so `scripts/snapshot.js` streams the file and parses numbers directly into typed arrays instead of `JSON.parse`.

## Analysis steps

1. **Type diff** — group nodes by type + constructor name, compare counts and self sizes. Shows *what* grew.
2. **Id comparability** — V8 assigns increasing ids within a process. Sample after-snapshot nodes with id ≤ before's max id and check the same id exists in before with the same name. If >60% match, the snapshots are from the same process and "new" = `id > beforeMaxId`.
3. **Dominator tree** (Lengauer-Tarjan, ignoring weak and shortcut edges). A dominates X if every path from the GC root to X passes through A. **Retained size** of A = total self size of everything A dominates = memory freed if A were released. Also computed: retained size counting only new nodes.
4. **Accumulator detection** — nodes whose new-retained size exceeds max(1MB, 1% of growth) and where no single dominated child carries ≥50% of it. This favors containers (Map tables, dictionary objects, arrays) over long linear chains. Nodes with <10 dominated children are reported as "large single objects" instead. Structurally similar accumulators (same type/name and same top-3 retainer edges) are collapsed into groups, which folds e.g. one-context-per-in-flight-request into a single line.
5. **Before comparison** — locate the same container in before: by identical id; otherwise via the nearest old ancestor on the retainer chain plus the same edge-name path (needed because a Map's backing `table` is reallocated when it grows); otherwise via the full path from root. Verdict is GROWING if retained size more than doubled (plus a threshold) or dominated children more than doubled (+50).
6. **Retainer chains** — BFS shortest path from the root over strong edges, printed bottom-up.
7. **New strings by retainer** — group new strings by their first retainer's type and property name.

## Caveats

- A GROWING verdict on one pair can still be warm-up (e.g. a cache filling to its cap). Two pairs, or a third snapshot, strengthen the conclusion.
- Retained size depends on the dominator tree: an object reachable from two unrelated owners is dominated by their common ancestor, so its size may appear under a synthetic root rather than either owner.
- Snapshots taken right after a GC are the most reliable; DevTools and `v8.writeHeapSnapshot()` force a GC first.
- Without comparable ids (different processes), all "new" columns are disabled and accumulators are ranked by total retained size.
