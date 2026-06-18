// callArgShapes (§5-L2): for every call to a configured set of functions (by-name or by-identity,
// exactly like literalCalls — the same CallMatchSpec), surface the classified SHAPE of its
// arguments plus association anchors. The seam framework plugins consume — e.g. react-query reads
// `queryKey` array segments off a `useQuery` call, and links a nested `invalidateQueries` to its
// `useMutation` via the shared enclosing declaration (`encloser`) or the precise lexical container
// (`enclosingCallId`). GENERIC: zero react-query policy here — the consumer picks properties by name
// and decides what they mean (§4). A THIN consumer of the shared matched-call walk: the walk owns
// matching + cross-program iteration + the enclosing-matched-call stack; here we project shapes.

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { TsProjectHost } from './ls-host.ts';
import { forEachMatchedCall } from './call-match-walk.ts';
import { classifyValue } from './value-shape.ts';
import { enclosingConstruction } from './construction-encloser.ts';
import { mintEncloserId } from './encloser-id.ts';
import { mintSymbolId, moduleName } from './symbol-id.ts';
import { spanFromRange } from './spans.ts';
import type {
  CallArgShapesResult,
  CallMatchSpec,
  ShapedCall,
  ShapedEncloser,
} from './call-scan-shared.ts';

export function scanCallArgShapes(host: TsProjectHost, spec: CallMatchSpec): CallArgShapesResult {
  const calls: ShapedCall[] = [];
  const { mode, moduleResolved } = forEachMatchedCall(host, spec, (hit) => {
    const { sourceFile, rel, callNode } = hit;
    const args = callNode.arguments.map((a) => classifyValue(sourceFile, rel, a));
    const callee = callNode.expression;
    const callSpan = spanFromRange(sourceFile, rel, callee.getStart(sourceFile), callee.getEnd());
    calls.push({
      fn: hit.fn,
      provenance: hit.provenance,
      callId: hit.callId,
      callSpan,
      args,
      encloser: buildEncloser(host, sourceFile, rel, callNode),
      ...(hit.enclosingMatchedCallId !== undefined
        ? { enclosingCallId: hit.enclosingMatchedCallId }
        : {}),
    });
  });
  return { calls, mode, moduleResolved };
}

/** The nearest enclosing named declaration the call rolls up to (a `const`/`function`/method/class),
 *  with a chainable SymbolId minted on its bare name token (§6) — or the module itself for a call at
 *  top level. Shared with `construction_sites` via enclosingConstruction + encloser-id (one mint
 *  site, no id-encoding drift). */
function buildEncloser(
  host: TsProjectHost,
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  callNode: ts.CallExpression,
): ShapedEncloser {
  const enc = enclosingConstruction(callNode);
  if (enc === undefined) {
    const name = moduleName(rel);
    return {
      id: mintSymbolId(name, rel, 1, 1, host.rootTag),
      name,
      kind: 'module',
      span: spanFromRange(sourceFile, rel, 0, 0),
    };
  }
  const { id } = mintEncloserId(sourceFile, rel, enc.idName, enc.nameStart, host.rootTag);
  const span = spanFromRange(sourceFile, rel, enc.nameStart, enc.nameStart + enc.idName.length);
  return { id, name: enc.name, kind: enc.kind, span };
}
