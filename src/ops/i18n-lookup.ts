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

const argsSchema = z
  .strictObject({
    key: z.string().optional(),
    prefix: z.string().optional(),
    /** Reverse lookup: find the key(s) whose locale VALUE matches (case-insensitive substring by
     *  default — "I see this UI string, which key is it?"). `valueMode:'exact'` for a whole-value match. */
    value: z.string().min(1).optional(),
    valueMode: z.enum(['substring', 'exact']).optional(),
    /** Restrict emitted values to ONE locale (defs are per key×locale — a prefix lookup on a
     *  many-locale repo is N×locales rows). Orthogonal to the selector; missingPerKey stays global. */
    locale: z.string().optional(),
  })
  .refine((a) => [a.key, a.prefix, a.value].filter((x) => x !== undefined).length <= 1, {
    message: 'provide at most one selector: key, prefix, or value',
  });

export const i18nLookupOp = defineOp({
  name: 'i18n_lookup',
  summary: 'Locale values + usage sites for a key/prefix — OR reverse-lookup the key by its value',
  mutating: false,
  requires: ['ts', 'i18n'],
  argsSchema,
  argsHint:
    '{ key?: string, prefix?: string, value?: string, valueMode?: "substring"|"exact", locale?: string }',
  example: { args: { key: 'profile.greeting' } },
  notes: [
    'values are opaque text (no ICU/plural semantics); keys missing in some locale are listed per key.',
    'reverse lookup: value (case-insensitive substring; valueMode:"exact" for a whole-value match) finds the dotted key(s) for a string you see in the UI — returns the same defs (full key + locale + span + value). At most one selector (key | prefix | value).',
    'usage sites are import-resolved via the TS checker: a named-import alias (`import { t as tr }; tr(…)`) counts as t, and an aliased-base member access (`import { i18n as i }; i.t(…)`) counts as a configured dotted name like i18n.t. Matching stays confined to user-named bindings — a bare t never matches an arbitrary `obj.t()`, nor a destructure rename of a non-i18n value (no fabrication). It resolves the FUNCTION, not the key — a dynamic key stays unresolvable.',
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
