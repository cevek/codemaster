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
    { name: 'note', type: 'text' },
  ],
  rows(data) {
    const unused = (data as { unused?: UnusedKeyView[] }).unused ?? [];
    return unused.map((u): readonly Cell[] => [
      u.key,
      u.file,
      u.span.line,
      u.confidence,
      u.note ?? null,
    ]);
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
  argsSchema: z.strictObject({}),
  argsHint: '{}',
  example: { args: {} },
  notes: [
    'any dynamic call of a configured function demotes EVERY unused-claim to partial — flagged "could not prove dead", never reported as definitely unused.',
    'usages are matched by call name as written — an `import { t as tr }` alias is missed (syntactic, not symbol-resolved).',
  ],
  table: findUnusedI18nKeysTable,
  async run(ctx, _args) {
    const i18n = ctx.plugins.get<I18nPluginApi>('i18n');
    try {
      const view = i18n.unusedKeys();
      const failures = [...i18n.parseFailures()].map(([file, message]) => ({ file, message }));
      return ok({
        unused: view.unused,
        degraded: view.degraded,
        scanned: { keys: view.scannedKeys, usages: view.scannedUsages },
        ...(failures.length > 0 ? { parseFailures: failures } : {}),
      });
    } catch (thrown) {
      return failFromThrown('i18n', thrown);
    }
  },
});
