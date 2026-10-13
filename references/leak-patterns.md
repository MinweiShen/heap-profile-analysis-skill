# Leak patterns and their snapshot signatures

Use this to name the mechanism behind a GROWING accumulator. For each pattern: what it looks like in the retainer chain / entries, why it leaks, and how to fix it.

## Contents

1. Module-level cache or dictionary without eviction
2. State-library initial value mutated in place (Jotai / Recoil / Redux / Zustand / Vue reactive)
3. Map/Set keyed per request or per render, never cleared
4. Framework render-phase bookkeeping that is never reset
5. AsyncLocalStorage / async context captured by long-lived resources
6. Timers and intervals
7. Event listeners and subscriptions
8. Closures capturing large scopes
9. Detached DOM (browser)
10. False positives — large but not leaking

---

## 1. Module-level cache or dictionary without eviction

**Signature**: chain goes `require.cache` / `__webpack_module_cache__` → some module → a context variable or exported object → a Map / plain Object whose keys are request-derived (URLs, user ids, keywords, slugs). Child count scales with the number of distinct requests.

**Why**: modules are singletons for the process lifetime. Anything stored on them lives forever.

**Fix**: bounded LRU (`lru-cache` with `max`/`ttl`), or move the cache to request scope. If a cache is intended, cap it and measure hit rate.

## 2. State-library initial value mutated in place

**Signature**: a store/atom definition object (e.g. Jotai atom with `init`, `read`, `write`, `debugLabel`) whose **initial value** (`init`, `initialState`, `defaultValue`) holds runtime data keyed by request — in before it had a handful of keys, in after hundreds.

**Why**: in SSR, each request gets a fresh store, but before the store has its own value for an atom, reads return the atom's initial value **by reference**. Updaters like

```ts
set(myAtom, (prev) => { prev[key] = data; return prev; });
// or get(myAtom)[key] = data
```

mutate the module-level initial object. Every request writes into the shared object: memory leaks, and requests see each other's data (correctness/security issue too).

**Fix**: immutable updates (`set(a, prev => ({ ...prev, [key]: data }))`), or `atomFamily(key)` with per-request store; `Object.freeze(initialValue)` in development to surface mutations. Audit every atom/slice whose initial value is an object or array.

## 3. Map/Set keyed per request or per render, never cleared

**Signature**: `Map` → `table` array with N entries; keys are request/component objects (queues, contexts, sockets). Many `system / Hole` slots mean entries are deleted on the happy path but leak on some path (errors, aborted renders, early returns).

**Fix**: delete in `finally`; use `WeakMap` when the key object's lifetime should govern the entry; clear the map at the end of the request/render.

## 4. Framework render-phase bookkeeping that is never reset

**Signature**: module-level structures inside a renderer (React SSR / custom renderer), e.g. `renderPhaseUpdates: Map<queue, update>` with keys like `{ last, dispatch: dispatchAction.bind(...), obsolete }` and values `{ action, next }`. Usually accompanied by growth in `native_bind` and `(bound arguments)` (one bound `dispatch` per hook queue).

**Why**: a component calls `setState`/`dispatch` during render on the server; the renderer stores a render-phase update that is consumed only if the component re-renders through the same hook. React itself resets this state per component (`resetHooksState`); forks or custom renderers may not.

**Fix**: renderer resets/clears the structure after each component or request; app side, remove setState/dispatch calls during render (move to effects, or compute derived state).

## 5. AsyncLocalStorage / async context captured by long-lived resources

**Signature**: `<symbol kResourceStore>` or `kAsyncContextFrame` edges from a `Socket`, `UDP`, `Pipe`, `Timeout`, pool object → a per-request store `{ ctx, ... }` holding request/response data. Count is bounded by pool size, so it plateaus.

**Why**: async resources inherit the ALS store active when they were created. A pooled connection or interval created inside a request keeps that request's context forever.

**Fix**: create pooled/long-lived resources outside request scope (`als.exit(() => ...)`, or `AsyncResource` bound to the root context). Usually a moderate, bounded cost — mention it but rank it below unbounded growth.

## 6. Timers and intervals

**Signature**: `Timeout` objects in `TimersList`, `_onTimeout` closures holding large contexts, `_timerArgs` holding promises/responses; `setInterval` without `clearInterval`.

**Fix**: clear on teardown; `timer.unref()` doesn't free memory — only clearing does. Monitoring maps that track timers (`_timeoutMap`) are fine if their size is stable.

## 7. Event listeners and subscriptions

**Signature**: `EventEmitter._events.<name>` arrays growing; `MaxListenersExceededWarning` in logs; RxJS `Subscriber` / `AnonymousSubject` counts growing; store `listeners` Sets growing.

**Fix**: `off`/`removeListener`/`unsubscribe` in cleanup; `once` where appropriate; `AbortSignal` for bulk removal.

## 8. Closures capturing large scopes

**Signature**: many `(closure)` nodes whose `context` holds a big object (response body, request) although the function only needs a small part.

**Fix**: extract needed fields before creating the long-lived callback; null out references.

## 9. Detached DOM (browser)

**Signature**: `Detached HTMLDivElement` etc. (`detachedness` field = 2), retained by JS arrays, listeners, or framework fiber references.

**Fix**: remove listeners and references on unmount; check component libraries' cleanup.

## 10. False positives — large but not leaking

- **In-flight requests**: per-request contexts, response bodies, rendered HTML strings. Many similar objects, retained by sockets/promises, but the count tracks concurrency, not uptime.
- **JIT code / bytecode growth** (`(code)` type): warms up after deploy then plateaus.
- **Bounded pools and caches**: client connection maps, LRU caches at capacity.
- **Monitoring structures with stable size**: timer/resource trackers whose entry count doesn't grow.
- **Module source strings**: the bundle source itself (tens of MB, `string:(()=>{ var __webpack_modules__`) — present in both snapshots.

Rule them out with numbers (entry count before vs after), and list them in the report's "ruled out" section.
