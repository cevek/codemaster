// `affected` — changed files → the TESTS that must re-run, via the `ts` import graph
// (read-only, §17 Phase 5). Transitive reverse reachability: each changed file → all its
// transitive importers (BFS over `ts.importersOf`) → projected to the test files among
// them, plus the changed files that are themselves tests. Composed at the op level over the
// ts plugin's public API; adds no plugin capability (§5-L3), reuses `impact-closure`'s
// bounded BFS (no second traversal).
//
// Honesty (UNDER-report is the fatal direction here — a missed test = a silent skip = a bug
// ships): the affected set is reported COMPLETE only when nothing blocked the trace — no
// closure cap, no DELETED changed file (its former importers cannot be traced from the
// post-change tree), no UNTRACED changed file (a non-TS asset/config outside the import
// graph). Any of those → `complete:false` and a `!!` note steering the consumer to run the
// full suite; the listed set is an honest LOWER BOUND, never dressed as exhaustive. The
// test-file heuristic is a path-glob convention, STATED in the output, never proven.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import type { Result } from '../core/result.ts';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { isOk } from '../common/result/narrow.ts';
import { matchesAnyGlob } from '../common/glob/match.ts';
import { brandGitPath } from '../support/fs/canonicalize.ts';
import { fileExists } from '../support/fs/exists.ts';
import { gitStatus } from '../support/git/status.ts';
import { gitDiffAgainst } from '../support/git/diff-against.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { GroupRow } from '../plugins/ts/query-types.ts';
import type { ImportersView } from '../plugins/ts/importers.ts';
import { defineOp } from './registry.ts';
import { semanticFanoutRefusal } from './guard/semantic-fanout-guard.ts';
import { buildClosure, type ClosureResult, type Expand } from './impact-closure.ts';

const DEFAULT_DEPTH = 25;
const MAX_DEPTH = 50;
const DEFAULT_NODES = 1000;
const MAX_NODES = 5000;

/** The default test-file convention (path globs). STATED in the output as a heuristic — a
 *  project with a different layout overrides it via `testGlobs`. */
const DEFAULT_TEST_GLOBS = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.spec.js',
  '**/*.spec.jsx',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
];

/** The BFS super-seed id — primed into the closure's visited-set, so it must not collide
 *  with a real module node. A NUL byte cannot occur in a repo-relative path (git uses NUL
 *  as its own field separator), so an importer file (always a real `ImporterRow.at` path)
 *  can never equal it. Built via String.fromCharCode(0) so the source carries no literal NUL byte. */
const SEED_ID = String.fromCharCode(0) + 'affected-seed';

const argsSchema = z.strictObject({
  /** Diff base: a ref/branch/commit (e.g. `main`, `HEAD~3`). Omitted → the working-tree
   *  change set (uncommitted + untracked vs HEAD). Two-dot (ref→working tree), NOT
   *  merge-base. Ignored when `files` is given. */
  since: z.string().min(1).optional(),
  /** An explicit changed set (repo-relative paths) — bypasses git entirely. For composing
   *  `affected` onto a change set computed elsewhere, and for hermetic tests. */
  files: z.array(z.string().min(1)).optional(),
  /** Transitive depth to walk (default 25). The node cap is the harder never-hang bound;
   *  depth defaults high because a missed test (under-report) is the fatal direction. */
  depth: z.number().int().min(1).max(MAX_DEPTH).optional(),
  /** Global cap on total importer nodes across all depths (default 1000). The true
   *  never-hang guard: total LS work is `nodes × importersOf`. */
  nodes: z.number().int().min(1).max(MAX_NODES).optional(),
  /** Override the test-file path globs (the stated heuristic). */
  testGlobs: z.array(z.string().min(1)).optional(),
  /** Bypass the in-process semantic-fanout size guard (t-411303) and warm anyway. */
  force: z.boolean().optional(),
});

type AffectedArgs = z.infer<typeof argsSchema>;

/** A module node for the closure — synthetic GroupRow kept INTERNAL (never reaches the
 *  renderer, which matches GroupRow by key-set — query-types.ts:83). `roles:'import'` keeps
 *  the closure's value-flow / dynamic-boundary logic inert; importersOf is uncapped so
 *  `groupTotal === enclosers.length` (no hub truncation), and a module always re-expands
 *  (no `unexpandable`). Only `id`/`name`/`roles`/`file` are read back out. */
function moduleNode(file: string): GroupRow {
  return {
    id: file,
    name: file,
    file: file as RepoRelPath,
    line: 1,
    col: 1,
    kind: 'module',
    count: 0,
    roles: 'import',
    exported: false,
    confidence: 'certain',
  };
}

/** The importer file of one row — `ImporterRow.at` is `file:line` (repo-relative POSIX
 *  paths never contain a colon), split on the last colon. */
function importerFile(at: string): string {
  const sep = at.lastIndexOf(':');
  return sep > 0 ? at.slice(0, sep) : at;
}

interface ChangeSet {
  mode: string;
  files: readonly RepoRelPath[];
  traced: RepoRelPath[];
  untraced: RepoRelPath[];
  deleted: RepoRelPath[];
}

/** Resolve the changed set + its mode label from the args (explicit / since-ref / dirty
 *  working tree), then classify each file: traced (a TS file in some program → walkable),
 *  untraced (on disk but outside the TS graph — a non-TS asset/config), or deleted (gone
 *  from disk — its former importers cannot be traced from the post-change tree). */
async function changeSet(
  root: string,
  args: AffectedArgs,
  programFiles: ReadonlySet<string>,
): Promise<Result<ChangeSet>> {
  let raw: readonly string[];
  let mode: string;
  if (args.files !== undefined) {
    raw = args.files;
    mode = 'files (explicit)';
  } else if (args.since !== undefined) {
    const r = await gitDiffAgainst(root, args.since);
    if (!isOk(r)) return fail(r.failure);
    raw = r.data;
    mode = `since ${args.since} (two-dot ref→working-tree, incl. uncommitted + untracked)`;
  } else {
    const r = await gitStatus(root);
    if (!isOk(r)) return fail(r.failure);
    raw = r.data.dirtyPaths;
    mode = 'working tree vs HEAD (uncommitted + untracked)';
  }
  const files = raw.map(brandGitPath);
  const traced: RepoRelPath[] = [];
  const untraced: RepoRelPath[] = [];
  const deleted: RepoRelPath[] = [];
  for (const f of files) {
    if (programFiles.has(f)) traced.push(f);
    else if (fileExists(root, f)) untraced.push(f);
    else deleted.push(f);
  }
  return ok({ mode, files, traced, untraced, deleted });
}

/** Build the bounded transitive-importer closure of the traced changed files, via one BFS
 *  whose super-seed fans out to every changed file's importers (one global node budget + one
 *  visited-set). The SEED fan-out is itself bounded by the node budget: `importersOf` is an
 *  un-memoized O(files) scan, so without a stop a huge change set would do O(changed × repo)
 *  work BEFORE buildClosure's own per-add cap ever runs — the seed loop therefore stops
 *  accumulating (and scanning) at the budget and signals the truncation (→ `hubTruncated`,
 *  reported incomplete), never a silent drop. A per-source `importersOf` that THROWS degrades
 *  that one module to a leaf, recorded in `failed` (§3.4/§3.6). */
function importerClosure(
  ts: TsPluginApi,
  traced: readonly string[],
  depth: number,
  nodes: number,
): { closure: ClosureResult; failed: string[] } {
  const failed: string[] = [];
  const expand: Expand = (id) => {
    const isSeed = id === SEED_ID;
    const sources = isSeed ? traced : [id];
    const byFile = new Map<string, GroupRow>();
    for (const src of sources) {
      // Bound the seed's changed-file fan-out by the node budget — stop scanning once full.
      if (isSeed && byFile.size >= nodes) break;
      let view: ImportersView;
      try {
        view = ts.importersOf(src);
      } catch {
        failed.push(src);
        continue;
      }
      for (const imp of view.importers) {
        if (isSeed && byFile.size >= nodes) break;
        const file = importerFile(imp.at);
        if (file === id || byFile.has(file)) continue;
        byFile.set(file, moduleNode(file));
      }
    }
    const enclosers = [...byFile.values()];
    // A truncated seed fan-out → `groupTotal > enclosers.length`, the signal buildClosure
    // turns into `hubTruncated`; the op reports the closure incomplete on it.
    const truncated = isSeed && byFile.size >= nodes;
    return {
      ok: true,
      enclosers,
      groupTotal: truncated ? enclosers.length + 1 : enclosers.length,
      callableNatured: false,
    };
  };
  const closure = buildClosure({ id: SEED_ID, name: SEED_ID }, expand, {
    maxDepth: depth,
    maxNodes: nodes,
  });
  return { closure, failed };
}

export const affectedOp = defineOp({
  name: 'affected',
  summary:
    'Changed files → the tests that must re-run (transitive importers via the ts import graph), proof-carrying, completeness-honest',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: `{ since?: string (ref; default = working tree vs HEAD), files?: string[], depth?: 1-${MAX_DEPTH} (default ${DEFAULT_DEPTH}), nodes?: 1-${MAX_NODES} (default ${DEFAULT_NODES}), testGlobs?: string[] }`,
  example: { args: { since: 'main' } },
  notes: [
    "on an oversized IN-PROCESS repo (> `ts.searchWarmMaxFiles`, default 4000 source files) this op REFUSES to warm (its importer-graph fan-out builds every program and would OOM, killing the daemon) and redirects to `daemon.isolation:'process'`; pass `force:true` to warm anyway. No refusal in process-mode.",
    'changed set: `files` (explicit) > `since` ref (two-dot ref→working-tree, incl. uncommitted+untracked) > default (working tree vs HEAD). Affected = test files among the transitive importers of changed files, ∪ changed files that are themselves tests.',
    'UNDER-report is fatal (a skipped test ships a bug): `complete:true` only when nothing blocked the trace — no node/depth cap, no fan-out truncation, no deleted/untraced/unqueryable changed file, no undiscovered nested-package tsconfig. Anything else → `complete:false` + a `!!` LOWER-BOUND note (run the full suite).',
    '`complete` = TRACE-completeness, NOT glob-completeness: it attests the STATIC import graph over the LOADED programs within testGlobs. A test outside testGlobs is excluded even at `complete:true`; an undiscovered nested-package config forces `complete:false` and is named.',
    'STATIC trace only: a dynamic `import()` / `require()` of a changed module is NOT followed (inherited from importersOf) — a test that lazily imports it can be silently missed. `complete` does not cover runtime-dynamic loading.',
    'test heuristic = path globs (default *.test.* / *.spec.* / test|tests|__tests__/**), STATED never proven; override with testGlobs. Bounded: a depth cap + a node budget over BOTH the changed-file fan-out and the transitive walk — exceeding either caps the set (complete:false). importersOf is an un-memoized O(files) scan, so a very large change set is slow-but-terminating.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    // Pre-warm guard (t-411303): the transitive importer BFS builds/warms every program and fans the
    // import graph across them (the same fan `importers_of` guards) — on an oversized in-process repo
    // that OOMs and kills the daemon (§1). Refuse with a process-mode redirect BEFORE any warm.
    // `force` bypasses; process-mode + an estimate failure fall through (see the guard).
    const refusal = semanticFanoutRefusal(ctx, ts, args.force);
    if (refusal !== undefined) return fail(refusal);
    const root = ctx.daemon?.root;
    if (root === undefined) {
      return fail({
        tool: 'git',
        message: 'no workspace root available to compute the changed set',
      });
    }
    const maxDepth = args.depth ?? DEFAULT_DEPTH;
    const maxNodes = args.nodes ?? DEFAULT_NODES;
    const testGlobs = args.testGlobs ?? DEFAULT_TEST_GLOBS;
    try {
      const programFiles = new Set<string>(ts.allProgramTsFiles());
      const cs = await changeSet(root, args, programFiles);
      if (!isOk(cs)) return fail(cs.failure);
      const { mode, files, traced, untraced, deleted } = cs.data;

      const { closure, failed } = importerClosure(ts, traced, maxDepth, maxNodes);
      // §3.4 floor: a nested-package tsconfig codemaster did NOT load is invisible to
      // importersOf, so a test there is silently un-traced. Mirror find_unused_exports —
      // demote `complete` and NAME the configs, never a silent false-complete.
      const undiscovered = ts.undiscoveredProgramLabels();

      // Affected tests = test files among the transitive importers (closure nodes) ∪ the
      // ON-DISK changed files that are themselves tests (a changed test re-runs because it
      // changed). A DELETED changed test is excluded — it no longer exists to run.
      const tests = new Set<string>();
      for (const node of closure.nodes) {
        if (matchesAnyGlob(node.row.file, testGlobs)) tests.add(node.row.file);
      }
      for (const f of [...traced, ...untraced]) {
        if (matchesAnyGlob(f, testGlobs)) tests.add(f);
      }
      const testList = [...tests].sort();

      const complete =
        closure.capped === undefined &&
        !closure.hubTruncated &&
        deleted.length === 0 &&
        untraced.length === 0 &&
        failed.length === 0 &&
        undiscovered.length === 0;

      const notes: string[] = [];
      if (closure.hubTruncated) {
        notes.push(
          `!! changed-file fan-out exceeded the node budget (${maxNodes}) — only the first ${maxNodes} importer module(s) were expanded; affected-test set is a LOWER BOUND — raise nodes: or narrow the change set.`,
        );
      }
      if (undiscovered.length > 0) {
        notes.push(
          `!! ${undiscovered.length} repo tsconfig(s) NOT loaded as programs (nested package, not adjacent / referenced) — tests under them are invisible to the import graph and NOT traced; set is a LOWER BOUND — run the full suite. (${undiscovered.join(', ')})`,
        );
      }
      if (closure.capped?.by === 'nodes') {
        notes.push(
          `!! reached node cap (${maxNodes}) — importer graph INCOMPLETE (${closure.capped.boundaryNodes} node(s) un-expanded); affected-test set is a LOWER BOUND — run the full suite or raise nodes:.`,
        );
      } else if (closure.capped?.by === 'depth') {
        notes.push(
          `!! reached depth cap (${maxDepth}) — ${closure.capped.boundaryNodes} boundary node(s) un-expanded; affected-test set is a LOWER BOUND — raise depth:.`,
        );
      }
      if (deleted.length > 0) {
        notes.push(
          `!! ${deleted.length} changed file(s) DELETED (gone from disk) — their former importers cannot be traced from the post-change tree; their affected tests are NOT included — run the full suite. (${deleted.join(', ')})`,
        );
      }
      if (untraced.length > 0) {
        notes.push(
          `!! ${untraced.length} changed file(s) outside the TS import graph (non-TS asset / config) — tests reaching them via non-TS imports are NOT traced; set is a LOWER BOUND. (${untraced.join(', ')})`,
        );
      }
      if (failed.length > 0) {
        notes.push(
          `!! ${failed.length} module(s) could not be queried (importersOf failed) — their importers are NOT traced; affected-test set is a LOWER BOUND — run the full suite. (${failed.join(', ')})`,
        );
      }
      notes.push(
        `test heuristic (path globs, stated not proven): ${testGlobs.join(', ')}${args.testGlobs === undefined ? ' [default]' : ''}`,
      );

      const data: JsonValue = {
        summary: { affectedTests: testList.length, changedFiles: files.length, complete },
        notes,
        changeSet: {
          mode,
          traced: traced.length,
          ...(untraced.length > 0 ? { untraced } : {}),
          ...(deleted.length > 0 ? { deleted } : {}),
          ...(undiscovered.length > 0 ? { undiscoveredPrograms: [...undiscovered] } : {}),
        },
        tests: testList,
      };
      return ok(data);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
