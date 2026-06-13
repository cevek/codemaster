// `i18n_lookup` — per-locale values + proof spans + usage sites for a key (or a dotted
// prefix). The locale JSON is the oracle; keys missing from some locale are listed per
// key, never silently completed (§3.6). The op IS the cross-tier join (key defs from the
// i18n plugin, usage sites the ts plugin observed) — no shared store (§5-L3).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { I18nPluginApi, KeyDef } from '../plugins/i18n/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

const i18nLookupTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'key', type: 'text' },
    { name: 'locale', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'value', type: 'text' },
  ],
  rows(data) {
    const defs = (data as { defs?: KeyDef[] }).defs ?? [];
    return defs.map((d): readonly Cell[] => [d.key, d.locale, d.file, d.span.line, d.value]);
  },
  notes(data) {
    const missing =
      (data as { missingPerKey?: { key: string; missingLocales: string[] }[] }).missingPerKey ?? [];
    return missing.map(
      (m) => `key '${m.key}' missing in locale(s): ${m.missingLocales.join(', ')}`,
    );
  },
};

const argsSchema = z.strictObject({
  key: z.string().optional(),
  prefix: z.string().optional(),
});

export const i18nLookupOp = defineOp({
  name: 'i18n_lookup',
  summary: 'Locale values + proof spans + usage sites for a key (or dotted prefix)',
  mutating: false,
  requires: ['ts', 'i18n'],
  argsSchema,
  argsHint: '{ key?: string, prefix?: string }',
  example: { args: { key: 'profile.greeting' } },
  notes: [
    'values are opaque text (no ICU/plural semantics); keys missing in some locale are listed per key.',
    'usage sites are found by call name as written — an `import { t as tr }` alias is missed (syntactic, not symbol-resolved).',
  ],
  table: i18nLookupTable,
  async run(ctx, args) {
    const i18n = ctx.plugins.get<I18nPluginApi>('i18n');
    try {
      const view = i18n.lookup(args);
      const failures = [...i18n.parseFailures()].map(([file, message]) => ({ file, message }));
      return ok({
        defs: view.defs,
        usages: view.usages,
        locales: view.locales,
        matched: view.matched,
        ...(view.missingPerKey.length > 0 ? { missingPerKey: view.missingPerKey } : {}),
        ...(failures.length > 0 ? { parseFailures: failures } : {}),
      });
    } catch (thrown) {
      return failFromThrown('i18n', thrown);
    }
  },
});
