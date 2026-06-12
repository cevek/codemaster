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
  dispose(): void;
}

export function createTsProjectHost(root: string, tsconfigOverride?: string): TsProjectHost {
  let files = new Map<string, { version: number }>(); // abs path (posix) → version
  let projectVersion = 1;

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
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (fileName) => String(files.get(toPosix(fileName))?.version ?? 1),
    getScriptSnapshot: (fileName) => {
      try {
        return ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => readCompilerOptions(root, configPath),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
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

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
