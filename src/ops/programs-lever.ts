// The `programs:` read-op arg (t-228533), shared by find_usages / importers_of / find_unused_exports
// so the schema fragment + disclosure live in ONE place (no 3× copy-paste). The arg names extra
// tsconfig paths to load as READ-only programs for THIS call, widening the search over an otherwise-
// UNDISCOVERED nested config so a count/dead-code verdict is complete without editing the repo. It is
// NOT a flag: `root` is a flag only because ROUTING needs it pre-op; `programs:` is op-CONSUMED, so a
// zod-validated per-op arg is cleaner and visible in each op's inputSchema (§11).
//
// The lever runs BEFORE the query (it mutates the ts host's coverage/program set), and its effect is
// disclosed verdict-first (§12): `programsLoaded` (searched → floor lifted for them), `programsFloored`
// (loaded but STILL floored — partial coverage, does NOT lift the floor), `programsNotFound`. The
// covered-vs-floored decision is the ONE correct-resolution coverage proof, never a second gate.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';

/** Cap mirrors the discovery backstop: far above any real repo's tsconfig count, a runaway guard. */
export const programsArgShape = {
  /** Extra tsconfig paths (repo-relative, or a directory → its `tsconfig.json`) to load as READ-only
   *  programs for THIS call, so the search covers an otherwise-undiscovered nested config. */
  programs: z.array(z.string().min(1)).min(1).max(64).optional(),
} as const;

/** Load the requested programs (idempotent, bounded) and return verdict-first disclosure fields +
 *  notes. No-op (empty) when `programs` is absent, so a caller can splat unconditionally. */
export function applyProgramsLever(
  ts: TsPluginApi,
  programs: readonly string[] | undefined,
): { fields: Record<string, JsonValue>; notes: string[] } {
  if (programs === undefined || programs.length === 0) return { fields: {}, notes: [] };
  const report = ts.loadPrograms(programs);
  const fields: Record<string, JsonValue> = {};
  if (report.loaded.length > 0) fields.programsLoaded = report.loaded;
  if (report.floored.length > 0) fields.programsFloored = report.floored;
  if (report.notFound.length > 0) fields.programsNotFound = report.notFound;
  const notes: string[] = [];
  if (report.floored.length > 0) {
    notes.push(
      `!! programs: ${report.floored.length} config(s) LOADED but STILL FLOORED (${report.floored.join(', ')}) — partial coverage (an un-injectable stray or a file outside the correct-resolution union remains under them), so they do NOT lift the completeness floor.`,
    );
  }
  if (report.notFound.length > 0) {
    notes.push(
      `programs: ${report.notFound.length} path(s) NOT FOUND under the repo root (${report.notFound.join(', ')}) — pass a repo-relative tsconfig path (or its dir); cross-repo targets use root:, not programs:.`,
    );
  }
  return { fields, notes };
}
