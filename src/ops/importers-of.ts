// `importers_of` — who imports / re-exports from a module. Generic module-graph
// primitive: "who depends on X" without grepping import strings (aliased specifiers
// resolve through the project's own tsconfig paths).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Result, Truncation } from '../core/result.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { ImporterRow, ImportersView } from '../plugins/ts/importers.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

/** §3.4 FLOOR (mirrors `affected` / `find_usages`): repo tsconfigs NOT scanned make the importer
 *  list a LOWER BOUND. Returns the set-level machine-readable verdict (`complete:false` + the named
 *  configs) so a count-only consumer sees incompleteness without parsing prose, plus a `!!` note for
 *  the verdict position. Empty when every loaded program was scanned (the common case adds nothing). */
function importersFloor(view: ImportersView): { fields: Record<string, JsonValue>; note?: string } {
  const u = view.undiscoveredPrograms;
  if (u === undefined || u.length === 0) return { fields: {} };
  const named = u.slice(0, 3).join(', ');
  const more = u.length > 3 ? `, +${u.length - 3} more` : '';
  return {
    fields: { complete: false, undiscoveredPrograms: u },
    note: `!! LOWER BOUND — ${u.length} repo tsconfig(s) NOT loaded as programs (${named}${more}); importers under them were NOT scanned. A module imported ONLY there reads as fewer/zero importers here — do NOT treat a low/zero count as proof nothing depends on it. Load/reference the config to recover a complete list.`,
  };
}

/** Project importer rows (§3). `at` is the op's own stable `file:line` field — split on
 *  the last colon (repo-relative POSIX paths never contain one). Import edges read off
 *  the resolved module graph are structural ⇒ `confidence` is `certain`. */
/** Split an `at` (`file:line`) — repo-relative POSIX paths never contain a colon, so the LAST one
 *  is the line separator. */
function fileOf(at: string): string {
  const sep = at.lastIndexOf(':');
  return sep > 0 ? at.slice(0, sep) : at;
}
function lineOf(at: string): number | null {
  const sep = at.lastIndexOf(':');
  const n = sep > 0 ? Number(at.slice(sep + 1)) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

const importersOfTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'module', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'imports', type: 'text' },
    // SUBTREE mode: `scope` (external=blocker / internal) + per-row `target` (the file under the
    // tree this importer pulls); both null in module mode. Additive — module-mode SELECTs unaffected.
    { name: 'scope', type: 'text' },
    { name: 'target', type: 'text' },
    { name: 'confidence', type: 'text' },
  ],
  rows(data) {
    const view = data as {
      mode?: string;
      module?: string;
      subtree?: string;
      importers?: ImporterRow[];
      external?: ImporterRow[];
      internal?: ImporterRow[];
    };
    if (view.mode === 'subtree') {
      const dir = view.subtree ?? null;
      return [...(view.external ?? []), ...(view.internal ?? [])].map((r): readonly Cell[] => [
        dir,
        fileOf(r.at),
        lineOf(r.at),
        r.imports,
        r.scope ?? null,
        r.target ?? null,
        'certain',
      ]);
    }
    const module = view.module ?? null;
    return (view.importers ?? []).map((r): readonly Cell[] => [
      module,
      fileOf(r.at),
      lineOf(r.at),
      r.imports,
      null,
      null,
      'certain',
    ]);
  },
};

const DEFAULT_LIMIT = 200;

/** SUBTREE-mode result (§fork3/4/5): EXTERNAL importers (own file outside the tree) are the
 *  deletion BLOCKERS — the headline; INTERNAL are counted + kept, non-blocking; UNCONFIRMED refs
 *  are flagged. The `safe` verdict is gated on `blockers===0 ∧ complete ∧ unconfirmed===0` — an
 *  undiscovered config or an unconfirmed ref is a LOWER BOUND, never proof of safety. Verdict scalars
 *  (mode/safe/blockers/complete/counts) + `note` are emitted BEFORE the bulk row arrays, so the §12
 *  char-cap can only trim re-fetchable rows, never the verdict. `blockers` counts distinct external
 *  FILES off the full set (not the capped/`shown` slice), so a truncated list still reports it true. */
function subtreeResult(view: ImportersView, limit: number): Result<JsonValue> {
  const external = view.external ?? [];
  const internal = view.internal ?? [];
  const unconfirmed = view.unconfirmed ?? [];
  const undiscovered = view.undiscoveredPrograms ?? [];
  const complete = undiscovered.length === 0;
  const blockers = new Set(external.map((r) => fileOf(r.at))).size;
  const safe = blockers === 0 && complete && unconfirmed.length === 0;

  const shownExternal = external.slice(0, limit);
  const truncated: Truncation | undefined =
    external.length > shownExternal.length
      ? {
          shown: shownExternal.length,
          total: external.length,
          hint: "raise limit, or project with sql (SELECT … WHERE scope = 'external')",
        }
      : undefined;

  return ok(
    {
      mode: 'subtree',
      subtree: view.subtree ?? view.module,
      safe,
      blockers,
      complete,
      internalCount: internal.length,
      unconfirmedCount: unconfirmed.length,
      ...(undiscovered.length > 0 ? { undiscoveredPrograms: undiscovered } : {}),
      note: subtreeNote(
        safe,
        blockers,
        complete,
        unconfirmed.length,
        undiscovered,
        internal.length,
      ),
      // `internal`/`unconfirmed` rows are capped too, but the `Truncation` envelope points only at
      // `external` (the blocker list). The full counts (`internalCount`/`unconfirmedCount`) carry the
      // truth, so a capped array is never silently complete; neither list feeds the safety verdict.
      external: shownExternal.map((r) => tag('subtree-importer', r)),
      internal: internal.slice(0, limit).map((r) => tag('subtree-importer', r)),
      unconfirmed: unconfirmed.slice(0, limit).map((r) => tag('subtree-unconfirmed', r)),
    },
    truncated !== undefined ? { truncated } : undefined,
  );
}

function subtreeNote(
  safe: boolean,
  blockers: number,
  complete: boolean,
  unconfirmed: number,
  undiscovered: readonly string[],
  internal: number,
): string {
  if (safe) {
    return `SAFE to delete — 0 external importers, all repo programs scanned, 0 unconfirmed refs. ${internal} internal importer(s) move/delete with the tree.`;
  }
  const parts: string[] = [];
  if (blockers > 0) parts.push(`${blockers} EXTERNAL importer file(s) block deletion`);
  if (unconfirmed > 0) {
    parts.push(
      `${unconfirmed} UNCONFIRMED ref(s) lexically under the tree (e.g. .scss / unresolvable spec) — verify by hand`,
    );
  }
  if (!complete) {
    const named = undiscovered.slice(0, 3).join(', ');
    const more = undiscovered.length > 3 ? `, +${undiscovered.length - 3} more` : '';
    parts.push(
      `!! LOWER BOUND — ${undiscovered.length} repo tsconfig(s) NOT scanned (${named}${more}); an external importer ONLY there is unseen`,
    );
  }
  return `NOT safe to delete: ${parts.join('; ')}.`;
}

const argsSchema = z.strictObject({
  /** Repo-relative path ('src/components/ui/dialog.tsx') or any import specifier the project
   *  itself would use ('@/components/ui/dialog'). A DIRECTORY ('src/plugins/ts', or a trailing
   *  slash) switches to SUBTREE mode: who imports ANYTHING under that folder — the
   *  "safe to delete this folder?" question. */
  module: z.string().min(1),
  /** Max importer rows to list (default 200); overflow is reported as truncation, never silent. */
  limit: z.number().int().positive().optional(),
});

export const importersOfOp = defineOp({
  name: 'importers_of',
  summary: 'Files that import or re-export from a module (tsconfig-paths aware)',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint:
    "{ module: string, limit?: number } — a file (module mode) OR a directory (subtree mode: 'who imports under this folder')",
  intake: { aliases: { path: 'module', file: 'module' } },
  example: { args: { module: '@/components/ui/dialog' } },
  notes: [
    'module = a repo-relative path or any import specifier the project uses (@/… aliases resolve via tsconfig paths); catches re-exports, not just direct imports.',
    'importers are found across ALL loaded programs (a `test/**` importer under a sibling tsconfig too) — see concepts: cross-program-read.',
    "DIRECTORY arg (e.g. 'src/plugins/ts', or a trailing slash) ⇒ SUBTREE mode — answers 'safe to delete this folder?': EXTERNAL importers (file outside the tree) are the blockers (`blockers` count), INTERNAL ones (file inside) are counted+kept but non-blocking, and an unresolvable spec lexically under the tree is FLAGGED `unconfirmed` (never raw-matched). `safe` is true ONLY when blockers=0 ∧ all programs scanned (complete) ∧ unconfirmed=0. directory-wins on a dir/file name collision; pass `foo.ts` to target the file.",
  ],
  table: importersOfTable,
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      const view = ts.importersOf(args.module);
      if (view.mode === 'subtree') {
        return subtreeResult(view, ctx.tableRowBound ?? args.limit ?? DEFAULT_LIMIT);
      }
      const floor = importersFloor(view);
      if (view.total === 0) {
        // The false-`0` case: with an undiscovered config present, "no importers" is a LOWER BOUND,
        // not proof. Lead with the `!!` floor note + the machine-readable verdict; otherwise keep
        // the plain "check the specifier" hint.
        return ok({
          ...floor.fields,
          module: view.module,
          importers: [],
          note:
            floor.note ??
            'no importers found — check the specifier (path or alias) against tsconfig',
        });
      }
      // sql-mode (§2.3/§11): a capped producer feeding a NOT IN / a positive WHERE lies. The engine
      // threads MAX_TABLE_ROWS as `tableRowBound` so the op caps exactly where the engine would —
      // uncapped for sql; `total > shown.length` below still reports truncation, marking it partial.
      const limit = ctx.tableRowBound ?? args.limit ?? DEFAULT_LIMIT;
      const shown = view.importers.slice(0, limit);
      const truncated: Truncation | undefined =
        view.total > shown.length
          ? {
              shown: shown.length,
              total: view.total,
              hint: 'raise limit, or scope by importing dir with sql (SELECT … WHERE file LIKE …)',
            }
          : undefined;
      return ok(
        {
          ...floor.fields,
          ...(floor.note !== undefined ? { notes: [floor.note] } : {}),
          module: view.module,
          importers: shown.map((r) => tag('importer', r)),
          total: view.total,
        },
        truncated !== undefined ? { truncated } : undefined,
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
