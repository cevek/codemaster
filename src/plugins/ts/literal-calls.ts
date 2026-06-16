// Cross-tier observation (§5-L2): a GENERIC scan for calls to a configured set of function
// names — `t('a.b')`, `i18n.t('x')` — with NO i18n knowledge inside the ts plugin. The i18n
// plugin (`deps: ['ts']`) consumes this; the cross-tier fact lives with the plugin that
// *observes* it. A string-literal first argument is read verbatim; a template literal /
// computed / non-literal argument is flagged `dynamic`, never guessed (§3.3/§18).
//
// IMPORT-RESOLVED matching (Task F, spec-i18n-alias-aware): a call's callee is matched against
// the configured names through its IMPORT, not only as written. A simple name `t` matches an
// identifier callee written `t` OR resolved through a named-import alias (`import { t as tr };
// tr('k')`). A dotted name `i18n.t` matches a member access whose base is `i18n` as written OR
// through an aliased import (`import { i18n as i }; i.t('k')`). The checker lives inside the ts
// plugin (the layering rule — only ts touches the LS); the i18n plugin owns the POLICY (which
// names, dynamic→partial, verdicts).
//
// HONESTY BOUNDARY (§3): matching is confined to USER-NAMED bindings (the written name, a
// named-import alias, or a configured dotted base) — a bare `t` config does NOT match member
// access (`tel.t('x')` on an unrelated namespace import) and a destructure rename
// (`const { t: x } = makeLogger()`) is not resolved, so neither fabricates a usage. A plain
// `const { t } = useTranslation(); t('k')` still matches by the written name `t`.
//   RESIDUAL (accepted, not locked out): config names the FUNCTION, never its MODULE, so a
//   named-import alias of a `t` exported by a NON-i18n module — `import { t as tr } from
//   './telemetry'; tr('k')` — still matches by resolved name (the same by-name limit as the
//   pre-existing `import { t } from './telemetry'; t('k')`, one hop further and rarer). Closing
//   it needs module-anchored symbol identity — out of this task's scope, parked in plan.md F-b.
//   Conversely a key reached ONLY through a binding we don't follow (renamed destructure of the
//   hook, element access, `t` passed as a value) is missed — find_unused may over-report it.

import ts from 'typescript';
import type { Span } from '../../core/span.ts';
import { spanFromRange } from './spans.ts';
import type { TsProjectHost } from './ls-host.ts';

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
};

/** A configured dotted name (`i18n.t`) split into its base + leaf for member-access matching. */
type DottedName = { base: string; leaf: string };

export function scanLiteralCalls(host: TsProjectHost, fnNames: readonly string[]): LiteralCall[] {
  const out: LiteralCall[] = [];
  const program = host.service.getProgram();
  if (program === undefined) return out;
  if (fnNames.length === 0) return out;

  // Simple names (`t`) match an identifier callee; dotted names (`i18n.t`) match a member access.
  const simpleLeaves = new Set<string>();
  const dotted: DottedName[] = [];
  for (const name of fnNames) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) simpleLeaves.add(name);
    else dotted.push({ base: name.slice(0, dot), leaf: name.slice(dot + 1) });
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes('/node_modules/')) continue;
    if (sourceFile.isDeclarationFile) continue;
    const rel = host.relOf(sourceFile.fileName);
    // Resolve named-import aliases SYNTACTICALLY, once per file (bounded by #imports) — NOT per
    // call site via the checker, which made this whole-program structural scan a per-call SEMANTIC
    // walk (forced a checker warm + O(call-sites) symbol resolutions; §5/§19 regression). A direct
    // `import { t as tr }` is visible in the AST; that covers the alias cases (a multi-hop
    // re-export-chain alias is the documented residual — rare, under-reports, never fabricates).
    const importAlias = collectImportAliases(sourceFile);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const matched = matchCallee(node.expression, importAlias, simpleLeaves, dotted);
        if (matched !== undefined) {
          const arg0 = node.arguments[0];
          if (arg0 !== undefined) {
            const span = spanFromRange(sourceFile, rel, arg0.getStart(sourceFile), arg0.getEnd());
            // A plain string literal is a static key; a no-substitution template, a
            // template with substitutions, an identifier, etc. are all `dynamic` (§18).
            if (ts.isStringLiteral(arg0)) {
              out.push({ fn: matched, arg: arg0.text, span, dynamic: false });
            } else {
              out.push({ fn: matched, span, dynamic: true });
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

/** The configured name a call's callee resolves to, or undefined. An identifier callee matches
 *  a SIMPLE name (as written, or through a named-import alias). A member-access callee matches
 *  a DOTTED name only (its base as written, or through an aliased import) — never a simple name,
 *  so an unrelated `obj.t()` / `namespace.t()` is not mistaken for the i18n `t` (§3 honesty). */
function matchCallee(
  expr: ts.Expression,
  importAlias: ReadonlyMap<string, string>,
  simpleLeaves: ReadonlySet<string>,
  dotted: readonly DottedName[],
): string | undefined {
  if (ts.isIdentifier(expr)) {
    // The name as written is configured. A strict SUPERSET of the old by-written-name behaviour —
    // `import { translate as t }; t()` (local name `t`) still matches.
    if (simpleLeaves.has(expr.text)) return expr.text;
    if (simpleLeaves.size === 0) return undefined; // dotted-only config — no identifier can match
    // Named-import alias: `import { t as tr }; tr('k')` — the imported name behind `tr` is `t`.
    const imported = importAlias.get(expr.text);
    if (imported !== undefined && simpleLeaves.has(imported)) return imported;
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
      if (d.base === writtenBase || d.base === canonBase) return `${d.base}.${d.leaf}`;
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
