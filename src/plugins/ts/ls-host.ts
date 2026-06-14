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
  const loadFileList = (): void => {
    const next = new Map<string, { version: number }>();
    for (const abs of readProjectFileNames(root, configPath)) {
      const prev = files.get(abs);
      next.set(abs, prev ?? { version: 1 });
    }
    files = next;
    projectVersion++;
  };
  loadFileList();

  const servicesHost: ts.LanguageServiceHost = {
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
      if (over !== undefined) return ts.ScriptSnapshot.fromString(over.content);
      try {
        return ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => readCompilerOptions(root, configPath),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName) => {
      const posix = toPosix(fileName);
      if (overlay.isRemoved(posix)) return false; // tombstoned: the moved-away source is gone
      return overlay.has(posix) || ts.sys.fileExists(fileName);
    },
    readFile: (fileName, encoding) => {
      const posix = toPosix(fileName);
      if (overlay.isRemoved(posix)) return undefined;
      const over = overlay.get(posix);
      return over !== undefined ? over.content : ts.sys.readFile(fileName, encoding);
    },
    readDirectory: ts.sys.readDirectory,
    directoryExists: (dir) => overlay.hasDirectory(toPosix(dir)) || ts.sys.directoryExists(dir),
    getDirectories: ts.sys.getDirectories,
    getProjectVersion: () => String(projectVersion),
  };

  const service = ts.createLanguageService(servicesHost, ts.createDocumentRegistry());

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
    },
  };
}

function resolveConfigPath(root: string, override?: string): string | undefined {
  if (override !== undefined) return path.join(root, override);
  return ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
}

function readProjectFileNames(root: string, configPath: string | undefined): string[] {
  const parsed = parseConfig(root, configPath);
  return parsed.fileNames.map(toPosix).filter((f) => !f.includes('/node_modules/'));
}

function readCompilerOptions(root: string, configPath: string | undefined): ts.CompilerOptions {
  return parseConfig(root, configPath).options;
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
