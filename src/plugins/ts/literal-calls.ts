// Cross-tier observation (§5-L2): calls to a configured set of functions — `t('a.b')`, `i18n.t('x')`,
// a hook's destructured `const { t } = useTranslation()` — with NO i18n knowledge inside the ts
// plugin. The i18n plugin (`deps: ['ts']`) consumes this; the cross-tier fact lives with the plugin
// that *observes* it. A string-literal first argument is read verbatim; a template / computed /
// non-literal argument is flagged `dynamic`, never guessed (§3.3/§18).
//
// This is a THIN consumer of the shared matched-call walk (call-match-walk.ts): the walk surfaces
// every matched call (by-name or by-identity, chosen by `spec.module`); here we keep only calls with
// a first argument and project it to its literal key. The two matching models + the per-call
// iteration are owned upstream — see call-match-byname.ts / call-identity-scan.ts / call-match-walk.ts.

import type { TsProjectHost } from './ls-host.ts';
import { forEachMatchedCall } from './call-match-walk.ts';
import {
  literalArgFields,
  type CallMatchSpec,
  type LiteralCall,
  type LiteralCallsResult,
} from './call-scan-shared.ts';

export function scanLiteralCalls(host: TsProjectHost, spec: CallMatchSpec): LiteralCallsResult {
  const calls: LiteralCall[] = [];
  const { mode, moduleResolved } = forEachMatchedCall(host, spec, (hit) => {
    const arg0 = hit.callNode.arguments[0];
    if (arg0 === undefined) return; // a key usage needs a first argument
    calls.push({
      fn: hit.fn,
      ...literalArgFields(hit.sourceFile, hit.rel, arg0),
      provenance: hit.provenance,
    });
  });
  return { calls, mode, moduleResolved };
}
