// `find_unused_exports` — the read op for dead TS exports (§5-L3): locally-declared exports
// with no importer/usage anywhere, proven through the live LS. A thin pass-through to the ts
// plugin's `unusedExports` (the op IS the surface; the join logic — references, demotion —
// lives in the plugin, §5-L2). MIRRORS `find_unused_scss_classes`/`find_unused_i18n_keys`:
// a barrel-/`export *`-/dynamic-`import()`-reached export is `partial`, never `certain` dead.

import { z } from 'zod';
import { forceFlagGuardNotOverridable } from './force-flag.ts';
import type { JsonValue } from '../core/json.ts';
import { fail, failFromThrown, ok, partial } from '../common/result/construct.ts';
import { semanticFanoutRefusal } from './guard/semantic-fanout-guard.ts';
import { nameWithMore } from '../common/truncate/name-with-more.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { Truncation } from '../core/result.ts';
import type { TsPluginApi, UnusedExportView } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';
import { programsArgShape, applyProgramsLever } from './programs-lever.ts';
import { NOT_A_VERDICT_MARKER } from './scan-coverage.ts';

/** The empty-WALK marker (§3.4), shown as the first data field + an sql note whenever the scan
 *  opened no file at all: `unused (0)` is then "nothing was examined", not "no export is dead".
 *
 *  ONE key for both causes, because they are mutually exclusive by construction and a consumer that
 *  had to probe two keys to learn whether a verdict exists is the defect this closes. The CAUSE — and
 *  with it the one lever that can change the outcome (§3.6) — lives in the text: a scope filter that
 *  matched nothing is fixed by fixing the globs; a program covering no source file cannot be widened
 *  by any glob, so naming `pathInclude` there would be an inert lever. */
const notAVerdictWarning = (filterSet: boolean): string =>
  filterSet
    ? `${NOT_A_VERDICT_MARKER} — pathInclude/pathExclude matched 0 files — nothing was examined; this is NOT proof that no exports are dead. Check your path(s)/glob(s) against actual file paths.`
    : `${NOT_A_VERDICT_MARKER} — the program covers 0 source files, so no export was examined and nothing about dead exports was established: this is an EMPTY SCAN, not an empty RESULT. No scope filter was set, so widening one cannot help — check that the project's tsconfig \`include\`/\`files\` actually covers its sources (a target under another package? pass \`root:\`).`;

const findUnusedExportsTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'name', type: 'text' },
    { name: 'kind', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
    { name: 'confidence', type: 'text' },
    { name: 'symbol', type: 'text' },
    { name: 'note', type: 'text' },
  ],
  rows(data) {
    const unused = (data as { unused?: UnusedExportView[] }).unused ?? [];
    return unused.map((u): readonly Cell[] => [
      u.name,
      u.kind,
      u.file,
      u.span.line,
      u.span.col,
      u.confidence,
      u.symbol,
      u.note ?? null,
    ]);
  },
  notes(data) {
    const out: string[] = [];
    if ((data as { computedDynamicImport?: boolean }).computedDynamicImport === true) {
      out.push(
        'a computed import(expr) exists in the repo — it could load any module, so every claim here is demoted to partial.',
      );
    }
    const u = (data as { undiscoveredPrograms?: string[] }).undiscoveredPrograms;
    if (u !== undefined && u.length > 0) {
      out.push(
        `repo has ${u.length} tsconfig(s) NOT loaded as a program (${nameWithMore(u, 3)}) — a nested-package config neither adjacent to the main config nor \`references\`d. Every otherwise-certain claim here is demoted to partial (that program may use the export); load/reference it to recover certain verdicts.`,
      );
    }
    const t = (data as { truncated?: { examined: number; candidates: number } }).truncated;
    if (t !== undefined) {
      out.push(
        `examined ${t.examined} of ${t.candidates} candidate exports (cap hit) — narrow with pathInclude to cover the rest.`,
      );
    }
    // The empty-walk warning (§3.4/§3.6) is an honesty channel, so it must reach the
    // sql/table render too — sourced from the same data field the dense render shows, never
    // a re-derived string.
    const warn = (data as { notAVerdict?: string }).notAVerdict;
    if (warn !== undefined) out.push(warn);
    // The `programs:` lever's disclosure (§3.6) — forwarded from the same data field the text render
    // shows, so sql/table consumers see the floored/not-found configs too, never a re-derived string.
    out.push(...((data as { notes?: string[] }).notes ?? []));
    return out;
  },
};

export const findUnusedExportsOp = defineOp({
  name: 'find_unused_exports',
  summary:
    'TS exports with no importer/usage anywhere (semantic, via the LS); barrel/export*/dynamic import() demotes to partial',
  mutating: false,
  requires: ['ts'],
  argsSchema: z.strictObject({
    pathInclude: z.array(z.string()).optional(),
    pathExclude: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
    /** Bypass the in-process semantic-fanout size guard (t-679091) and warm anyway. */
    force: forceFlagGuardNotOverridable(),
    ...programsArgShape,
  }),
  argsHint:
    '{ pathInclude?: string[], pathExclude?: string[], limit?: number, programs?: string[] (extra tsconfig paths to load, to recover certain verdicts over an undiscovered nested config) }',
  example: { args: { pathInclude: ['src/features/**'] } },
  notes: [
    'on an oversized IN-PROCESS repo (> `ts.searchWarmMaxFiles`, default 4000 source files) this op REFUSES to warm (the dead-export scan warms the whole program and fans a reference search per candidate, which would OOM and can kill the daemon) and says WHY the repo was not auto-escalated into a killable child (t-754922) plus the one remedy for that cause. `force:true` does NOT override it (forcing killed the daemon in production). No refusal in an escalated / configured process-mode child.',
    'semantic, not textual: an aliased `import { X as Y }` (which text-grep would miss) still counts X as used, so X is never falsely reported.',
    'an export reached only via a barrel re-export (`export { X } from`), an `export *`, or a dynamic `import()` demotes to partial — flagged "could not prove dead", never reported as definitely unused.',
    'an entry-point or public-API export (an `index.ts`/`bin.ts` with no in-repo importer) legitimately has no usage and WILL appear here — verify before deleting. There is no entry-point config yet.',
    'an export used only WITHIN its own module (never imported) is NOT reported — it has a usage; this finds dead exports, not redundant `export` keywords.',
    'usage is observed across ALL loaded programs (see concepts: cross-program-read) — an export used only from a `test/**` file is SEEN as used (not falsely reported); a genuinely-dead export reads `certain` again.',
    'honest floor for the UNDISCOVERED case: a nested-package tsconfig that is neither adjacent to the main config nor `references`d is NOT loaded as a program, so an export used only from it cannot be proven dead. When any such config exists, every otherwise-`certain` claim is demoted to `partial` and the config is NAMED in the result note — never a silent false-`certain`-dead.',
    'an EMPTY WALK is not an empty result: when 0 files were scanned (a scope filter that matched nothing, or a program covering no source file) the answer leads with `notAVerdict` and `unused (0)` proves nothing — and when the LS produced no Program at all the op FAILS (`ok:false`) instead of reporting a clean repo.',
    'bounded: scoped by pathInclude/pathExclude (globs over the declaration file) and hard-capped at the NUMBER of reference searches (default 200, override with limit) — the cap is reported as truncation. Each examined export costs one LS reference search (O(import-graph)), so on a very large repo scope with pathInclude. Usage discovery still scans the whole program, so scoping never invents a false dead.',
  ],
  table: findUnusedExportsTable,
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    // STOPGAP (t-820448) — the t-679091 pre-warm guard on an op that was left ungated: the
    // dead-export scan warms the checker over the whole program and fans a reference search per
    // candidate across every program (measured: OOMs a 1 GB engine on a ~6.1k-file repo), which
    // in-process kills the daemon uncatchably. Stated lifetime: this call goes away (or is
    // re-derived) once the auto-escalate-oversized-repo-to-process-mode path lands and the guard's
    // "refuse in-process" semantics are replaced by "route to a killable child".
    const refusal = semanticFanoutRefusal(ctx, ts, args.force, args);
    if (refusal !== undefined) return fail(refusal);
    try {
      // Widen the search first (t-228533): a `programs:`-loaded config is searched + subtracted from
      // the undiscovered floor BEFORE `unusedExports` reads that floor, so a genuinely-dead export
      // reads `certain` again over an otherwise-floored nested config. A partial-coverage config stays
      // floored — disclosed, never a false lift.
      const lever = applyProgramsLever(ts, args.programs);
      const view = ts.unusedExports(
        {
          ...(args.pathInclude !== undefined ? { pathInclude: args.pathInclude } : {}),
          ...(args.pathExclude !== undefined ? { pathExclude: args.pathExclude } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
        ctx.deadline,
      );
      const truncated: Truncation | undefined =
        view.truncated !== undefined
          ? {
              shown: view.truncated.examined,
              total: view.truncated.candidates,
              hint: 'narrow with pathInclude / pathExclude, or raise limit, to examine the rest',
            }
          : undefined;
      // The LS produced no Program (t-000011): nothing was parsed, so the empty list establishes
      // nothing. A failed scan is a FAILURE, never an `ok` shaped like a clean repo — the honest
      // "couldn't" the agent can fall back from (§3.6).
      if (view.programUnavailable === true) {
        return fail({
          tool: 'ts-ls',
          message:
            'the TypeScript Language Service produced no Program for this workspace — no file was parsed and no export was examined, so nothing about dead exports could be established. Check the project tsconfig loads (`status`), then retry.',
        });
      }
      // False-clean guard (§3.4/§3.6): a scan that walked ZERO files examined NOTHING, so
      // `unused (0)` is "nothing examined", not "no dead exports". Surfaced as the FIRST data field
      // (verdict-first §12) so it renders loud and on top — an agent must never read a vacuous scan
      // as clean. Gated on scannedFiles===0 REGARDLESS of a filter: a filter is only ONE way to
      // empty the walk (a degenerate `include`, a program covering no source, is another and was the
      // false-clean this gate missed). `scannedExports===0` is deliberately NOT the trigger — real
      // files in scope that export nothing are a finished walk, and flagging them would dress a
      // complete answer as partial, the same lie inverted.
      const filterSet = args.pathInclude !== undefined || args.pathExclude !== undefined;
      const notAVerdict = view.scannedFiles === 0 ? notAVerdictWarning(filterSet) : undefined;
      const data = {
        ...(notAVerdict !== undefined ? { notAVerdict } : {}),
        // `programs:` verdict-first (§12): what the lever loaded / left floored / couldn't find,
        // ahead of the bulk `unused` list.
        ...lever.fields,
        ...(lever.notes.length > 0 ? { notes: lever.notes } : {}),
        unused: view.unused.map((u) => tag('unused-export', u)),
        scanned: { exports: view.scannedExports, files: view.scannedFiles },
        ...(view.computedDynamicImport ? { computedDynamicImport: true } : {}),
        ...(view.undiscoveredPrograms !== undefined
          ? { undiscoveredPrograms: view.undiscoveredPrograms }
          : {}),
        ...(view.truncated !== undefined ? { truncated: view.truncated } : {}),
      };
      // §1 never-hang: the wall-clock budget ran out mid-scan — the `unused` list is a PARTIAL
      // answer (an unexamined export might be dead), so return it as an honest timeout `partial`,
      // never a complete "these are all the dead exports" (§3.4). A clean scan stays `ok`.
      if (view.timedOut === true) {
        const total = view.truncated?.candidates ?? view.scannedExports;
        return partial(data, {
          tool: 'timeout',
          message: `find_unused_exports exceeded its wall-clock budget after ${view.scannedExports} of ${total} candidate export(s) — the list is partial; scope with pathInclude to finish within budget`,
        });
      }
      return ok(data, truncated !== undefined ? { truncated } : undefined);
    } catch (thrown) {
      return failFromThrown('ts', thrown);
    }
  },
});
