// The BY-NAME matching model (§5-L2): a call's callee is matched against the configured names
// through its IMPORT, syntactically — no `module` anchor. A simple name `t` matches an identifier
// callee written `t` OR a named-import alias (`import { t as tr }; tr('k')`); a dotted name `i18n.t`
// matches a member access whose base is `i18n` as written OR aliased. Confined to USER-NAMED
// bindings (no bare-`t`-matches-`obj.t()`, no destructure rename) so a match is strong enough to
// ASSERT a usage (§3). Domain-neutral: nothing here knows i18n — the consuming plugin owns policy.
//
// This is one half of the matched-call engine; the WALK that drives it lives in call-match-walk.ts.
// RESIDUAL: config names the FUNCTION, never its MODULE — a same-named `t` from a NON-i18n module
// still matches by resolved name. Closing it is the by-IDENTITY model (call-identity-scan.ts).

import ts from 'typescript';
import {
  splitNames,
  type CalleeMatch,
  type DottedName,
  type MatchModel,
} from './call-scan-shared.ts';

/** No file is ever skipped in by-name mode — every file is walked and matched against the
 *  configured names through its own import aliases. */
const EMPTY_POOL: ReadonlySet<string> = new Set<string>();

export function buildByNameModel(fnNames: readonly string[]): MatchModel {
  const { simpleLeaves, dotted } = splitNames(fnNames);
  const noNames = simpleLeaves.size === 0 && dotted.length === 0;
  return {
    mode: 'by-name',
    moduleResolved: true, // there is no module to resolve in by-name mode
    perGroup: () => (sourceFile) => {
      // A names-less config can match nothing — skip every file (output is empty either way; this
      // just avoids the walk).
      if (noNames) return undefined;
      const importAlias = collectImportAliases(sourceFile);
      return {
        pool: EMPTY_POOL,
        match: (callee) => matchByName(callee, importAlias, simpleLeaves, dotted),
      };
    },
  };
}

/** The configured name a call's callee resolves to (by name), with its provenance, or undefined.
 *  An identifier callee matches a SIMPLE name (written / named-import alias). A member-access
 *  callee matches a DOTTED name only (its base written / aliased) — never a simple name, so an
 *  unrelated `obj.t()` / `namespace.t()` is not mistaken for the i18n `t` (§3 honesty). */
function matchByName(
  expr: ts.Expression,
  importAlias: ReadonlyMap<string, string>,
  simpleLeaves: ReadonlySet<string>,
  dotted: readonly DottedName[],
): CalleeMatch | undefined {
  if (ts.isIdentifier(expr)) {
    // The name as written is configured — a strict SUPERSET of the old by-written-name behaviour.
    if (simpleLeaves.has(expr.text)) return { fn: expr.text, provenance: 'written' };
    if (simpleLeaves.size === 0) return undefined; // dotted-only config — no identifier can match
    // Named-import alias: `import { t as tr }; tr('k')` — the imported name behind `tr` is `t`.
    const imported = importAlias.get(expr.text);
    if (imported !== undefined && simpleLeaves.has(imported)) {
      return { fn: imported, provenance: 'alias' };
    }
    return undefined;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    if (dotted.length === 0) return undefined;
    const writtenLeaf = expr.name.text;
    const leafMatches = dotted.filter((d) => d.leaf === writtenLeaf);
    if (leafMatches.length === 0) return undefined;
    const writtenBase = calleeName(expr.expression);
    // The base may be an aliased import (`import { i18n as i }; i.t()`) — accept its written OR
    // imported name. The leaf is a property name (not import-aliasable) → match as written.
    const canonBase = ts.isIdentifier(expr.expression)
      ? importAlias.get(expr.expression.text)
      : undefined;
    for (const d of leafMatches) {
      if (d.base === writtenBase) return { fn: `${d.base}.${d.leaf}`, provenance: 'namespace' };
      if (d.base === canonBase) return { fn: `${d.base}.${d.leaf}`, provenance: 'namespace' };
    }
    return undefined;
  }
  return undefined;
}

/** Map each named-import LOCAL name to the name it IMPORTS, from a SYNTACTIC walk of the file's
 *  import declarations — `import { t as tr }` → `tr` ↦ `t`. Only genuinely-aliased specifiers
 *  (a `propertyName`) are recorded; a plain `import { t }` is caught by the written-name fast path.
 *  Pure AST, no checker — so a non-import binding (a local `const tr`, a destructure) is NOT here
 *  and can't fabricate a usage (§3). Re-export-chain aliases (the local imports from a barrel that
 *  itself re-aliases) are NOT followed (documented residual — rare, under-reports, never lies). */
function collectImportAliases(sourceFile: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const named = stmt.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (el.propertyName !== undefined) map.set(el.name.text, el.propertyName.text);
    }
  }
  return map;
}

/** Reconstruct the written callee name: `t` (Identifier) or `i18n` / `a.b` (PropertyAccess
 *  chain of identifiers). Anything else (element access, a call result, `this`) has no
 *  statically-written dotted name → `undefined`. */
function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const base = calleeName(expr.expression);
    return base === undefined ? undefined : `${base}.${expr.name.text}`;
  }
  return undefined;
}
