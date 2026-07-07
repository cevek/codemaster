// Shared view types for the read-side TS queries (definitions / usages / type-expand).
// Split out so each query file stays a single responsibility under the line cap; these
// are pure data shapes the ops project and render, carried proof-first (every view holds
// the `Span` that proves it).

import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import type { HandleRebind } from '../../core/ids.ts';
import type { UsageRole } from './usage-roles.ts';

/** A target that could not be resolved but whose stale handle DID rebind — carries the
 *  structured `HandleRebind` (notably `{status:'gone'}`, §6) so the op surfaces it on the
 *  failure's `handle` field instead of flattening the §6 signal into a bare message. The
 *  plain-`string` miss (no handle held, or a position that exists but cannot be re-located)
 *  stays a message. */
export type UnresolvedTarget = { unresolved: string; rebind: HandleRebind };

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
  /** The symbol's type has a call/construct signature (a function, method, class, OR an
   *  arrow/fn-expr-bound `const` whose `kind` reads as `const`). `impact` uses this to flag a
   *  value-only read of a CALLABLE as a dynamic-dispatch boundary — a kind-only check misses the
   *  arrow-const case. Populated by `buildDefinition`; absent where it wasn't computed. */
  callable?: boolean;
};

export type UsageView = {
  span: Span;
  role: UsageRole;
  confidence: Confidence;
  /** The program that surfaced this ref (`tsconfig.json` / `tsconfig.test.json`), primary
   *  preferred. Populated ONLY when more than one program is loaded (Task G) — so a single-program
   *  repo's view shape is unchanged. HONEST ASYMMETRY: a sibling label means present ONLY there; the
   *  primary label means present in primary, POSSIBLY elsewhere too (the dedup prefers primary and
   *  this label cannot enumerate every containing program). */
  program?: string;
  /** `mergeDeclarations` mode: indices into `UsagesView.mergedDeclarations` of the declaration(s)
   *  whose reference set surfaced this exact site — per-site provenance so two unrelated same-named
   *  symbols are never presented as one undifferentiated set (§3.3). */
  decls?: number[];
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
  /** Multi-program (Task G): the comma-joined set of programs that surfaced the refs rolled up
   *  here (a group can span programs). Populated ONLY when more than one program is loaded. */
  programs?: string;
  /** `mergeDeclarations` mode: the comma-joined set of `mergedDeclarations` indices whose refs
   *  rolled up into this encloser (per-site provenance aggregated to the group, §3.3). */
  decls?: string;
  /** A representative reference SITE inside this encloser — the span of the first
   *  reference rolled up here (`line`/`col` above are the encloser's NAME token, not
   *  where the reference is). Populated by the rollup.
   *
   *  `find_usages` SURFACES it (a group becomes proof-carrying at the reference level —
   *  the condense renderer has a key set WITH `site`). `impact` STRIPS it (via
   *  `group-row.ts`'s `omitGroupSite`): it pins the precise `dynamic` value-flow boundary at
   *  `site` separately, and a per-row span across the whole closure listing is noise (§12).
   *  The terse renderer matches a `GroupRow` by its sorted key set
   *  (`format/render/condense.ts`), so any new `GroupRow` emit path must either strip site
   *  or add a matching condense branch — never leak an unrecognized key set. (The optional
   *  `programs`/`decls` decorations above are STRIPPED from the key set before matching and
   *  appended to the rendered line, so they don't multiply the branch set.) */
  site?: Span;
};

export type UsageOptions = {
  limit: number;
  /** Keep only references with this syntactic role (e.g. 'jsx'). */
  role?: UsageRole | undefined;
  /** Roll references up to their nearest enclosing named declaration. */
  groupBy?: 'enclosing' | undefined;
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
  /** Grouped mode: keep only enclosers of this kind
   *  ('function'|'method'|'class'|'const'|'variable'|'module'). */
  enclosingKind?: string | undefined;
  /** Grouped mode: keep only exported enclosers. */
  exportedOnly?: boolean | undefined;
  /** Drop an `import`-role ref iff its file ALSO has a substantive (non-import) ref —
   *  imports are bookkeeping for the usages that follow. Default on; the op forces it OFF
   *  in sql-mode (a capped table feeding NOT IN over import rows would lie — §2.2) and a
   *  `role:'import'` question is naturally unaffected. Never a filter: an import-only file
   *  always stays, and `reexport` refs (barrel surface) are never dropped. */
  collapseImports?: boolean | undefined;
  /** Union usages across ALL same-named declarations (the interface-decl + host-decl + impl
   *  triplet pattern), instead of failing on the ambiguity. Per-site provenance is preserved
   *  (`UsageView.decls`), so unrelated same-named symbols are never silently conflated (§3.3).
   *  Only meaningful for a `name` target — a SymbolId / position addresses one declaration. */
  mergeDeclarations?: boolean | undefined;
};

export type UsagesView = {
  definition?: SymbolView;
  /** `mergeDeclarations` mode: the declarations whose usages were unioned, in `decls`-index
   *  order — the legend each `UsageView.decls` entry points into. */
  mergedDeclarations?: SymbolView[];
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
  /** §3.4 FLOOR: repo tsconfigs NOT loaded as programs (a nested-package config neither adjacent
   *  to the primary nor `references`d, and not loaded by the read-path nearest-config discovery) —
   *  a usage living ONLY under such a program is NOT searched, so this set being non-empty means
   *  the usages are a LOWER BOUND, never provably complete. Set-level (the found usages are each
   *  `certain`; incompleteness is a property of the SET, not any row), surfaced by the op as
   *  `complete:false` + a named `!!` note. Absent/empty ⇒ every loaded program was searched. */
  undiscoveredPrograms?: string[];
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
  /** The quick-info one-liner. Present ONLY for a single-line declaration (where it IS the whole
   *  resolved type); for a multi-line type it is omitted and `type` carries the head verbatim — the
   *  two are mutually exclusive, never the same line twice (field feedback; output-density audit). */
  about?: string;
  /** The full resolved type text. Present whenever the resolved type is multi-line (adds anything
   *  beyond the first line); omitted for single-line declarations, where `about` carries it. */
  type?: string;
  doc?: string;
  span?: Span;
  /** Object-like members (§3.3). An optional member's ` | undefined` is stripped (the `?` already
   *  implies it) — except under exactOptionalPropertyTypes, where an explicit `| undefined` is a
   *  distinct type and is kept (type-expand.ts). */
  members?: MemberView[];
  /** Union / intersection constituents — one entry per arm (§3.3). SUPPRESSED when the head
   *  (`about`/`type`) already lists every arm verbatim and isn't LS-truncated (it would just repeat
   *  them); a wide/elided union keeps it as the load-bearing complete list (density audit). */
  constituents?: string[];
  /** Call signatures of a callable type — EVERY overload, each NoTruncation (the checker has them
   *  via `getSignaturesOfType`). Present whenever the type is callable: quick-info shows only the
   *  first signature + a `(+N overload)` count, dropping the rest, so the full set lives here. For a
   *  function/namespace merge it carries the call shape while `members` carries the namespace
   *  exports — neither truncating the other (§3.4). */
  signatures?: string[];
  /** Honest caveats: depth cap reached, a member's type string elided, a nested object-literal
   *  member list capped — never a silent `…` (§3.4). The TOP-LEVEL member-list cap does NOT land
   *  here; it rides the structured `membersTruncated` below (→ `Result.truncated`) so a count-only
   *  consumer sees it. Nested (depth>1) overflow stays a soft note — `Truncation` is a single
   *  `{shown,total}` and can't carry multiple nested caps; a known, deliberate structured-channel gap. */
  notes?: string[];
  /** Top-level member-list cap (`memberLimit`): members shown vs the type's total property count.
   *  Present ONLY when the list was truncated; the op lifts it onto `Result.truncated` (the honest
   *  truncation channel), never a soft `notes` line. At `verbosity:'full'` the cap is unbounded, so
   *  this is absent unless an explicit `memberLimit` was passed. */
  membersTruncated?: { shown: number; total: number };
};

/** Depth + member bounds for structural type expansion (§3.3). */
export type ExpandOptions = { depth: number; memberLimit: number };
