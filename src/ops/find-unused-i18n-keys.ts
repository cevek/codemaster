// `find_unused_i18n_keys` — locale keys with zero literal usages observed in TS/TSX. The
// op IS the join (keys from the i18n plugin minus the `t('…')` literals the ts plugin
// observed). ANY dynamic call of a configured function ANYWHERE demotes EVERY unused-claim
// to `partial` with a note — a computed key could be any key (§3.3, the
// `find_unused_scss_classes` precedent: dynamic is flagged, never bridged).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { I18nPluginApi, UnusedKeyView } from '../plugins/i18n/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

const findUnusedI18nKeysTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'key', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'confidence', type: 'text' },
  ],
  rows(data) {
    const unused = (data as { unused?: UnusedKeyView[] }).unused ?? [];
    return unused.map((u): readonly Cell[] => [u.key, u.file, u.span.line, u.confidence]);
  },
  notes(data) {
    if ((data as { degraded?: boolean }).degraded !== true) return [];
    return [
      'every unused-claim demoted to partial: a dynamic t(`…`) call or a locale parse failure makes "definitely dead" unprovable for any key.',
    ];
  },
};

export const findUnusedI18nKeysOp = defineOp({
  name: 'find_unused_i18n_keys',
  summary: 'Locale keys with no literal t() usage in TS/TSX; any dynamic call demotes to partial',
  mutating: false,
  requires: ['ts', 'i18n'],
  argsSchema: z.strictObject({
    prefix: z.string().optional(),
    pathInclude: z.array(z.string()).optional(),
    pathExclude: z.array(z.string()).optional(),
  }),
  argsHint: '{ prefix?: string, pathInclude?: string[], pathExclude?: string[] }',
  example: { args: { prefix: 'errors.codes' } },
  notes: [
    'any dynamic call of a configured function demotes EVERY unused-claim to partial — flagged "could not prove dead", never reported as definitely unused.',
    'usages are import-resolved via the TS checker: a named-import alias (`import { t as tr }; tr(…)`) counts as t, and an aliased-base member access (`import { i18n as i }; i.t(…)`) counts as a configured dotted name like i18n.t — so an aliased call no longer over-reports a used key as unused. Matching stays confined to user-named bindings — a bare t never matches an arbitrary `obj.t()`, nor a destructure rename of a non-i18n value.',
    'BOUNDARY: a key used ONLY through a binding the resolver does not follow — a renamed destructure of the hook (`const { t: x } = useTranslation()`), element access (`i18n["t"]`), or `t` passed as a value — is not counted, so it may be reported unused. The certain/partial verdict reflects the RESOLVED usage scan only (a by-name limit; the module-anchored close is docs/plan.md F-b).',
    'prefix (dotted key namespace, e.g. "errors.codes" — segment-aware, same as i18n_lookup; no trailing dot) + pathInclude/pathExclude (globs over the locale path) scope which keys are REPORTED (the whole-locale answer caps fast — narrow it); scanned.keys reflects the scope. The degraded verdict still reflects the whole usage scan, so scoping never invents a certain-dead key.',
  ],
  table: findUnusedI18nKeysTable,
  async run(ctx, args) {
    const i18n = ctx.plugins.get<I18nPluginApi>('i18n');
    try {
      const view = i18n.unusedKeys({
        ...(args.prefix !== undefined ? { prefix: args.prefix } : {}),
        ...(args.pathInclude !== undefined ? { pathInclude: args.pathInclude } : {}),
        ...(args.pathExclude !== undefined ? { pathExclude: args.pathExclude } : {}),
      });
      const failures = [...i18n.parseFailures()].map(([file, message]) => ({ file, message }));
      return ok({
        unused: view.unused,
        degraded: view.degraded,
        ...(view.degradedReason !== undefined ? { degradedReason: view.degradedReason } : {}),
        scanned: { keys: view.scannedKeys, usages: view.scannedUsages },
        ...(failures.length > 0 ? { parseFailures: failures } : {}),
      });
    } catch (thrown) {
      return failFromThrown('i18n', thrown);
    }
  },
});
