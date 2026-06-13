// `find_missing_i18n_keys` — literal `t('…')` usages whose key is absent from one or more
// locales, reported per locale (a usage site × each missing locale). Dynamic usages can't
// be checked against the locale set — they are listed separately as unresolvable, never
// guessed (§18). The op IS the join (usage sites the ts plugin observed vs the key set the
// i18n plugin owns).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { I18nPluginApi, MissingKeyView } from '../plugins/i18n/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

const findMissingI18nKeysTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'key', type: 'text' },
    { name: 'locale', type: 'text' },
    { name: 'usage_file', type: 'text' },
    { name: 'usage_line', type: 'int' },
    { name: 'confidence', type: 'text' },
  ],
  rows(data) {
    const missing = (data as { missing?: MissingKeyView[] }).missing ?? [];
    return missing.map((m): readonly Cell[] => [
      m.key,
      m.locale,
      m.span.file,
      m.span.line,
      m.confidence,
    ]);
  },
  notes(data) {
    const dyn = (data as { dynamicUsages?: unknown[] }).dynamicUsages ?? [];
    if (dyn.length === 0) return [];
    return [
      `${dyn.length} dynamic t(\`…\`) usage(s) could not be checked against locales — listed separately, never guessed.`,
    ];
  },
};

export const findMissingI18nKeysOp = defineOp({
  name: 'find_missing_i18n_keys',
  summary: 'Literal t() usages whose key is absent from ≥1 locale, reported per locale',
  mutating: false,
  requires: ['ts', 'i18n'],
  argsSchema: z.strictObject({}),
  argsHint: '{}',
  example: { args: {} },
  notes: [
    'dynamic usages (template/computed keys) can not be checked against locales — listed separately as unresolvable, never guessed.',
    'usages are matched by call name as written — an `import { t as tr }` alias is missed (syntactic, not symbol-resolved).',
  ],
  table: findMissingI18nKeysTable,
  async run(ctx, _args) {
    const i18n = ctx.plugins.get<I18nPluginApi>('i18n');
    try {
      const view = i18n.missingKeys();
      const failures = [...i18n.parseFailures()].map(([file, message]) => ({ file, message }));
      return ok({
        missing: view.missing,
        locales: view.locales,
        ...(view.dynamicUsages.length > 0 ? { dynamicUsages: view.dynamicUsages } : {}),
        ...(failures.length > 0 ? { parseFailures: failures } : {}),
      });
    } catch (thrown) {
      return failFromThrown('i18n', thrown);
    }
  },
});
