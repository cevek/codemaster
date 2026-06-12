// Shared view types for the read-side TS queries (definitions / usages / type-expand).
// Split out so each query file stays a single responsibility under the line cap; these
// are pure data shapes the ops project and render, carried proof-first (every view holds
// the `Span` that proves it).

import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import type { UsageRole } from './usage-roles.ts';

export type SymbolView = {
  id: string;
  name: string;
  kind: string;
  span: Span;
  container?: string;
};

export type UsageView = {
  span: Span;
  role: UsageRole;
  confidence: Confidence;
};

/** One enclosing-declaration rollup row. `id` is a chainable ts: SymbolId of the
 *  encloser; `count` = references inside it. `name`/`file`/`line`/`col`/`exported` are
 *  carried explicitly (not decoded from `id`) so a relational projection of this row never
 *  has to crack open the opaque SymbolId payload (§6). `exported` is `false` for a
 *  module-level (top-level) rollup — those are not exported symbols. */
export type GroupRow = {
  id: string;
  name: string;
  file: RepoRelPath;
  line: number;
  col: number;
  kind: string;
  count: number;
  roles: string;
  exported: boolean;
  confidence: Confidence;
};

export type UsageOptions = {
  limit: number;
  /** Keep only references with this syntactic role (e.g. 'jsx'). */
  role?: UsageRole | undefined;
  /** Roll references up to their nearest enclosing named declaration. */
  groupBy?: 'enclosing' | undefined;
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
  /** Grouped mode: keep only enclosers of this kind ('function'|'method'|'class'|'module'). */
  enclosingKind?: string | undefined;
  /** Grouped mode: keep only exported enclosers. */
  exportedOnly?: boolean | undefined;
  /** Drop an `import`-role ref iff its file ALSO has a substantive (non-import) ref —
   *  imports are bookkeeping for the usages that follow. Default on; the op forces it OFF
   *  in sql-mode (a capped table feeding NOT IN over import rows would lie — §2.2) and a
   *  `role:'import'` question is naturally unaffected. Never a filter: an import-only file
   *  always stays, and `reexport` refs (barrel surface) are never dropped. */
  collapseImports?: boolean | undefined;
};

export type UsagesView = {
  definition?: SymbolView;
  /** Flat mode. */
  usages?: UsageView[];
  /** Grouped mode (`groupBy: 'enclosing'`), sorted by count desc. */
  groups?: GroupRow[];
  /** Grouped mode: distinct enclosers BEFORE the limit cap. `groups.length` may be less —
   *  the gap is honest truncation of the rollup (§3.4), surfaced by the op. */
  groupTotal?: number;
  /** References matching the question (post role filter), before the limit cap. Counts
   *  everything matched — collapsing imports for display never shrinks it (§2.2). */
  total: number;
  /** References dropped by YOUR filters (path/kind/exported) — explicit, so a filter
   *  never reads as completeness (§3.4). */
  excluded: number;
  /** `import`-role refs hidden by the conditional collapse (§2.2) — their files still
   *  appear via a real usage. Display-only: `total` still counts them. */
  importsCollapsed?: number;
  /** Per-role counts of the role-UNFILTERED answer (same path filters), populated only
   *  when a `role` filter is active (§2.3). Lets an empty `0 usages` show what the
   *  unfiltered answer looked like — "0" must never be indistinguishable from "none
   *  exist", which is a §3.4-class lie. */
  roleBreakdown?: Record<string, number>;
};

export type TypeView = {
  about: string;
  type: string;
  doc?: string;
  span?: Span;
};
