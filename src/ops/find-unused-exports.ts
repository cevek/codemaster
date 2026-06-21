// `find_unused_exports` — the read op for dead TS exports (§5-L3): locally-declared exports
// with no importer/usage anywhere, proven through the live LS. A thin pass-through to the ts
// plugin's `unusedExports` (the op IS the surface; the join logic — references, demotion —
// lives in the plugin, §5-L2). MIRRORS `find_unused_scss_classes`/`find_unused_i18n_keys`:
// a barrel-/`export *`-/dynamic-`import()`-reached export is `partial`, never `certain` dead.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { Truncation } from '../core/result.ts';
import type { TsPluginApi, UnusedExportView } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

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
      const named = u.slice(0, 3).join(', ');
      const more = u.length > 3 ? `, +${u.length - 3} more` : '';
      out.push(
        `repo has ${u.length} tsconfig(s) NOT loaded as a program (${named}${more}) — a nested-package config neither adjacent to the main config nor \`references\`d. Every otherwise-certain claim here is demoted to partial (that program may use the export); load/reference it to recover certain verdicts.`,
      );
    }
    const t = (data as { truncated?: { examined: number; candidates: number } }).truncated;
    if (t !== undefined) {
      out.push(
        `examined ${t.examined} of ${t.candidates} candidate exports (cap hit) — narrow with pathInclude to cover the rest.`,
      );
    }
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
  }),
  argsHint: '{ pathInclude?: string[], pathExclude?: string[], limit?: number }',
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
      return ok(
        {
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
