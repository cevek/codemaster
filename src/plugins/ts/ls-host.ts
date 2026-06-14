// The long-lived LanguageService over a versioned disk-backed host (§5-L2). Lazy
// warm: building the host parses tsconfig + file list; types compute only when a
// semantic query runs. `reindex` bumps script versions for changed files and rescans
// the file list (adds/removes), so the LS reuses everything untouched.
//
// Phase-1 simplification, stated honestly: codemaster's own bundled `typescript`
// drives the service (the project's own TS via project-resolution is roadmap §19 —
// `status` reports which is active through `version`), and a monorepo runs the root
// tsconfig only (project references land with §9's per-package Programs).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import { toPosix } from '../../support/fs/canonicalize.ts';
import { Overlay, type OverlayEntry } from './vfs/overlay.ts';

export interface TsProjectHost {
  readonly service: ts.LanguageService;
  readonly configPath: string | undefined;
  /** Repo-relative posix path → absolute path, for every tracked file. */
  fileNames(): readonly string[];
  absOf(rel: RepoRelPath): string;
  relOf(abs: string): RepoRelPath;
  isTracked(rel: RepoRelPath): boolean;
  reindex(changed: readonly RepoRelPath[]): void;
  /** Monotonic project version — bumps whenever anything changes. */
  projectVersion(): number;
  /** Best-effort fallback LanguageService from the patched TS fork (§4 rescue) — for the
   *  extract refactors the stock LS asserts on (e.g. an extracted block using a css-module
   *  member). Built lazily over the SAME host state and cached. `undefined` when the fork
   *  can't load or its major doesn't match the bundled TS (version coupling → degrade
   *  honestly, never a wrong edit). */
  rescueService(): ts.LanguageService | undefined;
  /** Overlay post-edit content (and tombstone moved-away `removed` paths) so the LS
   *  typechecks unsaved source (§2.7). Inert when empty — reads resolve exactly as from
   *  disk. Always paired with a `clear`. */
  setOverlay(entries: readonly OverlayEntry[], removed?: readonly RepoRelPath[]): void;
  clearOverlay(): void;
  dispose(): void;
}

export function createTsProjectHost(root: string, tsconfigOverride?: string): TsProjectHost {
  let files = new Map<string, { version: number }>(); // abs path (posix) → version
  let projectVersion = 1;
  const overlay = new Overlay();

  const configPath = resolveConfigPath(root, tsconfigOverride);
  // Parse the tsconfig ONCE and cache it. The LS calls `getCompilationSettings` on every
  // synchronize / module-resolution pass; re-parsing there reruns `parseJsonConfigFileContent`'s
  // recursive whole-tree directory scan each time → O(LS-calls × tree-scan) = an unbounded HANG
  // on a large repo (tiny test fixtures made each re-parse instant, so it never surfaced). We
  // re-parse only on a structural reindex (`loadFileList`), where a re-glob IS the intent.
  let parsed: ts.ParsedCommandLine;
  const loadFileList = (): void => {
    parsed = parseConfig(root, configPath); // (re-)glob the project: picks up added/removed files
    const next = new Map<string, { version: number }>();
    for (const abs of parsed.fileNames.map(toPosix).filter((f) => !f.includes('/node_modules/'))) {
      next.set(abs, files.get(abs) ?? { version: 1 });
    }
    files = next;
    projectVersion++;
  };
  loadFileList();

  // The host is parameterised on a typescript namespace `tsm` so the §4 rescue can stand up a
  // SECOND LS from the patched fork over the SAME file/overlay state — using the fork's
  // ScriptSnapshot / sys / lib path, never the stock module's, so the two never cross-feed.
  const makeServicesHost = (tsm: typeof ts): ts.LanguageServiceHost => ({
    // Overlay files join the script set so a synthetic (overlay-only) file is visible to
    // the LS even when not on disk; tombstoned (moved-away) paths drop out so a stale
    // import dangles. For an in-place rename the overlay ⊆ tracked files, removed is empty.
    getScriptFileNames: () =>
      [...new Set([...files.keys(), ...overlay.keys()])].filter((f) => !overlay.isRemoved(f)),
    getScriptVersion: (fileName) => {
      const posix = toPosix(fileName);
      const over = overlay.get(posix);
      // A distinct, monotonic token while overlaid → the LS re-reads; reverts to the disk
      // version on clear (also distinct from the last overlay token, forcing a re-read).
      if (over !== undefined) return `o${over.version}`;
      return String(files.get(posix)?.version ?? 1);
    },
    getScriptSnapshot: (fileName) => {
      const posix = toPosix(fileName);
      if (overlay.isRemoved(posix)) return undefined;
      const over = overlay.get(posix);
      if (over !== undefined) return tsm.ScriptSnapshot.fromString(over.content);
      try {
        return tsm.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => parsed.options, // cached — never re-parse on the hot path (above)
    getDefaultLibFileName: (options) => tsm.getDefaultLibFilePath(options),
    fileExists: (fileName) => {
      const posix = toPosix(fileName);
      if (overlay.isRemoved(posix)) return false; // tombstoned: the moved-away source is gone
      return overlay.has(posix) || tsm.sys.fileExists(fileName);
    },
    readFile: (fileName, encoding) => {
      const posix = toPosix(fileName);
      if (overlay.isRemoved(posix)) return undefined;
      const over = overlay.get(posix);
      return over !== undefined ? over.content : tsm.sys.readFile(fileName, encoding);
    },
    readDirectory: tsm.sys.readDirectory,
    directoryExists: (dir) => overlay.hasDirectory(toPosix(dir)) || tsm.sys.directoryExists(dir),
    getDirectories: tsm.sys.getDirectories,
    getProjectVersion: () => String(projectVersion),
  });

  const service = ts.createLanguageService(makeServicesHost(ts), ts.createDocumentRegistry());

  // Rescue LS — `undefined` = not yet attempted, `null` = attempted & unavailable, else the
  // built service. Lazy + cached: only stood up the first time an extract asserts.
  let rescue: ts.LanguageService | null | undefined;
  const rescueService = (): ts.LanguageService | undefined => {
    if (rescue !== undefined) return rescue ?? undefined;
    const fix = loadRescueTs();
    if (fix === undefined) {
      rescue = null;
      return undefined;
    }
    rescue = fix.createLanguageService(makeServicesHost(fix), fix.createDocumentRegistry());
    return rescue;
  };

  return {
    service,
    configPath,
    fileNames: () => [...files.keys()],
    absOf: (rel) => path.join(root, rel),
    relOf: (abs) => {
      const posix = toPosix(abs);
      const prefix = `${toPosix(root)}/`;
      return (posix.startsWith(prefix) ? posix.slice(prefix.length) : posix) as RepoRelPath;
    },
    isTracked: (rel) => files.has(toPosix(path.join(root, rel))),
    reindex(changed) {
      let structural = false;
      for (const rel of changed) {
        const abs = toPosix(path.join(root, rel));
        const entry = files.get(abs);
        if (entry !== undefined) entry.version++;
        else if (isTsLike(abs)) structural = true; // a new/renamed source file
      }
      projectVersion++;
      if (structural) loadFileList();
    },
    projectVersion: () => projectVersion,
    rescueService,
    setOverlay(entries, removed = []) {
      overlay.set(
        entries.map((e) => ({ abs: toPosix(e.abs), content: e.content })),
        removed.map((r) => toPosix(path.join(root, r))),
      );
      projectVersion++;
    },
    clearOverlay() {
      overlay.clear();
      projectVersion++;
    },
    dispose() {
      service.dispose();
      if (rescue !== null && rescue !== undefined) rescue.dispose();
    },
  };
}

/** Load the patched TS fork (§4 rescue) from codemaster's OWN node_modules. Returns the
 *  namespace only when it loads AND its major version matches the bundled TS — a major
 *  mismatch means the fork's refactor edits may not align with the project's own TS, so we
 *  decline (the rescue is best-effort; an unavailable rescue is an honest failure, never a
 *  wrong edit). Any load error degrades to `undefined`. */
function loadRescueTs(): typeof ts | undefined {
  try {
    const fix = createRequire(import.meta.url)(
      '@cevek/typescript-extract-refactor-fix',
    ) as typeof ts;
    if (typeof fix.createLanguageService !== 'function' || typeof fix.version !== 'string') {
      return undefined;
    }
    if (fix.version.split('.')[0] !== ts.version.split('.')[0]) return undefined;
    return fix;
  } catch {
    return undefined;
  }
}

function resolveConfigPath(root: string, override?: string): string | undefined {
  if (override !== undefined) return path.join(root, override);
  return ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
}

function parseConfig(root: string, configPath: string | undefined): ts.ParsedCommandLine {
  if (configPath === undefined) {
    return {
      options: { allowJs: true, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      fileNames: ts.sys
        .readDirectory(root, ['.ts', '.tsx', '.js', '.jsx'], ['node_modules', 'dist', 'build'], [])
        .map(toPosix),
      errors: [],
    };
  }
  const text = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(
    text.config ?? {},
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
}

function isTsLike(p: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts)$/.test(p);
}
