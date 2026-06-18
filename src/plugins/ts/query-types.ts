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
