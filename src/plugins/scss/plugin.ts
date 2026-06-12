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
import type { TsPluginApi } from '../ts/plugin.ts';
import { parseScssClasses, type ScssClass } from './parse.ts';

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
}

export function createScssPlugin(root: string): ScssPluginApi {
  let registry: PluginRegistry | undefined;
  let state: Map<RepoRelPath, ScssClass[]> | undefined;
  const failures = new Map<RepoRelPath, string>();
  let version = 0;

  const parseOne = (rel: RepoRelPath): ScssClass[] => {
    try {
      const source = readFileSync(path.join(root, rel), 'utf8');
      const parsed = parseScssClasses(rel, source);
      if (!parsed.ok) {
        failures.set(rel, parsed.message);
        return [];
      }
      failures.delete(rel);
      return parsed.classes;
    } catch {
      // File vanished between listing and reading — not an error, just absent.
      failures.delete(rel);
      return [];
    }
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
        if (classes.length === 0 && !exists(root, rel)) state.delete(rel);
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
  };
}

function exists(root: string, rel: string): boolean {
  try {
    readFileSync(path.join(root, rel), { encoding: 'utf8', flag: 'r' });
    return true;
  } catch {
    return false;
  }
}
