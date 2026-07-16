// `importers_of` — who imports / re-exports from a module. Generic module-graph
// primitive: "who depends on X" without grepping import strings (aliased specifiers
// resolve through the project's own tsconfig paths).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Result, Truncation } from '../core/result.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { capList } from '../common/truncate/cap-list.ts';
import { nameWithMore } from '../common/truncate/name-with-more.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { lowerBoundNote } from './lower-bound-note.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { ImporterRow, ImportersView } from '../plugins/ts/importers.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';
import { programsArgShape, applyProgramsLever } from './programs-lever.ts';

/** A `Truncation` as an inline `JsonValue` field (the core type carries no index signature, so it
 *  is not assignable to `JsonValue` directly — projected here for the `*Truncated` data fields). */
function truncField(t: Truncation): JsonValue {
  return { shown: t.shown, total: t.total, hint: t.hint };
}

/** §3.4 FLOOR (mirrors `affected` / `find_usages`): repo tsconfigs NOT scanned make the importer
 *  list a LOWER BOUND. Returns the set-level machine-readable verdict (`complete:false` + the named
 *  configs) so a count-only consumer sees incompleteness without parsing prose, plus a `!!` note for
 *  the verdict position. Empty when every loaded program was scanned (the common case adds nothing). */
function importersFloor(view: ImportersView): { fields: Record<string, JsonValue>; note?: string } {
  const u = view.undiscoveredPrograms;
  if (u === undefined || u.length === 0) return { fields: {} };
  return {
    fields: { complete: false, undiscoveredPrograms: u },
    note: lowerBoundNote(u, {
      subject: 'importers',
      noun: 'importer',
      negation: 'that nothing depends on it',
    }),
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

/** SUBTREE-mode result: EXTERNAL importers (own file outside the tree) are the
 *  deletion BLOCKERS — the headline; INTERNAL are counted + kept, non-blocking; UNCONFIRMED refs
 *  are flagged. The `safe` verdict is gated on `blockers===0 ∧ complete ∧ unconfirmed===0` — an
 *  undiscovered config or an unconfirmed ref is a LOWER BOUND, never proof of safety. Verdict scalars
 *  (mode/safe/blockers/complete/counts) + `note` are emitted BEFORE the bulk row arrays, so the §12
 *  char-cap can only trim re-fetchable rows, never the verdict. `blockers` counts distinct external
 *  FILES off the full set (not the capped/`shown` slice), so a truncated list still reports it true. */
function subtreeResult(
  view: ImportersView,
  limit: number,
  lever: { fields: Record<string, JsonValue>; notes: string[] },
): Result<JsonValue> {
  const external = view.external ?? [];
  const internal = view.internal ?? [];
  const unconfirmed = view.unconfirmed ?? [];
  const undiscovered = view.undiscoveredPrograms ?? [];
  const complete = undiscovered.length === 0;
  const blockers = new Set(external.map((r) => fileOf(r.at))).size;
  const safe = blockers === 0 && complete && unconfirmed.length === 0;

  // Every capped array co-produces its own §3.4 {shown,total,hint} (t-145509): `external` (the
  // blocker list) rides the envelope `truncated`; `internal`/`unconfirmed` carry their own inline
  // `*Truncated` field, placed with the verdict scalars BEFORE the row bulk so the §12 char-cap can
  // only ever trim a re-fetchable row, never a truncation channel. `blockers`/`safe` read the FULL
  // external set (below), so a capped list never weakens the verdict.
  const ext = capList(
    external,
    limit,
    "raise limit, or project with sql (SELECT … WHERE scope = 'external')",
  );
  const int = capList(
    internal,
    limit,
    "raise limit, or project with sql (SELECT … WHERE scope = 'internal')",
  );
  const unc = capList(
    unconfirmed,
    limit,
    "raise limit, or project with sql (SELECT … WHERE confidence = 'unconfirmed')",
  );

  const baseNote = subtreeNote(
    safe,
    blockers,
    complete,
    unconfirmed.length,
    undiscovered,
    internal.length,
  );
  return ok(
    {
      mode: 'subtree',
      subtree: view.subtree ?? view.module,
      // `programs:` verdict-first (§12) — what the lever loaded / left floored precedes the row bulk.
      ...lever.fields,
      safe,
      blockers,
      complete,
      internalCount: internal.length,
      unconfirmedCount: unconfirmed.length,
      ...(int.truncation !== undefined ? { internalTruncated: truncField(int.truncation) } : {}),
      ...(unc.truncation !== undefined ? { unconfirmedTruncated: truncField(unc.truncation) } : {}),
      ...(undiscovered.length > 0 ? { undiscoveredPrograms: undiscovered } : {}),
      note: [baseNote, ...lever.notes].join(' '),
      external: ext.shown.map((r) => tag('subtree-importer', r)),
      internal: int.shown.map((r) => tag('subtree-importer', r)),
      unconfirmed: unc.shown.map((r) => tag('subtree-unconfirmed', r)),
    },
    ext.truncation !== undefined ? { truncated: ext.truncation } : undefined,
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
    // Affirmative safe must disclose the scan's limit: only STATIC import/export are traced (a
    // dynamic `import()`/`require()` is invisible — inherited from importersOf, cf. affected.ts).
    return `SAFE to delete — 0 external importers, all repo programs scanned, 0 unconfirmed refs. ${internal} internal importer(s) move/delete with the tree. CAVEAT: static import/export only — a dynamic import()/require() of a file under the tree is NOT traced.`;
  }
  const parts: string[] = [];
  if (blockers > 0) parts.push(`${blockers} EXTERNAL importer file(s) block deletion`);
  if (unconfirmed > 0) {
    parts.push(
      `${unconfirmed} UNCONFIRMED ref(s) lexically under the tree (e.g. .scss / unresolvable spec) — verify by hand`,
    );
  }
  if (!complete) {
    parts.push(
      `!! LOWER BOUND — ${undiscovered.length} repo tsconfig(s) NOT scanned (${nameWithMore(undiscovered, 3)}); an external importer ONLY there is unseen`,
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
  ...programsArgShape,
});

export const importersOfOp = defineOp({
  name: 'importers_of',
  summary:
    'Files that import or re-export from a module — or, for a DIRECTORY arg, who imports under that subtree ("safe to delete this folder?") (tsconfig-paths aware)',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint:
    "{ module: string, limit?: number, programs?: string[] (extra tsconfig paths to load, to widen the importer search over an undiscovered nested config) } — a file (module mode) OR a directory (subtree mode: 'who imports under this folder')",
  // `moduleTarget` — a `query`/`name` (symbol-name spelling) hard-rejects with a pointed steer
  // (§3.6): a symbol name never resolves to a module PATH, so aliasing it would silently return
  // "0 importers". Declared here beside the aliases, not in a central table (t-138266).
  intake: { aliases: { path: 'module', file: 'module' }, moduleTarget: true },
  example: { args: { module: '@/components/ui/dialog' } },
  notes: [
    'module = a repo-relative path or any import specifier the project uses (@/… aliases resolve via tsconfig paths); catches re-exports, not just direct imports.',
    'importers are found across ALL loaded programs (a `test/**` importer under a sibling tsconfig too) — see concepts: cross-program-read.',
    'the result carries `resolved`: `false` means the specifier did NOT resolve to a file (a typo / out-of-project path) — a `0` there is a bad arg, said LOUDLY (`module unresolved`), distinct from an honest resolved-0. §3.6.',
    "DIRECTORY arg (e.g. 'src/plugins/ts', or a trailing slash) ⇒ SUBTREE mode — answers 'safe to delete this folder?': EXTERNAL importers (file outside the tree) are the blockers (`blockers` count), INTERNAL ones (file inside) are counted+kept but non-blocking, and an unresolvable spec lexically under the tree is FLAGGED `unconfirmed` (never raw-matched). `safe` is true ONLY when blockers=0 ∧ all programs scanned (complete) ∧ unconfirmed=0. directory-wins on a dir/file name collision; pass `foo.ts` to target the file.",
  ],
  table: importersOfTable,
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      // Widen the search first (t-228533) — a `programs:`-loaded config joins the fan-out + drops from
      // the floor BEFORE `importersOf` reads it, so an importer only under a nested config is found.
      const lever = applyProgramsLever(ts, args.programs);
      const view = ts.importersOf(args.module);
      if (view.mode === 'subtree') {
        return subtreeResult(view, ctx.tableRowBound ?? args.limit ?? DEFAULT_LIMIT, lever);
      }
      const floor = importersFloor(view);
      // §3.6 honesty: a specifier that did NOT resolve to a file is a distinct answer from an honest
      // resolved-0 — a `0` under it is almost certainly a typo'd/out-of-project arg, not proof
      // nothing depends on the module. Surfaced explicitly (verdict-first) so it never reads as a
      // silent resolved-0. `resolved` is `false` only in module mode (subtree never reaches here).
      const unresolved = view.resolved === false;
      if (view.total === 0) {
        // Three zero cases, kept distinct: a DEGENERATE primary that ALSO left the arg UNRESOLVED (the
        // program covers no files — the non-resolution is the config's fault, not the arg's, t-784222),
        // an UNRESOLVED specifier (loud non-resolution), or a genuinely RESOLVED module nothing imports.
        // The empty-program note is gated on `unresolved`: `resolveModuleArg` resolves via
        // `ts.sys.fileExists` INDEPENDENT of the primary's file set, so an existing-file arg is
        // `resolved:true` even under an empty primary — the "this is why X did not resolve" note would
        // then contradict the `resolved:true` field it ships beside (a self-lie). A resolved-0 under an
        // empty primary falls through to the honest "0 importers" (the undiscovered floor, orthogonal,
        // still caveats it a LOWER BOUND). The undiscovered-config floor coexists with any of the three.
        const zeroNote =
          view.emptyProgram === true && unresolved
            ? `primary program covers no files: the project's tsconfig resolved 0 source files (a broken or empty \`include\`, or nothing built) — this is why '${view.module}' did not resolve, NOT the arg form. Fix the tsconfig include/config, or target a package with its own tsconfig via root:<pkg-dir>.`
            : unresolved
              ? `module unresolved: ${view.module} — the specifier did not resolve to a file under the project (importers, if any, would be literal-string matches). Pass a repo-relative path or an import specifier the project uses (e.g. '@/x').`
              : (floor.note ??
                `module resolved: ${view.module} — 0 importers (nothing imports or re-exports it).`);
        return ok({
          ...lever.fields,
          ...floor.fields,
          resolved: view.resolved ?? true,
          module: view.module,
          importers: [],
          note: [
            zeroNote,
            // A resolved-0 riding the plain "0 importers" note still owes the floor caveat if a
            // config is undiscovered; the unresolved note leads, floor follows.
            ...(unresolved && floor.note !== undefined ? [floor.note] : []),
            ...lever.notes,
          ].join(' '),
        });
      }
      // sql-mode (§2.3/§11): a capped producer feeding a NOT IN / a positive WHERE lies. The engine
      // threads MAX_TABLE_ROWS as `tableRowBound` so the op caps exactly where the engine would —
      // uncapped for sql; `total > shown.length` below still reports truncation, marking it partial.
      const limit = ctx.tableRowBound ?? args.limit ?? DEFAULT_LIMIT;
      const capped = capList(
        view.importers,
        limit,
        'raise limit, or scope by importing dir with sql (SELECT … WHERE file LIKE …)',
      );
      const shown = capped.shown;
      const truncated = capped.truncation;
      // An UNRESOLVED specifier that still has importers matched them by LITERAL string (a `.scss`
      // path, a package spec the TS resolver doesn't map to a file) — say so, since the match is
      // weaker than a resolved-module identity match (§3 honesty). Resolved matches add no note.
      const unresolvedNote = unresolved
        ? [
            `module unresolved: ${view.module} — the specifier did not resolve to a file; the importer(s) below are LITERAL-string matches on the specifier, not module-identity matches. Pass a repo-relative path or a tsconfig alias for a resolved-identity result.`,
          ]
        : [];
      const moduleNotes = [
        ...unresolvedNote,
        ...(floor.note !== undefined ? [floor.note] : []),
        ...lever.notes,
      ];
      return ok(
        {
          ...lever.fields,
          ...floor.fields,
          resolved: view.resolved ?? true,
          ...(moduleNotes.length > 0 ? { notes: moduleNotes } : {}),
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
