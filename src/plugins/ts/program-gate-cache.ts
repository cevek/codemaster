// The write gate's caches (§3.1 — a cache is allowed only under rigorous invalidation). The baseline
// half of `gateAcross` is a pure function of a program's DISK view: the per-file versions and
// compilerOptions — `SingleProgram.diskVersion()`, bumped by every reindex and never by an overlay —
// plus module resolution, which TS reuses across Program rebuilds unless the file — or, on a change
// of the root-file set such as a move's dest/tombstone, the whole program — is reprocessed. An
// install under gitignored `node_modules` is therefore invisible to the warm LS until such a rebuild
// (t-710809), and after one the LS's disk view can differ from a baseline cached before it. That
// cannot produce a false REFUSAL — `program-gate.ts` re-derives every cached file holding a
// diagnostic the cache does not cover; the residual false-clean is t-828499.
//
// Two layers: per-program, per-FILE baseline diagnostics (a rename gates `touched`, a move the whole
// tree — one store serves both), and the whole-gate result keyed EXACTLY on its inputs, so an apply
// that follows an identical dry-run skips the gate. A hashed key is not used: a collision serves
// another edit's verdict, i.e. a false clean.

import type { SingleProgram } from './program/single.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import { fileDiagnostics, type TsDiagnostic } from './diagnostics.ts';
import type { GateResult } from './program-gate.ts';

interface Generation {
  diskVersion: number;
  /** abs → that file's disk diagnostics; `null` = the file is not in the program. */
  files: Map<string, TsDiagnostic[] | null>;
}

export interface GateCache {
  /** Disk diagnostics of `checkAbs` in `program`; `fromCache` = at least one file was not computed
   *  now. A file enters the store only after its diagnostics returned — a cancelled collection
   *  leaves the interrupted file absent, never empty. */
  baseline(
    program: SingleProgram,
    relOf: (abs: string) => RepoRelPath,
    checkAbs: readonly string[],
  ): { diags: TsDiagnostic[]; fromCache: boolean };
  /** Recompute `absPaths` from the current disk program, replacing their stored entries. */
  refresh(
    program: SingleProgram,
    relOf: (abs: string) => RepoRelPath,
    absPaths: readonly string[],
  ): void;
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
  const generations = new WeakMap<SingleProgram, Generation>();
  const ids = new WeakMap<SingleProgram, number>();
  let nextId = 0;
  const results = new Map<string, StoredResult>(); // insertion order = LRU order
  const dropStale = (): void => {
    for (const [key, stored] of results) {
      if (stored.versions.some(([p, v]) => p.diskVersion() !== v)) results.delete(key);
    }
  };

  const generationOf = (program: SingleProgram): Generation => {
    const current = generations.get(program);
    if (current?.diskVersion === program.diskVersion()) return current;
    const fresh: Generation = { diskVersion: program.diskVersion(), files: new Map() };
    generations.set(program, fresh);
    return fresh;
  };

  return {
    baseline(program, relOf, checkAbs) {
      const gen = generationOf(program);
      const diags: TsDiagnostic[] = [];
      let fromCache = false;
      for (const abs of checkAbs) {
        let entry = gen.files.get(abs);
        if (entry === undefined) {
          entry = fileDiagnostics(program.service, relOf, abs) ?? null;
          gen.files.set(abs, entry);
        } else {
          fromCache = true;
        }
        if (entry !== null) diags.push(...entry);
      }
      return { diags, fromCache };
    },
    refresh(program, relOf, absPaths) {
      const gen = generationOf(program);
      for (const abs of absPaths)
        gen.files.set(abs, fileDiagnostics(program.service, relOf, abs) ?? null);
    },
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
