// Shared leaf for the call-scan pair (§5-L2): the cross-tier "calls to a configured set of
// functions" types + pure AST helpers, imported by BOTH the by-name scan (literal-calls.ts) and
// the by-identity scan (call-identity-scan.ts). A leaf module so the two scans don't form an
// import cycle, and so the ts plugin's public surface (plugin.ts) can re-export these types
// WITHOUT reaching into either scan file. Domain-neutral: nothing here knows about i18n — the
// consuming plugin owns that policy (§4/§5).

import ts from 'typescript';
import type { Span } from '../../core/span.ts';
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

/** Classify a call's first argument: a plain string literal is a static key (read verbatim);
 *  anything else (template, identifier, computed) is `dynamic`, never guessed (§18). */
export function literalArgFields(
  sourceFile: ts.SourceFile,
  rel: Span['file'],
  arg0: ts.Expression,
): { arg?: string; span: Span; dynamic: boolean } {
  const span = spanFromRange(sourceFile, rel, arg0.getStart(sourceFile), arg0.getEnd());
  if (ts.isStringLiteral(arg0)) return { arg: arg0.text, span, dynamic: false };
  return { span, dynamic: true };
}
