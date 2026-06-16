// `i18n_lookup` — per-locale values + proof spans + usage sites for a key (or a dotted
// prefix). The locale JSON is the oracle; keys missing from some locale are listed per
// key, never silently completed (§3.6). The op IS the cross-tier join (key defs from the
// i18n plugin, usage sites the ts plugin observed) — no shared store (§5-L3).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { I18nPluginApi, KeyDef, KeyUsage } from '../plugins/i18n/plugin.ts';
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
    const out: string[] = [];
    // Honesty first (§3.6): when the usage scan could not run, say so BEFORE listing usages, so an
    // empty list never reads as "used nowhere".
    const incomplete = (data as { usagesIncomplete?: string }).usagesIncomplete;
    if (incomplete !== undefined) out.push(`usage sites incomplete: ${incomplete}.`);
    // Provenance breakdown — makes the symbol-identity resolution self-auditable (F-c): the
    // reader sees how each usage was matched without opening every call site.
    const usages = (data as { usages?: KeyUsage[] }).usages ?? [];
    if (usages.length > 0) {
      const byProv = new Map<string, number>();
      for (const u of usages) byProv.set(u.provenance, (byProv.get(u.provenance) ?? 0) + 1);
      const parts = [...byProv].map(([p, n]) => `${p}:${n}`).join(', ');
      out.push(`${usages.length} usage site(s) — resolved by ${parts}.`);
    }
    const missing =
      (data as { missingPerKey?: { key: string; missingLocales: string[] }[] }).missingPerKey ?? [];
    for (const m of missing) {
      out.push(`key '${m.key}' missing in locale(s): ${m.missingLocales.join(', ')}`);
    }
    return out;
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
    'each usage row carries provenance — how its callee resolved (written | alias | destructure | namespace) — so the resolution is self-auditable.',
    'when i18n.module is configured, usages match by SYMBOL IDENTITY: a call counts iff its callee binding resolves to a function FROM that module (through import / alias / namespace, or a `const { t } = useTranslation()` hook destructure incl. a renamed `{ t: x }`). A same-named t from another module does NOT match. Without i18n.module, the by-name model is used (alias-aware: `import { t as tr }; tr(…)` and aliased-base `i.t(…)`). It resolves the FUNCTION, not the key — a dynamic key stays unresolvable. Honest edges: a COMPUTED-index call `i18n[expr]()`, t passed as a value, and multi-hop re-export chains under-report (never fabricate); within-file shadowing of a bound name is the syntactic bound (no scope check).',
  ],
  table: i18nLookupTable,
  async run(ctx, args) {
    const i18n = ctx.plugins.get<I18nPluginApi>('i18n');
    try {
      const view = i18n.lookup(args);
      const failures = [...i18n.parseFailures()].map(([file, message]) => ({ file, message }));
      return ok({
        // Verdict-before-bulk (§12): the incompleteness flag leads, so a cap can never bury it.
        ...(view.usagesIncomplete !== undefined ? { usagesIncomplete: view.usagesIncomplete } : {}),
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
