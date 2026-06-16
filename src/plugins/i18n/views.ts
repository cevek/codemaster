// The i18n plugin's result/view shapes (§5-L2) — the proof-carrying payloads its public API
// returns, kept out of plugin.ts so the plugin file stays focused on behaviour.

import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import type { LiteralCallProvenance } from '../ts/plugin.ts';

/** One key as defined in one locale file. */
export type KeyDef = {
  key: string;
  locale: string;
  file: RepoRelPath;
  span: Span;
  value: string;
};

/** A `t('…')` usage of a matched key + HOW its callee resolved (F-c, self-auditable). */
export type KeyUsage = { key: string; span: Span; provenance: LiteralCallProvenance };

export type I18nLookupFilter = {
  key?: string | undefined;
  prefix?: string | undefined;
  value?: string | undefined;
  valueMode?: 'substring' | 'exact' | undefined;
  /** Restrict the emitted `defs` to one locale (defs are per key×locale — on a many-locale
   *  repo a prefix lookup is N×locales rows). `missingPerKey` stays computed over ALL locales. */
  locale?: string | undefined;
};

export type I18nLookupView = {
  /** Per-locale definitions of the matched keys. */
  defs: KeyDef[];
  /** Literal `t('…')` usage sites of the matched keys. */
  usages: KeyUsage[];
  /** All known locale ids (so "missing in X" is meaningful). */
  locales: string[];
  /** Matched keys missing from one or more locales. */
  missingPerKey: { key: string; missingLocales: string[] }[];
  matched: number;
  /** Set when the usage scan could not run reliably (identity mode + the configured module did
   *  not resolve): `usages` is then NOT authoritative — an empty list means "we matched nothing",
   *  never "used nowhere". Mirrors the unused/missing demotion so the lookup can't read as
   *  complete (§3.6). */
  usagesIncomplete?: string;
};

export type UnusedKeyView = {
  key: string;
  file: RepoRelPath;
  span: Span;
  confidence: Confidence;
};

export type I18nUnusedView = {
  /** Every unused key, each carrying its OWN confidence — a key under a demoted namespace is
   *  `partial`, an unrelated key stays `certain` (prefix-scoped demotion, backlog I-a). */
  unused: UnusedKeyView[];
  /** True when SOME demotion is in effect — a global reason (headless dynamic call, parse
   *  failure, unresolved module) OR a prefix-scoped one. Not "every key demoted": see
   *  `globalDemote` for that. */
  degraded: boolean;
  /** True when EVERY key is demoted (no namespace stays `certain`): a dynamic call with no
   *  static prefix, a locale parse failure, or an unresolved i18n module. */
  globalDemote: boolean;
  /** Static namespace heads that scoped the demotion (e.g. `errors.codes.`) — keys under these
   *  are `partial`, the rest `certain`. Empty when `globalDemote` (the whole scan is partial). */
  demotedPrefixes: readonly string[];
  /** The single global reason for the demotion (set iff degraded). Stated ONCE here, never
   *  stamped per row — every row would carry the identical string (a 1-per-key repeat). */
  degradedReason?: string;
  scannedKeys: number;
  scannedUsages: number;
};

/** Scoping for `unusedKeys` (the whole-locale answer caps fast on a real key set). `prefix`
 *  narrows by dotted key namespace (segment-aware, no trailing dot — e.g. 'errors.codes');
 *  pathInclude/pathExclude are globs over the locale .json path. Scopes which keys are REPORTED —
 *  the `degraded` verdict still reflects the WHOLE usage scan, so scoping never upgrades a key to
 *  a false `certain` dead. */
export type I18nUnusedFilter = {
  prefix?: string;
  pathInclude?: readonly string[];
  pathExclude?: readonly string[];
};

export type MissingKeyView = {
  key: string;
  /** Proof span over the usage site (in the TS file). */
  span: Span;
  /** Every readable locale that lacks this key — ONE fact per usage site, not a row per locale
   *  (with 10 locales a partially-translated key would otherwise be 9 identical-but-locale rows). */
  missingLocales: string[];
};

export type I18nMissingView = {
  missing: MissingKeyView[];
  /** Dynamic usages: unresolvable, listed separately, never guessed (§18). */
  dynamicUsages: { span: Span }[];
  locales: string[];
  /** Set iff a locale failed to parse OR the i18n module did not resolve: a key absent / a usage
   *  unmatched is invisible, so `missing` is incomplete — never let it read as "fully translated"
   *  (§3.6). */
  degradedReason?: string;
};
