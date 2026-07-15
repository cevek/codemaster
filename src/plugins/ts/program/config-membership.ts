// `list_symbols` grouping layer (t-143952) — assign each git-source file to the tsconfig(s) that
// include it, so the catalogue can group names per config ("the app config has these; the test config
// has these"). This is the ONLY part of list_symbols that walks the tree + expands globs, so it is the
// only part that can be slow — it is bounded on THREE dimensions (config count, total globbed files,
// and any throw) and the op DEGRADES to the flat single-group catalogue on `degraded`. It NEVER warms
// the LS / builds a program: config file-sets come from `parseJsonConfigFileContent` (syntactic, the
// same call coverage.ts uses for the undiscovered floor — the intentional parallel, kept separate so
// this stays a self-contained no-warm helper).
//
// NEVER-HANG: §19 says codemaster's own SYNCHRONOUS code is not wall-clock-cancellable, so the
// guarantee here is bounded-BY-DESIGN (capped config count + capped globbed-file count + throw→flat),
// not a mid-loop deadline — a deadline cannot preempt this synchronous pass. NO cache: the
// syntactic-cache key deliberately skips `.json` (isScannedSourcePath), so it cannot detect a tsconfig
// edit — caching membership on it would serve stale groups (§3.5). A rare first-contact op recomputes
// this bounded pass per call instead.

import * as path from 'node:path';
import ts from 'typescript';
import { toPosix } from '../../../support/fs/canonicalize.ts';
import { relLabel, repoTsconfigsFrom, walkRepoFiles } from './discover.ts';

/** Hard cap on tsconfigs parsed before degrading to flat (far above any real repo; a runaway backstop). */
const MAX_CONFIGS = 512;
/** Hard cap on total globbed file entries processed before degrading to flat (§1 bounded-by-design). */
const MAX_GLOBBED_FILES = 400_000;

const TS_SOURCE_RE = /\.(ts|tsx|cts|mts)$/;

/** Per-file grouping decision. `primary` = the config whose group this file's names land in;
 *  `owners` = every config that includes the file (⊇ {primary}), so the op can annotate a shared file
 *  without double-counting it (its names appear only under `primary`). */
export interface FileOwnership {
  primary: string;
  owners: string[];
}

export interface ConfigMembership {
  /** repo-relative posix path → its ownership. Absent key ⇒ the file is under no tsconfig (the op
   *  puts it in a `(no tsconfig)` group — never dropped). */
  byFile: Map<string, FileOwnership>;
  /** Set ⇒ grouping is unavailable (over a bound, or a parse threw); the op degrades to a single flat
   *  group and states this reason. Absent ⇒ grouping is trustworthy. */
  degraded?: string;
}

/** Compute file→tsconfig ownership for the whole repo, host-free + bounded. Never throws: a failure
 *  or an over-bound repo returns `{ byFile, degraded }` and the op falls back to the flat catalogue. */
export function computeConfigMembership(root: string): ConfigMembership {
  try {
    return compute(root);
  } catch (thrown) {
    return { byFile: new Map(), degraded: `config discovery failed (${messageOf(thrown)})` };
  }
}

function compute(root: string): ConfigMembership {
  const rootPosix = toPosix(root);
  const repoFiles = walkRepoFiles(root);
  const configs = repoTsconfigsFrom(repoFiles, root); // absolute posix
  if (configs.length === 0) return { byFile: new Map(), degraded: 'no tsconfig found' };
  if (configs.length > MAX_CONFIGS)
    return {
      byFile: new Map(),
      degraded: `too many tsconfigs (${configs.length} > ${MAX_CONFIGS})`,
    };

  const byFile = new Map<string, FileOwnership>();
  let globbed = 0;
  for (const configAbs of configs) {
    const label = relLabel(root, configAbs);
    for (const fileAbs of configSourceFiles(configAbs)) {
      if (++globbed > MAX_GLOBBED_FILES)
        return { byFile, degraded: `too many globbed files (> ${MAX_GLOBBED_FILES})` };
      const rel = relUnderRoot(rootPosix, fileAbs);
      if (rel === undefined) continue; // outside root — not in the git surface anyway
      addOwner(byFile, rel, label);
    }
  }
  for (const own of byFile.values()) own.primary = pickPrimary(own.owners);
  return { byFile };
}

/** A config's TS-source file-set (posix abs), from `parseJsonConfigFileContent` (syntactic, no LS).
 *  Best-effort: an unreadable/malformed config yields no files rather than throwing (that config just
 *  contributes no ownership).
 *
 *  DRIFT NOTE — this is the SAME parse+filter core as `coverage.ts` `fileNamesOf` (readConfigFile →
 *  parseJsonConfigFileContent → `fileNames.map(toPosix).filter(!node_modules && TS_SOURCE_RE)`), and
 *  `TS_SOURCE_RE` is duplicated. They intentionally DIVERGE downstream (coverage applies the §10 junk /
 *  git-ignore filter; this does not), but the parse+extension policy must stay in sync — unifying the
 *  shared core into a `program/`-level helper both call is a filed follow-up (t-400905), deferred here
 *  to avoid editing coverage.ts across a parallel track. */
function configSourceFiles(configPath: string): string[] {
  try {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      read.config ?? {},
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath,
    );
    return parsed.fileNames
      .map(toPosix)
      .filter((f) => !f.includes('/node_modules/') && TS_SOURCE_RE.test(f));
  } catch {
    return [];
  }
}

function addOwner(byFile: Map<string, FileOwnership>, rel: string, label: string): void {
  const hit = byFile.get(rel);
  if (hit === undefined) byFile.set(rel, { primary: label, owners: [label] });
  else if (!hit.owners.includes(label)) hit.owners.push(label);
}

/** The primary config for a file included by several: the DEEPEST-dir config wins (most specific);
 *  a same-dir tie prefers the base `tsconfig.json`, else the lexically-smallest label — fully
 *  deterministic, so a shared file lands in the SAME group cold or warm (§16). */
function pickPrimary(owners: readonly string[]): string {
  return [...owners].sort(comparePrimary)[0] ?? owners[0] ?? '';
}

function comparePrimary(a: string, b: string): number {
  const da = dirDepth(a);
  const db = dirDepth(b);
  if (da !== db) return db - da; // deeper (more specific) config dir first
  const ba = path.posix.basename(a) === 'tsconfig.json';
  const bb = path.posix.basename(b) === 'tsconfig.json';
  if (ba !== bb) return ba ? -1 : 1; // base tsconfig.json wins the same-dir tie
  return a.localeCompare(b);
}

function dirDepth(label: string): number {
  const dir = path.posix.dirname(label);
  return dir === '.' || dir === '' ? 0 : dir.split('/').length;
}

/** `abs` (posix) as a repo-relative posix path, or undefined when it is not under root.
 *
 *  JOIN-KEY ASSUMPTION: the op joins these membership keys to the catalogue's file keys (`brandGitPath`
 *  of git's on-disk spelling) by RAW string identity. Both sides are SYMMETRICALLY raw (neither
 *  case-folds nor realpaths), so they agree whenever git and `parseJsonConfigFileContent` emit the same
 *  on-disk spelling — the normal case. A spelling divergence (a differently-cased tsconfig `include`
 *  glob on a case-insensitive volume, or a symlinked layout TS realpaths) would miss the join → the
 *  file falls into the `(no tsconfig)` group (mis-grouped, but its NAMES are never dropped — grouping is
 *  best-effort). Full canonicalization through the §19 chokepoint is a filed follow-up (t-694619). */
function relUnderRoot(rootPosix: string, abs: string): string | undefined {
  const prefix = `${rootPosix}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : undefined;
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : 'unknown error';
}
