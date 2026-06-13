// The `i18n` plugin (§5-L2): owner of locale-key knowledge. Parses the configured locale
// JSON files into flattened dotted keys (its own parser — `parseLocaleKeys` over
// `ts.parseJsonText`, §4); usage facts come from the `ts` plugin's generic, i18n-unaware
// `literalCalls` cross-tier API (the TS plugin *observes* the `t('…')` calls; this plugin
// asks — §5). State is per locale file, rebuilt per-file on reindex (the scss precedent).
//
// Enabled iff `config.i18n` is present (no autodetection v1); the gate lives in the
// composition root's `pluginsFor`, never in `opsFor` — the ops register unconditionally
// with `requires`, gated by plugin presence (§ spec-i18n-plugin).

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Plugin, PluginRegistry, FreshnessFingerprint } from '../../core/plugin.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { walkFiles } from '../../support/fs/walk.ts';
import { matchesAnyGlob } from '../../common/glob/match.ts';
import type { TsPluginApi } from '../ts/plugin.ts';
import { parseLocaleKeys, type LocaleKey } from './parse.ts';

/** One key as defined in one locale file. */
export type KeyDef = {
  key: string;
  locale: string;
  file: RepoRelPath;
  span: Span;
  value: string;
};

type I18nLookupView = {
  /** Per-locale definitions of the matched keys. */
  defs: KeyDef[];
  /** Literal `t('…')` usage sites of the matched keys. */
  usages: { key: string; span: Span }[];
  /** All known locale ids (so "missing in X" is meaningful). */
  locales: string[];
  /** Matched keys missing from one or more locales. */
  missingPerKey: { key: string; missingLocales: string[] }[];
  matched: number;
};

export type UnusedKeyView = {
  key: string;
  file: RepoRelPath;
  span: Span;
  confidence: Confidence;
  note?: string;
};

type I18nUnusedView = {
  unused: UnusedKeyView[];
  /** True when EVERY unused-claim was demoted to partial — a dynamic call or a locale
   *  parse failure makes "definitely dead" unprovable for all keys. */
  degraded: boolean;
  scannedKeys: number;
  scannedUsages: number;
};

export type MissingKeyView = {
  key: string;
  locale: string;
  /** Proof span over the usage site (in the TS file). */
  span: Span;
  confidence: Confidence;
};

type I18nMissingView = {
  missing: MissingKeyView[];
  /** Dynamic usages: unresolvable, listed separately, never guessed (§18). */
  dynamicUsages: { span: Span }[];
  locales: string[];
};

export interface I18nPluginApi extends Plugin {
  lookup(filter: { key?: string | undefined; prefix?: string | undefined }): I18nLookupView;
  unusedKeys(): I18nUnusedView;
  missingKeys(): I18nMissingView;
  parseFailures(): ReadonlyMap<RepoRelPath, string>;
}

type LocaleFile = { id: string; keys: LocaleKey[] };

// Primitives, not the config object — the composition root (`pluginsFor`) extracts these
// from `config.i18n`, keeping `config/` out of the plugin layer (the `ts`/`scss`
// precedent: `createTsPlugin(root, tsconfigOverride?)`, `createScssPlugin(root)`).
export function createI18nPlugin(
  root: string,
  localeGlobs: readonly string[],
  functions: readonly string[] = ['t'],
): I18nPluginApi {
  let registry: PluginRegistry | undefined;
  let state: Map<RepoRelPath, LocaleFile> | undefined;
  const failures = new Map<RepoRelPath, string>();
  let version = 0;

  const localeIdOf = (rel: RepoRelPath): string => path.posix.basename(rel).replace(/\.json$/, '');

  const parseOne = (rel: RepoRelPath): LocaleFile => {
    try {
      const source = readFileSync(path.join(root, rel), 'utf8');
      const parsed = parseLocaleKeys(rel, source);
      if (!parsed.ok) {
        failures.set(rel, parsed.message);
        return { id: localeIdOf(rel), keys: [] };
      }
      failures.delete(rel);
      return { id: localeIdOf(rel), keys: parsed.keys };
    } catch {
      // Vanished between listing and reading — absent, not an error.
      failures.delete(rel);
      return { id: localeIdOf(rel), keys: [] };
    }
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
        if (exists(root, rel)) state.set(rel, parseOne(rel));
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
      const matches = (key: string): boolean => {
        if (filter.key !== undefined) return key === filter.key;
        if (filter.prefix !== undefined)
          return key === filter.prefix || key.startsWith(`${filter.prefix}.`);
        return true;
      };
      const locales = localeIds(all);
      const failed = failedLocaleIds();
      // Only provable against locales we could actually read.
      const checkable = locales.filter((l) => !failed.has(l));
      const defs: KeyDef[] = [];
      const definedLocales = new Map<string, Set<string>>(); // key → locale ids present
      for (const [rel, file] of all) {
        for (const k of file.keys) {
          if (!matches(k.key)) continue;
          defs.push({ key: k.key, locale: file.id, file: rel, span: k.span, value: k.value });
          const set = definedLocales.get(k.key) ?? new Set<string>();
          set.add(file.id);
          definedLocales.set(k.key, set);
        }
      }
      const missingPerKey = [...definedLocales.entries()]
        .map(([key, present]) => ({
          key,
          missingLocales: checkable.filter((l) => !present.has(l)),
        }))
        .filter((m) => m.missingLocales.length > 0);
      const matchedKeys = new Set(definedLocales.keys());
      const usages = ts()
        .literalCalls(functions)
        .filter((c) => !c.dynamic && c.arg !== undefined && matchedKeys.has(c.arg))
        .map((c) => ({ key: c.arg as string, span: c.span }));
      return { defs, usages, locales, missingPerKey, matched: matchedKeys.size };
    },

    unusedKeys() {
      const all = warm();
      const calls = ts().literalCalls(functions);
      const dynamic = calls.some((c) => c.dynamic);
      const used = new Set(
        calls.filter((c) => !c.dynamic && c.arg !== undefined).map((c) => c.arg),
      );

      // ANY parse failure means a key could live only in the unreadable file (undercount)
      // or a "dead" key could actually be reached there — so EVERY unused-claim is demoted,
      // the same global rule as a dynamic call (§3.3/§3.6).
      const hasFailures = failures.size > 0;
      const degraded = dynamic || hasFailures;
      const reasons: string[] = [];
      if (dynamic) reasons.push('a dynamic t(`…`) call exists');
      if (hasFailures) reasons.push('a locale file failed to parse');
      const note =
        reasons.length > 0 ? `cannot prove this key is dead — ${reasons.join(' and ')}` : undefined;

      // One representative definition per key (first locale file, by sorted path).
      const rep = new Map<string, { file: RepoRelPath; span: Span }>();
      for (const rel of [...all.keys()].sort()) {
        for (const k of all.get(rel)?.keys ?? []) {
          if (!rep.has(k.key)) rep.set(k.key, { file: rel, span: k.span });
        }
      }
      const unused: UnusedKeyView[] = [];
      for (const [key, where] of rep) {
        if (used.has(key)) continue;
        unused.push({
          key,
          file: where.file,
          span: where.span,
          confidence: degraded ? 'partial' : 'certain',
          ...(note !== undefined ? { note } : {}),
        });
      }
      return { unused, degraded, scannedKeys: rep.size, scannedUsages: calls.length };
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
      const calls = ts().literalCalls(functions);
      const missing: MissingKeyView[] = [];
      for (const c of calls) {
        if (c.dynamic || c.arg === undefined) continue;
        const present = definedBy.get(c.arg) ?? new Set<string>();
        for (const locale of checkable) {
          if (present.has(locale)) continue;
          missing.push({ key: c.arg, locale, span: c.span, confidence: 'certain' });
        }
      }
      const dynamicUsages = calls.filter((c) => c.dynamic).map((c) => ({ span: c.span }));
      return { missing, dynamicUsages, locales };
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
