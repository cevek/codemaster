// Scope-aware shadow tracking for css-module import names — the single source of truth both
// css-usage.ts (co-extract analysis/rewrite) and css-modules.ts (cross-tier usage scan) share.
//
// A css-module import `import s from './x.module.scss'` is a top-level binding; a function
// parameter or catch variable named `s` (`useStore((s) => s.field)`, `rows.map((s) => …)`)
// SHADOWS it inside its subtree. Counting that shadowed `s.field` as a class access would be a
// false "class used" (§3) — so consumers thread a `shadowed` set down the AST and skip any
// binding name in it. This module owns the binding-introduction logic; it is NOT duplicated.
//
// KNOWN LIMITATION (tracked, not silent — §3.6): only function params + catch vars (and their
// destructuring) introduce a shadow here. A `const`/`let`/`var` rebind of the import name
// (`const s = getThing(); s.notCss`) is NOT skipped, so such an access is still mis-counted as a
// class use. A correct fix needs block-POSITION-aware shadowing (a `const s` shadows only from
// its declaration onward in its block — a subtree-wide skip would over-skip a real `s.x` earlier
// in the same block, a worse, false-"unused" lie), so it is deferred rather than naively patched.
// Low-frequency (rebinding a css-import default name with a local const is rare). For the
// find-UNUSED direction this rebind residual is safe (a false "used", never a false "certain
// unused"). It is NOT uniformly safe across consumers: the i18n identity scan (call-identity-scan.ts)
// reuses this gate, and there a const/let/var rebind of `t` (`const t = …; t('absent.key')`) still
// FABRICATES a find_missing row — a fabrication, not an under-report. Don't claim a blanket §3 win.

import ts from 'typescript';

/** Return `shadowed` extended with any `pool` names this node binds (function params / catch
 *  var). The accessor identifier inside such a subtree is the local binding, not the import. */
export function extendShadow(
  node: ts.Node,
  pool: ReadonlySet<string>,
  shadowed: ReadonlySet<string>,
): ReadonlySet<string> {
  const introduced = shadowsFrom(node, pool);
  if (introduced.size === 0) return shadowed;
  return new Set([...shadowed, ...introduced]);
}

function shadowsFrom(node: ts.Node, pool: ReadonlySet<string>): Set<string> {
  const hit = new Set<string>();
  const params = functionLikeParameters(node);
  if (params !== undefined) {
    for (const p of params) collectBoundNames(p.name, pool, hit);
    return hit;
  }
  if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
    collectBoundNames(node.variableDeclaration.name, pool, hit);
  }
  return hit;
}

function collectBoundNames(
  binding: ts.BindingName,
  pool: ReadonlySet<string>,
  out: Set<string>,
): void {
  if (ts.isIdentifier(binding)) {
    if (pool.has(binding.text)) out.add(binding.text);
    return;
  }
  for (const el of binding.elements) {
    if (ts.isBindingElement(el)) collectBoundNames(el.name, pool, out);
  }
}

function functionLikeParameters(node: ts.Node): readonly ts.ParameterDeclaration[] | undefined {
  if (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.parameters;
  }
  return undefined;
}
