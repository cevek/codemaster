// Discover the repo's OTHER tsconfigs so their programs can be loaded beside the primary one
// (spec Task G scope-IN 1). The warm LS compiles ONE tsconfig; a symbol used only from a file in
// a sibling program (the near-universal `tsconfig.test.json`, Vite's `tsconfig.app.json` +
// `tsconfig.node.json`, build scripts) reads as having NO usage — the honesty gap this closes.
//
// Three sources, all bounded (a fixed cap + a visited set — discovery runs ONCE and is cached by
// the host, never per query: a per-query directory scan is the §19 hang this project forbids):
//   1. sibling `tsconfig*.json` files in the primary config's directory;
//   2. PACKAGE `tsconfig*.json` — a nested dir holding its own `package.json` (a workspace-glob
//      member, OR a truly isolated non-referenced non-member package, t-865312). The `package.json`
//      anchor is the discriminator; the whole point vs. Ask-1 is that a member GLOB is no longer
//      required, so an isolated frontend package (its own tsconfig+package.json, no manifest) loads
//      instead of flooring every cross-package query;
//   3. `references` followed transitively from each discovered config (what a composite repo wires).
// This is plain DISCOVERY — we load each as its own independent program. The project-reference
// REDIRECT machinery (composite build graph) is the monorepo story the spec scopes OUT.

import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import type { RepoRelPath } from '../../../core/brands.ts';
import { matchesAnyGlob } from '../../../common/glob/match.ts';
import { toPosix } from '../../../support/fs/canonicalize.ts';
import { walkFiles } from '../../../support/fs/walk.ts';
import { readWorkspaceExclusions } from './workspace-globs.ts';

export interface DiscoveredConfig {
  /** Absolute path to the sibling tsconfig. */
  path: string;
  /** Repo-relative posix label for status/provenance (e.g. `tsconfig.test.json`). */
  label: string;
}

/** Hard cap on sibling configs (§1 bounded): far above any real repo's tsconfig count (a 50-member
 *  all-Vite monorepo ≈ 150), a runaway backstop for a pathological `references` cycle the visited-set
 *  should already break. Cap-dropped configs stay in the UNDISCOVERED set → still floored → honest. */
const MAX_SIBLING_CONFIGS = 256;

/** Sibling tsconfigs to load beside `primaryConfigPath`, EXCLUDING it. `repoTsconfigs` is the
 *  host's cached repo-wide `tsconfig*.json` list (`repoTsconfigsFrom`) — reused here for source 2
 *  (workspace members) so there is ONE repo walk, not a second.
 *
 *  A no-tsconfig root (a pnpm/vite monorepo with only `tsconfig.base.json` + per-package configs, no
 *  root `tsconfig.json` — real claude-ui) has an UNDEFINED primary (the fallback program stands in).
 *  Source 1 (siblings adjacent to the primary) is then skipped, but source 2 (workspace MEMBERS,
 *  seeded from the manifest INDEPENDENTLY of any primary) + source 3 (`references` from those
 *  members) still fire — else every member is undiscovered and every cross-package query is floored
 *  (t-816306). Empty only when there is neither a primary NOR a workspace manifest yielding members. */
export function discoverSiblingConfigs(
  root: string,
  primaryConfigPath: string | undefined,
  repoTsconfigs: readonly string[],
): DiscoveredConfig[] {
  const primary = primaryConfigPath !== undefined ? toPosix(primaryConfigPath) : undefined;
  const seen = new Set<string>(primary !== undefined ? [primary] : []);
  const found: string[] = [];

  const add = (abs: string): void => {
    const posix = toPosix(abs);
    if (seen.has(posix) || found.length >= MAX_SIBLING_CONFIGS) return;
    seen.add(posix);
    found.push(posix);
  };

  // Source 1: `tsconfig*.json` beside the primary config (only when a primary exists — a no-tsconfig
  // root has no primary directory to scan; its members come from source 2).
  if (primaryConfigPath !== undefined) {
    const dir = path.dirname(primaryConfigPath);
    try {
      for (const entry of readdirSync(dir)) {
        if (isTsconfigBasename(entry)) {
          add(path.join(dir, entry));
        }
      }
    } catch {
      // Unreadable dir → just skip source 1; the other sources may still yield siblings.
    }
  }

  // Source 2: PACKAGE `tsconfig*.json` (dogfood-jul Ask 1 + t-865312) — a nested dir carrying its own
  // `package.json`, whether or not it is a workspace-glob member. This is the ONLY discovery source
  // when the primary is undefined, so a no-root monorepo's packages load as independent programs.
  for (const abs of packageConfigs(root, repoTsconfigs, primaryConfigPath)) add(abs);

  // Source 3: BFS `references` from the primary (if any) and every config found so far (source 1 +
  // 2) — so a member's Vite app/node split reachable only via its hub's `references` is loaded too.
  const queue = [...(primary !== undefined ? [primary] : []), ...found];
  while (queue.length > 0 && seen.size <= MAX_SIBLING_CONFIGS) {
    const config = queue.shift();
    if (config === undefined) continue;
    for (const ref of referencePaths(config)) {
      if (!seen.has(ref)) {
        add(ref);
        queue.push(ref);
      }
    }
  }

  return found.map((abs) => ({ path: abs, label: relLabel(root, abs) }));
}

/** The subset of `repoTsconfigs` that define an independent PACKAGE: a `tsconfig*.json` whose
 *  DIRECTORY holds a `package.json` (the real npm/pnpm package definition), sitting in a NESTED
 *  subdirectory. The `package.json` anchor is the discriminator — a workspace-glob member is one way
 *  to be a package, but a truly isolated nested package (its own tsconfig+package.json, NOT referenced
 *  and NOT a workspace-glob member — t-865312) is the same thing and loads the same way. Dropping the
 *  positive-glob REQUIREMENT is the whole fix: the repro repo has no workspace manifest at all, so a
 *  member-glob gate floored its entire frontend. A bare nested/fixture tsconfig WITHOUT a package.json
 *  stays out (→ still undiscovered/floored, the `programs:` lever's job), so this never over-indexes.
 *
 *  Excluded: the ROOT dir (`.` — a root-level `tsconfig.test.json` is an adjacent SIBLING, glob-based,
 *  not a dir-package), the primary config itself, and any config sharing the primary's own directory
 *  (adjacent siblings). A dir matched by a NEGATIVE (`!`) workspace glob is honored as an explicit
 *  exclusion. All inputs are already-walked paths (respecting the §10 ignore set — a package.json dir
 *  under node_modules/dist/.claude never reaches here), so this is a pure in-memory filter over the
 *  cached list — no new fs walk beyond a bounded per-config `package.json` existence probe. Iterated in
 *  `repoTsconfigs` order for a deterministic result (cold == warm on a capped repo). */
export function packageConfigs(
  root: string,
  repoTsconfigs: readonly string[],
  primaryConfigPath?: string,
): string[] {
  const negative = readWorkspaceExclusions(root);
  const primary = primaryConfigPath !== undefined ? toPosix(primaryConfigPath) : undefined;
  const primaryDir =
    primaryConfigPath !== undefined
      ? path.posix.dirname(relLabel(root, primaryConfigPath))
      : undefined;
  const out: string[] = [];
  for (const abs of repoTsconfigs) {
    const posix = toPosix(abs);
    if (posix === primary) continue; // the primary itself
    const rel = relLabel(root, abs);
    if (path.isAbsolute(rel)) continue; // outside the root — never a package here
    const packageDir = path.posix.dirname(rel);
    if (packageDir === '.') continue; // root-level config — an adjacent sibling, not a dir-package
    if (packageDir === primaryDir) continue; // shares the primary's dir — a glob-based sibling
    if (negative.length > 0 && matchesAnyGlob(packageDir, negative)) continue; // workspace-excluded
    if (!existsSync(path.join(root, packageDir, 'package.json'))) continue;
    out.push(abs);
  }
  return out;
}

/** `packageConfigs` as repo-relative posix LABELS — the candidate roots the `list` inactive-registry
 *  disclosure (§3.6) names (a nested dir with its own `package.json`, the only kind that autodetects a
 *  framework plugin as its own `root:<dir>`). */
export function packageConfigLabels(
  root: string,
  repoTsconfigs: readonly string[],
  primaryConfigPath?: string,
): string[] {
  return packageConfigs(root, repoTsconfigs, primaryConfigPath).map((c) => relLabel(root, c));
}

/** Resolved tsconfig paths a config `references` (a dir → its `tsconfig.json`, a `.json` as-is).
 *  Best-effort: a malformed/unreadable config yields no references rather than throwing. */
function referencePaths(configPath: string): string[] {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const config = read.config as { references?: unknown } | undefined;
  const refs = config?.references;
  if (!Array.isArray(refs)) return [];
  const dir = path.dirname(configPath);
  const out: string[] = [];
  for (const ref of refs) {
    const p = (ref as { path?: unknown }).path;
    if (typeof p !== 'string') continue;
    const resolved = path.resolve(dir, p);
    out.push(toPosix(resolved.endsWith('.json') ? resolved : path.join(resolved, 'tsconfig.json')));
  }
  return out;
}

/** True for a tsconfig basename — `tsconfig.json` or `tsconfig.<name>.json`. The single predicate
 *  behind sibling discovery (source 1), the repo-wide undiscovered scan (`repoTsconfigsFrom`), AND
 *  the `ls-host` reindex cache-invalidation trigger (a tsconfig add/remove in the changed set), so
 *  the three can never drift apart. */
export function isTsconfigBasename(base: string): boolean {
  return base === 'tsconfig.json' || /^tsconfig\..+\.json$/.test(base);
}

export function relLabel(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? toPosix(abs) : toPosix(rel);
}

/** The primary program's provenance label — `relLabel` plus the no-tsconfig fallback. */
export function primaryLabel(root: string, configPath: string | undefined): string {
  return configPath === undefined ? '(no tsconfig)' : relLabel(root, configPath);
}

/** Resolve the tsconfig that drives the primary program: an explicit override (repo-relative), else
 *  the nearest `tsconfig.json` up from the root (`undefined` for a non-TS folder). */
export function resolveConfigPath(root: string, override?: string): string | undefined {
  if (override !== undefined) return path.join(root, override);
  return ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
}

/** Does a reindex changed path alter the discovered/undiscovered PROGRAM set (not just a file's
 *  content)? A `tsconfig*.json` add/remove/edit, OR a `pnpm-workspace.yaml` edit (re-globbing
 *  existing member configs). `package.json` is deliberately NOT here (it churns on every install);
 *  the consequence is a bounded, CONSERVATIVE staleness (a larger undiscovered set → more floored,
 *  never a false `certain`-dead) until the next tsconfig change / respawn. `RepoRelPath` is posix, so
 *  a trailing-segment basename is all we need. */
export function isStructuralConfigChange(rel: RepoRelPath): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return isTsconfigBasename(base) || base === 'pnpm-workspace.yaml';
}

/** Every source-ish file in the repo (repo-relative posix) — the SINGLE §19-bounded walk shared by
 *  `repoTsconfigsFrom` (the undiscovered scan) AND `computeCoverage` (member coverage + stray injection),
 *  so there is ONE repo walk per host lifetime, never one per consumer. Reuses `walkFiles`' §10
 *  name-ignore set (node_modules / dist / build / .next / tool + agent state dirs) — conservative by
 *  construction. A partial walk (unreadable subtree) returns what it found. Host-cached (never per
 *  query, §19). */
export function walkRepoFiles(root: string): string[] {
  return (walkFiles(toPosix(root)).data ?? []).map((f) => f.path);
}

/** The repo's `tsconfig.json` / `tsconfig.*.json` (absolute posix), filtered from the shared walk.
 *  Drives the honest demotion in `find_unused_exports`: this set MINUS the loaded configs (primary +
 *  the adjacent/`references`/member siblings) is the UNDISCOVERED programs — a nested-package tsconfig
 *  codemaster does not build, whose files could reference an export the loaded programs all read as
 *  dead (a false `certain`-dead). Fewer configs (a partial walk) only ever UNDER-demotes. */
export function repoTsconfigsFrom(repoFiles: readonly string[], root: string): string[] {
  const rootPosix = toPosix(root);
  const out: string[] = [];
  for (const rel of repoFiles) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (isTsconfigBasename(base)) out.push(`${rootPosix}/${rel}`);
  }
  return out;
}
