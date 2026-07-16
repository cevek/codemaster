// `find_unused_exports` — the read op for dead TS exports (§5-L3): locally-declared exports
// with no importer/usage anywhere, proven through the live LS. A thin pass-through to the ts
// plugin's `unusedExports` (the op IS the surface; the join logic — references, demotion —
// lives in the plugin, §5-L2). MIRRORS `find_unused_scss_classes`/`find_unused_i18n_keys`:
// a barrel-/`export *`-/dynamic-`import()`-reached export is `partial`, never `certain` dead.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { nameWithMore } from '../common/truncate/name-with-more.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { Truncation } from '../core/result.ts';
import type { TsPluginApi, UnusedExportView } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';
import { programsArgShape, applyProgramsLever } from './programs-lever.ts';

/** Shown (as the first data field + an sql note) when a pathInclude/pathExclude matched no
 *  files: the scan examined nothing, so `unused (0)` is NOT proof that no exports are dead. */
const FILTER_NO_FILES_WARNING =
  'pathInclude/pathExclude matched 0 files — nothing was examined; this is NOT proof that no exports are dead. Check your path(s)/glob(s) against actual file paths.';

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
    // The vacuous-filter warning (§3.4/§3.6) is an honesty channel, so it must reach the
    // sql/table render too — sourced from the same data field the dense render shows, never
    // a re-derived string.
    const warn = (data as { filterMatchedNoFiles?: string }).filterMatchedNoFiles;
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
    ...programsArgShape,
  }),
  argsHint:
    '{ pathInclude?: string[], pathExclude?: string[], limit?: number, programs?: string[] (extra tsconfig paths to load, to recover certain verdicts over an undiscovered nested config) }',
  example: { args: { pathInclude: ['src/features/**'] } },
  notes: [
    'semantic, not textual: an aliased `import { X as Y }` (which text-grep would miss) still counts X as used, so X is never falsely reported.',
    'an export reached only via a barrel re-export (`export { X } from`), an `export *`, or a dynamic `import()` demotes to partial — flagged "could not prove dead", never reported as definitely unused.',
    'an entry-point or public-API export (an `index.ts`/`bin.ts` with no in-repo importer) legitimately has no usage and WILL appear here — verify before deleting. There is no entry-point config yet.',
    'an export used only WITHIN its own module (never imported) is NOT reported — it has a usage; this finds dead exports, not redundant `export` keywords.',
    'usage is observed across ALL loaded programs (see concepts: cross-program-read) — an export used only from a `test/**` file is SEEN as used (not falsely reported); a genuinely-dead export reads `certain` again.',
    'honest floor for the UNDISCOVERED case: a nested-package tsconfig that is neither adjacent to the main config nor `references`d is NOT loaded as a program, so an export used only from it cannot be proven dead. When any such config exists, every otherwise-`certain` claim is demoted to `partial` and the config is NAMED in the result note — never a silent false-`certain`-dead.',
    'bounded: scoped by pathInclude/pathExclude (globs over the declaration file) and hard-capped at the NUMBER of reference searches (default 200, override with limit) — the cap is reported as truncation. Each examined export costs one LS reference search (O(import-graph)), so on a very large repo scope with pathInclude. Usage discovery still scans the whole program, so scoping never invents a false dead.',
  ],
  table: findUnusedExportsTable,
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      // Widen the search first (t-228533): a `programs:`-loaded config is searched + subtracted from
      // the undiscovered floor BEFORE `unusedExports` reads that floor, so a genuinely-dead export
      // reads `certain` again over an otherwise-floored nested config. A partial-coverage config stays
      // floored — disclosed, never a false lift.
      const lever = applyProgramsLever(ts, args.programs);
      const view = ts.unusedExports({
        ...(args.pathInclude !== undefined ? { pathInclude: args.pathInclude } : {}),
        ...(args.pathExclude !== undefined ? { pathExclude: args.pathExclude } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      const truncated: Truncation | undefined =
        view.truncated !== undefined
          ? {
              shown: view.truncated.examined,
              total: view.truncated.candidates,
              hint: 'narrow with pathInclude / pathExclude, or raise limit, to examine the rest',
            }
          : undefined;
      // False-clean guard (§3.4/§3.6): a pathInclude/pathExclude that matched ZERO files scanned
      // NOTHING, so `unused (0)` is "nothing examined", not "no dead exports". Surfaced as the
      // FIRST data field (verdict-first §12) so it renders loud and on top — an agent must never
      // read a vacuous scan as clean. Gated on a filter being set AND scannedFiles===0:
      // scannedExports===0 alone is legitimate (real files in scope that export nothing), so it
      // would false-warn; scannedFiles===0 uniquely means the glob/path matched no file. An
      // honest whole-repo zero (no filter set) is never flagged.
      const filterSet = args.pathInclude !== undefined || args.pathExclude !== undefined;
      const filterMatchedNoFiles =
        filterSet && view.scannedFiles === 0 ? FILTER_NO_FILES_WARNING : undefined;
      return ok(
        {
          ...(filterMatchedNoFiles !== undefined ? { filterMatchedNoFiles } : {}),
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
        },
        truncated !== undefined ? { truncated } : undefined,
      );
    } catch (thrown) {
      return failFromThrown('ts', thrown);
    }
  },
});
