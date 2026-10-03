// The disk version of every path, ONE per host and shared by all its programs. Two consumers treat
// an equal version as an unchanged body: the shared `DocumentRegistry` (one SourceFile per path and
// options bucket, reused across programs on a version match) and the write gate's diagnostics
// builder (program-gate-builder.ts). A per-program counter breaks both — programs drift apart
// (one re-globs a path out and back), so one program's new version can equal another's old one for
// a different body; and a path a program reaches only through an import (outside its `include`)
// never had a counter at all. A host-wide counter per path, advanced once for every path a reindex
// names and never reset, gives each reindexed body of a path one version everywhere. A path no
// reindex ever names (gitignored codegen, `node_modules`, outside the root) stays at 1 — stale for
// the LS as a whole (t-710809 / t-024049).

export interface FileVersions {
  /** The current disk version of `absPosix` (1 until a reindex first names it). */
  of(absPosix: string): number;
  /** Advance each path once — the host calls this on every reindex, before its programs reindex. */
  advance(absPosix: readonly string[]): void;
}

export function createFileVersions(): FileVersions {
  const versions = new Map<string, number>();
  return {
    of: (abs) => versions.get(abs) ?? 1,
    advance(paths) {
      for (const abs of new Set(paths)) versions.set(abs, (versions.get(abs) ?? 1) + 1);
    },
  };
}
