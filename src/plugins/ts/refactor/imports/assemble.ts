// Assemble a `RefactorPlan` from a tree whose moves/edits are already applied. Shared by
// `planMove` (after the file/folder move) and `planExtract` (after the LS edits + re-target):
// both run the import rewrite, then read the tree's final state into the plain plan the op
// executes. Reading the tree is identical regardless of HOW it was mutated.

import type { TsProjectHost } from '../../ls-host.ts';
import type { VFSTree } from '../tree/tree.ts';
import type ts from 'typescript';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { readTextFile } from '../../../../support/fs/read-file.ts';
import { computeCommitPlan } from '../tree/commit-plan.ts';
import type { RefactorPlan } from '../plan.ts';
import { detectImportCaptures, detectReverseImportCaptures } from '../capture/imports.ts';
import { rewriteImports } from './rewrite.ts';

const TS_RE = /\.(tsx?|mts|cts)$/;

function diskText(host: TsProjectHost, rel: RepoRelPath): string | undefined {
  const fromProgram = host.service.getProgram()?.getSourceFile(host.absOf(rel))?.text;
  if (fromProgram !== undefined) return fromProgram;
  const read = readTextFile(host.absOf(rel));
  // A genuine read failure (file vanished / unreadable between listing and plan) → undefined,
  // so the caller ABORTS rather than guessing '' — which rollback would later write back,
  // truncating the file (§3.6: a failure is reported, never guessed around).
  return read.ok ? read.data : undefined;
}

export function assemblePlan(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
): RefactorPlan | string {
  const { rewrites } = rewriteImports(host, tree, options);
  const commit = computeCommitPlan(tree);

  const removed: RepoRelPath[] = [];
  const overlayFiles: { path: RepoRelPath; content: string }[] = [];
  const diff: RefactorPlan['diff'] = [];
  // Completeness backstop (§2.8): typecheck EVERY TS file. A file we failed to rewrite still
  // references a moved/extracted target's OLD path, which the overlay tombstones — so it
  // dangles and is caught, never a silent "clean" over a missed importer.
  const checkPaths = new Set<string>();

  for (const node of tree.iterFiles()) {
    const current = node.currentPath();
    const initial = node.initialPath();
    const override = node.contentOverride();
    const isTs = TS_RE.test(node.currentName);
    if (isTs) checkPaths.add(String(current));

    if (node.synthetic) continue; // a fresh file → handled by commit.newFiles, no diff/removal
    if (current !== initial) {
      const before = diskText(host, initial);
      if (before === undefined)
        return `cannot read ${initial} to plan its move — aborting (no guess)`;
      const after = override ?? before;
      diff.push({ from: initial, to: current, before, after });
      if (isTs) {
        overlayFiles.push({ path: current, content: after });
        removed.push(initial);
      }
    } else if (override !== null) {
      const before = diskText(host, initial);
      if (before === undefined)
        return `cannot read ${initial} to plan its edit — aborting (no guess)`;
      diff.push({ from: current, to: current, before, after: override });
      if (isTs) overlayFiles.push({ path: current, content: override });
    }
  }

  // Synthetic new files: their content IS the after; show as a pure add and overlay them so
  // an importer of the new symbol resolves during the dry-run typecheck.
  for (const nf of commit.newFiles) {
    diff.push({ from: nf.path, to: nf.path, before: '', after: nf.content });
    if (TS_RE.test(nf.path)) overlayFiles.push({ path: nf.path, content: nf.content });
  }

  // Widen the typecheck scope to EVERY TS file in the LS program, not just the git tree. The
  // program is seeded from tsconfig globs (disk), so a gitignored-but-compiled importer is in
  // the program yet absent from the tree — without this it would never be typechecked and a
  // dangling import after the move would read as clean (a §2.8 completeness lie).
  for (const abs of host.fileNames()) {
    if (TS_RE.test(abs)) checkPaths.add(String(host.relOf(abs)));
  }

  // Import-path capture gate (§ capture-safety): confirm every rewritten specifier still resolves
  // to its intended target over the POST-MOVE file set — a same-named, type-compatible export the
  // §2.8 typecheck would wave through is caught here. Bounded to the rewritten specifiers, not a
  // whole-repo scan.
  const captures = detectImportCaptures(options, rewrites, overlayFiles, removed, (rel) =>
    host.absOf(rel),
  );

  // Reverse capture (§ capture-safety): a pre-existing, non-rewritten import the move now SHADOWS
  // (its unchanged specifier re-binds onto a file the move introduces). New arrivals = the move's
  // destinations + the synthetic new files — the only paths that can newly intercept a resolution.
  const newArrivals = [
    ...commit.moves.map((m) => m.to),
    ...commit.newFiles.map((f) => f.path),
  ] as RepoRelPath[];
  captures.push(
    ...detectReverseImportCaptures(host, options, rewrites, overlayFiles, removed, newArrivals),
  );

  return {
    moves: commit.moves.map((m) => ({ from: m.from, to: m.to, kind: m.kind })),
    newFiles: commit.newFiles.map((f) => ({ path: f.path, content: f.content })),
    contentWrites: commit.contentWrites.map((w) => ({ path: w.path, content: w.content })),
    removed,
    overlayFiles,
    checkPaths: [...checkPaths] as RepoRelPath[],
    diff,
    captures,
  };
}
