// Block-scoped CSS-module usage for co-extract (spec-css-coextract §2.3) — the TS-domain half
// of the join. Two pure passes over content strings (the op feeds in the planned extracted +
// remaining contents, never disk):
//
//   analyzeCssExtractUsage — per css-module import in the EXTRACTED file: which `s.X` classes
//     the extracted block references (move candidates), which the REMAINING source still
//     references (→ leave behind), and whether the remaining source uses the import name
//     NON-TRIVIALLY (spread / destructure / rebind / computed) → a wildcard that leaves ALL.
//   rewriteExtractedCss — repoint the extracted file's css import at the new sheet, inject a
//     `<name>Legacy` import for the left-behind classes, and repoint their `s.X` refs to it.
//
// Both are SCOPE-AWARE: a function parameter / catch var that shadows the import name (e.g.
// `useStore((s) => s.field)`) is skipped, so the lambda's `s` is never mistaken for the CSS
// import. The shadow helpers are factored once and shared by both passes.

import ts from 'typescript';
import { applyEdits, type TextEdit } from '../../../../support/text-edits/apply.ts';

/** One css-module default import found in a file, with the offsets needed to rewrite it. */
type CssImport = {
  localName: string;
  specifier: string;
  specifierStart: number;
  specifierEnd: number;
  importEnd: number;
};

/** Per-import usage split the op needs to classify + rewrite. `specifier` is verbatim as
 *  written in the extracted file (the op resolves it to a sheet path). */
export type CssImportUsage = {
  localName: string;
  specifier: string;
  refsInExtracted: string[];
  refsInRemaining: string[];
  /** The remaining source used the import non-trivially → treat every class as still-used. */
  remainingWildcard: boolean;
  /** The EXTRACTED block used the import non-trivially (spread / rebind / computed / passed as
   *  a value). We then can't enumerate which classes it really touches, so co-extract must NOT
   *  repoint the import — moving any class could strand a non-literal access. */
  extractedWildcard: boolean;
};

/** Instruction to rewrite one css import in the extracted file. */
export type ImportRewrite = {
  localName: string;
  /** Repoint the existing import's specifier here (the new sheet). */
  newSpec: string;
  /** When `leftBehind` is non-empty: add `import <localName>Legacy from <legacySpec>`. */
  legacySpec: string;
  /** Classes that stayed in the source sheet — their `s.X` refs repoint to `<name>Legacy`. */
  leftBehind: readonly string[];
};

const scriptKind = (fileName: string): ts.ScriptKind =>
  /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

const parse = (fileName: string, content: string): ts.SourceFile =>
  ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKind(fileName));

// Tolerate a trailing `?inline` / `?raw` / `#frag` (bundler query suffixes) on the specifier.
const isCssSpecifier = (spec: string): boolean => /\.(scss|sass|css)(\?|#|$)/.test(spec);

export function analyzeCssExtractUsage(
  extracted: { fileName: string; content: string },
  remaining: { fileName: string; content: string },
): CssImportUsage[] {
  const extractedSf = parse(extracted.fileName, extracted.content);
  const imports = findCssModuleImports(extractedSf);
  if (imports.length === 0) return [];

  const localNames = new Set(imports.map((i) => i.localName));
  // Strict collection on BOTH sides — the extracted block can rebind/spread the import too, and
  // a non-trivial use there is just as unsafe to repoint as one in the remainder.
  const extracted2 = collectAccesses(extractedSf, localNames);
  const remaining2 = collectAccesses(parse(remaining.fileName, remaining.content), localNames);

  return imports.map((imp) => ({
    localName: imp.localName,
    specifier: imp.specifier,
    refsInExtracted: [...(extracted2.refs.get(imp.localName) ?? new Set<string>())],
    refsInRemaining: [...(remaining2.refs.get(imp.localName) ?? new Set<string>())],
    remainingWildcard: remaining2.wildcard.has(imp.localName),
    extractedWildcard: extracted2.wildcard.has(imp.localName),
  }));
}

export function rewriteExtractedCss(
  fileName: string,
  content: string,
  rewrites: readonly ImportRewrite[],
): string {
  const sf = parse(fileName, content);
  const imports = findCssModuleImports(sf);
  const byName = new Map(imports.map((i) => [i.localName, i]));
  const edits: TextEdit[] = [];

  for (const rw of rewrites) {
    const imp = byName.get(rw.localName);
    if (imp === undefined) continue;
    edits.push({
      start: imp.specifierStart,
      end: imp.specifierEnd,
      text: JSON.stringify(rw.newSpec),
    });
    if (rw.leftBehind.length === 0) continue;
    const legacyName = `${rw.localName}Legacy`;
    edits.push({
      start: imp.importEnd,
      end: imp.importEnd,
      text: `\nimport ${legacyName} from ${JSON.stringify(rw.legacySpec)};`,
    });
  }

  // Repoint left-behind refs (`s.X` / `s['X']`) to `<name>Legacy`, scope-aware.
  const legacyTargets = new Map<string, Set<string>>();
  for (const rw of rewrites) {
    if (rw.leftBehind.length > 0) legacyTargets.set(rw.localName, new Set(rw.leftBehind));
  }
  if (legacyTargets.size > 0) {
    const names = new Set(legacyTargets.keys());
    walkAccesses(sf, names, (localName, member, exprNode) => {
      if (legacyTargets.get(localName)?.has(member) !== true) return;
      edits.push({
        start: exprNode.getStart(sf),
        end: exprNode.getEnd(),
        text: `${localName}Legacy`,
      });
    });
  }

  return applyEdits(content, edits);
}

function findCssModuleImports(sf: ts.SourceFile): CssImport[] {
  const out: CssImport[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!isCssSpecifier(spec)) continue;
    const name = stmt.importClause?.name?.text;
    if (name === undefined) continue;
    out.push({
      localName: name,
      specifier: spec,
      specifierStart: stmt.moduleSpecifier.getStart(sf),
      specifierEnd: stmt.moduleSpecifier.getEnd(),
      importEnd: stmt.getEnd(),
    });
  }
  return out;
}

/** Scope-aware usage scan of the css-import names. Records literal `s.X` / `s['X']` member
 *  accesses (the move/leave candidates); ANY non-trivial VALUE use (spread, rebind, computed
 *  access, passed as an argument, JSX-spread) flags a wildcard → the caller treats the whole
 *  sheet as still-used. Non-value occurrences of the name (a member name `props.s`, an object
 *  key `{ s: 1 }`, a destructuring binding `{ s: cls }`, the import binding site) are NOT uses
 *  and never flag a wildcard — counting them would be a false "still used" reason (§3). */
function collectAccesses(
  sf: ts.SourceFile,
  names: ReadonlySet<string>,
): { refs: Map<string, Set<string>>; wildcard: Set<string> } {
  const refs = new Map<string, Set<string>>();
  const wildcard = new Set<string>();
  const record = (ln: string, member: string): void => {
    const set = refs.get(ln) ?? new Set<string>();
    set.add(member);
    refs.set(ln, set);
  };

  const visit = (node: ts.Node, shadowed: ReadonlySet<string>): void => {
    const next = extendShadow(node, names, shadowed);
    if (ts.isIdentifier(node) && names.has(node.text) && !shadowed.has(node.text)) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        record(node.text, parent.name.text);
      } else if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        ts.isStringLiteralLike(parent.argumentExpression)
      ) {
        record(node.text, parent.argumentExpression.text);
      } else if (!isNonValueOccurrence(node, parent)) {
        wildcard.add(node.text);
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, next);
    });
  };
  visit(sf, new Set());
  return { refs, wildcard };
}

/** True when this identifier occurrence is NOT a value reference to the binding — so it can't
 *  be a non-trivial use. Covers: the import binding site; a member NAME (`props.s`); an object
 *  literal KEY (`{ s: 1 }`); any destructuring `BindingElement` (`const { s } = x` /
 *  `({ s: c }) =>` — a binding/key, not a use). An object-literal SHORTHAND (`{ s }`) is a real
 *  value use and is deliberately NOT covered (→ wildcard). */
function isNonValueOccurrence(node: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent)) return true;
  // A property NAME in a type literal / class body (`(p: { s: number })`, `class { s = 1 }`) —
  // a declaration, not a value reference to the import.
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  return false;
}

/** Walk literal `s.X` / `s['X']` accesses where `s` ∈ names and is not shadowed, invoking
 *  `onAccess(localName, member, exprIdentifier)`. The single scope-aware traversal both the
 *  permissive collector and the rewrite pass share. */
function walkAccesses(
  sf: ts.SourceFile,
  names: ReadonlySet<string>,
  onAccess: (localName: string, member: string, expr: ts.Identifier) => void,
): void {
  const visit = (node: ts.Node, shadowed: ReadonlySet<string>): void => {
    const next = extendShadow(node, names, shadowed);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text) &&
      !next.has(node.expression.text)
    ) {
      onAccess(node.expression.text, node.name.text, node.expression);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text) &&
      !next.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      onAccess(node.expression.text, node.argumentExpression.text, node.expression);
    }
    ts.forEachChild(node, (child) => {
      visit(child, next);
    });
  };
  visit(sf, new Set());
}

// ---------- shared scope/shadow helpers ----------

/** Return `shadowed` extended with any `pool` names this node binds (function params / catch
 *  var). The accessor identifier inside such a subtree is the local binding, not the import. */
function extendShadow(
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
