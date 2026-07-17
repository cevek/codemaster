// The bounded transitive-dependents closure behind `impact` — a pure BFS over a
// `find_usages`-style `expand` callback (the op supplies one that calls the ts plugin).
// No I/O lives here: the callback does the LS work, this module owns ONLY the traversal
// invariants the trust contract turns on (§1 never-hang, §3 honest uncertainty):
//
//   · visited-set keyed by encloser SymbolId  → cycles terminate (A→B→A hits visited).
//   · a GLOBAL node cap across all levels      → total work = nodeCap × find_usages, the
//                                                 only bound (checked before every expand
//                                                 AND before every add); reported, never
//                                                 silently truncated.
//   · a depth cap                              → boundary nodes left un-expanded are
//                                                 counted and reported (raise depth).
//   · UN-EXPANDABLE dead-ends                  → a dependent we cannot re-query by its
//                                                 SymbolId (a module-level rollup like
//                                                 `(top-level x.ts)`, reached by a value/
//                                                 call edge) hides its own transitive
//                                                 dependents; it is COUNTED and the closure
//                                                 reported incomplete — never a silent stop
//                                                 (§3.4). A pure import/reexport leaf is
//                                                 benign (the LS already followed re-exports).
//   · value-flow boundary detection            → a dependent that references a CALLABLE
//                                                 parent purely as a value (read/write, no
//                                                 call/jsx) is a point where the parent can
//                                                 be dispatched dynamically; the SITE is
//                                                 flagged (never bridged — §3.3) and the
//                                                 closure reported partial. The node is
//                                                 still a CERTAIN dependent and still
//                                                 expanded — the incoming edge's role says
//                                                 nothing about whether the node itself has
//                                                 referrers (over-report is the safe
//                                                 direction for a blast radius).
//
// Filtering (kind/path/exported) is NOT applied here: it would prune the WALK and hide
// transitive dependents reachable only through a filtered node — the dangerous
// (under-report) direction. The op applies filters as a projection over the COMPLETE
// closure instead.

import type { GroupRow } from '../plugins/ts/query-types.ts';
import { type Deadline, NO_DEADLINE } from '../common/async/deadline.ts';

/** What `expand` returns for one node: its dependent enclosers (each a chainable
 *  `GroupRow`) plus the completeness facts the closure must propagate. `ok:false` is a
 *  dead-end — a node whose SymbolId no longer resolves (a module rollup / unresolved id). */
type ExpandOutcome =
  | {
      ok: true;
      enclosers: readonly GroupRow[];
      /** Distinct enclosers BEFORE find_usages' own limit cap — `> enclosers.length`
       *  means this hub had more dependents than the per-call limit (a hub truncation). */
      groupTotal: number;
      /** True iff the parent is the kind of thing normally invoked/rendered (callable by
       *  kind, or some dependent references it via `call`/`jsx`). Only then is a value-only
       *  read of it a meaningful dynamic-dispatch escape — a plain data const, never called,
       *  is consumed by a read, not dispatched. */
      callableNatured: boolean;
    }
  | { ok: false };

export type Expand = (id: string) => ExpandOutcome;

/** A dependent in the closure, carrying the depth at which it was first reached (BFS, so
 *  this is its SHALLOWEST distance from the target) on top of the `GroupRow` proof. */
interface ClosureNode {
  row: GroupRow;
  depth: number;
}

/** A value-flow escape site (§3.3): the parent is read as a value inside `encloser`, where
 *  dynamic dispatch could carry its impact to consumers find_usages cannot see. Flagged at
 *  the encloser's `file:line:col`, never bridged to the invisible consumer. */
interface DynamicBoundary {
  encloser: GroupRow;
  /** The ancestor symbol that is read as a value here. */
  readsAsValue: string;
}

export interface ClosureResult {
  nodes: ClosureNode[];
  dynamicBoundaries: DynamicBoundary[];
  /** Dependents we could not re-expand (module rollups / unresolved ids reached by a
   *  value/call edge) — their own transitive dependents are a genuine gap. */
  unexpandable: number;
  /** Set when a hard bound stopped the traversal — the dependent set is INCOMPLETE. `nodes`/`depth`
   *  are DESIGN caps (the op reports them as `ok` + a `!!` note); `timeout` is the wall-clock budget
   *  running out mid-walk (§1 never-hang) — an abnormal degrade the op turns into a
   *  `ToolFailure{tool:'timeout', partial}`, honest about the un-walked remainder. */
  capped?: { by: 'nodes' | 'depth' | 'timeout'; boundaryNodes: number };
  /** Set when some single hub returned more dependents than find_usages' per-call limit. */
  hubTruncated: boolean;
}

export interface ClosureSeed {
  id: string;
  name: string;
}

export interface ClosureLimits {
  maxDepth: number;
  maxNodes: number;
}

const VALUE_ONLY_ROLES = new Set(['read', 'write']);
const CALLABLE_ROLES = new Set(['call', 'jsx']);
const BENIGN_LEAF_ROLES = new Set(['import', 'reexport']);

function splitRoles(roles: string): string[] {
  return roles.split(',').filter((r) => r.length > 0);
}

/** A dependent that references its parent ONLY as a value (read/write) — no call/jsx/type
 *  binding. The escape candidate, gated on the parent being callable-natured by the caller. */
function rolesValueOnly(roles: string): boolean {
  const parts = splitRoles(roles);
  return parts.length > 0 && parts.every((r) => VALUE_ONLY_ROLES.has(r));
}

function rolesIncludeCallable(roles: string): boolean {
  return splitRoles(roles).some((r) => CALLABLE_ROLES.has(r));
}

/** A dead-end reached ONLY by import/reexport edges is benign: the LS already resolves
 *  re-exports transitively, so the importers that actually USE the target were found
 *  directly, not hidden behind this module node. A dead-end reached by a value/call edge
 *  (e.g. `export const b = target()`) genuinely hides `b`'s own dependents. Empty roles
 *  (the seed sentinel) are treated benign — the seed never returns `ok:false`. */
function rolesBenignLeaf(roles: string): boolean {
  return splitRoles(roles).every((r) => BENIGN_LEAF_ROLES.has(r));
}

/** An encloser whose ONLY relationship to the target is being (part of) its definition —
 *  `find_usages` includes the decl ref, but the definition site is not a DEPENDENT (a
 *  dependent references the target from outside its own declaration). For a top-level
 *  symbol this is the file's module rollup; for a method, its class. Dropped by the op so
 *  the target's own container is never reported as depending on it. A node that also uses
 *  the target (roles `decl,call`) is a real dependent and is kept. */
function rolesDeclOnly(roles: string): boolean {
  const parts = splitRoles(roles);
  return parts.length > 0 && parts.every((r) => r === 'decl');
}

/** Breadth-first transitive dependents of `seed`, bounded by `limits`. The `seed`'s own id
 *  primes the visited-set so a self-reference (recursion, a decl ref rolling up to the
 *  target itself) is never reported as a distinct dependent. */
export function buildClosure(
  seed: ClosureSeed,
  expand: Expand,
  limits: ClosureLimits,
  /** The op's cumulative wall-clock budget (§1). Polled at each frontier node BEFORE its
   *  `expand` (the costly find_usages), so the accumulated closure-so-far is a real partial the
   *  op returns honestly. `NO_DEADLINE` (the default) never expires — the pure node/depth caps
   *  stay the only bounds, so an existing call is byte-identical. */
  deadline: Deadline = NO_DEADLINE,
): ClosureResult {
  const visited = new Set<string>([seed.id]);
  const nodes: ClosureNode[] = [];
  const dynamicBoundaries: DynamicBoundary[] = [];
  let hubTruncated = false;
  let unexpandable = 0;
  let capped: ClosureResult['capped'];

  // Each frontier entry is a node discovered at the previous depth, queued for expansion;
  // `roles` is how it referenced ITS parent — used only to classify a dead-end (benign
  // import/reexport leaf vs a value/call edge that hides dependents).
  let frontier: { id: string; name: string; roles: string }[] = [
    { id: seed.id, name: seed.name, roles: '' },
  ];

  for (let depth = 1; depth <= limits.maxDepth && frontier.length > 0; depth++) {
    const next: { id: string; name: string; roles: string }[] = [];
    for (let i = 0; i < frontier.length; i++) {
      const parent = frontier[i];
      if (parent === undefined) continue;
      // Never-hang: stop BEFORE the find_usages call once the budget is spent. `frontier[i]`
      // is not yet expanded, so it is part of the un-expanded boundary.
      if (nodes.length >= limits.maxNodes) {
        capped = { by: 'nodes', boundaryNodes: frontier.length - i + next.length };
        return finish();
      }
      // Wall-clock budget (§1): checked at the SAME pre-expand point, so `parent` is un-expanded
      // and counted in the boundary exactly like the node cap. The accumulated `nodes` are a real
      // partial closure — the op returns them under an honest `timeout` failure, never as complete.
      if (deadline.expired()) {
        capped = { by: 'timeout', boundaryNodes: frontier.length - i + next.length };
        return finish();
      }
      const outcome = expand(parent.id);
      if (!outcome.ok) {
        if (!rolesBenignLeaf(parent.roles)) unexpandable++;
        continue;
      }
      if (outcome.groupTotal > outcome.enclosers.length) hubTruncated = true;
      for (const row of outcome.enclosers) {
        if (visited.has(row.id)) continue; // diamond / cycle — already counted at ≤ this depth
        if (nodes.length >= limits.maxNodes) {
          // `frontier[i]` IS being expanded (its already-added rows are in `nodes`/`next`),
          // so it is NOT part of the un-expanded boundary — exclude it (the `- 1`).
          capped = { by: 'nodes', boundaryNodes: frontier.length - i - 1 + next.length };
          return finish();
        }
        visited.add(row.id);
        nodes.push({ row, depth });
        next.push({ id: row.id, name: row.name, roles: row.roles });
        if (outcome.callableNatured && rolesValueOnly(row.roles)) {
          dynamicBoundaries.push({ encloser: row, readsAsValue: parent.name });
        }
      }
    }
    frontier = next;
  }
  // Frontier still populated after the depth loop → deeper dependents exist beyond the cap.
  if (frontier.length > 0) capped = { by: 'depth', boundaryNodes: frontier.length };
  return finish();

  function finish(): ClosureResult {
    return {
      nodes,
      dynamicBoundaries,
      unexpandable,
      hubTruncated,
      ...(capped !== undefined ? { capped } : {}),
    };
  }
}

export { rolesIncludeCallable, rolesDeclOnly };
