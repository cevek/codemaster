// The undiscovered-floor coverage proof + workspace-member stray injection (t-232769, building on
// t-816306 member discovery / t-851482 coverage-proof). Answers ONE honest question per repo:
// "is every git-tracked TS-source file searched by a program that resolves its imports CORRECTLY?"
//
// The load-bearing rule is the CORRECT-RESOLUTION UNION: a file counts as covered ONLY when a
// program with real compilerOptions (a member/sibling tsconfig, or the primary when it HAS a config)
// contains it — the no-config FALLBACK primary (whole-repo glob under NO paths/baseUrl) is EXCLUDED.
// Counting fallback-globbed files would resurrect the exact t-816306 lie: a file "covered" but whose
// `@x/*` alias imports were never resolved → complete:true while its aliased usages went unsearched.
//
// Two outputs from the one bounded pass (syntactic — `parseJsonConfigFileContent`, no LS build; run
// once per undiscovered memo, never the LS hot path §19):
//   • memberStrays — git-tracked source under a workspace MEMBER dir that the member's own `include`
//     omits (e.g. `packages/x/scripts/smoke.ts` under `include:['src']`). Injected into that member's
//     program (single.ts `injectedFiles`) so it compiles under the member's OWN options → correct
//     alias resolution. This is the ONLY un-floor lever: a stray under NO member is never injected.
//   • safe — the tsconfigs to SUBTRACT from the undiscovered floor: any whose entire (non-empty)
//     TS-source glob ⊆ the correct-resolution union (incl. the injected strays), i.e. a redundant
//     base/extends config (`tsconfig.base.json`) whose files are all already searched correctly. A
//     config globbing ANY file OUTSIDE the union (an uncovered orphan, or a fallback-only file whose
//     aliases were never resolved) STAYS floored — by construction, on ANY repo, not by coincidence.

import * as path from 'node:path';
import ts from 'typescript';
import { toPosix } from '../../../support/fs/canonicalize.ts';
import { isJunkRelPath } from '../../../support/fs/ignored-paths.ts';
import { relLabel, workspaceMemberConfigs, type DiscoveredConfig } from './discover.ts';

/** TS-source extensions a tsconfig `include` owns by default (`.d.ts` ⊂ `.ts$`). `.js/.jsx` are
 *  `allowJs`-conditional, so requiring their coverage would floor on tooling JS no program intends to
 *  own — excluded to keep the floor precise (a genuinely allowJs'd `.js` under a member IS globbed by
 *  its config, so it lands in the union either way and never reads as a stray). */
const TS_SOURCE_RE = /\.(ts|tsx|cts|mts)$/;

export interface Coverage {
  /** Config paths (posix abs) to SUBTRACT from the undiscovered floor. */
  safe: Set<string>;
  /** Workspace-member config path (posix abs) → its injected stray files (posix abs), to compile in
   *  that member's program (`createSingleProgram` `injectedFiles`) under the member's own options. */
  memberStrays: Map<string, string[]>;
}

/** Compute the coverage proof for the undiscovered floor + the per-member stray injection sets.
 *  Order-independent (set membership only) → cold == warm on a capped repo. */
export function computeCoverage(
  root: string,
  /** The REAL-config primary's §10-filtered file-set (`primary.fileNames()`), or `[]` when the
   *  primary is the no-config fallback — which is EXCLUDED from the correct-resolution union. */
  primaryFileNames: readonly string[],
  discovered: readonly DiscoveredConfig[],
  repoTsconfigs: readonly string[],
  /** Repo-relative posix paths from the shared walk (name-ignored; git-ignore applied here). */
  repoFiles: readonly string[],
  /** The host's memoized git-ignored set (the §10 git arm), computed once per structural reindex. */
  ignored: ReadonlySet<string>,
): Coverage {
  const rootPosix = toPosix(root);
  const abs = (rel: string): string => `${rootPosix}/${rel}`;

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
      out = p.fileNames.map(toPosix).filter((f) => {
        if (f.includes('/node_modules/')) return false;
        if (!TS_SOURCE_RE.test(f)) return false;
        if (f.startsWith(`${rootPosix}/`))
          return !isJunkRelPath(f.slice(rootPosix.length + 1), ignored);
        return true;
      });
    } catch {
      out = []; // unreadable/malformed → no coverage (conservative floor)
    }
    parsed.set(configPath, out);
    return out;
  };

  // 1. Correct-resolution union: the real-config primary (fallback passed as []) ∪ every DISCOVERED
  //    config's syntactic TS-source set. Every entry is resolved under real options.
  const covered = new Set<string>(primaryFileNames.filter((f) => TS_SOURCE_RE.test(f)));
  for (const c of discovered) for (const f of fileNamesOf(toPosix(c.path))) covered.add(f);

  // 2. Member dir → its config path (deepest-enclosing lookup below).
  const memberConfigList = workspaceMemberConfigs(root, repoTsconfigs).map(toPosix);
  const memberConfigs = new Set(memberConfigList);
  const memberDirToConfig = new Map<string, string>();
  for (const m of memberConfigList) memberDirToConfig.set(path.posix.dirname(relLabel(root, m)), m);
  const memberDirs = new Set(memberDirToConfig.keys());

  // 3. Member strays: a git-tracked TS-source file under a member dir that the DEEPEST-enclosing
  //    member's OWN config does not glob → injected into THAT member → searched under the member's OWN
  //    options (correct alias resolution). The gate is the member's OWN glob, NOT the whole `covered`
  //    union: a file an ANCESTOR loose-root globs with the WRONG options (no member `paths`) is STILL
  //    injected into its member, else its alias-imports resolve only under the ancestor (they don't)
  //    and the usage is silently missed while the member un-floors — the wrong-options coverage lie.
  //    Added to `covered` (post-injection it IS correctly covered). A file under NO member is NEVER
  //    injected — it stays out of the union (the anti-lie floor).
  //    POLLUTION GATE: a stray is injected ONLY when it is a plain external MODULE with no program-wide
  //    type-space augmentation. A file carrying `declare global`/`declare module '…'`, or a non-module
  //    SCRIPT (whose top-level decls are global), would — once in the member's program — SHIFT the
  //    reported type of the member's OWN src symbols (`expand_type` would show a type the member's real
  //    tsconfig never yields, the never-lie violation §3). Such a stray is NOT injected and its member
  //    STAYS floored (`strayFloored`): honestly unsearched beats a lie about a src symbol's type.
  const ownGlobs = new Map<string, Set<string>>();
  const ownGlobOf = (cfg: string): Set<string> => {
    let s = ownGlobs.get(cfg);
    if (s === undefined) ownGlobs.set(cfg, (s = new Set(fileNamesOf(cfg))));
    return s;
  };
  const memberStrays = new Map<string, string[]>();
  const strayFloored = new Set<string>(); // members with an un-injectable (polluting) stray
  for (const rel of repoFiles) {
    if (!TS_SOURCE_RE.test(rel) || isJunkRelPath(rel, ignored)) continue;
    const a = abs(rel);
    const dir = enclosingMemberDir(rel, memberDirs);
    if (dir === undefined) continue;
    const cfg = memberDirToConfig.get(dir);
    if (cfg === undefined || ownGlobOf(cfg).has(a)) continue;
    if (!isInjectableStray(a)) {
      strayFloored.add(cfg); // an unsearched stray remains under this member → keep it floored
      continue;
    }
    const list = memberStrays.get(cfg);
    if (list === undefined) memberStrays.set(cfg, [a]);
    else list.push(a);
    covered.add(a);
  }

  // 4. Decide, per tsconfig, whether it is subtracted from the undiscovered floor:
  //    • a workspace MEMBER is DIR-based — every git-tracked TS-source under its dir is in the union
  //      post-injection (we inject ALL INJECTABLE member-dir strays), so it is safe iff it covers
  //      SOMETHING (its own src, a `references` hub, or an injected stray) AND has no un-injectable
  //      (polluting) stray left unsearched. A member covering literally nothing, or one straying a
  //      file we cannot safely inject, stays floored.
  //    • a NON-member (a base/extends config like `tsconfig.base.json`, or an undiscovered nested
  //      config) is GLOB-based — safe iff its entire non-empty TS-source glob ⊆ the correct-resolution
  //      union (all its files are already searched correctly), else floored. A config globbing a
  //      fallback-only file (aliases never resolved) or an uncovered orphan stays floored, ANY repo.
  const safe = new Set<string>();
  for (const cfg of repoTsconfigs) {
    const glob = fileNamesOf(cfg);
    if (memberConfigs.has(cfg)) {
      const covers = glob.length > 0 || memberStrays.has(cfg) || declaresReferences(cfg);
      if (covers && !strayFloored.has(cfg)) safe.add(cfg);
      continue;
    }
    if (glob.length === 0) {
      if (declaresReferences(cfg)) safe.add(cfg);
      continue;
    }
    if (glob.every((f) => covered.has(f))) safe.add(cfg);
  }
  return { safe, memberStrays };
}

/** Is this stray SAFE to inject into a member's program — i.e. a plain external MODULE whose
 *  declarations stay module-scoped? Returns false for anything that would leak into the program's
 *  GLOBAL type-space and shift the member's OWN src symbols' reported types (the never-lie violation):
 *  a `declare global {}` (global augmentation), a `declare module '…' {}` (module augmentation), or a
 *  non-module SCRIPT (no import/export → its top-level decls ARE global). One bounded `createSourceFile`
 *  per candidate stray, once per coverage memo (§19) — never the LS hot path. Unreadable/parse-fail →
 *  false (conservative: don't inject, keep the member floored). */
function isInjectableStray(absPosix: string): boolean {
  let text: string | undefined;
  try {
    text = ts.sys.readFile(absPosix);
  } catch {
    text = undefined;
  }
  if (text === undefined) return false;
  const sf = ts.createSourceFile(absPosix, text, ts.ScriptTarget.Latest, false);
  if (!ts.isExternalModule(sf)) return false; // a SCRIPT — top-level declarations are GLOBAL
  for (const st of sf.statements) {
    if (!ts.isModuleDeclaration(st)) continue;
    if ((st.flags & ts.NodeFlags.GlobalAugmentation) !== 0) return false; // `declare global { … }`
    if (ts.isStringLiteral(st.name)) return false; // `declare module '…' { … }`
  }
  return true;
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
