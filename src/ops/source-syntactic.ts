// `source { syntactic: true }` — the op-level projection of the no-program declaration reader
// (t-229522). Kept out of `source.ts` so each path is one responsibility and the file stays under the
// line cap; the shapes it emits are IDENTICAL to the checker path's (same keys, same renderer) except
// for the two honesty additions this path requires: a per-entry `provenance:'syntactic'` and the
// always-on scope note the op leads with.
//
// Why identical shapes matter: an agent that switches the flag must not have to re-learn the answer.
// So a divergence is only ever an ADDITION that says "this is not type-verified", never a rename.

import type { JsonValue } from '../core/json.ts';
import type { Result } from '../core/result.ts';
import { ok } from '../common/result/construct.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { TsTargetInput } from '../plugins/ts/plugin.ts';
import { SYNTACTIC_SCOPE } from './syntactic-scope.ts';

/** The scope + provenance statement every syntactic-`source` answer leads with (verdict-first, §12).
 *  Always on: the one thing an agent must not have to infer is whether the bytes it is reading were
 *  type-verified. It also states the one thing this path structurally cannot do, so a miss below is
 *  read as a capability boundary rather than as an absence. */
export const SYNTACTIC_SOURCE_NOTE = `syntactic (AST-only, no program built, no type-check): ${SYNTACTIC_SCOPE} Bodies are read at the address given — this path does not follow a reference to its definition and resolves no module specifier; both come back as an explicit miss. Drop syntactic:true for the type-verified path.`;

function describeTarget(t: TsTargetInput): string {
  if (t.symbolId !== undefined) return t.symbolId;
  if (t.name !== undefined) return t.name;
  if (t.file !== undefined) return `${t.file}:${t.line ?? '?'}:${t.col ?? '?'}`;
  return '<target>';
}

/** Read N declaration bodies off the syntactic surface. A `ToolFailure` from the plugin (git, the
 *  @internal helper) is returned as-is for the WHOLE call — a per-target "not found" in its place
 *  would read as a proven absence (§3.6). */
export function runSourceSyntactic(
  ts: TsPluginApi,
  targets: readonly TsTargetInput[],
): Result<JsonValue> {
  const sources: JsonValue[] = [];
  const unresolved: JsonValue[] = [];
  for (const target of targets) {
    const res = ts.sourceSyntactic(target);
    if (!res.ok) return res;
    const outcome = res.data;
    if ('miss' in outcome) {
      unresolved.push({
        target: describeTarget(target),
        reason: outcome.miss,
        ...(outcome.rebind !== undefined ? { handle: { status: outcome.rebind.status } } : {}),
      });
      continue;
    }
    const { view, moreDeclarations, rebind } = outcome.resolved;
    sources.push({
      id: view.id,
      name: view.name,
      kind: view.kind,
      // Same key as the checker path, and the same fallback: at worst the agent still gets a
      // proof-carrying location rather than nothing.
      decl: view.decl ?? view.span,
      // §3.3 per-site provenance: this body was located by an AST scan, not by the checker.
      provenance: 'syntactic',
      // §6: a rebind is stated, never silent — `source` is built for chained SymbolIds.
      ...(rebind !== undefined && rebind.status === 'rebound'
        ? { rebound: { from: rebind.from, to: rebind.to.id, confidence: rebind.confidence } }
        : {}),
      // §3.4: an overload set / merged declaration yields several — showing one without saying so
      // is a completeness lie. Same key as the checker path's `moreDefinitions`.
      ...(moreDeclarations !== undefined && moreDeclarations.length > 0
        ? { moreDefinitions: [...moreDeclarations] }
        : {}),
    });
  }
  return ok({
    note: SYNTACTIC_SOURCE_NOTE,
    sources,
    ...(unresolved.length > 0 ? { unresolved } : {}),
  });
}
