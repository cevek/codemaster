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
import { matchesAnyGlob } from '../../common/glob/match.ts';
import { resolveRelativeSpecifier } from '../../support/fs/resolve-relative.ts';
import { fileExists } from '../../support/fs/exists.ts';
import { readTextOrAbsent } from '../../support/fs/read-or-absent.ts';
import type { TsPluginApi } from '../ts/plugin.ts';
import { parseScssClasses, type ScssClass, type SheetReachability } from './parse.ts';
import { parseStylesheetRoot } from './parse-root.ts';
import { classifyForExtract, type ClassVerdict } from './extract-classify.ts';
import { extractRules, type ExtractedRules } from './extract-rules.ts';
import {
  runCascadeQuery,
  type CascadeInput,
  type CascadeFilter,
  type CascadeOutcome,
} from './cascade/query.ts';

// Re-export the shapes ops consume so they go through the plugin's public surface (layering:
// ops compose plugins via their public API, never reaching into a plugin-internal module).
export type { ClassVerdict, LeftBehindCode } from './extract-classify.ts';
export type { CascadeInput } from './cascade/query.ts';
export type { CascadeProperty } from './cascade/resolve.ts';

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

/** Stylesheet-path scoping for `unusedClasses` (globs over the .scss RepoRelPath), mirroring
 *  search_symbol's pathInclude/pathExclude. Scopes which sheets are REPORTED on; cross-sheet
 *  `composes:` reachability is still resolved over every sheet, so scoping never fabricates a
 *  dead class that another (excluded) sheet keeps alive (§3). */
type ScssUnusedFilter = {
  pathInclude?: readonly string[];
  pathExclude?: readonly string[];
};

export interface ScssPluginApi extends Plugin {
  classes(file?: string): ScssClassView[];
  unusedClasses(filter?: ScssUnusedFilter): UnusedScssView;
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
  /** Resolved cascade view (spec-css-cascade-op): every rule across the in-scope sheets whose
   *  subject targets the class, ordered by specificity, with the winning declaration per
   *  property. Re-parses the in-scope sheets fresh on demand (bounded, scopeable by `filter`);
   *  cross-module/state/computed contributors stay `partial` — never a fabricated winner (§3,
   *  §19). A bad selector (no class) returns `ok:false`, never a throw. */
  cascadeFor(input: CascadeInput, filter?: CascadeFilter): CascadeOutcome;
}

/** Parsed facts for one stylesheet: its class declarations plus the reachability sets
 *  `find_unused` consults. Held per-file in plugin state and rebuilt per-file on reindex. */
type ParsedSheet = { classes: ScssClass[]; reachability: SheetReachability };

const EMPTY_SHEET: ParsedSheet = {
  classes: [],
  reachability: { entangledOnly: new Set(), linkedReachable: new Set(), importedComposes: [] },
};

export function createScssPlugin(root: string): ScssPluginApi {
  let registry: PluginRegistry | undefined;
  let state: Map<RepoRelPath, ParsedSheet> | undefined;
  const failures = new Map<RepoRelPath, string>();
  let version = 0;

  const parseOne = (rel: RepoRelPath): ParsedSheet => {
    const read = readTextOrAbsent(root, rel);
    // ENOENT is absence (a watcher race), not a failure; a real IO error is recorded so an
    // unreadable stylesheet never reads as "no classes" (§3.6).
    if (read.kind === 'absent') {
      failures.delete(rel);
      return EMPTY_SHEET;
    }
    if (read.kind === 'error') {
      failures.set(rel, read.message);
      return EMPTY_SHEET;
    }
    const parsed = parseScssClasses(rel, read.text);
    if (!parsed.ok) {
      failures.set(rel, parsed.message);
      return EMPTY_SHEET;
    }
    failures.delete(rel);
    return { classes: parsed.classes, reachability: parsed.reachability };
  };

  const warm = (): Map<RepoRelPath, ParsedSheet> => {
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
        const sheet = parseOne(rel);
        if (sheet.classes.length === 0 && !fileExists(root, rel)) state.delete(rel);
        else state.set(rel, sheet);
      }
      if (touched) version++;
      return Promise.resolve();
    },
    pending: () => [],

    classes(file) {
      const all = warm();
      const views: ScssClassView[] = [];
      for (const [rel, sheet] of all) {
        if (file !== undefined && rel !== file) continue;
        for (const c of sheet.classes) views.push(toView(rel, c));
      }
      return views;
    },

    unusedClasses(filter) {
      const all = warm();
      if (registry === undefined) throw new Error('scss plugin not initialized');
      // Scope which sheets we REPORT on. Applied to the emit loop only — the cross-sheet
      // reachability below still walks every sheet, so an excluded sheet that `composes:` an
      // included class keeps it alive (never a scoped-away false dead, §3).
      const inScope = (rel: RepoRelPath): boolean => {
        const inc = filter?.pathInclude;
        const exc = filter?.pathExclude;
        if (inc !== undefined && inc.length > 0 && !matchesAnyGlob(rel, inc)) return false;
        if (exc !== undefined && exc.length > 0 && matchesAnyGlob(rel, exc)) return false;
        return true;
      };
      const ts = registry.get<TsPluginApi>('ts');
      const usages = ts.cssModuleUsages();

      // Cross-sheet `composes: x from './other'` linkage (spec-scss-css-honesty follow-up):
      // a class reached only because ANOTHER sheet composes it is not provably dead. Resolve
      // each `from` relative to the consuming sheet (relative-only — matching codemaster's css
      // resolution); an aliased/unresolvable `from` can't be pinned to a provider, so the
      // composed name is demoted in EVERY sheet (conservative — never a false `certain` dead).
      const crossSheetReachable = new Map<string, Set<string>>();
      const unresolvedComposed = new Set<string>();
      for (const [consumerRel, sheet] of all) {
        for (const { name, from } of sheet.reachability.importedComposes) {
          const providerRel = resolveRelativeSpecifier(consumerRel, from);
          // Unresolvable (aliased/bare) OR resolved to a path we don't actually index (a
          // relative spec that doesn't byte-match a walked sheet — e.g. an omitted extension,
          // a `..`-escape, a `.`/`./`): we can't PIN the provider, so demote the name
          // everywhere rather than let the provider class read `certain` dead (the §3 lie).
          if (providerRel === undefined || !all.has(providerRel)) {
            unresolvedComposed.add(name);
            continue;
          }
          const bucket = crossSheetReachable.get(providerRel);
          if (bucket === undefined) crossSheetReachable.set(providerRel, new Set([name]));
          else bucket.add(name);
        }
      }

      const unused: UnusedClassView[] = [];
      const dynamicModules: string[] = [];
      let scannedModules = 0;
      let scannedClasses = 0;
      for (const [rel, sheet] of all) {
        if (!inScope(rel)) continue;
        scannedModules++;
        scannedClasses += sheet.classes.length;
        const accesses = usages.byModule.get(rel) ?? [];
        const hasDynamic = accesses.some((a) => a.confidence === 'dynamic');
        if (hasDynamic) dynamicModules.push(rel);
        const used = new Set(accesses.filter((a) => a.className !== '').map((a) => a.className));
        const { entangledOnly } = sheet.reachability;
        const crossReach = crossSheetReachable.get(rel);
        // Union the sheet's own linkage with cross-sheet + unresolvable composed names.
        const linkedReachable =
          crossReach === undefined && unresolvedComposed.size === 0
            ? sheet.reachability.linkedReachable
            : new Set<string>([
                ...sheet.reachability.linkedReachable,
                ...(crossReach ?? []),
                ...unresolvedComposed,
              ]);

        // Dedup: the same class declared across N selectors (`.card .row`, `.row + .row`)
        // parses to N rows — collapse to ONE unused row, keeping its first span and OR-ing
        // the interpolation flag (any interpolated occurrence keeps the class `partial`).
        const collapsed = new Map<string, { rep: ScssClass; partial: boolean }>();
        for (const c of sheet.classes) {
          const prev = collapsed.get(c.name);
          if (prev === undefined) collapsed.set(c.name, { rep: c, partial: c.partial });
          else prev.partial = prev.partial || c.partial;
        }

        for (const [name, { rep, partial }] of collapsed) {
          if (used.has(name)) continue;
          const demoted = demote(name, partial, hasDynamic, entangledOnly, linkedReachable);
          unused.push({
            ...toView(rel, rep),
            confidence: demoted.confidence,
            ...(demoted.note !== undefined ? { note: demoted.note } : {}),
          });
        }
      }
      return { unused, dynamicModules, scannedModules, scannedClasses };
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

    cascadeFor(input, filter): CascadeOutcome {
      return runCascadeQuery(root, [...warm().keys()], input, filter);
    },
  };
}

/** Decide an unused class's honest confidence + reason. "Could not prove dead" is `partial`,
 *  never `certain` unused (§3.3/§3.4). A computed access anywhere in the module (`hasDynamic`)
 *  demotes the whole module; a class reachable via `composes:`/`@extend`, or one living only in
 *  an entangled contextual/compound/nested selector, or declared via interpolation, is likewise
 *  not provably dead. Only a genuinely simple, cleanly-owned, statically-unreferenced class
 *  stays `certain`. */
function demote(
  name: string,
  partial: boolean,
  hasDynamic: boolean,
  entangledOnly: ReadonlySet<string>,
  linkedReachable: ReadonlySet<string>,
): { confidence: Confidence; note?: string } {
  if (hasDynamic) {
    return { confidence: 'partial', note: 'importer uses computed access — cannot prove unused' };
  }
  if (linkedReachable.has(name)) {
    return {
      confidence: 'partial',
      note: 'reachable via composes:/@extend linkage — cannot prove dead',
    };
  }
  if (entangledOnly.has(name)) {
    return {
      confidence: 'partial',
      note: 'appears only in a contextual/compound/nested selector — cannot prove dead',
    };
  }
  if (partial) return { confidence: 'partial', note: 'declared via interpolated selector' };
  return { confidence: 'certain' };
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
