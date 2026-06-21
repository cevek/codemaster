// The `i18n` plugin (§5-L2): owner of locale-key knowledge. Parses the configured locale
// JSON files into flattened dotted keys (its own parser — `parseLocaleKeys` over
// `ts.parseJsonText`, §4); usage facts come from the `ts` plugin's generic, i18n-unaware
// `literalCalls` cross-tier API (the TS plugin *observes* the `t('…')` calls; this plugin
// asks — §5). State is per locale file, rebuilt per-file on reindex (the scss precedent).
//
// Enabled iff `config.i18n` is present (no autodetection v1); the gate lives in the
// composition root's `pluginsFor`, never in `opsFor` — the ops register unconditionally
// with `requires`, gated by plugin presence (§ spec-i18n-plugin).

import * as path from 'node:path';
import type { Plugin, PluginRegistry, FreshnessFingerprint } from '../../core/plugin.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Span } from '../../core/span.ts';
import { walkFiles } from '../../support/fs/walk.ts';
import { fileExists } from '../../support/fs/exists.ts';
import { readTextOrAbsent } from '../../support/fs/read-or-absent.ts';
import { matchesAnyGlob } from '../../common/glob/match.ts';
import type { CallMatchSpec, TsPluginApi } from '../ts/plugin.ts';
import { parseLocaleKeys, type LocaleKey } from './parse.ts';
import { dynamicDemotion, isKeyDemoted } from './demotion.ts';
import type {
  I18nLookupFilter,
  I18nLookupView,
  I18nMissingView,
  I18nUnusedFilter,
  I18nUnusedView,
  KeyDef,
  MissingKeyView,
  UnusedKeyView,
} from './views.ts';

export type { KeyDef, KeyUsage, UnusedKeyView, MissingKeyView } from './views.ts';

export interface I18nPluginApi extends Plugin {
  lookup(filter: I18nLookupFilter): I18nLookupView;
  unusedKeys(filter?: I18nUnusedFilter): I18nUnusedView;
  missingKeys(): I18nMissingView;
  parseFailures(): ReadonlyMap<RepoRelPath, string>;
}

type LocaleFile = { id: string; keys: LocaleKey[] };

/** Symbol-identity anchoring (spec-i18n-symbol-identity): `module` switches usage matching from
 *  by-name to "callee resolves to a function from this module"; `hook` adds the destructure path. */
export type I18nMatchConfig = { module?: string | undefined; hook?: string | undefined };

// Primitives, not the config object — the composition root (`pluginsFor`) extracts these
// from `config.i18n`, keeping `config/` out of the plugin layer (the `ts`/`scss`
// precedent: `createTsPlugin(root, tsconfigOverride?)`, `createScssPlugin(root)`).
export function createI18nPlugin(
  root: string,
  localeGlobs: readonly string[],
  functions: readonly string[] = ['t'],
  match: I18nMatchConfig = {},
): I18nPluginApi {
  let registry: PluginRegistry | undefined;
  let state: Map<RepoRelPath, LocaleFile> | undefined;
  const failures = new Map<RepoRelPath, string>();
  let version = 0;

  const localeIdOf = (rel: RepoRelPath): string => path.posix.basename(rel).replace(/\.json$/, '');

  const parseOne = (rel: RepoRelPath): LocaleFile => {
    const read = readTextOrAbsent(root, rel);
    // ENOENT is absence (a watcher race), not a failure; a real IO error is recorded so an
    // unreadable locale never reads as "no keys" (§3.6).
    if (read.kind === 'absent') {
      failures.delete(rel);
      return { id: localeIdOf(rel), keys: [] };
    }
    if (read.kind === 'error') {
      failures.set(rel, read.message);
      return { id: localeIdOf(rel), keys: [] };
    }
    const parsed = parseLocaleKeys(rel, read.text);
    // A malformed file still contributes its well-formed-prefix keys (degrade-and-continue,
    // §3.6) — but the failure stays recorded, so `failedLocaleIds`/`globalDemote` keep those
    // keys `partial` and surface the parse failure; never a silent `certain` over a broken file.
    if (parsed.ok) failures.delete(rel);
    else failures.set(rel, parsed.message);
    return { id: localeIdOf(rel), keys: parsed.keys };
  };

  const warm = (): Map<RepoRelPath, LocaleFile> => {
    if (state === undefined) {
      state = new Map();
      const walked = walkFiles(root);
      const files = walked.ok ? walked.data : (walked.data ?? []);
      for (const f of files) {
        if (!matchesAnyGlob(f.path, localeGlobs)) continue;
        state.set(f.path, parseOne(f.path));
      }
      version++;
    }
    return state;
  };

  const ts = (): TsPluginApi => {
    if (registry === undefined) throw new Error('i18n plugin not initialized');
    return registry.get<TsPluginApi>('ts');
  };

  // The usage scan (memoized in the ts plugin). `unresolved` is the honesty signal: an identity
  // module that resolved to NO file matched nothing → every key looks unused, so the
  // unused/missing verdicts must demote (§3.6). By-name mode never hits this.
  const scanCalls = (): {
    calls: ReturnType<TsPluginApi['literalCalls']>['calls'];
    unresolved: boolean;
  } => {
    const spec: CallMatchSpec = {
      functions,
      ...(match.module !== undefined ? { module: match.module } : {}),
      ...(match.hook !== undefined ? { hook: match.hook } : {}),
    };
    const scan = ts().literalCalls(spec);
    return { calls: scan.calls, unresolved: scan.mode === 'identity' && !scan.moduleResolved };
  };

  const localeIds = (all: Map<RepoRelPath, LocaleFile>): string[] =>
    [...new Set([...all.values()].map((f) => f.id))].sort();

  // Locale ids whose file currently fails to parse. A failed file makes NO provable
  // claim about which keys it has — so "missing in <that locale>" can't be asserted
  // (§3.6). Such locales are excluded from missing-determination and the parse failure is
  // surfaced in the op envelope; an unused-scan with ANY failure is demoted wholesale (a
  // key could live only in the unreadable file — §3.3, the scss parse-failure precedent).
  const failedLocaleIds = (): Set<string> => new Set([...failures.keys()].map(localeIdOf));

  return {
    id: 'i18n',
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
        if (!matchesAnyGlob(rel, localeGlobs)) continue;
        touched = true;
        if (fileExists(root, rel)) state.set(rel, parseOne(rel));
        else {
          state.delete(rel);
          failures.delete(rel);
        }
      }
      if (touched) version++;
      return Promise.resolve();
    },
    pending: () => [],

    lookup(filter) {
      const all = warm();
      // Forward (key/prefix) OR reverse (value): the value branch is the "I see this UI string —
      // which key?" lookup. Substring is case-insensitive (default); exact matches the whole value.
      const matches = (key: string, value: string): boolean => {
        if (filter.key !== undefined) return key === filter.key;
        if (filter.prefix !== undefined)
          return key === filter.prefix || key.startsWith(`${filter.prefix}.`);
        if (filter.value !== undefined)
          return filter.valueMode === 'exact'
            ? value === filter.value
            : value.toLowerCase().includes(filter.value.toLowerCase());
        return true;
      };
      const locales = localeIds(all);
      const failed = failedLocaleIds();
      // Only provable against locales we could actually read.
      const checkable = locales.filter((l) => !failed.has(l));
      // 1) Which KEYS match. For a value query the matching ENTRY's key qualifies — but the value
      //    only matches in SOME locales, so we must not let that decide presence (else a key
      //    present everywhere with a different value reads as "missing"). Match keys first, then
      //    report each matched key's TRUE per-locale presence below.
      const matchedKeys = new Set<string>();
      for (const file of all.values())
        for (const k of file.keys) if (matches(k.key, k.value)) matchedKeys.add(k.key);

      // 2) defs (scoped by `locale`) + each matched key's presence across EVERY locale.
      const defs: KeyDef[] = [];
      const definedLocales = new Map<string, Set<string>>(); // key → locale ids present
      for (const [rel, file] of all) {
        for (const k of file.keys) {
          if (!matchedKeys.has(k.key)) continue;
          const set = definedLocales.get(k.key) ?? new Set<string>();
          set.add(file.id);
          definedLocales.set(k.key, set);
          if (filter.locale === undefined || file.id === filter.locale) {
            defs.push({ key: k.key, locale: file.id, file: rel, span: k.span, value: k.value });
          }
        }
      }
      const missingPerKey = [...definedLocales.entries()]
        .map(([key, present]) => ({
          key,
          missingLocales: checkable.filter((l) => !present.has(l)),
        }))
        .filter((m) => m.missingLocales.length > 0);
      const scan = scanCalls();
      const usages = scan.calls
        .filter((c) => !c.dynamic && c.arg !== undefined && matchedKeys.has(c.arg))
        .map((c) => ({ key: c.arg as string, span: c.span, provenance: c.provenance }));
      return {
        defs,
        usages,
        locales,
        missingPerKey,
        matched: matchedKeys.size,
        ...(scan.unresolved
          ? {
              usagesIncomplete:
                'the configured i18n module did not resolve — no usage could be matched, so usage sites are NOT authoritative',
            }
          : {}),
      };
    },

    unusedKeys(filter) {
      const all = warm();
      // Scope which keys we REPORT. `degraded`/`used` below are computed over the WHOLE usage
      // scan regardless, so scoping never turns a globally-demoted key into a false certain dead.
      const inc = filter?.pathInclude ?? [];
      const exc = filter?.pathExclude ?? [];
      // A locale file passes the path globs if it matches pathInclude (when set) and not pathExclude.
      const filePasses = (file: RepoRelPath): boolean =>
        (inc.length === 0 || matchesAnyGlob(file, inc)) &&
        !(exc.length > 0 && matchesAnyGlob(file, exc));
      // A key is in scope if its namespace matches `prefix` (segment-aware, identical to i18n_lookup)
      // AND at least ONE locale file defining it passes the path globs. Scoping over the FULL
      // defining-file set (not a single "representative") is what keeps a key shared across locales
      // in scope when any of its files is included — never order-dependent on which locale sorts first.
      const inScope = (key: string, files: readonly RepoRelPath[]): boolean => {
        if (
          filter?.prefix !== undefined &&
          key !== filter.prefix &&
          !key.startsWith(`${filter.prefix}.`)
        )
          return false;
        if (inc.length === 0 && exc.length === 0) return true;
        return files.some(filePasses);
      };
      const { calls, unresolved } = scanCalls();
      const used = new Set(
        calls.filter((c) => !c.dynamic && c.arg !== undefined).map((c) => c.arg),
      );

      // Prefix-scoped demotion (backlog I-a): a dynamic `t(`errors.codes.${x}`)` can only ever
      // resolve to a key under `errors.codes.` — so it demotes THAT namespace, leaving unrelated
      // keys provably certain. A headless dynamic call (`t(k)`, `t(`${x}`)`) has no such proof and
      // degrades the whole scan. A parse failure / unresolved module is global the same way: a key
      // could live only in the unreadable file, or no usage matched at all (§3.3/§3.6).
      const demote = dynamicDemotion(calls.filter((c) => c.dynamic).map((c) => c.span));
      const hasFailures = failures.size > 0;
      const globalDemote = demote.global || hasFailures || unresolved;
      const demotedPrefixes = globalDemote ? [] : demote.prefixes;
      const degraded = globalDemote || demotedPrefixes.length > 0;

      // ONE reason string — never stamped per row (identical for every demoted key).
      const globalReasons: string[] = [];
      if (demote.global) globalReasons.push('a dynamic t() call with no static prefix exists');
      if (hasFailures) globalReasons.push('a locale file failed to parse');
      if (unresolved)
        globalReasons.push(
          'the configured i18n module did not resolve — no usage could be matched',
        );
      const degradedReason =
        globalReasons.length > 0
          ? `cannot prove any key dead — ${globalReasons.join(' and ')}`
          : demotedPrefixes.length > 0
            ? `a dynamic t(\`…\`) demotes namespace(s) ${demotedPrefixes.join(', ')} — unrelated keys stay certain`
            : undefined;

      // One representative definition per key (first locale file, by sorted path), PLUS the full
      // set of files defining each key — path scoping (inScope) runs over the whole set, not the rep.
      const rep = new Map<string, { file: RepoRelPath; span: Span }>();
      const keyFiles = new Map<string, RepoRelPath[]>();
      for (const rel of [...all.keys()].sort()) {
        for (const k of all.get(rel)?.keys ?? []) {
          if (!rep.has(k.key)) rep.set(k.key, { file: rel, span: k.span });
          const arr = keyFiles.get(k.key);
          if (arr === undefined) keyFiles.set(k.key, [rel]);
          else arr.push(rel);
        }
      }
      const unused: UnusedKeyView[] = [];
      let scannedKeys = 0;
      for (const [key, where] of rep) {
        if (!inScope(key, keyFiles.get(key) ?? [where.file])) continue;
        scannedKeys++;
        if (used.has(key)) continue;
        unused.push({
          key,
          file: where.file,
          span: where.span,
          confidence: isKeyDemoted(key, globalDemote, demotedPrefixes) ? 'partial' : 'certain',
        });
      }
      return {
        unused,
        degraded,
        globalDemote,
        demotedPrefixes,
        ...(degradedReason !== undefined ? { degradedReason } : {}),
        scannedKeys,
        scannedUsages: calls.length,
      };
    },

    missingKeys() {
      const all = warm();
      const locales = localeIds(all);
      const failed = failedLocaleIds();
      // Only assert "missing in <locale>" for locales we could actually read (§3.6); an
      // unparseable locale is surfaced via parseFailures in the op envelope, never claimed
      // certain-missing.
      const checkable = locales.filter((l) => !failed.has(l));
      const definedBy = new Map<string, Set<string>>(); // key → locale ids defining it
      for (const file of all.values()) {
        for (const k of file.keys) {
          const set = definedBy.get(k.key) ?? new Set<string>();
          set.add(file.id);
          definedBy.set(k.key, set);
        }
      }
      const { calls, unresolved } = scanCalls();
      const missing: MissingKeyView[] = [];
      for (const c of calls) {
        if (c.dynamic || c.arg === undefined) continue;
        const present = definedBy.get(c.arg) ?? new Set<string>();
        // ONE row per usage site, carrying the LIST of readable locales that lack the key —
        // never a row per (usage × locale). Computed over `checkable` only (an unreadable locale
        // is surfaced via parseFailures, never claimed certain-missing — §3.6).
        const missingLocales = checkable.filter((l) => !present.has(l));
        if (missingLocales.length > 0) missing.push({ key: c.arg, span: c.span, missingLocales });
      }
      const dynamicUsages = calls.filter((c) => c.dynamic).map((c) => ({ span: c.span }));
      // A key absent from an UNREADABLE locale cannot be seen, so an empty (or short) `missing`
      // must not read as "fully translated" — flag the incompleteness, mirroring unusedKeys (§3.6).
      // An unresolved i18n module is the same incompleteness: no usage matched, so `missing` is
      // empty for a reason that is NOT "all translated" — say so.
      const reasons: string[] = [];
      if (failed.size > 0)
        reasons.push(
          'a locale file failed to parse — a key absent there is invisible; missing analysis is incomplete',
        );
      if (unresolved)
        reasons.push(
          'the configured i18n module did not resolve — no usage could be matched, so missing analysis ran over nothing',
        );
      const degradedReason = reasons.length > 0 ? reasons.join('; ') : undefined;
      return {
        missing,
        dynamicUsages,
        locales,
        ...(degradedReason !== undefined ? { degradedReason } : {}),
      };
    },

    parseFailures: () => failures,
  };
}
