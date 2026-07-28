// `find_unused_i18n_keys` — locale keys with zero literal usages observed in TS/TSX. The
// op IS the join (keys from the i18n plugin minus the `t('…')` literals the ts plugin
// observed). A dynamic `t(`errors.codes.${x}`)` demotes ONLY the `errors.codes.*` namespace to
// `partial` (its static prefix is the only provable bound); a HEADLESS dynamic call (`t(k)`,
// `t(`${x}`)`) — or a parse failure / unresolved module — demotes EVERY claim (§3.3/§3.6).
//
// To keep one dynamic key from burying the genuinely-dead tail in 1000+ all-`partial` rows
// (backlog I-a), the default render lists the `certain`-dead keys and COLLAPSES the partials to a
// summary (count + reason + a remedy computed from THIS call's args). `partials:'list'` lists them
// all; `partials:'hide'` shows only the certain tail. sql-mode emits every row uncapped.
//
// The summary verdict is SCOPED to what the call reports and the blocking call sites are named
// (t-949045): a `prefix=` answer whose every row is provable is not stamped `degraded` by a dynamic
// call confined elsewhere, and a demote that narrowing cannot lift says so instead of proposing the
// narrowing the caller already applied. Per-key confidence is untouched (the whole-scan fact).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Span } from '../core/span.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { nameWithMore } from '../common/truncate/name-with-more.ts';
import { HIDE_CONF_KEY } from '../format/render/shapes/meta-keys.ts';
import type { I18nPluginApi, UnusedKeyView } from '../plugins/i18n/plugin.ts';
import type { I18nUnusedView } from '../plugins/i18n/views.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

const DEFAULT_LIMIT = 200;
const ROW_CAP_HINT = 'raise limit (or in sql-mode the per-call row bound was hit)';
/** How many blocking call sites are shown inline. The cut states itself as `more` inside the
 *  `blocking` block — NOT through the envelope `Truncation`, which the `unused` row cap owns
 *  (two cuts of different natures must not share one channel, §3.4). */
const BLOCKER_CAP = 3;

const locOf = (s: Span): string => `${s.file}:${s.line}:${s.col}`;

/** The remedy line for the collapsed partials — computed from the CALL's own args, so it can never
 *  propose the state the caller is already in (t-949045: both reporters passed `prefix=` and were
 *  told to "narrow with prefix"). A global demote is not liftable by narrowing at all; a namespace
 *  demote is, but only for a caller who has not already narrowed INTO the demoted namespace. */
function partialHint(
  view: I18nUnusedView,
  prefix: string | undefined,
  reached: readonly string[],
): string {
  const sites = view.blockers.map(locOf);
  // Necessary, never sufficient: with a cause no call can fix also standing, repairing the named
  // site leaves the verdict identical — the remedy line must say so, not just the docs (§3.6).
  const also = view.nonCallCause ? ' (a non-call cause also stands — see degradedReason)' : '';
  const at = sites.length > 0 ? ` — blocking dynamic call: ${nameWithMore(sites, 1)}${also}` : '';
  const list = 'partials:"list" to see them';
  if (view.globalDemote)
    return `narrowing does not lift this demote: no key anywhere is provable${at}. ${list}`;
  // Named, not dumped — the same set is already on `demoted` beside this line.
  const demoted = nameWithMore([...reached], 3);
  // A prefix ALREADY inside a demoted namespace cannot be narrowed out of it — every sub-namespace
  // is demoted too. A BROADER prefix (or none) still has provable siblings to narrow to.
  if (prefix !== undefined && reached.some((h) => `${prefix}.`.startsWith(h)))
    return `narrowing further does not lift this demote: prefix="${prefix}" is inside the demoted namespace(s) ${demoted}${at}. ${list}`;
  // Only promise the narrowing remedy when a key outside the demoted heads actually EXISTS. The
  // fact is whole-scan (`anyProvableKey`), not this answer's own rows: a caller who already
  // narrowed into the demoted namespace sees no certain row, which says nothing about the repo.
  const remedy = view.anyProvableKey ? 'a prefix= outside them returns a provable answer, or ' : '';
  return `these keys are under the demoted namespace(s) ${demoted}${at} — ${remedy}${list}`;
}

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
    "partials (default 'summary'): the certain-dead keys are always listed; 'summary' collapses the demoted (partial) keys to a count + reason + a remedy hint (so one dynamic key never buries the dead tail in 1000+ rows), 'list' lists every partial key, 'hide' drops them entirely. The partial summary names the demoted namespaces, and the hint is computed from THIS call's args — it never proposes the narrowing the caller has ALREADY applied, and says outright when narrowing cannot lift the demote.",
    'blocking: the dynamic call sites a caller must change for the reported keys to become provable — proof spans of WHICH t() cost the verdict, capped with `more`. The CAUSAL set, not every reaching call: under a global demote only the headless calls are named (a headed one is subsumed), and a demote caused by a locale parse failure / an unresolved module names NO call (empty). Necessary, never sufficient — when degradedReason also names a parse failure, fixing the t() alone does not lift the demote.',
    'i18n.module identity match-model: see i18n_lookup. With it, a same-named t from another module no longer keeps a key alive and a renamed-destructure / namespace-alias usage is no longer mis-reported as unused; without it, the by-name model (alias-aware).',
    'BOUNDARY (identity mode): a key reached ONLY through a COMPUTED-index call (`i18n[expr]()`), a t passed as a value, or a multi-hop re-export chain is not counted, so it MAY be reported unused (under-report, never a fabricated usage). Within-file shadowing of a bound name is the syntactic bound (no scope check).',
    'prefix (dotted key namespace, e.g. "errors.codes" — segment-aware, same as i18n_lookup; no trailing dot) + pathInclude/pathExclude (globs over the locale path) scope which keys are REPORTED; scanned.keys reflects the scope. Each key\'s own confidence still reflects the WHOLE usage scan, so scoping never invents a certain-dead key; only the summary degraded/degradedReason follow the scope — a prefix whose every row is provable is NOT stamped degraded by a dynamic call confined to another namespace (globalDemote stays the whole-scan fact). A locale parse failure / an unresolved i18n module stay WHOLE-SCAN: they HIDE keys, so even an all-provable scope — including an EMPTY one — reads degraded, never clean.',
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
      // A GLOBAL demote already states every claim is partial (the envelope note below), so the
      // per-row `· partial` is repetition — `~hideConf` drops the tail in text (confidence stays on
      // every row, so json/sql are unchanged). A namespace-only demote keeps the per-row tail (the
      // confidence varies: certain vs partial rows are the signal).
      const tagKey = (u: UnusedKeyView): JsonValue =>
        tag('i18n-unused-key', view.globalDemote ? { ...u, [HIDE_CONF_KEY]: true } : u);
      // Verdict-before-bulk (§12): the small load-bearing fields render FIRST so the hard
      // char-cap can only ever truncate the (truncation-reported) `unused` tail, never the verdict.
      // The demote's PROOF, beside its reason: the dynamic call sites that reach the reported keys
      // (t-949045 — the caller could not find which t() cost them the verdict). Capped inline with
      // its own `more`, so the envelope's Truncation stays the `unused` row cap's alone.
      const blockers = view.blockers;
      const blocking =
        blockers.length === 0
          ? {}
          : {
              blocking: {
                count: blockers.length,
                sites: blockers.slice(0, BLOCKER_CAP).map((span) => tag('bare-span', { span })),
                ...(blockers.length > BLOCKER_CAP ? { more: blockers.length - BLOCKER_CAP } : {}),
              },
            };
      const head = {
        degraded: view.degraded,
        globalDemote: view.globalDemote,
        ...(view.degradedReason !== undefined ? { degradedReason: view.degradedReason } : {}),
        ...blocking,
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
          { ...head, unused: rows.map(tagKey) },
          rows.length < view.unused.length
            ? { truncated: { shown: rows.length, total: view.unused.length, hint: ROW_CAP_HINT } }
            : undefined,
        );
      }

      const mode = args.partials ?? 'summary';
      const certain = view.unused.filter((u) => u.confidence === 'certain');
      const partial = view.unused.filter((u) => u.confidence === 'partial');
      const reached = view.demotedPrefixes.filter((p) => partial.some((u) => u.key.startsWith(p)));
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
                      demoted: view.globalDemote ? 'global' : reached,
                      hint: partialHint(view, args.prefix, reached),
                    },
            }
          : {}),
        unused: shown.map(tagKey),
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
