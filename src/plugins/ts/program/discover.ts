// Discover the repo's OTHER tsconfigs so their programs can be loaded beside the primary one
// (spec Task G scope-IN 1). The warm LS compiles ONE tsconfig; a symbol used only from a file in
// a sibling program (the near-universal `tsconfig.test.json`, Vite's `tsconfig.app.json` +
// `tsconfig.node.json`, build scripts) reads as having NO usage — the honesty gap this closes.
//
// Three sources, all bounded (a fixed cap + a visited set — discovery runs ONCE and is cached by
// the host, never per query: a per-query directory scan is the §19 hang this project forbids):
//   1. sibling `tsconfig*.json` files in the primary config's directory;
//   2. workspace-MEMBER `tsconfig*.json` — a dir matched by the repo's `pnpm-workspace.yaml` /
//      `package.json` `workspaces` globs AND holding a `package.json` (the actual member definition;
//      a pnpm/vite monorepo wires packages by GLOB, not `references`, so members are otherwise
//      undiscovered and every cross-package query is floored — dogfood-jul Ask 1);
//   3. `references` followed transitively from each discovered config (what a composite repo wires).
// This is plain DISCOVERY — we load each as its own independent program. The project-reference
// REDIRECT machinery (composite build graph) is the monorepo story the spec scopes OUT.

import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { matchesAnyGlob } from '../../../common/glob/match.ts';
import { toPosix } from '../../../support/fs/canonicalize.ts';
import { hasIgnoredDirSegment } from '../../../support/fs/ignored-paths.ts';
import { walkFiles } from '../../../support/fs/walk.ts';
import { readWorkspaceGlobs } from './workspace-globs.ts';

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

  // Source 2: workspace-member `tsconfig*.json` (dogfood-jul Ask 1) — the ONLY discovery source when
  // the primary is undefined, so a no-root monorepo's members load as independent programs.
  for (const abs of workspaceMemberConfigs(root, repoTsconfigs)) add(abs);

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

/** The subset of `repoTsconfigs` that are workspace members: a `tsconfig*.json` whose DIRECTORY is
 *  matched by a positive workspace glob, not matched by a negative (`!`) one, AND holds a
 *  `package.json` (the real npm/pnpm member definition — a dir-glob match alone over-discovers a
 *  nested non-member tsconfig, esp. under a `**` glob where picomatch's single-segment `*` no longer
 *  bounds it). All inputs are already-walked paths (respecting the §10 ignore set), so this is a pure
 *  in-memory filter — no new fs walk. Iterated in `repoTsconfigs` order for a deterministic result
 *  (cold == warm on a capped repo). */
function workspaceMemberConfigs(root: string, repoTsconfigs: readonly string[]): string[] {
  const { positive, negative } = readWorkspaceGlobs(root);
  if (positive.length === 0) return [];
  const out: string[] = [];
  for (const abs of repoTsconfigs) {
    const rel = relLabel(root, abs);
    if (path.isAbsolute(rel)) continue; // outside the root — never a member
    const memberDir = path.posix.dirname(rel);
    if (!matchesAnyGlob(memberDir, positive)) continue;
    if (negative.length > 0 && matchesAnyGlob(memberDir, negative)) continue;
    if (!existsSync(path.join(root, memberDir, 'package.json'))) continue;
    out.push(abs);
  }
  return out;
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

/** §10 junk predicate over a REPO-RELATIVE posix path — the SAME filter `single.ts` applies to a
 *  built program's file-set (name-based dir segments + the git-ignored set). Applying it to BOTH the
 *  coverage UNION and the required-walk below keeps them symmetric with what the programs actually
 *  contain (no phantom strays) AND makes the floor consistent with the gitignored-file decision: a
 *  gitignored file is OUT of the source surface (never a stray), a git-tracked `.ts` in no program IS
 *  in the surface → floored. */
function isJunk(rel: string, ignored: ReadonlySet<string>): boolean {
  return hasIgnoredDirSegment(rel) || ignored.has(rel);
}

/** TS-source extensions a tsconfig `include` owns by default (`.d.ts` ⊂ `.ts$`). `.js/.jsx` are
 *  `allowJs`-conditional, so requiring their coverage would floor on tooling JS no program intends to
 *  own — excluded to keep the floor precise (a genuinely allowJs'd `.js` under a member IS globbed by
 *  its config, so it lands in the union either way and never reads as a stray). */
const TS_SOURCE_RE = /\.(ts|tsx|cts|mts)$/;

/** Discovered configs safe to SUBTRACT from the undiscovered floor (posix abs). A config qualifies
 *  iff it covers files/`references` AND — when it is a workspace MEMBER — every git-tracked TS-source
 *  file physically under its package directory lands in the UNION of the loaded programs' file-sets
 *  (primary + every discovered config, the set `built()` compiles). A member covering SOME of its
 *  files but STRAYING others (an uncovered `lib/foo.ts` no program globs) is NOT returned → it stays
 *  in the floor (complete:false), never a claimed-complete result over a git-tracked file no program
 *  searches (§3.4 the one honest→lying direction). A zero-coverage member (empty `include`, no refs)
 *  is likewise never returned. SYNTACTIC + ONE bounded pass: `parseJsonConfigFileContent` globs the
 *  file LIST without building/type-checking (no sibling warm, §9), the shared repo walk supplies the
 *  member files, and the whole thing runs once per undiscovered memo — never the LS hot path (§19).
 *  Order-independent (set membership only) → cold == warm. */
export function coveredConfigPaths(
  root: string,
  /** The primary program's already-§10-filtered file-set (`primary.fileNames()` — no LS warm). */
  primaryFileNames: readonly string[],
  discovered: readonly DiscoveredConfig[],
  repoTsconfigs: readonly string[],
  /** Repo-relative posix paths from the shared walk (name-ignored; git-ignore applied here). */
  repoFiles: readonly string[],
  /** The host's memoized git-ignored set (the §10 git arm), computed once per structural reindex. */
  ignored: ReadonlySet<string>,
): Set<string> {
  const rootPosix = toPosix(root);
  // 1. UNION of loaded programs' file-sets: primary (already §10-filtered) ∪ every DISCOVERED
  //    config's SYNTACTIC file-set (no LS build), §10-filtered to match the built program exactly.
  const covered = new Set<string>(primaryFileNames);
  const parsed = new Map<string, string[]>();
  const fileNamesOf = (configPath: string): string[] => {
    const hit = parsed.get(configPath);
    if (hit !== undefined) return hit;
    let out: string[] = [];
    try {
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      const p = ts.parseJsonConfigFileContent(
        read.config ?? {},
        ts.sys,
        path.dirname(configPath),
        undefined,
        configPath,
      );
      out = p.fileNames.map(toPosix).filter((abs) => {
        if (abs.includes('/node_modules/')) return false;
        if (abs.startsWith(`${rootPosix}/`))
          return !isJunk(abs.slice(rootPosix.length + 1), ignored);
        return true;
      });
    } catch {
      out = []; // unreadable/malformed → no coverage (conservative floor)
    }
    parsed.set(configPath, out);
    return out;
  };
  for (const c of discovered) for (const abs of fileNamesOf(toPosix(c.path))) covered.add(abs);

  // 2. Workspace-MEMBER package directories (repo-relative posix). Only members get the file-level
  //    gate — a source-1 sibling adjacent to the primary has no bounded package dir to walk.
  const memberConfigs = new Set(workspaceMemberConfigs(root, repoTsconfigs).map(toPosix));
  const memberDirs = new Set<string>();
  for (const m of memberConfigs) memberDirs.add(path.posix.dirname(relLabel(root, m)));

  // 3. ONE pass over the shared walk: a member dir with a git-tracked TS-source file in NO program is
  //    STRAYING. Bounded by files × path-depth, once per memo (§19) — never per-op.
  const strayDirs = new Set<string>();
  for (const rel of repoFiles) {
    if (!TS_SOURCE_RE.test(rel) || isJunk(rel, ignored)) continue;
    const dir = enclosingMemberDir(rel, memberDirs);
    if (dir !== undefined && !covered.has(`${rootPosix}/${rel}`)) strayDirs.add(dir);
  }

  // 4. Decide per discovered config: covers files/refs, and (if a member) no stray under its dir.
  const safe = new Set<string>();
  for (const c of discovered) {
    const abs = toPosix(c.path);
    if (fileNamesOf(abs).length === 0 && !declaresReferences(abs)) continue; // covers nothing → floor
    if (memberConfigs.has(abs) && strayDirs.has(path.posix.dirname(relLabel(root, abs)))) continue;
    safe.add(abs);
  }
  return safe;
}

/** The DEEPEST member directory enclosing `fileRel` (walk-up prefix, bounded by path depth), or
 *  undefined when the file is under no member. */
function enclosingMemberDir(fileRel: string, memberDirs: ReadonlySet<string>): string | undefined {
  let dir = path.posix.dirname(fileRel);
  while (dir !== '.' && dir !== '' && dir !== '/') {
    if (memberDirs.has(dir)) return dir;
    const parent = path.posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Does this tsconfig declare a non-empty `references` array (a hub delegating to child programs)? */
function declaresReferences(configPath: string): boolean {
  try {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const refs = (read.config as { references?: unknown } | undefined)?.references;
    return Array.isArray(refs) && refs.length > 0;
  } catch {
    return false;
  }
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

/** Every source-ish file in the repo (repo-relative posix) — the SINGLE §19-bounded walk shared by
 *  `repoTsconfigsFrom` (the undiscovered scan) AND `coveredConfigPaths` (member file-level coverage),
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
