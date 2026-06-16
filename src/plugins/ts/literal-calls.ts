// Cross-tier observation (§5-L2): a GENERIC scan for calls to a configured set of functions —
// `t('a.b')`, `i18n.t('x')`, a hook's destructured `const { t } = useTranslation()` — with NO
// i18n knowledge inside the ts plugin. The i18n plugin (`deps: ['ts']`) consumes this; the
// cross-tier fact lives with the plugin that *observes* it. A string-literal first argument is
// read verbatim; a template literal / computed / non-literal argument is flagged `dynamic`,
// never guessed (§3.3/§18).
//
// TWO matching models, chosen by config (the i18n plugin owns the POLICY; this owns the AST):
//
//  • BY-NAME (default — no `module`): a call's callee is matched against the configured names
//    through its IMPORT, syntactically. A simple name `t` matches an identifier callee written
//    `t` OR a named-import alias (`import { t as tr }; tr('k')`); a dotted name `i18n.t` matches
//    a member access whose base is `i18n` as written OR aliased. Confined to USER-NAMED bindings
//    (no bare-`t`-matches-`obj.t()`, no destructure rename) so a match is strong enough to ASSERT
//    a usage (§3). RESIDUAL: config names the FUNCTION, never its MODULE — a same-named `t` from a
//    NON-i18n module still matches by resolved name. Closing it is the by-IDENTITY model.
//
//  • BY-IDENTITY (`module` set — ./call-identity-scan.ts): a call matches iff its callee binding
//    resolves to a function from THE configured module — through import / alias / namespace, or a
//    `const { t } = useTranslation()` hook destructure (incl. renamed `{ t: x }`). The module is
//    resolved ONCE (tsconfig-paths aware) and bindings are collected SYNTACTICALLY per file
//    (bounded by #imports + #destructures), NOT a per-call-site checker walk — that would
//    reintroduce the O(call-sites) semantic sweep §19 forbids. Kills the same-named-`t`
//    false positive AND the renamed-destructure / namespace-alias false negatives.
//
// Every match carries `provenance` (F-c): HOW the callee resolved — `written` | `alias` |
// `destructure` | `namespace` — so the resolution is self-auditable (§3 legible honesty).

import ts from 'typescript';
import type { TsProjectHost } from './ls-host.ts';
import { scanByIdentity } from './call-identity-scan.ts';
import {
  literalArgFields,
  splitNames,
  type CallMatchSpec,
  type DottedName,
  type LiteralCall,
  type LiteralCallProvenance,
  type LiteralCallsResult,
} from './call-scan-shared.ts';

export function scanLiteralCalls(host: TsProjectHost, spec: CallMatchSpec): LiteralCallsResult {
  // By-IDENTITY iff a module anchors the functions; otherwise the by-name model (no regression
  // for existing setups). A `hook` without a `module` falls back to by-name (the schema refuses
  // that config, but a programmatic caller might pass it — stay honest, never anchor a bare hook).
  if (spec.module !== undefined) return scanByIdentity(host, spec);
  return { calls: scanByName(host, spec.functions), mode: 'by-name', moduleResolved: true };
}

function scanByName(host: TsProjectHost, fnNames: readonly string[]): LiteralCall[] {
  const out: LiteralCall[] = [];
  const program = host.service.getProgram();
  if (program === undefined || fnNames.length === 0) return out;
  const { simpleLeaves, dotted } = splitNames(fnNames);

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes('/node_modules/')) continue;
    if (sourceFile.isDeclarationFile) continue;
    const rel = host.relOf(sourceFile.fileName);
    // Resolve named-import aliases SYNTACTICALLY, once per file (bounded by #imports) — NOT per
    // call site via the checker (which made this whole-program structural scan a per-call SEMANTIC
    // walk: a checker warm + O(call-sites) symbol resolutions; §5/§19 regression). A direct
    // `import { t as tr }` is visible in the AST; a multi-hop re-export-chain alias is the
    // documented residual — rare, under-reports, never fabricates.
    const importAlias = collectImportAliases(sourceFile);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const matched = matchByName(node.expression, importAlias, simpleLeaves, dotted);
        if (matched !== undefined) {
          const arg0 = node.arguments[0];
          if (arg0 !== undefined) {
            out.push({
              fn: matched.fn,
              ...literalArgFields(sourceFile, rel, arg0),
              provenance: matched.provenance,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return out;
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
): { fn: string; provenance: LiteralCallProvenance } | undefined {
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
