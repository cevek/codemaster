// Shared leaf for the call-scan pair (§5-L2): the cross-tier "calls to a configured set of
// functions" types + pure AST helpers, imported by BOTH the by-name scan (literal-calls.ts) and
// the by-identity scan (call-identity-scan.ts). A leaf module so the two scans don't form an
// import cycle, and so the ts plugin's public surface (plugin.ts) can re-export these types
// WITHOUT reaching into either scan file. Domain-neutral: nothing here knows about i18n — the
// consuming plugin owns that policy (§4/§5).

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { spanFromRange } from './spans.ts';

/** How a matched callee resolved to a configured function — the self-audit trail (F-c).
 *  `written`: the configured name, as written · `alias`: a named-import / destructure rename ·
 *  `namespace`: a member access (`ns.t` / `i18n.t`) · `destructure`: a hook's `const { t } = …`. */
export type LiteralCallProvenance = 'written' | 'alias' | 'destructure' | 'namespace';

export type LiteralCall = {
  /** The configured name this call was matched to (`t`, `i18n.t`) — canonical, NOT the
   *  written callee (an aliased `tr` resolves to its configured `t`). */
  fn: string;
  /** The first argument's value when it is a plain string literal. Absent when dynamic. */
  arg?: string;
  /** Proof span over the first argument (the key site). */
  span: Span;
  /** True when the first argument is not a plain string literal (template/computed/var). */
  dynamic: boolean;
  /** How the callee resolved to `fn` — self-auditable resolution provenance (F-c). */
  provenance: LiteralCallProvenance;
};

/** What to match: the configured function names, optionally anchored to a `module` (+ a `hook`
 *  that returns the function) to switch from by-name to by symbol identity. */
export type CallMatchSpec = {
  functions: readonly string[];
  /** The module the functions are exported from — enables by-identity matching when set. */
  module?: string | undefined;
  /** The hook that returns a configured function (e.g. `useTranslation`). Requires `module`. */
  hook?: string | undefined;
};

export type LiteralCallsResult = {
  calls: LiteralCall[];
  /** Which model produced `calls`. */
  mode: 'by-name' | 'identity';
  /** identity mode only: did the configured `module` resolve to a real file? When `false`, no
   *  binding can be matched, so every usage is unseen — the consumer MUST demote its
   *  certain/dead verdicts (a §3.6 completeness lie otherwise). Always `true` in by-name mode
   *  (there is no module to resolve). */
  moduleResolved: boolean;
};

/** A configured dotted name (`i18n.t`) split into its base + leaf for member-access matching. */
export type DottedName = { base: string; leaf: string };

/** Split configured names into simple identifiers (`t`) and dotted member names (`i18n.t`). A
 *  leading-dot or multi-segment name is malformed for these matchers and silently under-reports
 *  (never fabricates): a `.t` lands in `simpleLeaves` and can never equal a real identifier; an
 *  `a.b.c` yields base `a.b`, which the single-identifier base matcher never matches. */
export function splitNames(fnNames: readonly string[]): {
  simpleLeaves: Set<string>;
  dotted: DottedName[];
} {
  const simpleLeaves = new Set<string>();
  const dotted: DottedName[] = [];
  for (const name of fnNames) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) simpleLeaves.add(name);
    else dotted.push({ base: name.slice(0, dot), leaf: name.slice(dot + 1) });
  }
  return { simpleLeaves, dotted };
}

/** What a matched callee resolved to — the unit a `MatchModel`'s matcher returns. */
export type CalleeMatch = { fn: string; provenance: LiteralCallProvenance };

/** A per-file matcher (built over that file's bindings/aliases) plus the shadow pool to thread
 *  down the AST. `pool` empty → no shadow threading happens (the by-name model never shadows). */
export type FilePrep = {
  match: (callee: ts.Expression, shadowed: ReadonlySet<string>) => CalleeMatch | undefined;
  pool: ReadonlySet<string>;
};

/** A matching model (by-name or by-identity): whether the configured module resolved, and a
 *  per-program factory of per-file preps. A file-prep `undefined` means "skip this file" (the
 *  by-identity model skips files with no module binding — the cost short-circuit it always had).
 *  The walk ({@link forEachMatchedCall}) drives the model; the model owns the resolution policy. */
export type MatchModel = {
  mode: LiteralCallsResult['mode'];
  moduleResolved: boolean;
  perGroup: (
    program: ts.Program,
  ) => (sourceFile: ts.SourceFile, rel: RepoRelPath) => FilePrep | undefined;
};

/** One matched call surfaced by the walk. `callId` is a stable, per-site key (`rel:offset`); a
 *  consumer joins nested calls to their lexical container via `enclosingMatchedCallId` — the
 *  nearest enclosing matched call (e.g. `invalidateQueries` inside a `useMutation`'s `onSuccess`),
 *  or `undefined` at the outermost match. */
export type MatchHit = {
  sourceFile: ts.SourceFile;
  rel: RepoRelPath;
  callNode: ts.CallExpression;
  fn: string;
  provenance: LiteralCallProvenance;
  callId: string;
  enclosingMatchedCallId?: string;
};

// ── Call-arg-shape scan (callArgShapes) ─────────────────────────────────────────────────────
// A GENERIC classification of a matched call's argument VALUES — the seam framework plugins
// (react-query: queryKey segments, invalidateQueries shapes) consume. Domain-neutral: nothing here
// knows queryKey/onSuccess; the consumer picks properties by name. A literal value is `certain`
// (read verbatim); a bare identifier / member access / interpolated template / spread / call is
// `dynamic` (the value is not statically determinable — never guessed, §3.3).

/** A classified argument/property/element value. A discriminated union over its syntactic shape;
 *  `array`/`object` recurse (bounded depth — deeper nodes collapse to `other`). */
export type ValueShape =
  | { kind: 'string'; value: string; span: Span; confidence: 'certain' }
  | { kind: 'number'; value: string; span: Span; confidence: 'certain' }
  | { kind: 'boolean'; value: string; span: Span; confidence: 'certain' }
  | { kind: 'null'; span: Span; confidence: 'certain' }
  | { kind: 'array'; elements: ValueShape[]; span: Span; confidence: Confidence }
  | { kind: 'object'; props: ValueProp[]; span: Span; confidence: Confidence }
  | { kind: 'function'; span: Span; confidence: 'certain' }
  | { kind: 'identifier'; span: Span; confidence: 'dynamic' }
  | { kind: 'property-access'; span: Span; confidence: 'dynamic' }
  | { kind: 'template'; span: Span; confidence: 'dynamic' }
  | { kind: 'spread'; span: Span; confidence: 'dynamic' }
  | { kind: 'call'; span: Span; confidence: 'dynamic' }
  | { kind: 'other'; span: Span; confidence: 'dynamic' };

/** One property of an object-literal argument. `key` is the static property name; a computed /
 *  spread property surfaces with a synthetic key (`[computed]` / `...`) so it is never silently
 *  dropped (§3.4). */
export type ValueProp = { key: string; value: ValueShape };

/** The enclosing named declaration a call rolls up to (chainable id, §6) — the association anchor
 *  (e.g. a `useMutation` and its `invalidateQueries` share one enclosing `const`). */
export type ShapedEncloser = { id: string; name: string; kind: string; span: Span };

export type ShapedCall = {
  /** The configured name this call matched (canonical, not the written callee). */
  fn: string;
  provenance: LiteralCallProvenance;
  /** Stable per-site key (`rel:offset`) — the join key for `enclosingCallId`. */
  callId: string;
  /** Span over the callee expression — proof of WHERE the call is. */
  callSpan: Span;
  /** Classified arguments (consumers typically read `args[0]`). */
  args: ValueShape[];
  encloser: ShapedEncloser;
  /** `callId` of the nearest enclosing matched call (e.g. the `useMutation` whose `onSuccess`
   *  lexically contains this `invalidateQueries`) — the precise disambiguator when one enclosing
   *  declaration holds more than one matched call. Absent at the outermost match. */
  enclosingCallId?: string;
};

export type CallArgShapesResult = {
  calls: ShapedCall[];
  mode: 'by-name' | 'identity';
  moduleResolved: boolean;
};

/** Classify a call's first argument: a string-literal-LIKE key is static (read verbatim);
 *  anything else (interpolated template, identifier, computed) is `dynamic`, never guessed (§18).
 *  `isStringLiteralLike` is exactly StringLiteral ∪ NoSubstitutionTemplateLiteral, so a backtick key
 *  with NO interpolation (`t(`a.b`)`) is the static literal it provably is — not falsely dynamic
 *  (which would drop a determinate use AND demote its namespace to partial). A `${…}` template is a
 *  `TemplateExpression`, NOT string-literal-like → still dynamic. Both literal forms expose `.text`. */
export function literalArgFields(
  sourceFile: ts.SourceFile,
  rel: Span['file'],
  arg0: ts.Expression,
): { arg?: string; span: Span; dynamic: boolean } {
  const span = spanFromRange(sourceFile, rel, arg0.getStart(sourceFile), arg0.getEnd());
  if (ts.isStringLiteralLike(arg0)) return { arg: arg0.text, span, dynamic: false };
  return { span, dynamic: true };
}
