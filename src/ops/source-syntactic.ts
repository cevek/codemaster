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
import { ok, partial } from '../common/result/construct.ts';
import type { Deadline } from '../common/async/deadline.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { TsTargetInput } from '../plugins/ts/plugin.ts';
import { SYNTACTIC_SCOPE, surfaceModeNote } from '../plugins/ts/plugin.ts';
import { describeTsTarget } from './ts-target.ts';

/** The scope + provenance statement every syntactic-`source` answer leads with (verdict-first, §12).
 *  Always on: the one thing an agent must not have to infer is whether the bytes it is reading were
 *  type-verified. It also states the two things this path structurally cannot do, so a miss below is read
 *  as a capability boundary rather than as an absence — and its one completeness limit: with no binder
 *  TS's declaration index collapses an overload set, so the implementation is what gets printed and the
 *  body-less signatures are not listed. */
export const SYNTACTIC_SOURCE_NOTE = `syntactic (AST-only, no program built, no type-check): ${SYNTACTIC_SCOPE} Bodies are read at the address given — this path does not follow a reference to its definition and resolves no module specifier; both come back as an explicit miss. An overload set prints its implementation and does not list the signatures. Drop syntactic:true for the type-verified path.`;

/** Read N declaration bodies off the syntactic surface. The plugin resolves the surface ONCE for the
 *  whole call, so every target is answered against one state (§8). A `ToolFailure` from the plugin (git,
 *  the @internal helper) is returned as-is for the WHOLE call — a per-target "not found" in its place
 *  would read as a proven absence (§3.6). */
export function runSourceSyntactic(
  ts: TsPluginApi,
  targets: readonly TsTargetInput[],
  deadline?: Deadline,
): Result<JsonValue> {
  const res = ts.sourceSyntactic(targets, deadline);
  if (!res.ok) return res;
  // The surface these bodies were read from (§8: read after the call built it). `undefined` when the
  // documented default (git) held → byte-identical answer; anything else prints ahead of the note.
  const surfaceMode = surfaceModeNote(ts.syntacticSurfaceProvenance());
  const surface = surfaceMode === undefined ? {} : { surface: surfaceMode };
  const sources: JsonValue[] = [];
  const unresolved: JsonValue[] = [];
  res.data.outcomes.forEach((outcome, i) => {
    const target = targets[i];
    const label = target === undefined ? '<target>' : describeTsTarget(target);
    if ('miss' in outcome) {
      unresolved.push({
        target: label,
        reason: outcome.miss,
        ...(outcome.rebind !== undefined ? { handle: { status: outcome.rebind.status } } : {}),
      });
      return;
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
      // §3.4: a merged declaration (an overload set, `interface` + `namespace`) has several — showing one
      // without saying so is a completeness lie. Same key as the checker path's `moreDefinitions`, and it
      // carries the same meaning: other declarations OF THIS SYMBOL, never a same-named other symbol.
      ...(moreDeclarations !== undefined && moreDeclarations.length > 0
        ? { moreDefinitions: [...moreDeclarations] }
        : {}),
    });
  });
  const data = {
    ...surface,
    note: SYNTACTIC_SOURCE_NOTE,
    sources,
    ...(unresolved.length > 0 ? { unresolved } : {}),
  };
  // §19: the budget cut the target loop short. The bodies already read ARE real data, so `partial` is the
  // honest shape — but the un-read targets must not be absent silently, which would read as "nothing
  // there" for a target we never looked at.
  if (res.data.timedOut === true) {
    return partial(
      {
        ...data,
        note: `${SYNTACTIC_SOURCE_NOTE} !! wall-clock budget reached — the remaining targets of this call were NOT read (re-request them); their absence here is not an absence in the repo.`,
      },
      { tool: 'timeout', message: 'the syntactic target loop exceeded its wall-clock budget' },
    );
  }
  return ok(data);
}
