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
  /** The name-token span — the proof of WHERE the symbol is (§3.1). */
  span: Span;
  /** The FULL enclosing-declaration span (§3.1): `export const X = …;`, the whole
   *  `interface`/`class`/`function` body. Carries verbatim text, so `find_definition` at
   *  full verbosity returns a signature+body, not an echo of the identifier. Populated by
   *  `findDefinitions`; absent where a declaration node couldn't be located. */
  decl?: Span;
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

/** One structural member of an expanded type (§3.3). `inherited` marks a member that
 *  comes from a base type, not the queried one. `members` is the nested expansion for an
 *  anonymous object-literal member at `depth > 1`. */
export type MemberView = {
  name: string;
  optional: boolean;
  type: string;
  inherited?: boolean;
  members?: MemberView[];
};

export type TypeView = {
  about: string;
  /** The full resolved type text. OMITTED when identical to `about` (single-line named
   *  declarations) — two identical lines are noise, not information (field feedback);
   *  present whenever the resolved type adds anything (multiline, aliases, literals). */
  type?: string;
  doc?: string;
  span?: Span;
  /** Object-like members (§3.3). */
  members?: MemberView[];
  /** Union / intersection constituents — one entry per arm (§3.3). */
  constituents?: string[];
  /** Honest caveats: member list capped (`… N more`), depth cap reached, type string
   *  elided — never a silent `…` (§3.4). */
  notes?: string[];
};

/** Depth + member bounds for structural type expansion (§3.3). */
export type ExpandOptions = { depth: number; memberLimit: number };
