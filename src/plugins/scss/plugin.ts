// The `scss` plugin (§5-L2): owner of SCSS class knowledge. Parses stylesheets with
// postcss-scss (CST, syntactic — §19); usage facts come from the `ts` plugin's
// cross-tier `cssModuleUsages` API (the TS plugin *observes* the imports; this plugin
// asks). State is per-file and rebuilt per-file on reindex.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Plugin, PluginRegistry, FreshnessFingerprint } from '../../core/plugin.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { walkFiles } from '../../support/fs/walk.ts';
import { fileExists } from '../../support/fs/exists.ts';
import { readTextOrAbsent } from '../../support/fs/read-or-absent.ts';
import type { TsPluginApi } from '../ts/plugin.ts';
import { parseScssClasses, type ScssClass } from './parse.ts';
import { parseStylesheetRoot } from './parse-root.ts';
import { classifyForExtract, type ClassVerdict } from './extract-classify.ts';
import { extractRules, type ExtractedRules } from './extract-rules.ts';

// Re-export the co-extract shapes ops consume so they go through the plugin's public surface.
export type { ClassVerdict, LeftBehindCode } from './extract-classify.ts';

type ClassifyResult =
  | { ok: true; verdicts: Map<string, ClassVerdict> }
  | { ok: false; message: string };

type ExtractRulesResult = { ok: true; sheets: ExtractedRules } | { ok: false; message: string };

export type ScssClassView = {
  name: string;
  file: string;
  span: Span;
  /** 'partial' when the declaring selector used interpolation (§19). */
  confidence: Confidence;
};

export type UnusedClassView = ScssClassView & {
  /** Why this can only be claimed partially (e.g. dynamic accesses in importers). */
  note?: string;
};

export type UnusedScssView = {
  unused: UnusedClassView[];
  /** Modules whose importers use computed access — their classes can't be proven
   *  unused (§3.3: dynamic is flagged, never bridged). */
  dynamicModules: string[];
  scannedModules: number;
  scannedClasses: number;
};

export interface ScssPluginApi extends Plugin {
  classes(file?: string): ScssClassView[];
  unusedClasses(): UnusedScssView;
  parseFailures(): ReadonlyMap<RepoRelPath, string>;
  /** Co-extract safety taxonomy (spec-css-coextract §2.7): classify each candidate class in
   *  `file` as safe-to-move or left-behind-with-a-code. `usedInRemaining` are the classes the
   *  post-extract source still references (so they stay). Reads the sheet fresh; a parse
   *  failure is returned, never thrown (§3.6). */
  classifyForExtract(
    file: RepoRelPath,
    classNames: readonly string[],
    usedInRemaining: ReadonlySet<string>,
  ): ClassifyResult;
  /** Co-extract rule transform (spec-css-coextract §2.4): clone the rules owned by the
   *  `safeClassNames` (with their leading comments) into a fresh sheet, and return the source
   *  sheet with those rules removed. Pure — the op writes both strings. A parse failure is
   *  returned, never thrown (§3.6). */
  extractRules(file: RepoRelPath, safeClassNames: readonly string[]): ExtractRulesResult;
}

export function createScssPlugin(root: string): ScssPluginApi {
  let registry: PluginRegistry | undefined;
  let state: Map<RepoRelPath, ScssClass[]> | undefined;
  const failures = new Map<RepoRelPath, string>();
  let version = 0;

  const parseOne = (rel: RepoRelPath): ScssClass[] => {
    const read = readTextOrAbsent(root, rel);
    // ENOENT is absence (a watcher race), not a failure; a real IO error is recorded so an
    // unreadable stylesheet never reads as "no classes" (§3.6).
    if (read.kind === 'absent') {
      failures.delete(rel);
      return [];
    }
    if (read.kind === 'error') {
      failures.set(rel, read.message);
      return [];
    }
    const parsed = parseScssClasses(rel, read.text);
    if (!parsed.ok) {
      failures.set(rel, parsed.message);
      return [];
    }
    failures.delete(rel);
    return parsed.classes;
  };

  const warm = (): Map<RepoRelPath, ScssClass[]> => {
    if (state === undefined) {
      state = new Map();
      const walked = walkFiles(root);
      const files = walked.ok ? walked.data : (walked.data ?? []);
      for (const f of files) {
        if (!f.path.endsWith('.scss')) continue;
        state.set(f.path, parseOne(f.path));
      }
      version++;
    }
    return state;
  };

  const toView = (rel: RepoRelPath, c: ScssClass): ScssClassView => ({
    name: c.name,
    file: rel,
    span: c.span,
    confidence: c.partial ? 'partial' : 'certain',
  });

  return {
    id: 'scss',
    version: '0.1.0',
    deps: ['ts'],

    init(deps) {
      registry = deps;
      return Promise.resolve();
    },
    dispose() {
      state = undefined;
      return Promise.resolve();
    },
    freshness(): FreshnessFingerprint {
      return state === undefined ? 'cold' : `v${version}`;
    },
    reindex(changed) {
      if (state === undefined) return Promise.resolve();
      let touched = false;
      for (const rel of changed) {
        if (!rel.endsWith('.scss')) continue;
        touched = true;
        const classes = parseOne(rel);
        if (classes.length === 0 && !fileExists(root, rel)) state.delete(rel);
        else state.set(rel, classes);
      }
      if (touched) version++;
      return Promise.resolve();
    },
    pending: () => [],

    classes(file) {
      const all = warm();
      const views: ScssClassView[] = [];
      for (const [rel, classes] of all) {
        if (file !== undefined && rel !== file) continue;
        for (const c of classes) views.push(toView(rel, c));
      }
      return views;
    },

    unusedClasses() {
      const all = warm();
      if (registry === undefined) throw new Error('scss plugin not initialized');
      const ts = registry.get<TsPluginApi>('ts');
      const usages = ts.cssModuleUsages();

      const unused: UnusedClassView[] = [];
      const dynamicModules: string[] = [];
      let scannedClasses = 0;
      for (const [rel, classes] of all) {
        scannedClasses += classes.length;
        const accesses = usages.byModule.get(rel) ?? [];
        const hasDynamic = accesses.some((a) => a.confidence === 'dynamic');
        if (hasDynamic) dynamicModules.push(rel);
        const used = new Set(accesses.filter((a) => a.className !== '').map((a) => a.className));
        for (const c of classes) {
          if (used.has(c.name)) continue;
          unused.push({
            ...toView(rel, c),
            confidence: hasDynamic || c.partial ? 'partial' : 'certain',
            ...(hasDynamic
              ? { note: 'importer uses computed access — cannot prove unused' }
              : c.partial
                ? { note: 'declared via interpolated selector' }
                : {}),
          });
        }
      }
      return { unused, dynamicModules, scannedModules: all.size, scannedClasses };
    },

    parseFailures: () => failures,

    classifyForExtract(file, classNames, usedInRemaining): ClassifyResult {
      const parsed = readAndParse(root, file);
      if (!parsed.ok) return { ok: false, message: parsed.message };
      // The taxonomy walk (selector parsing) must not escape as a throw — these methods
      // promise a Result, and the co-extract op relies on that to stay total (§3.6).
      try {
        return { ok: true, verdicts: classifyForExtract(parsed.root, classNames, usedInRemaining) };
      } catch (thrown) {
        return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
      }
    },

    extractRules(file, safeClassNames): ExtractRulesResult {
      const parsed = readAndParse(root, file);
      if (!parsed.ok) return { ok: false, message: parsed.message };
      // CST clone/serialize can throw on a pathological tree — return it, never throw.
      try {
        return { ok: true, sheets: extractRules(parsed.root, safeClassNames, file) };
      } catch (thrown) {
        return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
      }
    },
  };
}

/** Read a stylesheet from disk and parse it to a CST `Root`. A read OR parse failure is
 *  returned, never thrown (§3.6) — the co-extract op leaves every class behind on failure. */
function readAndParse(root: string, file: RepoRelPath): ReturnType<typeof parseStylesheetRoot> {
  let source: string;
  try {
    source = readFileSync(path.join(root, file), 'utf8');
  } catch (thrown) {
    return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
  }
  return parseStylesheetRoot(source, file);
}
