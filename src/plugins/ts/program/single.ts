// ONE LanguageService over ONE tsconfig — the unit the multi-program host (`../ls-host.ts`)
// composes (§9 "one Program per package tsconfig, each keeping its own compilerOptions" — a flat
// single-options Program would be a lie). Owns this program's file list (versioned, disk-backed),
// its overlay (dry-run shadow), and its own monotonic version. Lazy: building the LS object parses
// the tsconfig + globs the file list once; the program's types compute only when a query runs.
//
// The tsconfig parse is cached and re-run ONLY on a structural reindex (a re-glob IS the intent
// then) — never on the LS hot path (`getCompilationSettings` is called every synchronize pass; a
// per-call re-parse recursively directory-scans the whole tree → an unbounded HANG, the
// backoffice2 incident; see ls-host-config-cache.test.ts).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import ts from 'typescript';
import type { RepoRelPath } from '../../../core/brands.ts';
import { toPosix } from '../../../support/fs/canonicalize.ts';
import { Overlay, type OverlayEntry } from '../vfs/overlay.ts';

/** One queryable TS program (an LS over a single tsconfig) plus the bookkeeping the host needs
 *  to keep it fresh. Public methods only; the LS host internals stay private. */
export interface SingleProgram {
  /** The live LanguageService — the §3.1 oracle for this program. */
  readonly service: ts.LanguageService;
  /** The tsconfig this program compiles (absolute), or `undefined` for the no-config fallback. */
  readonly configPath: string | undefined;
  /** Short provenance label, e.g. `tsconfig.json` / `tsconfig.test.json` — surfaced in status so
   *  an agent knows which sibling program a cross-program usage came from. */
  readonly label: string;
  getProgram(): ts.Program | undefined;
  /** Every tracked file (absolute posix). */
  fileNames(): readonly string[];
  /** Is `absPosix` part of this program's tracked file set (config glob)? */
  isTracked(absPosix: string): boolean;
  /** Is `absPosix` a source file in the BUILT program right now (drives the cross-program
   *  fan-out: only run findReferences on programs that actually contain the decl file)? */
  containsFile(absPosix: string): boolean;
  /** Apply a changed set; returns `true` when the change was structural for THIS program (a
   *  tracked file added/removed → the file list was re-globbed). */
  reindex(changed: readonly RepoRelPath[]): boolean;
  /** This program's monotonic version (bumps on every reindex/overlay) — folds into the host's
   *  aggregate freshness fingerprint. */
  version(): number;
  /** Best-effort patched-TS-fork LS (§4 rescue) over the SAME state, lazily built + cached. */
  rescueService(): ts.LanguageService | undefined;
  setOverlay(entries: readonly OverlayEntry[], removed?: readonly RepoRelPath[]): void;
  clearOverlay(): void;
  withMergedOverlay<T>(
    entries: readonly OverlayEntry[],
    removed: readonly RepoRelPath[],
    fn: () => T,
  ): T;
  dispose(): void;
}

/** Build a single-program LS over `configPath`. The stock service shares `registry` with the
 *  host's other programs (the tsserver dedup: files common to two configs parse once — bounded by
 *  program count, not free; a config that changes target/module/jsx buckets separately). The §4
 *  rescue fork keeps its OWN registry — the two namespaces must never cross-feed. */
export function createSingleProgram(
  root: string,
  configPath: string | undefined,
  label: string,
  registry: ts.DocumentRegistry,
): SingleProgram {
  let files = new Map<string, { version: number }>(); // abs posix → version
  let version = 1;
  const overlay = new Overlay();

  let parsed: ts.ParsedCommandLine;
  const loadFileList = (): void => {
    parsed = parseConfig(root, configPath); // (re-)glob: picks up added/removed files
    const next = new Map<string, { version: number }>();
    for (const abs of parsed.fileNames.map(toPosix).filter((f) => !f.includes('/node_modules/'))) {
      next.set(abs, files.get(abs) ?? { version: 1 });
    }
    files = next;
    version++;
  };
  loadFileList();

  const makeServicesHost = (tsm: typeof ts): ts.LanguageServiceHost => ({
    getScriptFileNames: () =>
      [...new Set([...files.keys(), ...overlay.keys()])].filter((f) => !overlay.isRemoved(f)),
    getScriptVersion: (fileName) => {
      const posix = toPosix(fileName);
      const over = overlay.get(posix);
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
    getCompilationSettings: () => parsed.options, // cached — never re-parse on the hot path
    getDefaultLibFileName: (options) => tsm.getDefaultLibFilePath(options),
    fileExists: (fileName) => {
      const posix = toPosix(fileName);
      if (overlay.isRemoved(posix)) return false;
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
    getProjectVersion: () => String(version),
    // Canonicalize symlinks exactly like `tsc`/`createProgram` (`realpath: sys.realpath`); a
    // LanguageServiceHost that omits it loads a pnpm package under two paths and its types stop
    // unifying (ls-host-symlink.test.ts). A synthetic overlay/removed path realpaths to itself.
    realpath: (fileName) => {
      try {
        return tsm.sys.realpath ? tsm.sys.realpath(fileName) : fileName;
      } catch {
        return fileName;
      }
    },
  });

  const service = ts.createLanguageService(makeServicesHost(ts), registry);

  // Rescue LS — `undefined` = not yet attempted, `null` = attempted & unavailable, else built.
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
    label,
    getProgram: () => service.getProgram(),
    fileNames: () => [...files.keys()],
    isTracked: (absPosix) => files.has(absPosix),
    containsFile: (absPosix) => service.getProgram()?.getSourceFile(absPosix) !== undefined,
    reindex(changed) {
      let structural = false;
      for (const rel of changed) {
        const abs = toPosix(path.join(root, rel));
        const entry = files.get(abs);
        if (entry !== undefined) entry.version++;
        else if (isTsLike(abs)) structural = true; // a new/renamed source file (maybe ours)
      }
      version++;
      if (structural) loadFileList();
      return structural;
    },
    version: () => version,
    rescueService,
    setOverlay(entries, removed = []) {
      overlay.set(
        entries.map((e) => ({ abs: toPosix(e.abs), content: e.content })),
        removed.map((r) => toPosix(path.join(root, r))),
      );
      version++;
    },
    clearOverlay() {
      overlay.clear();
      version++;
    },
    withMergedOverlay(entries, removed, fn) {
      const snap = overlay.snapshot();
      overlay.merge(
        entries.map((e) => ({ abs: toPosix(e.abs), content: e.content })),
        removed.map((r) => toPosix(path.join(root, r))),
      );
      version++;
      try {
        return fn();
      } finally {
        overlay.set(snap.entries, snap.removed);
        version++;
      }
    },
    dispose() {
      service.dispose();
      if (rescue !== null && rescue !== undefined) rescue.dispose();
    },
  };
}

/** Load the patched TS fork (§4 rescue) from codemaster's OWN node_modules — only when it loads
 *  AND its major matches the bundled TS (a mismatch means the fork's edits may not align, so we
 *  decline; an unavailable rescue is an honest failure, never a wrong edit). */
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
