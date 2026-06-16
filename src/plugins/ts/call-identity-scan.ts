// By-IDENTITY call matching (§5-L2, spec-i18n-symbol-identity). A call counts iff its callee
// BINDING resolves to a function from the configured MODULE — not merely a same-named one. This
// closes the by-name model's residuals: a same-named function from another module no longer
// fabricates a usage, and a renamed destructure (`const { t: x } = useHook()`) / namespace alias
// of the real function is now caught. Domain-neutral: the consuming plugin names the module/hook;
// nothing here is i18n-specific (§4/§5).
//
// BOUNDED, checker-FREE (§19 never-hang). The cost is O(#files × (#imports + #destructures +
// #calls)) AST work + ONE module resolution — NOT a `getSymbolAtLocation` per call site (that
// per-call semantic walk is exactly what literal-calls.ts already removed once). Identity is
// established the cheap way the compiler establishes it: resolve the module specifier once
// (tsconfig-paths aware, shared with importers_of), then per file collect which LOCAL bindings are
// imported FROM that module (named / aliased / namespace) or destructured from its hook, and match
// call sites against those local names.
//
// RESIDUALS (honest, documented):
//  • WITHIN-FILE SHADOWING / REASSIGNMENT is the syntactic bound: a local that shadows a bound name
//    (a parameter `t`, or a `const o = useHook()` base later reassigned / re-declared in an inner
//    scope) is matched by name with no scope check — so it can FABRICATE or under-report depending
//    on the shadow direction. Same class as the prior by-name model; closing it needs scope
//    resolution (the checker), out of §19 budget here.
//  • A `t` passed as a VALUE, a COMPUTED-index call (`i18n[expr]()`), and multi-hop re-export
//    chains are not followed → under-report (never a fabricated usage).

import ts from 'typescript';
import type { TsProjectHost } from './ls-host.ts';
import {
  literalArgFields,
  splitNames,
  type CallMatchSpec,
  type LiteralCall,
  type LiteralCallProvenance,
  type LiteralCallsResult,
} from './call-scan-shared.ts';
import { resolveModuleArg, resolveSpecifier, samePath } from './resolve-module.ts';
import { programFileGroups } from './program/project-files.ts';

/** A call's callee shape we can match: an identifier `t`, or a member access `base.leaf`. */
type IdentBinding = { fn: string; provenance: LiteralCallProvenance };

/** The bindings collected per file (all bound to the configured module). */
type FileBindings = {
  /** local identifier name → the configured function it is (an imported / destructured `t`). */
  idents: Map<string, IdentBinding>;
  /** local base name → (member leaf → configured fn) for member access (`ns.t`, `i18n.t`). */
  bases: Map<string, Map<string, string>>;
};

export function scanByIdentity(host: TsProjectHost, spec: CallMatchSpec): LiteralCallsResult {
  const out: LiteralCall[] = [];
  const moduleArg = spec.module;
  if (moduleArg === undefined) return { calls: out, mode: 'identity', moduleResolved: false };

  // Spec-invariant lookups (independent of program / options).
  const { simpleLeaves, dotted } = splitNames(spec.functions);
  const dottedBases = new Set(dotted.map((d) => d.base));
  const dottedByBase = new Map<string, Map<string, string>>();
  for (const d of dotted) {
    const m = dottedByBase.get(d.base) ?? new Map<string, string>();
    m.set(d.leaf, `${d.base}.${d.leaf}`);
    dottedByBase.set(d.base, m);
  }
  // Every simple leaf, accessible as a member of a namespace import of the module
  // (`import * as i18n; i18n.t()`).
  const simpleLeafMap = new Map<string, string>();
  for (const leaf of simpleLeaves) simpleLeafMap.set(leaf, leaf);

  // Across ALL loaded programs (spec Task G): a `t('a.b')` whose `t` is imported from the module in
  // a `test/**` file is a real key usage. The module ARG is resolved ONCE to a canonical target
  // FILE — the arg may be a `paths` alias only ONE tsconfig declares, so resolve it under whichever
  // program resolves it (primary preferred). We must NOT skip a sibling group just because that
  // program can't resolve the arg: a `test/**` file imports the same target via a RELATIVE path
  // that resolves there, and `collectBindings` matches it per-file against the shared target. (The
  // earlier per-group gate dropped exactly that file → a live key read `certain` dead.) Each file
  // is scanned once (primary preferred). `moduleResolved` = could ANY program resolve the arg.
  const groups = programFileGroups(host);
  let targetAbs: string | undefined;
  for (const { program } of groups) {
    targetAbs = resolveModuleArg(host, moduleArg, program.getCompilerOptions());
    if (targetAbs !== undefined) break;
  }
  // No program resolves the module → nothing can bind. Report it so the consumer demotes (a §3.6
  // lie otherwise: "every key unused" when the truth is "we resolved no binding").
  if (targetAbs === undefined) return { calls: out, mode: 'identity', moduleResolved: false };

  for (const { program, files } of groups) {
    const options = program.getCompilerOptions();
    const ctx: SpecCtx = {
      targetAbs,
      options,
      simpleLeaves,
      dottedBases,
      dottedByBase,
      simpleLeafMap,
    };
    const specCache = new Map<string, string | undefined>();

    for (const sourceFile of files) {
      if (sourceFile.isDeclarationFile) continue;
      const rel = host.relOf(sourceFile.fileName);

      const bindings = collectBindings(sourceFile, spec, ctx, specCache);
      if (bindings.idents.size === 0 && bindings.bases.size === 0) continue; // no binding here

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const matched = matchCall(node.expression, bindings);
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
  }
  return { calls: out, mode: 'identity', moduleResolved: true };
}

type SpecCtx = {
  targetAbs: string;
  options: ts.CompilerOptions;
  simpleLeaves: ReadonlySet<string>;
  dottedBases: ReadonlySet<string>;
  dottedByBase: ReadonlyMap<string, Map<string, string>>;
  simpleLeafMap: ReadonlyMap<string, string>;
};

/** Collect, for one file, every local binding that resolves to the configured module —
 *  syntactically (imports) + structurally (hook destructures / returns). No checker. */
function collectBindings(
  sourceFile: ts.SourceFile,
  spec: CallMatchSpec,
  ctx: SpecCtx,
  cache: Map<string, string | undefined>,
): FileBindings {
  const idents = new Map<string, IdentBinding>();
  const bases = new Map<string, Map<string, string>>();
  const hookLocals = new Set<string>();

  // Pass 1 (top-level statements): imports FROM the configured module → local bindings.
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const resolved = resolveSpecifier(
      stmt.moduleSpecifier.text,
      sourceFile.fileName,
      ctx.options,
      cache,
    );
    if (resolved === undefined || !samePath(resolved, ctx.targetAbs)) continue;
    const clause = stmt.importClause;
    if (clause === undefined) continue;
    // A DEFAULT import (`import i18n from mod`) is the common i18n-object shape (`i18n.t()`), so
    // `i18n` is a member base for the SIMPLE leaves. The theoretical fabrication (default export
    // lacks `.t`) requires NON-compiling code — `i18n.t()` only typechecks if `.t` exists —
    // whereas NOT matching it would mark a live key `certain`-dead (a real §3 lie for every real
    // default-import user). Simple leaves ONLY (like the namespace/hook paths): the local name is
    // arbitrary, so attributing a dotted config base (`ns.t`, a NAMED export) to it would
    // misidentify and fabricate. Match the simple leaves; under-report a dotted default usage.
    if (clause.name !== undefined) addBase(bases, clause.name.text, ctx.simpleLeafMap);
    const named = clause.namedBindings;
    if (named === undefined) continue;
    if (ts.isNamespaceImport(named)) {
      // `import * as i18n from mod` → `i18n.t()` matches (a namespace exposes the module's exports).
      addBase(bases, named.name.text, ctx.simpleLeafMap);
      continue;
    }
    for (const el of named.elements) {
      const imported = el.propertyName?.text ?? el.name.text;
      const local = el.name.text;
      if (ctx.simpleLeaves.has(imported)) {
        idents.set(local, { fn: imported, provenance: local === imported ? 'written' : 'alias' });
      }
      if (ctx.dottedBases.has(imported)) {
        // `import { i18n } from mod; i18n.t()` — the exported object accessed as a member base.
        const leaves = ctx.dottedByBase.get(imported);
        if (leaves !== undefined) mergeBase(bases, local, leaves);
      }
      if (spec.hook !== undefined && imported === spec.hook) hookLocals.add(local);
    }
  }

  // Pass 2 (whole file): hook destructures / returns — `const { t } = useHook()`, `{ t: x }`, or a
  // non-destructured `const o = useHook()` (then `o.t()`).
  if (hookLocals.size > 0) collectHookBindings(sourceFile, hookLocals, ctx, idents, bases);

  return { idents, bases };
}

/** Register a member base whose SIMPLE-leaf access maps to a configured fn — `i18n.t()` on a
 *  namespace import / default import / hook return. Simple leaves only: a member base is reached
 *  through a local whose name is arbitrary, so a dotted config base (a NAMED export, handled by
 *  `mergeBase`) must never be attributed here. */
function addBase(
  bases: Map<string, Map<string, string>>,
  local: string,
  simpleLeafMap: ReadonlyMap<string, string>,
): void {
  if (simpleLeafMap.size === 0) return;
  const m = bases.get(local) ?? new Map<string, string>();
  for (const [leaf, fn] of simpleLeafMap) m.set(leaf, fn);
  bases.set(local, m);
}

function mergeBase(
  bases: Map<string, Map<string, string>>,
  local: string,
  leaves: ReadonlyMap<string, string>,
): void {
  const m = bases.get(local) ?? new Map<string, string>();
  for (const [leaf, fn] of leaves) m.set(leaf, fn);
  bases.set(local, m);
}

/** Bindings derived from a hook call `useHook()` whose callee is a local bound to the hook import:
 *  `const { t } = useHook()` / `{ t: x }` → an identifier binding (provenance `destructure`); a
 *  non-destructured `const o = useHook()` → a member base (so `o.t()` matches, provenance
 *  `namespace`). The destructure form closes the renamed-destructure false-negative; the
 *  non-destructured form closes the `o.t()` false-negative the spec's WHY also names. */
function collectHookBindings(
  sourceFile: ts.SourceFile,
  hookLocals: ReadonlySet<string>,
  ctx: SpecCtx,
  idents: Map<string, IdentBinding>,
  bases: Map<string, Map<string, string>>,
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      hookLocals.has(node.initializer.expression.text)
    ) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          if (!ts.isIdentifier(el.name)) continue; // a nested-pattern bind isn't a callable `t`
          // `{ t }` → propertyName undefined, name `t`; `{ t: x }` → propertyName `t`, name `x`.
          const propName =
            el.propertyName !== undefined && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : el.name.text;
          if (ctx.simpleLeaves.has(propName)) {
            idents.set(el.name.text, { fn: propName, provenance: 'destructure' });
          }
        }
      } else if (ts.isIdentifier(node.name)) {
        // `const o = useHook()` → `o` is the hook return object; `o.<leaf>()` is a real usage.
        addBase(bases, node.name.text, ctx.simpleLeafMap);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Match a call's callee against the file's bindings: an identifier `t`; a member access
 *  `base.leaf`; or an element access `base['leaf']` (a string-literal index) — all on a base
 *  PROVEN to bind the module, so resolving the literal leaf fabricates nothing. */
function matchCall(expr: ts.Expression, bindings: FileBindings): IdentBinding | undefined {
  if (ts.isIdentifier(expr)) return bindings.idents.get(expr.text);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const fn = bindings.bases.get(expr.expression.text)?.get(expr.name.text);
    if (fn !== undefined) return { fn, provenance: 'namespace' };
  }
  if (
    ts.isElementAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    ts.isStringLiteral(expr.argumentExpression)
  ) {
    const fn = bindings.bases.get(expr.expression.text)?.get(expr.argumentExpression.text);
    if (fn !== undefined) return { fn, provenance: 'namespace' };
  }
  return undefined;
}
