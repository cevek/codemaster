// Cross-tier observation (§5-L2): a GENERIC syntactic scan for calls to a configured
// set of function names — `t('a.b')`, `i18n.t('x')` — with NO i18n knowledge inside the
// ts plugin. The i18n plugin (`deps: ['ts']`) consumes this; the cross-tier fact lives
// with the plugin that *observes* it. A string-literal first argument is read verbatim;
// a template literal / computed / non-literal argument is flagged `dynamic`, never
// guessed (§3.3/§18).
//
// Known limit (stated where it bites — the op `notes`): matching is by call name AS
// WRITTEN, reconstructed from the callee identifier / property-access chain. An
// `import { t as tr }` alias is therefore missed — this is a syntactic scan, not symbol
// resolution.

import ts from 'typescript';
import type { Span } from '../../core/span.ts';
import { spanFromRange } from './spans.ts';
import type { TsProjectHost } from './ls-host.ts';

export type LiteralCall = {
  /** The callee name as written (`t`, `i18n.t`). */
  fn: string;
  /** The first argument's value when it is a plain string literal. Absent when dynamic. */
  arg?: string;
  /** Proof span over the first argument (the key site). */
  span: Span;
  /** True when the first argument is not a plain string literal (template/computed/var). */
  dynamic: boolean;
};

export function scanLiteralCalls(host: TsProjectHost, fnNames: readonly string[]): LiteralCall[] {
  const out: LiteralCall[] = [];
  const program = host.service.getProgram();
  if (program === undefined) return out;
  const wanted = new Set(fnNames);
  if (wanted.size === 0) return out;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes('/node_modules/')) continue;
    if (sourceFile.isDeclarationFile) continue;
    const rel = host.relOf(sourceFile.fileName);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        if (name !== undefined && wanted.has(name)) {
          const arg0 = node.arguments[0];
          if (arg0 !== undefined) {
            const span = spanFromRange(sourceFile, rel, arg0.getStart(sourceFile), arg0.getEnd());
            // A plain string literal is a static key; a no-substitution template, a
            // template with substitutions, an identifier, etc. are all `dynamic` (§18).
            if (ts.isStringLiteral(arg0)) {
              out.push({ fn: name, arg: arg0.text, span, dynamic: false });
            } else {
              out.push({ fn: name, span, dynamic: true });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return out;
}

/** Reconstruct the written callee name: `t` (Identifier) or `i18n.t` (PropertyAccess
 *  chain of identifiers). Anything else (element access, a call result, `this`) has no
 *  statically-written dotted name → `undefined` (not matchable as written). */
function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const base = calleeName(expr.expression);
    return base === undefined ? undefined : `${base}.${expr.name.text}`;
  }
  return undefined;
}
