// `find_missing_i18n_keys` — literal `t('…')` usages whose key is absent from one or more
// locales: ONE row per usage site carrying `missingLocales[]` (the sql/table projection stays
// flat, per usage × locale). Dynamic usages can't be checked against the locale set — listed
// separately as unresolvable, never guessed (§18). A locale that failed to parse makes the
// analysis incomplete (degradedReason), never a silent "fully translated". The op IS the join
// (usage sites the ts plugin observed vs the key set the i18n plugin owns).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { HIDE_MISSING_KEY } from '../format/render/shapes/meta-keys.ts';
import type { I18nPluginApi, MissingKeyView } from '../plugins/i18n/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

const findMissingI18nKeysTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'key', type: 'text' },
    { name: 'locale', type: 'text' },
    { name: 'usage_file', type: 'text' },
    { name: 'usage_line', type: 'int' },
  ],
  // The dense view folds the missing locales into one row per usage; the relational table stays
  // FLAT (one row per usage × missing locale) so a per-locale anti-join still works.
  rows(data) {
    const missing = (data as { missing?: MissingKeyView[] }).missing ?? [];
    const out: (readonly Cell[])[] = [];
    for (const m of missing) {
      for (const locale of m.missingLocales) out.push([m.key, locale, m.span.file, m.span.line]);
    }
    return out;
  },
  notes(data) {
    const out: string[] = [];
    const reason = (data as { degradedReason?: string }).degradedReason;
    if (reason !== undefined) out.push(`missing analysis incomplete: ${reason}.`);
    const dyn = (data as { dynamicUsages?: unknown[] }).dynamicUsages ?? [];
    if (dyn.length > 0)
      out.push(
        `${dyn.length} dynamic t(\`…\`) usage(s) could not be checked against locales — listed separately, never guessed.`,
      );
    return out;
  },
};

export const findMissingI18nKeysOp = defineOp({
  name: 'find_missing_i18n_keys',
  summary:
    'Literal t() usages whose key is absent from ≥1 locale (one row per usage + the locale list)',
  mutating: false,
  requires: ['ts', 'i18n'],
  argsSchema: z.strictObject({}),
  argsHint: '{}',
  example: { args: {} },
  notes: [
    'one row per usage site, carrying missingLocales[] (the readable locales that lack the key) — never a row per (usage × locale). The sql/table projection stays flat (one row per usage × locale).',
    'dynamic usages (template/computed keys) can not be checked against locales — listed separately as unresolvable, never guessed.',
    'when i18n.module is configured, usages match by SYMBOL IDENTITY: a usage counts iff its callee resolves to a function FROM that module (import / alias / namespace, or a `const { t } = useTranslation()` hook destructure incl. a renamed `{ t: x }`) — a same-named t from another module no longer fabricates a missing row. Without i18n.module the by-name model is used (alias-aware). It resolves the FUNCTION, not the key — a dynamic key stays unresolvable. If the configured i18n.module does not resolve, the missing analysis is flagged incomplete (no usage matched), never a silent "fully translated".',
  ],
  table: findMissingI18nKeysTable,
  async run(ctx, _args) {
    const i18n = ctx.plugins.get<I18nPluginApi>('i18n');
    try {
      const view = i18n.missingKeys();
      const failures = [...i18n.parseFailures()].map(([file, message]) => ({ file, message }));
      // When every usage misses the SAME locale set, the per-row `· missing in […]` is pure
      // repetition — hoist it to a header note and mark each row `~hideMissing` (the locale list
      // stays on every row, so json/sql are unchanged). Single-row answers keep it inline.
      const missing = view.missing;
      const allLocales = (m: { missingLocales: readonly string[] }): string =>
        [...m.missingLocales].sort().join(',');
      const first = missing[0];
      const uniform =
        missing.length >= 2 &&
        first !== undefined &&
        missing.every((m) => allLocales(m) === allLocales(first));
      const header =
        uniform && first !== undefined
          ? `missing in [${first.missingLocales.join(',')}] on all ${missing.length} usage(s)`
          : undefined;
      return ok({
        ...(header !== undefined ? { notes: [header] } : {}),
        missing: missing.map((m) =>
          tag('i18n-missing-usage', uniform ? { ...m, [HIDE_MISSING_KEY]: true } : m),
        ),
        locales: view.locales,
        ...(view.degradedReason !== undefined ? { degradedReason: view.degradedReason } : {}),
        ...(view.dynamicUsages.length > 0
          ? { dynamicUsages: view.dynamicUsages.map((d) => tag('bare-span', d)) }
          : {}),
        ...(failures.length > 0
          ? { parseFailures: failures.map((f) => tag('parse-failure', f)) }
          : {}),
      });
    } catch (thrown) {
      return failFromThrown('i18n', thrown);
    }
  },
});
