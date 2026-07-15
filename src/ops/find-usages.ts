// `find_usages` — semantic references from the live LS, with generic AST-level
// refinements (no domain semantics; the agent supplies the names):
//   role:'jsx'           keep only `<X/>` tag references (or call/type/import/…)
//   groupBy:'enclosing'  roll references up to their nearest enclosing named
//                        declaration — "which components render X" as one call
//   filter               pathExclude/pathInclude globs; encloser kind/exportedOnly
//   symbols:[…]          several targets in one call, sectioned per target
// Caps and filters are explicit (`total`/`excluded`/truncation) — never silent (§3.4).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Result, ToolFailure } from '../core/result.ts';
import { failFromThrown, fail, ok, partial } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { TsPluginApi, TsTargetInput } from '../plugins/ts/plugin.ts';
import type { UsageOptions } from '../plugins/ts/query-types.ts';
import { USAGE_ROLES } from '../plugins/ts/usage-roles.ts';
import { createJsScanner } from '../support/text-search/scan.ts';
import { defineOp } from './registry.ts';
import { withUndiscoveredHint } from './no-symbol-hint.ts';
import { findUsagesTable } from './find-usages-table.ts';
import { TEXT_ONLY_CAP, attachOverlay, overlayFor } from './find-usages-text.ts';
import { memberFallback } from './find-usages-member-fallback.ts';
import {
  targetOfElement,
  rowsShown,
  rowsTotal,
  listableField,
  hoistView,
  usageNotes,
  usagesFloor,
} from './find-usages-view.ts';
import { TS_TARGET_HINT, requireTarget, tsTargetShape, tsTargetIntake } from './ts-target.ts';
import { programsArgShape, applyProgramsLever } from './programs-lever.ts';

const ROW_CAP_HINT = 'raise limit (or in sql-mode the per-call row bound was hit)';

/** Appended to the ambiguous bare-name hard-FAIL to surface the opt-in union (t-262491). Kept as a
 *  constant so the discoverability test pins the exact hint the op advertises. */
const MERGE_DECLS_HINT =
  ' — or pass mergeDeclarations:true to union usages across all same-named declarations (per-site provenance kept)';

const argsSchema = z
  .strictObject({
    ...tsTargetShape,
    /** Several targets by exact name, answered as one sectioned result. */
    symbols: z.array(z.string().min(1)).min(1).max(20).optional(),
    limit: z.number().int().positive().max(2000).optional(),
    role: z.enum(USAGE_ROLES).optional(),
    /** Hide an import once its file also has a real usage (§2.2). Default true; the
     *  count is reported and import-only/re-export files always stay. */
    collapseImports: z.boolean().optional(),
    /** Add textual occurrences (comments/strings/docs) of the name, deduped against the
     *  semantic refs, identity unproven (§ text-overlay). */
    text: z.boolean().optional(),
    /** Union usages across ALL same-named declarations (the interface-decl + host-decl + impl
     *  triplet), instead of failing on the ambiguity. Per-site provenance kept (`usages[].decls`
     *  index into `mergedDeclarations`). Only for a `name` target. */
    mergeDeclarations: z.boolean().optional(),
    groupBy: z.literal('enclosing').optional(),
    ...programsArgShape,
    filter: z
      .strictObject({
        // `.min(1)`: an empty array is a meaningless intent (it would silently narrow to nothing),
        // so it fails fast with a pointed error rather than reading as "no usages" — parity with
        // search_symbol. The shared `passesPathFilter` still treats an empty array as include-all
        // as a defensive backstop for any non-op caller.
        pathExclude: z.array(z.string()).min(1).optional(),
        pathInclude: z.array(z.string()).min(1).optional(),
        /** Encloser kind, grouped mode: function | method | class | const | variable | module. */
        kind: z.string().optional(),
        /** Grouped mode: only exported enclosers. */
        exportedOnly: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((t) => t.symbols !== undefined || requireTarget.predicate(t), {
    message: `${requireTarget.message} — or pass symbols: [names]`,
  });

export const findUsagesOp = defineOp({
  name: 'find_usages',
  summary:
    'Semantic reference sites of symbol(s); role filter (jsx/call/type/import), rollup to enclosing declaration, path filters',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: `${TS_TARGET_HINT} | { symbols: string[] } — plus { limit?, role?: 'jsx'|'call'|'type'|'import'|'reexport'|'read'|'write'|'decl', collapseImports?: boolean (default true), text?: boolean, mergeDeclarations?: boolean, groupBy?: 'enclosing', filter?: {pathExclude?, pathInclude?, kind?, exportedOnly?}, programs?: string[] (extra tsconfig paths to load, to find usages under an undiscovered nested config) }`,
  intake: tsTargetIntake,
  example: {
    args: {
      symbols: ['DialogContent', 'SheetContent'],
      role: 'jsx',
      groupBy: 'enclosing',
      filter: { pathExclude: ['**/ui/**', '**/*.test.*'] },
    },
  },
  notes: [
    'role = what a ref syntactically IS: jsx (<X/> tags, closing deduped) · call · type · import · reexport (barrel `export {X} from` — never collapsed) · read · write · decl.',
    'role:read/write is SYNTACTIC (is the identifier read vs assigned) — it does NOT resolve store-field access: a zustand `useStore(s => s.count)` or a `set(...)` call reads as a `call`, not a read/write of `count`. Use it for variable/binding reads-vs-writes, not store-field tracing.',
    'collapseImports (default true): an import is hidden once its file also has a real usage (count returns as importsCollapsed); import-only files & re-exports always stay. collapseImports:false or role:import to list all. sql-mode keeps every import row.',
    "groupBy:'enclosing' rolls refs up to the nearest enclosing declaration ('which components render <X>'), sorted by count; encloser ids chain into other ops.",
    'filter {pathExclude/pathInclude globs, kind, exportedOnly}: dropped refs are reported as excludedByFilter — a filter never reads as completeness.',
    'symbols:[…] answers several targets in one sectioned call (unresolvable names → unresolved). A role filter matching 0 still prints the full role distribution + the dominant role to try.',
    "deleting a symbol? text:true adds comment/string/doc occurrences of the name, deduped against semantic refs and flagged 'text-only (identity NOT proven)' — role/path filters don't touch the text side.",
    'multi-program (see concepts: cross-program-read): each usage carries the `program` that surfaced it (sql column `program`). HONEST ASYMMETRY — a sibling label (tsconfig.test.json) means present ONLY there; the primary label means present in primary, POSSIBLY elsewhere too. Emitted only when >1 program is loaded.',
    'density (text/json, NOT sql): a column CONSTANT across the listed rows is hoisted to a header and dropped per-row — a single `role` filter → `role=<r>` (read effective role as `row.role ?? role`); the dominant program → `allProgram=<p>` (read `row.program ?? allProgram`). `listable` (collapsed-import count tie) appears ONLY when the rows are truncated. sql-mode keeps every value per row.',
    "mergeDeclarations:true — for an AMBIGUOUS name (the interface-decl + host-decl + impl triplet), union the usages of ALL same-named declarations instead of failing. The merged decls are listed in `mergedDeclarations`; each usage's `decls` indexes into it (per-site provenance — unrelated same-named symbols are never silently conflated). The ambiguous hard-FAIL surfaces this flag.",
    '{name, file} member fallback: when no TOP-LEVEL declaration of `name` lives in `file`, a class/type MEMBER, enum member, or re-exported binding of that name is resolved instead (the resolution is disclosed as a leading note); several such bindings → a pick-list + a member_usages redirect. So a method / type-member / re-export is not a dead-end.',
  ],
  table: findUsagesTable,
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    // sql-mode signal (§2.3): the engine sets tableRowBound only when this op feeds a
    // SQLite table. Import collapse is forced OFF there — the table projects from the
    // UNCOLLAPSED ref set, so "files that import X but don't render it" (NOT IN over the
    // import rows) stays trustworthy (§2.2).
    const sqlMode = ctx.tableRowBound !== undefined;
    const verbosity = ctx.flags.verbosity ?? 'terse';
    const options: UsageOptions = {
      // sql-mode (§2.3): a capped producer feeding a NOT IN lies. The engine threads the
      // SAME MAX_TABLE_ROWS it enforces, so the op caps exactly where the engine would —
      // and reports `truncated` below so the table is marked partial, never silently short.
      limit: ctx.tableRowBound ?? args.limit ?? 200,
      role: args.role,
      collapseImports: sqlMode ? false : (args.collapseImports ?? true),
      groupBy: args.groupBy,
      mergeDeclarations: args.mergeDeclarations,
      pathExclude: args.filter?.pathExclude,
      pathInclude: args.filter?.pathInclude,
      enclosingKind: args.filter?.kind,
      exportedOnly: args.filter?.exportedOnly,
    };
    const scanner = ctx.textScanner ?? createJsScanner();
    const textRoot = ctx.daemon?.root;
    const textCap = sqlMode ? (ctx.tableRowBound ?? TEXT_ONLY_CAP) : TEXT_ONLY_CAP;
    try {
      // Widen the search first (t-228533): a `programs:`-loaded config joins the cross-program fan-out
      // AND drops from the undiscovered floor BEFORE the usages query reads either, so a usage only
      // under an otherwise-undiscovered nested config is found and the LOWER-BOUND floor relaxes.
      // Inside the try so a load throw yields an honest ts-ls failure (parity with the sibling ops).
      const lever = applyProgramsLever(ts, args.programs);
      if (args.symbols !== undefined) {
        // Named once for the per-element absence hint (§3.4): a name that resolves to nothing while a
        // nested tsconfig is unloaded may live there, not be gone. Memoized on the host (§19).
        const undiscovered = ts.undiscoveredProgramLabels();
        const targets: Record<string, JsonValue>[] = [];
        // The bare name each target resolved to (aligned with `targets`), for the text overlay —
        // a SymbolId/position element scans under its RESOLVED name, never the raw addressing string.
        const resolvedNames: (string | undefined)[] = [];
        const unresolved: JsonValue[] = [];
        let shownRows = 0;
        let totalRows = 0;
        for (const sym of args.symbols) {
          // Each element may be a SymbolId / file:line[:col] / bare name (the single-target forms),
          // not only a bare name — so a held handle in the array chains exactly like a single target.
          const element = targetOfElement(sym);
          const fallbackName = element.name;
          const outcome = ts.findUsages(element, options);
          if (typeof outcome === 'string') {
            const reason = withUndiscoveredHint(outcome, undiscovered);
            unresolved.push(tag('unresolved-name', { name: sym, reason }));
            continue;
          }
          if ('unresolved' in outcome) {
            // A held SymbolId element CAN carry a rebind/gone reason; record it in the sectioned
            // `unresolved` list (a bare-name element simply has no handle).
            unresolved.push(tag('unresolved-name', { name: sym, reason: outcome.unresolved }));
            continue;
          }
          const { view } = outcome;
          shownRows += rowsShown(view);
          totalRows += rowsTotal(view);
          const notes = usageNotes(view, args.role, verbosity);
          const hoisted = hoistView(view, args.role, sqlMode);
          if (hoisted.progNote !== undefined) notes.push(hoisted.progNote);
          // §3.4 floor: a non-empty undiscovered set makes this section a LOWER BOUND — the `!!`
          // note leads (verdict-first), the fields ride as early machine-readable keys below.
          const floor = usagesFloor(view);
          if (floor.note !== undefined) notes.unshift(floor.note);
          resolvedNames.push(view.definition?.name ?? fallbackName);
          targets.push({
            symbol: sym,
            ...floor.fields,
            ...(view.definition !== undefined ? { definition: view.definition.id } : {}),
            ...(view.mergedDeclarations !== undefined
              ? { mergedDeclarations: view.mergedDeclarations.map((m) => tag('symbol', m)) }
              : {}),
            ...(hoisted.role !== undefined ? { role: hoisted.role } : {}),
            ...(hoisted.allProgram !== undefined ? { allProgram: hoisted.allProgram } : {}),
            ...(hoisted.groups !== undefined
              ? { enclosers: hoisted.groups.map((g) => tag('group-row', g)) }
              : {}),
            ...(hoisted.usages !== undefined
              ? { usages: hoisted.usages.map((u) => tag('usage', u)) }
              : {}),
            total: view.total,
            ...listableField(view),
            ...(view.excluded > 0 ? { excludedByFilter: view.excluded } : {}),
            ...(view.importsCollapsed !== undefined
              ? { importsCollapsed: view.importsCollapsed }
              : {}),
            ...(view.roleBreakdown !== undefined ? { roleBreakdown: view.roleBreakdown } : {}),
            ...(notes.length > 0 ? { notes } : {}),
          });
        }
        let textFailure: ToolFailure | undefined;
        if (args.text === true) {
          // Scan each target under its RESOLVED name (a SymbolId/position element resolved to a
          // bare name above), not the raw addressing string — a `ts:Foo@…` would scan for nothing.
          const named = targets
            .map((t, i) => ({ t, name: resolvedNames[i] }))
            .filter(
              (x): x is { t: Record<string, JsonValue>; name: string } => x.name !== undefined,
            );
          const entries = named.map((x) => ({ name: x.name, target: { name: x.name } }));
          const { byName, failure } = await overlayFor(ts, scanner, textRoot, textCap, entries);
          textFailure = failure;
          for (const x of named) {
            const tally = attachOverlay(x.t, byName.get(x.name));
            shownRows += tally.shown;
            totalRows += tally.total;
          }
        }
        const data = {
          ...lever.fields,
          ...(lever.notes.length > 0 ? { notes: lever.notes } : {}),
          targets,
          ...(unresolved.length > 0 ? { unresolved } : {}),
        };
        // A capped producer (semantic OR text) feeding NOT IN lies (§2.3) — report the
        // aggregate so sql-batch marks the table partial.
        const truncated =
          totalRows > shownRows
            ? { truncated: { shown: shownRows, total: totalRows, hint: ROW_CAP_HINT } }
            : undefined;
        if (textFailure !== undefined) return partial(data, textFailure);
        return ok(data, truncated);
      }

      let outcome = ts.findUsages(args, options);
      // Member / re-export fallback (t-755152): a bare `name`+`file` that resolves NO top-level
      // declaration is not a dead-end — the name may be a class/type MEMBER or a re-exported binding
      // IN that file. On a unique match, re-issue by position and disclose the resolution (leads the
      // notes below); several → an honest pick-list; none → the original top-level failure stands.
      let memberNote: string | undefined;
      if (typeof outcome === 'string') {
        const fb = memberFallback(ts, args, options);
        if (fb?.kind === 'ambiguous') return fail(fb.failure);
        if (fb?.kind === 'resolved') {
          outcome = fb.outcome;
          memberNote = fb.note;
        }
      }
      if (typeof outcome === 'string') {
        let message = withUndiscoveredHint(outcome, ts.undiscoveredProgramLabels());
        // Discoverability (t-262491): a bare `name` that hard-FAILs on ambiguity has an opt-in
        // union — surface `mergeDeclarations` in the failure so the agent isn't left to grep or
        // re-issue per declaration. SHAPE-gated (bare name, no file/symbolId, merge not already
        // asked) and confirmed by a real >1 same-named count — never a substring match on the
        // message, and never a hint on a plain not-found (merge would not help there).
        if (
          args.name !== undefined &&
          args.symbolId === undefined &&
          args.file === undefined &&
          args.mergeDeclarations !== true &&
          ts.sameNamedDeclarations(args.name).length > 1
        ) {
          message += MERGE_DECLS_HINT;
        }
        return fail({ tool: 'ts-ls', message });
      }
      if ('unresolved' in outcome) {
        // §6: the held handle's symbol is gone — state the structured `{status:'gone'}` on
        // `handle` (empty data), never a guessed rebind to an unrelated same-named symbol.
        return fail({ tool: 'ts-ls', message: outcome.unresolved }, { handle: outcome.rebind });
      }
      const { view, rebind } = outcome;
      let shown = rowsShown(view);
      let total = rowsTotal(view);
      const notes = usageNotes(view, args.role, verbosity);
      // R1 — honest disclosure (§3.6): mergeDeclarations was requested but the target addresses ONE
      // declaration (a SymbolId/position), so it could not apply. Say so instead of silently dropping
      // the flag. (When it DID apply, `view.mergedDeclarations` is present and this never fires.)
      if (args.mergeDeclarations === true && view.mergedDeclarations === undefined) {
        notes.push(
          'mergeDeclarations ignored — a symbol/position target addresses ONE declaration; pass a `name` to union all same-named declarations',
        );
      }
      const hoisted = hoistView(view, args.role, sqlMode);
      if (hoisted.progNote !== undefined) notes.push(hoisted.progNote);
      // §3.4 floor (verdict-first): a non-empty undiscovered set makes the usages a LOWER BOUND.
      // `complete:false` + `undiscoveredPrograms` lead the data object so a count-only consumer
      // reads the incompleteness without parsing prose; the `!!` note leads `notes`.
      const floor = usagesFloor(view);
      if (floor.note !== undefined) notes.unshift(floor.note);
      // `programs:` lever notes lead (before the floor note) — they explain WHY the floor did/not lift.
      for (const n of [...lever.notes].reverse()) notes.unshift(n);
      // The member-fallback resolution note leads all others (t-755152): the agent addressed a name it
      // expected to be top-level and got a member — that reframe comes first, before any floor/lever.
      if (memberNote !== undefined) notes.unshift(memberNote);
      const data: Record<string, JsonValue> = {
        ...lever.fields,
        ...floor.fields,
        ...(view.definition !== undefined ? { definition: tag('symbol', view.definition) } : {}),
        ...(view.mergedDeclarations !== undefined
          ? { mergedDeclarations: view.mergedDeclarations.map((m) => tag('symbol', m)) }
          : {}),
        // Hoisted header columns (role / allProgram) precede the row bulk so the verdict reads first.
        ...(hoisted.role !== undefined ? { role: hoisted.role } : {}),
        ...(hoisted.allProgram !== undefined ? { allProgram: hoisted.allProgram } : {}),
        ...(hoisted.groups !== undefined
          ? { enclosers: hoisted.groups.map((g) => tag('group-row', g)) }
          : {}),
        ...(hoisted.usages !== undefined
          ? { usages: hoisted.usages.map((u) => tag('usage', u)) }
          : {}),
        total: view.total,
        // When imports are collapsed in a FLAT usages list, `total` (raw) exceeds the listed set by
        // exactly `importsCollapsed` — surface `listable` so `total=N` ties to the `usages (M):`
        // header and the truncation's `shown X/Y` (Y = listable), instead of two unexplained totals.
        // Gated to flat mode: in groupBy the listed rows are ENCLOSERS (a different axis), so a
        // usages-based `listable` would tie to nothing — omit it there.
        ...listableField(view),
        ...(view.excluded > 0 ? { excludedByFilter: view.excluded } : {}),
        ...(view.importsCollapsed !== undefined ? { importsCollapsed: view.importsCollapsed } : {}),
        ...(view.roleBreakdown !== undefined ? { roleBreakdown: view.roleBreakdown } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      };
      let textFailure: ToolFailure | undefined;
      if (args.text === true) {
        const name = view.definition?.name ?? args.name;
        const entries = name !== undefined ? [{ name, target: args as TsTargetInput }] : [];
        const { byName, failure } = await overlayFor(ts, scanner, textRoot, textCap, entries);
        textFailure = failure;
        if (name !== undefined) {
          const tally = attachOverlay(data, byName.get(name));
          shown += tally.shown;
          total += tally.total;
        }
      }
      const extras = {
        ...(rebind !== undefined ? { handle: rebind } : {}),
        ...(total > shown ? { truncated: { shown, total, hint: ROW_CAP_HINT } } : {}),
      };
      if (textFailure !== undefined) {
        return partial(data, textFailure, rebind !== undefined ? { handle: rebind } : undefined);
      }
      return ok(data, extras);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
