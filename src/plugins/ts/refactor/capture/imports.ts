// Capture detection for `move_file` / `extract_symbol` — their rewrites are IMPORT specifiers,
// so the capture flavor is PATH RESOLUTION. Two directions, both re-resolved with the project's
// OWN resolver over the POST-MOVE file set (a same-named, type-compatible re-bind the §2.8
// typecheck waves through):
//   FORWARD (`detectImportCaptures`): a specifier WE rewrote no longer lands on the target it was
//     pointed at. For each rewritten specifier we know the intended node; re-resolve the EMITTED
//     specifier and confirm it still lands there.
//   REVERSE (`detectReverseImportCaptures`): a PRE-EXISTING, non-rewritten import the move now
//     SHADOWS — its specifier (unchanged) resolved to one real module before and to a file the
//     move INTRODUCED after. Bounded to specifiers that newly land on a move-introduced file.
//
// CONSERVATIVE (the §1 over-refusal guard): only a POSITIVE divergence is a capture — a specifier
// that resolves, but elsewhere/anew. A declined resolution (a CSS-module import, an unmapped
// path) or a previously-dangling import (resolved to nothing before) yields nothing — a dangle is
// the §2.8 typecheck's job, never a fabricated refusal (§3).

import ts from 'typescript';
import type { RepoRelPath } from '../../../../core/brands.ts';
import type { TsProjectHost } from '../../ls-host.ts';
import { toPosix } from '../../../../support/fs/canonicalize.ts';
import { moduleSpecifierOf } from '../ast/specifier.ts';
import type { Capture } from './types.ts';

/** One import specifier the rewrite changed, with the target it was meant to land on. */
export interface RewrittenImport {
  /** Importer's CURRENT (post-move) absolute path — the `containingFile` resolution runs from. */
  importerCurrentAbs: string;
  /** Importer's current repo-relative path — the capture's proof file. */
  importerCurrentPath: RepoRelPath;
  /** The specifier text the rewrite emitted (e.g. `../ui/Button`). */
  newSpec: string;
  /** Absolute path of the node the rewrite pointed this specifier at (post-move). */
  expectedTargetCurrentAbs: string;
  /** 1-based line/col of the specifier (stable across the rewrite — same line before/after). */
  line: number;
  col: number;
}

/** Captures where a rewritten import no longer resolves to its intended target. `overlayFiles`
 *  are the post-edit TS contents at their CURRENT paths; `removed` are tombstoned old paths. */
export function detectImportCaptures(
  options: ts.CompilerOptions,
  rewrites: readonly RewrittenImport[],
  overlayFiles: readonly { path: RepoRelPath; content: string }[],
  removed: readonly RepoRelPath[],
  absOf: (rel: RepoRelPath) => string,
): Capture[] {
  if (rewrites.length === 0) return [];
  const afterContent = new Map<string, string>();
  for (const f of overlayFiles) afterContent.set(toPosix(absOf(f.path)), f.content);
  const removedAbs = new Set(removed.map((r) => toPosix(absOf(r))));
  const host = postMoveResolutionHost(removedAbs, afterContent);

  const out: Capture[] = [];
  for (const rw of rewrites) {
    const resolved = ts.resolveModuleName(rw.newSpec, rw.importerCurrentAbs, options, host)
      .resolvedModule?.resolvedFileName;
    // Declined (css / unmapped) → not a capture (typecheck guards a true dangle). Only a positive
    // landing on a DIFFERENT file is the silent path-capture this gate exists to catch.
    if (resolved === undefined) continue;
    if (toPosix(resolved) !== toPosix(rw.expectedTargetCurrentAbs)) {
      out.push({
        file: rw.importerCurrentPath,
        line: rw.line,
        col: rw.col,
        kind: 'forward',
        detail: `rewritten import \`${rw.newSpec}\` now resolves to ${toPosix(resolved)}, not the intended ${toPosix(rw.expectedTargetCurrentAbs)}`,
      });
    }
  }
  return out;
}

/** Reverse path-capture: a PRE-EXISTING import (one the rewrite did NOT touch) whose unchanged
 *  specifier now resolves to a file the move INTRODUCED, when it previously resolved to a
 *  different real module — the move silently shadows it (type-blind to §2.8 when both are
 *  compatible). Bounded: only specifiers that post-resolve onto a `newArrivals` path pay the
 *  second (pre-move) resolution; a previously-dangling import (no prior target) is NOT a capture
 *  (the §1 over-refusal guard — a dangle is the typecheck's job). `newArrivals` are the CURRENT
 *  paths the move creates (move destinations + new files). */
export function detectReverseImportCaptures(
  host: TsProjectHost,
  options: ts.CompilerOptions,
  rewrites: readonly RewrittenImport[],
  overlayFiles: readonly { path: RepoRelPath; content: string }[],
  removed: readonly RepoRelPath[],
  newArrivals: readonly RepoRelPath[],
): Capture[] {
  const program = host.service.getProgram();
  if (program === undefined || newArrivals.length === 0) return [];

  const afterContent = new Map<string, string>();
  for (const f of overlayFiles) afterContent.set(toPosix(host.absOf(f.path)), f.content);
  const removedAbs = new Set(removed.map((r) => toPosix(host.absOf(r))));
  const newArrivalAbs = new Set(newArrivals.map((p) => toPosix(host.absOf(p))));
  const postHost = postMoveResolutionHost(removedAbs, afterContent);
  // Sites the FORWARD pass already owns — never double-flag a specifier we deliberately rewrote.
  const rewrittenSites = new Set(
    rewrites.map((r) => `${toPosix(r.importerCurrentAbs)}:${r.line}:${r.col}`),
  );
  // Resolution is a pure function of (dir, spec, host); memoize per host to bound the scan to
  // O(distinct dir×spec) instead of O(imports).
  const postCache = new Map<string, string | undefined>();
  const preCache = new Map<string, string | undefined>();
  const resolve = (
    spec: string,
    fromAbs: string,
    h: ts.ModuleResolutionHost,
    cache: Map<string, string | undefined>,
  ): string | undefined => {
    const key = `${toPosix(fromAbs).slice(0, toPosix(fromAbs).lastIndexOf('/'))}|${spec}`;
    const hit = cache.get(key);
    if (hit !== undefined || cache.has(key)) return hit;
    const r = ts.resolveModuleName(spec, fromAbs, options, h).resolvedModule?.resolvedFileName;
    cache.set(key, r);
    return r;
  };

  const out: Capture[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.fileName.includes('/node_modules/')) continue;
    const abs = toPosix(sf.fileName);
    // A moved-away original (its imports were rewritten + its new copy is a new arrival) and a
    // freshly-introduced file are NOT "pre-existing importers" — skip both.
    if (removedAbs.has(abs) || newArrivalAbs.has(abs)) continue;
    // Walk the POST-EDIT content: an edited-in-place file (e.g. an extract's source) has its new
    // text in the overlay; everything else is unchanged, so reuse the parsed program SourceFile.
    const overlaid = afterContent.get(abs);
    const parsed =
      overlaid !== undefined
        ? ts.createSourceFile(
            sf.fileName,
            overlaid,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TSX,
          )
        : sf;

    const visit = (node: ts.Node): void => {
      const lit = moduleSpecifierOf(node);
      if (lit !== undefined) {
        const start = lit.getStart(parsed);
        const lc = parsed.getLineAndCharacterOfPosition(start);
        const line = lc.line + 1;
        const col = lc.character + 1;
        if (!rewrittenSites.has(`${abs}:${line}:${col}`)) {
          const rpost = resolve(lit.text, sf.fileName, postHost, postCache);
          // Only a specifier that NOW lands on a move-introduced file can be a reverse shadow.
          if (rpost !== undefined && newArrivalAbs.has(toPosix(rpost))) {
            const rpre = resolve(lit.text, sf.fileName, ts.sys, preCache);
            // Require a prior REAL target that differs — a previously-dangling import is not a
            // positive divergence (never over-refuse a move that merely satisfies an old dangle).
            if (rpre !== undefined && toPosix(rpre) !== toPosix(rpost)) {
              out.push({
                file: host.relOf(sf.fileName) as RepoRelPath,
                line,
                col,
                kind: 'reverse',
                detail: `pre-existing import \`${lit.text}\` now resolves to ${toPosix(rpost)} (a file the move introduces), not its prior ${toPosix(rpre)} — the move would silently shadow it`,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return out;
}

const posixDirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/** A `ts.ModuleResolutionHost` reading the POST-MOVE file set: tombstoned old paths (and dirs the
 *  move EMPTIES) are absent, moved/new files are present (with their synthetic parent directories),
 *  everything else falls through to disk. So a dry-run resolution sees the world as it WILL be
 *  after apply — a stale relative resolution can't land in a directory the move drained. */
function postMoveResolutionHost(
  removedAbs: ReadonlySet<string>,
  afterContent: ReadonlyMap<string, string>,
): ts.ModuleResolutionHost {
  const dirs = new Set<string>();
  for (const f of afterContent.keys()) {
    let d = posixDirname(f);
    while (d.length > 0 && !dirs.has(d)) {
      dirs.add(d);
      d = posixDirname(d);
    }
  }
  // Directories that CONTAIN a removed file (the only dirs a move can empty) — the gate that
  // bounds the emptiness walk below to the move's neighborhood, never the whole repo.
  const removedDirs = new Set<string>();
  for (const r of removedAbs) {
    let d = posixDirname(r);
    while (d.length > 0 && !removedDirs.has(d)) {
      removedDirs.add(d);
      d = posixDirname(d);
    }
  }
  // True when `dirPosix` has NO surviving file in its subtree post-move (every file is removed,
  // every subdir is itself emptied), so it must report non-existent. Memoized; short-circuits on
  // the first surviving file, so a large dir with survivors costs O(1), and the recursion stays
  // within the moved subtree (only `removedDirs` reach here from `directoryExists`).
  const emptiedMemo = new Map<string, boolean>();
  const setMemo = (k: string, v: boolean): boolean => {
    emptiedMemo.set(k, v);
    return v;
  };
  const emptiedByMove = (dirPosix: string): boolean => {
    const cached = emptiedMemo.get(dirPosix);
    if (cached !== undefined) return cached;
    if (dirs.has(dirPosix)) return setMemo(dirPosix, false); // holds a moved-in file
    emptiedMemo.set(dirPosix, false); // re-entrancy guard (symlink cycles)
    let directFiles: readonly string[];
    let subDirs: readonly string[];
    try {
      directFiles = ts.sys.readDirectory(dirPosix, undefined, undefined, ['*'], 1);
      subDirs = ts.sys.getDirectories ? ts.sys.getDirectories(dirPosix) : [];
    } catch {
      return setMemo(dirPosix, false); // unreadable → don't tombstone what we can't inspect
    }
    for (const f of directFiles) {
      if (!removedAbs.has(toPosix(f))) return setMemo(dirPosix, false); // a survivor → not empty
    }
    for (const sub of subDirs) {
      if (!emptiedByMove(`${dirPosix}/${sub}`)) return setMemo(dirPosix, false);
    }
    return setMemo(dirPosix, true);
  };
  const host: ts.ModuleResolutionHost = {
    fileExists(f) {
      const p = toPosix(f);
      if (removedAbs.has(p)) return false;
      if (afterContent.has(p)) return true;
      return ts.sys.fileExists(f);
    },
    readFile(f) {
      const p = toPosix(f);
      if (removedAbs.has(p)) return undefined;
      const c = afterContent.get(p);
      return c !== undefined ? c : ts.sys.readFile(f);
    },
    directoryExists(d) {
      const p = toPosix(d);
      if (dirs.has(p)) return true;
      // A dir the move drains of every file must look gone — else a stale relative resolution
      // could land an index probe there and MASK a capture (gated to `removedDirs` so we never
      // walk an untouched tree).
      if (removedDirs.has(p) && emptiedByMove(p)) return false;
      return ts.sys.directoryExists ? ts.sys.directoryExists(d) : false;
    },
    getDirectories: (d) => (ts.sys.getDirectories ? ts.sys.getDirectories(d) : []),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
  if (ts.sys.realpath !== undefined) host.realpath = ts.sys.realpath;
  return host;
}
