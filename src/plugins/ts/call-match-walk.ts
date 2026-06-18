// The shared matched-call ITERATION (§5-L2) — the one cross-program walk that drives BOTH
// matching models (by-name · by-identity) and feeds every "calls to a configured set of functions"
// scan: `literalCalls` (i18n keys) and `callArgShapes` (call-arg shapes for framework plugins).
// The match LOGIC lives in the model builders (call-match-byname.ts · call-identity-scan.ts); this
// owns only the traversal, the scope-shadow threading, and the enclosing-matched-call stack — so
// the per-call iteration is written once, not copied per consumer (§4 one-implementation rule).
//
// Cross-program (spec Task G): every loaded program's files are visited via `programFileGroups`,
// each file once (a file shared by two programs is matched under the primary's options) — so a
// call living only in a sibling (`test/**` under `tsconfig.test.json`) is never missed.

import ts from 'typescript';
import type { TsProjectHost } from './ls-host.ts';
import { extendShadow } from './scope-shadow.ts';
import { programFileGroups } from './program/project-files.ts';
import { buildByNameModel } from './call-match-byname.ts';
import { buildByIdentityModel } from './call-identity-scan.ts';
import type { CallMatchSpec, FilePrep, MatchHit } from './call-scan-shared.ts';
import type { RepoRelPath } from '../../core/brands.ts';

/** Drive the matched-call walk: for each matched call expression, invoke `onMatch` with its node,
 *  resolution provenance, a stable `callId`, and the nearest enclosing matched call. Returns the
 *  envelope every scan reports — which model ran and whether the configured module resolved
 *  (`identity` mode only; always `true` by-name). The walk emits EVERY matched call (arg-less
 *  included); a consumer that only wants calls with a first argument gates that in `onMatch`. */
export function forEachMatchedCall(
  host: TsProjectHost,
  spec: CallMatchSpec,
  onMatch: (hit: MatchHit) => void,
): { mode: 'by-name' | 'identity'; moduleResolved: boolean } {
  const model =
    spec.module !== undefined ? buildByIdentityModel(host, spec) : buildByNameModel(spec.functions);
  // No module resolved → nothing can bind (identity mode); emit nothing, report it so the consumer
  // demotes its certain/dead verdicts (§3.6).
  if (!model.moduleResolved) return { mode: model.mode, moduleResolved: false };

  for (const { program, files } of programFileGroups(host)) {
    const prepFile = model.perGroup(program);
    for (const sourceFile of files) {
      if (sourceFile.isDeclarationFile) continue;
      const rel = host.relOf(sourceFile.fileName);
      const prep = prepFile(sourceFile, rel);
      if (prep === undefined) continue; // no binding in this file (identity-mode cost short-circuit)
      walkFile(sourceFile, rel, prep, onMatch);
    }
  }
  return { mode: model.mode, moduleResolved: true };
}

const EMPTY_SHADOW: ReadonlySet<string> = new Set<string>();

/** Pre-order walk of one file: at each call expression, run the file's matcher (gated by the
 *  current scope-shadow set), surface a hit, then recurse with this call pushed as the enclosing
 *  matched call so a nested match (e.g. `invalidateQueries` inside `onSuccess`) carries its
 *  container's `callId`. Shadow threading is skipped when the pool is empty (the by-name model
 *  never shadows) so that path stays allocation-free. */
function walkFile(
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  prep: FilePrep,
  onMatch: (hit: MatchHit) => void,
): void {
  const hasPool = prep.pool.size > 0;
  const stack: string[] = [];
  const visit = (node: ts.Node, shadowed: ReadonlySet<string>): void => {
    const inner = hasPool ? extendShadow(node, prep.pool, shadowed) : shadowed;
    if (ts.isCallExpression(node)) {
      const matched = prep.match(node.expression, inner);
      if (matched !== undefined) {
        const callId = `${rel}:${node.getStart(sourceFile)}`;
        const enclosingMatchedCallId = stack[stack.length - 1];
        onMatch({
          sourceFile,
          rel,
          callNode: node,
          fn: matched.fn,
          provenance: matched.provenance,
          callId,
          ...(enclosingMatchedCallId !== undefined ? { enclosingMatchedCallId } : {}),
        });
        stack.push(callId);
        ts.forEachChild(node, (child) => visit(child, inner));
        stack.pop();
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(sourceFile, EMPTY_SHADOW);
}
