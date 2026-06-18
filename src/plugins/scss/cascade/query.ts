// The cascade QUERY orchestration (spec-css-cascade-op): turn a `css_cascade` input into a
// resolved view. Re-parses the in-scope sheets FRESH on demand (bounded, scopeable by the
// filter — never extending the plugin's hot `warm`/`reindex` path), then resolves. Kept off
// `plugin.ts` so that file stays a thin public surface (the §"≤300 lines" rule).

import * as path from 'node:path';
import type { RepoRelPath } from '../../../core/brands.ts';
import { matchesAnyGlob } from '../../../common/glob/match.ts';
import { readTextOrAbsent } from '../../../support/fs/read-or-absent.ts';
import { parseStylesheetRoot } from '../parse-root.ts';
import { scrubRoot } from '../scrub-root.ts';
import { extractContributions, type CascadeContribution } from './rules.ts';
import { resolveCascade, type CascadeResolution } from './resolve.ts';
import { analyzeBranch, splitSelectorList } from './specificity.ts';

/** What `css_cascade` resolves: a CSS-module class in a sheet, or a raw selector (whose
 *  subject's principal class becomes the target). */
export type CascadeInput =
  | { kind: 'class'; file: RepoRelPath; className: string }
  | { kind: 'selector'; selector: string };

/** Stylesheet-path scoping for the cross-sheet search (globs over the .scss path); the
 *  owning sheet is always searched regardless. */
export type CascadeFilter = { pathInclude?: readonly string[]; pathExclude?: readonly string[] };

export type CascadeOutcome =
  | {
      ok: true;
      target: string;
      owningFile?: RepoRelPath;
      resolution: CascadeResolution;
      scannedSheets: number;
      parseFailures: { file: string; message: string }[];
    }
  | { ok: false; message: string };

export function runCascadeQuery(
  root: string,
  indexedSheets: readonly RepoRelPath[],
  input: CascadeInput,
  filter?: CascadeFilter,
): CascadeOutcome {
  const resolved = resolveTarget(input);
  if (!resolved.ok) return resolved;
  const { target, owningFile } = resolved;

  // The candidate set: every indexed stylesheet (`.scss`/`.sass`/`.css`) plus, for class mode,
  // the owning sheet even if it isn't in the index yet (e.g. just created, not yet reindexed).
  // The file LIST comes from the caller's cached state (no per-call FS walk); the sheets are
  // RE-PARSED fresh on demand.
  const candidates = new Set<RepoRelPath>(indexedSheets);
  if (owningFile !== undefined) candidates.add(owningFile);

  const contributions: CascadeContribution[] = [];
  const parseFailures: { file: string; message: string }[] = [];
  let scannedSheets = 0;
  for (const rel of candidates) {
    if (rel !== owningFile && !inScope(rel, filter)) continue;
    const read = readTextOrAbsent(root, rel);
    if (read.kind === 'absent') continue;
    if (read.kind === 'error') {
      parseFailures.push({ file: rel, message: scrubRoot(root, read.message) });
      continue;
    }
    const parsed = parseStylesheetRoot(read.text, rel, path.join(root, rel));
    if (!parsed.ok) {
      parseFailures.push({ file: rel, message: scrubRoot(root, parsed.message) });
      continue;
    }
    scannedSheets++;
    try {
      contributions.push(...extractContributions(parsed.root, rel, read.text, target));
    } catch (thrown) {
      // A pathological selector must never throw out of a read op (§3.6).
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      parseFailures.push({ file: rel, message: scrubRoot(root, message) });
    }
  }

  return {
    ok: true,
    target,
    ...(owningFile !== undefined ? { owningFile } : {}),
    resolution: resolveCascade(target, owningFile, contributions),
    scannedSheets,
    parseFailures,
  };
}

/** Resolve the input to a target class + owning sheet. A selector's target is the principal
 *  (last) class of its first branch's subject; a selector with no subject class can't be a
 *  module-class cascade — an honest `ok:false`, never a guess. */
function resolveTarget(
  input: CascadeInput,
): { ok: true; target: string; owningFile?: RepoRelPath } | { ok: false; message: string } {
  if (input.kind === 'class') {
    const target = input.className.replace(/^\./, '');
    if (target.length === 0) return { ok: false, message: 'empty class name' };
    return { ok: true, target, owningFile: input.file };
  }
  const first = splitSelectorList(input.selector)[0] ?? input.selector.trim();
  const { subjectClasses } = analyzeBranch(first).traits;
  const target = subjectClasses[subjectClasses.length - 1];
  if (target === undefined) {
    return {
      ok: false,
      message:
        'selector subject has no class — css_cascade resolves the cascade for a CSS-module class; pass {file, class} or a selector whose rightmost compound carries a class',
    };
  }
  return { ok: true, target };
}

function inScope(rel: RepoRelPath, filter?: CascadeFilter): boolean {
  const inc = filter?.pathInclude;
  const exc = filter?.pathExclude;
  if (inc !== undefined && inc.length > 0 && !matchesAnyGlob(rel, inc)) return false;
  if (exc !== undefined && exc.length > 0 && matchesAnyGlob(rel, exc)) return false;
  return true;
}
