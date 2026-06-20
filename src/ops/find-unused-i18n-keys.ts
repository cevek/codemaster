// `find_unused_i18n_keys` — locale keys with zero literal usages observed in TS/TSX. The
// op IS the join (keys from the i18n plugin minus the `t('…')` literals the ts plugin
// observed). A dynamic `t(`errors.codes.${x}`)` demotes ONLY the `errors.codes.*` namespace to
// `partial` (its static prefix is the only provable bound); a HEADLESS dynamic call (`t(k)`,
// `t(`${x}`)`) — or a parse failure / unresolved module — demotes EVERY claim (§3.3/§3.6).
//
// To keep one dynamic key from burying the genuinely-dead tail in 1000+ all-`partial` rows
// (backlog I-a), the default render lists the `certain`-dead keys and COLLAPSES the partials to a
// summary (count + reason + how to narrow). `partials:'list'` lists them all; `partials:'hide'`
// shows only the certain tail. sql-mode emits every row (each with its confidence) uncapped.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { I18nPluginApi, UnusedKeyView } from '../plugins/i18n/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

const DEFAULT_LIMIT = 200;
const ROW_CAP_HINT = 'raise limit (or in sql-mode the per-call row bound was hit)';

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
    // never a hardcoded cause that could contradict it; and state plainly that the `certain`
    // rows ARE provably dead even when some others are demoted.
    const reason =
      (data as { degradedReason?: string }).degradedReason ?? 'definitely dead is unprovable';
    if ((data as { globalDemote?: boolean }).globalDemote === true)
      return [`every unused-claim demoted to partial — ${reason}. No row here is provably dead.`];
    return [`some namespaces demoted to partial — ${reason}. confidence='certain' rows ARE dead.`];
  },
};

export const findUnusedI18nKeysOp = defineOp({
  name: 'find_unused_i18n_keys',
  summary: 'Locale keys with no literal t() usage; a dynamic key demotes only its namespace',
  mutating: false,
  requires: ['ts', 'i18n'],
  argsSchema: z.strictObject({
    prefix: z.string().optional(),
    pathInclude: z.array(z.string()).optional(),
    pathExclude: z.array(z.string()).optional(),
    partials: z.enum(['summary', 'list', 'hide']).optional(),
    limit: z.number().int().positive().max(2000).optional(),
  }),
  argsHint:
    "{ prefix?: string, pathInclude?: string[], pathExclude?: string[], partials?: 'summary'|'list'|'hide', limit?: number }",
  example: { args: { prefix: 'errors.codes' } },
  notes: [
    'a dynamic t() call demotes unused-claims to partial. A TEMPLATE with a static prefix (t(`errors.codes.${x}`)) demotes ONLY the errors.codes.* namespace — unrelated keys stay certain; a HEADLESS dynamic call (t(k) / t(`${x}`)), a locale parse failure, or an unresolved i18n module demotes EVERY claim. Never reported as definitely-unused when demoted.',
    "partials (default 'summary'): the certain-dead keys are always listed; 'summary' collapses the demoted (partial) keys to a count + reason + narrow-hint (so one dynamic key never buries the dead tail in 1000+ rows), 'list' lists every partial key, 'hide' drops them entirely. The partial summary names the demoted namespaces.",
    'when i18n.module is configured, usages match by SYMBOL IDENTITY: a key counts as used iff a call whose callee resolves to a function FROM that module (import / alias / namespace, or a `const { t } = useTranslation()` hook destructure incl. a renamed `{ t: x }`) references it. This closes the by-name residuals: a same-named t from another module no longer keeps a key alive, and a renamed-destructure / namespace-alias usage is no longer mis-reported as unused. Without i18n.module the by-name model is used (alias-aware).',
    'BOUNDARY (identity mode): a key reached ONLY through a COMPUTED-index call (`i18n[expr]()`), a t passed as a value, or a multi-hop re-export chain is not counted, so it MAY be reported unused (under-report, never a fabricated usage). Within-file shadowing of a bound name is the syntactic bound (no scope check).',
    'prefix (dotted key namespace, e.g. "errors.codes" — segment-aware, same as i18n_lookup; no trailing dot) + pathInclude/pathExclude (globs over the locale path) scope which keys are REPORTED; scanned.keys reflects the scope. The demotion verdict still reflects the whole usage scan, so scoping never invents a certain-dead key.',
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
      // Verdict-before-bulk (§12): the small load-bearing fields render FIRST so the hard
      // char-cap can only ever truncate the (truncation-reported) `unused` tail, never the verdict.
      const head = {
        degraded: view.degraded,
        globalDemote: view.globalDemote,
        ...(view.degradedReason !== undefined ? { degradedReason: view.degradedReason } : {}),
        scanned: { keys: view.scannedKeys, usages: view.scannedUsages },
        ...(failures.length > 0
          ? { parseFailures: failures.map((f) => tag('parse-failure', f)) }
          : {}),
      };

      // sql-mode (§2.3): emit EVERY row (each with its confidence) so a NOT IN never lies; cap
      // only at the engine's table bound and report truncation so the table is marked partial.
      if (ctx.tableRowBound !== undefined) {
        const rows = view.unused.slice(0, ctx.tableRowBound);
        return ok(
          { ...head, unused: rows.map((u) => tag('i18n-unused-key', u)) },
          rows.length < view.unused.length
            ? { truncated: { shown: rows.length, total: view.unused.length, hint: ROW_CAP_HINT } }
            : undefined,
        );
      }

      const mode = args.partials ?? 'summary';
      const certain = view.unused.filter((u) => u.confidence === 'certain');
      const partial = view.unused.filter((u) => u.confidence === 'partial');
      const listed = mode === 'list' ? view.unused : certain;
      const cap = args.limit ?? DEFAULT_LIMIT;
      const shown = listed.slice(0, cap);
      const data = {
        ...head,
        ...(mode !== 'list' && partial.length > 0
          ? {
              partial:
                mode === 'hide'
                  ? { count: partial.length }
                  : {
                      count: partial.length,
                      // Only the namespaces that actually cover a REPORTED partial key — a
                      // whole-scan prefix with no in-scope partials would mislabel the summary.
                      demoted: view.globalDemote
                        ? 'global'
                        : view.demotedPrefixes.filter((p) =>
                            partial.some((u) => u.key.startsWith(p)),
                          ),
                      hint: 'cannot prove these dead — partials:"list" to see them, or narrow with prefix=<namespace>',
                    },
            }
          : {}),
        unused: shown.map((u) => tag('i18n-unused-key', u)),
      };
      return ok(
        data,
        shown.length < listed.length
          ? { truncated: { shown: shown.length, total: listed.length, hint: ROW_CAP_HINT } }
          : undefined,
      );
    } catch (thrown) {
      return failFromThrown('i18n', thrown);
    }
  },
});
