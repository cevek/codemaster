// A cached module resolver for `detectReverseImportCaptures`. The reverse-capture gate re-resolves
// (potentially) every pre-existing import in the program to see whether the move makes an unchanged
// specifier newly land on a move-introduced file — the DOMINANT cost of the gate on a large repo is
// the FS-probing `resolveModuleName`, not the AST walk.
//
// A shared `ts.ModuleResolutionCache` per host memoizes the directory-existence / `package.json`
// probes ACROSS specifiers (what tsserver does), on top of the `(dir, spec)` string memo that dedups
// identical imports. Two caches — one bound to the post-move host, one to pre-move disk (`ts.sys`) —
// since the hosts disagree on tombstoned / move-introduced files; they are NEVER shared across hosts.
//
// This is a PURE-PERFORMANCE narrowing of how the resolves are computed, never of WHICH captures are
// reported: a `ModuleResolutionCache` is transparent to the resolution result, and the containing
// file is always passed ABSOLUTE, so the cache's `currentDirectory` only affects keying, never which
// file resolves. Byte-identical by construction.
//
// (A relative-only "skip the resolve when the specifier's basename can match no move-introduced file"
// pre-filter was attempted here and DROPPED — an adversarial review found sound counterexamples where
// a relative specifier's resolved basename does NOT equal its last segment, e.g. a non-dotted
// `moduleSuffixes` entry or a bare `..` directory import, so the skip silently dropped real reverse
// captures. Reattempt is tracked in the backlog with those counterexamples as required guards.)

import ts from 'typescript';
import { toPosix } from '../../../../support/fs/canonicalize.ts';

/** Two host-scoped resolvers sharing a `ModuleResolutionCache` each — the post-move file set and
 *  pre-move disk. Each still string-memoizes on `(dir, spec)` so an identical import resolves once. */
export interface ReverseResolver {
  resolvePost(spec: string, fromAbs: string): string | undefined;
  resolvePre(spec: string, fromAbs: string): string | undefined;
}

export function createReverseResolver(
  options: ts.CompilerOptions,
  currentDirectory: string,
  postHost: ts.ModuleResolutionHost,
): ReverseResolver {
  const getCanonical = (f: string): string =>
    ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase();
  const mrcPost = ts.createModuleResolutionCache(currentDirectory, getCanonical, options);
  const mrcPre = ts.createModuleResolutionCache(currentDirectory, getCanonical, options);
  const postMemo = new Map<string, string | undefined>();
  const preMemo = new Map<string, string | undefined>();
  const run = (
    spec: string,
    fromAbs: string,
    h: ts.ModuleResolutionHost,
    mrc: ts.ModuleResolutionCache,
    memo: Map<string, string | undefined>,
  ): string | undefined => {
    const posix = toPosix(fromAbs);
    const key = `${posix.slice(0, posix.lastIndexOf('/'))}|${spec}`;
    const hit = memo.get(key);
    if (hit !== undefined || memo.has(key)) return hit;
    const r = ts.resolveModuleName(spec, fromAbs, options, h, mrc).resolvedModule?.resolvedFileName;
    memo.set(key, r);
    return r;
  };
  return {
    resolvePost: (spec, fromAbs) => run(spec, fromAbs, postHost, mrcPost, postMemo),
    resolvePre: (spec, fromAbs) => run(spec, fromAbs, ts.sys, mrcPre, preMemo),
  };
}
