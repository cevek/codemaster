// Capture detection for `move_file` / `extract_symbol` — their rewrites are IMPORT specifiers,
// so the capture flavor is PATH RESOLUTION: a moved/relinked import whose new specifier lands on a
// DIFFERENT same-named, type-compatible export than it bound to before (the typecheck won't catch
// it — both sides compile). For each specifier the rewrite changed we know the target node it was
// pointed at; we re-resolve the EMITTED specifier with the project's own resolver over the
// POST-MOVE file set and confirm it still lands on that exact target. A legitimate move resolves
// to precisely the intended file → no capture (the §1 over-refusal guard); a divergence is flagged.
//
// CONSERVATIVE: only a POSITIVE divergence (resolves, but elsewhere) is a capture. A specifier the
// resolver declines (a CSS-module import, an unmapped path) yields nothing — a dangling import is
// the §2.8 typecheck's job, not a silent capture. We never fabricate a refusal (§3).

import ts from 'typescript';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { toPosix } from '../../../../support/fs/canonicalize.ts';
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

const posixDirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/** A `ts.ModuleResolutionHost` reading the POST-MOVE file set: tombstoned old paths are absent,
 *  moved/new files are present (with their synthetic parent directories), everything else falls
 *  through to disk. So a dry-run resolution sees the world as it WILL be after apply. */
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
      if (dirs.has(toPosix(d))) return true;
      return ts.sys.directoryExists ? ts.sys.directoryExists(d) : false;
    },
    getDirectories: (d) => (ts.sys.getDirectories ? ts.sys.getDirectories(d) : []),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
  if (ts.sys.realpath !== undefined) host.realpath = ts.sys.realpath;
  return host;
}
