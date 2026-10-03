// The write gate's result memo (§3.1 — a cache is allowed only under rigorous invalidation): a whole
// `GateResult` keyed EXACTLY on its inputs — the affected programs and their
// `SingleProgram.diskVersion()`, bumped by every reindex and never by an overlay, plus the edit and
// the check scope — so an apply that follows an identical dry-run skips the gate. A hashed key is not
// used: a collision serves another edit's verdict, i.e. a false clean. Per-file diagnostics are not
// cached here; their one authority is the diagnostics builder (program-gate-builder.ts).
//
// Module resolution is not part of the key: TS reuses it across Program rebuilds, so an install under
// gitignored `node_modules` between a dry-run and its apply at one disk version reuses the dry-run's
// verdict (t-710809 / t-828499).

import type { SingleProgram } from './program/single.ts';
import type { GateHostCtx, GateResult } from './program-gate.ts';
import { createGateBuilders } from './program-gate-builder.ts';

/** The gate context factory a host holds for its lifetime: the memo and the builders are created
 *  once here, the program list is re-read per gate (`built()` materializes the siblings). */
export function gateContext(
  base: Omit<GateHostCtx, 'programs' | 'cache' | 'builders'> & {
    programs: () => readonly SingleProgram[];
  },
): () => GateHostCtx {
  const cache = createGateCache();
  const builders = createGateBuilders();
  return () => ({ ...base, programs: base.programs(), cache, builders });
}

export interface GateCache {
  /** Stable per-object id: a re-created sibling program is a different program. */
  idOf(program: SingleProgram): number;
  /** `programs` are the ones the key names: an entry whose program moved past its disk version can
   *  never hit again and is dropped rather than left holding memory. */
  result(key: string, programs: readonly SingleProgram[]): GateResult | undefined;
  storeResult(key: string, programs: readonly SingleProgram[], result: GateResult): void;
}

const RESULT_SLOTS = 4;
/** Above this a key costs more to hold and compare than a reuse saves (a whole-tree codemod). */
const RESULT_KEY_MAX_CHARS = 4_000_000;

interface StoredResult {
  result: GateResult;
  versions: readonly (readonly [SingleProgram, number])[];
}

export function createGateCache(): GateCache {
  const ids = new WeakMap<SingleProgram, number>();
  let nextId = 0;
  const results = new Map<string, StoredResult>(); // insertion order = LRU order
  const dropStale = (): void => {
    for (const [key, stored] of results) {
      if (stored.versions.some(([p, v]) => p.diskVersion() !== v)) results.delete(key);
    }
  };

  return {
    idOf(program) {
      let id = ids.get(program);
      if (id === undefined) {
        id = nextId++;
        ids.set(program, id);
      }
      return id;
    },
    result(key) {
      dropStale();
      const hit = results.get(key);
      if (hit === undefined) return undefined;
      results.delete(key);
      results.set(key, hit);
      return copyResult(hit.result);
    },
    storeResult(key, programs, result) {
      dropStale();
      if (key.length > RESULT_KEY_MAX_CHARS) return;
      results.delete(key);
      const versions = programs.map((p) => [p, p.diskVersion()] as const);
      results.set(key, { result: copyResult(result), versions });
      while (results.size > RESULT_SLOTS) {
        const oldest = results.keys().next().value;
        if (oldest === undefined) break;
        results.delete(oldest);
      }
    },
  };
}

function copyResult(r: GateResult): GateResult {
  return {
    baseline: [...r.baseline],
    overlay: [...r.overlay],
    programs: [...r.programs],
    degraded: [...r.degraded],
  };
}
