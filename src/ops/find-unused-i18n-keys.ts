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
    // Echo the REAL reason from the envelope (dynamic call / parse failure / unresolved module),
    // never a hardcoded cause that could contradict it.
    const reason = (data as { degradedReason?: string }).degradedReason;
    return [
      `every unused-claim demoted to partial — ${reason ?? 'definitely dead is unprovable'}.`,
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
    'when i18n.module is configured, usages match by SYMBOL IDENTITY: a key counts as used iff a call whose callee resolves to a function FROM that module (import / alias / namespace, or a `const { t } = useTranslation()` hook destructure incl. a renamed `{ t: x }`) references it. This closes the by-name residuals: a same-named t from another module no longer keeps a key alive, and a renamed-destructure / namespace-alias usage is no longer mis-reported as unused. Without i18n.module the by-name model is used (alias-aware).',
    'BOUNDARY (identity mode): a key reached ONLY through a COMPUTED-index call (`i18n[expr]()`), a t passed as a value, or a multi-hop re-export chain is not counted, so it MAY be reported unused (under-report, never a fabricated usage). Within-file shadowing of a bound name is the syntactic bound (no scope check). If the configured i18n.module does not resolve at all, every claim demotes to partial (no usage could be matched — never a silent all-dead).',
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
