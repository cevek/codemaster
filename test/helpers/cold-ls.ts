// The independent cold-LS oracle home (§16). A fresh-from-cold `ts.Program` built over the
// whole fixture repo — never the warm daemon's own Language Service — so a differential test
// compares two independent TS views and catches incremental-update drift, not the checker
// against itself. Ships `coldMembers`/`coldDiagnostics` (lifted out of `expand-type.test.ts`,
// which now imports them — its still-green run is the behaviour-preserving proof) and
// `coldFindReferences` (a cold LS over the post-op tree — the rename/move cross-check, §3).
// (`find_usages` is pinned against a HAND-CURATED ground truth, not a cold `findReferences` —
// that would run the identical LS algorithm and be circular, §16.)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

export interface ColdView {
  program: ts.Program;
  checker: ts.TypeChecker;
}

/** A cold `ts.Program` over the whole fixture, built from its own `tsconfig.json` (same
 *  file set + options a real cold boot would compile). Whole-repo, not single-file, so
 *  cross-file references resolve — `coldMembers` and (Stage 3) `coldFindReferences` share it.
 *  Internal until a test imports it directly; keeping it unexported avoids a knip dead-export. */
// The default-lib SourceFiles (lib.es2022.d.ts, …) are immutable and identical across every
// cold Program/LS this process builds, yet re-parsing them per oracle call is a big slice of the
// e2e cost (many tests per file, each rebuilding from cold). Cache the parsed lib SourceFile per
// (path × target) and share it across every cold build in the process — node's test runner forks
// per file, so this caches within a file's tests. Test-only + read-only + immutable, so sound.
const libCache = new Map<string, ts.SourceFile | undefined>();
const isLib = (fileName: string): boolean => /\/typescript\/lib\/lib\..+\.d\.ts$/.test(fileName);

function cachingHost(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const inner = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, version, onError, shouldCreate) => {
    if (!isLib(fileName)) return inner(fileName, version, onError, shouldCreate);
    const key = `${fileName}@${JSON.stringify(version)}`;
    if (!libCache.has(key)) libCache.set(key, inner(fileName, version, onError, shouldCreate));
    return libCache.get(key);
  };
  return host;
}

function coldProgram(root: string, configRel = 'tsconfig.json'): ColdView {
  const configPath = path.join(root, configRel);
  const raw: unknown = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
  const { config, error } = raw as { config: unknown; error?: unknown };
  assert.ok(error === undefined, `oracle could not read tsconfig: ${JSON.stringify(error)}`);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options, cachingHost(parsed.options));
  return { program, checker: program.getTypeChecker() };
}

export interface ColdMember {
  name: string;
  optional: boolean;
  type: string;
}

/** Independent oracle for `expand_type`: the `{name, optional, type}` member set a cold
 *  checker produces for a named interface/type alias, sorted for set comparison. */
export function coldMembers(root: string, fileRel: string, typeName: string): ColdMember[] {
  const { program, checker } = coldProgram(root);
  const file = path.join(root, fileRel);
  const sf = program.getSourceFile(file);
  assert.ok(sf !== undefined, `oracle could not load ${fileRel}`);
  let nameNode: ts.Identifier | undefined;
  sf.forEachChild((node) => {
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name.text === typeName
    ) {
      nameNode = node.name;
    }
  });
  assert.ok(nameNode !== undefined, `oracle could not find ${typeName}`);
  const symbol = checker.getSymbolAtLocation(nameNode);
  assert.ok(symbol !== undefined);
  const type = checker.getApparentType(checker.getDeclaredTypeOfSymbol(symbol));
  return type
    .getProperties()
    .map((p) => ({
      name: p.getName(),
      optional: (p.flags & ts.SymbolFlags.Optional) !== 0,
      type: checker.typeToString(
        checker.getTypeOfSymbolAtLocation(p, nameNode as ts.Node),
        undefined,
        ts.TypeFormatFlags.NoTruncation,
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Independent oracle for `expand_type` signatures (Bug A/B): the call-signature strings a cold
 *  checker produces for a named function declaration — EVERY overload, via the SAME
 *  `getSignaturesOfType(…, Call)` + `signatureToString(NoTruncation)` the warm path uses, so a
 *  "2 vs 2" agreement is real (cold-vs-warm drift), not the checker against itself. Anchors on the
 *  first function/namespace declaration of `fnName` (overloads/merges share the name). */
export function coldSignatures(root: string, fileRel: string, fnName: string): string[] {
  const { program, checker } = coldProgram(root);
  const file = path.join(root, fileRel);
  const sf = program.getSourceFile(file);
  assert.ok(sf !== undefined, `oracle could not load ${fileRel}`);
  let nameNode: ts.Identifier | undefined;
  sf.forEachChild((node) => {
    if (nameNode === undefined && ts.isFunctionDeclaration(node) && node.name?.text === fnName) {
      nameNode = node.name;
    }
  });
  assert.ok(nameNode !== undefined, `oracle could not find function ${fnName}`);
  const symbol = checker.getSymbolAtLocation(nameNode);
  assert.ok(symbol !== undefined);
  const type = checker.getTypeOfSymbolAtLocation(symbol, nameNode);
  return checker
    .getSignaturesOfType(type, ts.SignatureKind.Call)
    .map((s) => checker.signatureToString(s, undefined, ts.TypeFormatFlags.NoTruncation));
}

/** The post-op cross-check oracle for rename_symbol / move_file (spec-kitchensink §3): a
 *  fresh-from-cold `ts.LanguageService` over the ON-DISK post-op tree — never the warm daemon
 *  that performed the edit — answering `getReferencesAtPosition`. After a rename, a cold
 *  find-references on the NEW name must resolve the SAME set of files the op claimed to
 *  rewrite (no reference left dangling, none added). This is a secondary cross-check; the
 *  primary completeness gate stays `coldDiagnostics() == []` (a missed rewrite fails to
 *  compile) + a hand-curated touched-set. For `find_usages` this oracle would be CIRCULAR
 *  (identical LS algorithm, §16) — use a hand-curated set there, not this. */
function coldLanguageService(
  root: string,
  configRel = 'tsconfig.json',
): { service: ts.LanguageService; fileNames: string[] } {
  const configPath = path.join(root, configRel);
  const raw: unknown = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
  const { config, error } = raw as { config: unknown; error?: unknown };
  assert.ok(error === undefined, `oracle could not read tsconfig: ${JSON.stringify(error)}`);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const fileNames = parsed.fileNames;
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => '1', // cold + immutable: every file is read once, never edited
    getScriptSnapshot: (fileName) =>
      existsSync(fileName)
        ? ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'))
        : undefined,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return { service: ts.createLanguageService(host, sharedRegistry), fileNames };
}

// Shared across every cold LS in the process so the immutable lib + identical fixture files are
// parsed once, not per oracle call (see the libCache note above).
const sharedRegistry = ts.createDocumentRegistry();

/** The set of repo-relative files a cold LS finds referencing `symbolName` — located at its
 *  first word-boundary occurrence in `fileRel`. Includes the declaration file, every
 *  import/usage, and re-export sites. Sorted for set comparison.
 *
 *  CALLER CONTRACT: pass a `fileRel` whose FIRST occurrence of `symbolName` is the declaration
 *  (e.g. the decl file after a rename) — the lookup anchors there, so a leading comment/import
 *  mentioning the name first would mis-anchor. The current callers pass decl files.
 *
 *  `configRel` selects WHICH tsconfig's program the cold oracle builds — default `tsconfig.json`;
 *  pass `tsconfig.test.json` to get the independent ground truth for cross-program usages (Task G),
 *  i.e. a program that includes the test files where the only usage lives. */
export function coldFindReferences(
  root: string,
  fileRel: string,
  symbolName: string,
  configRel = 'tsconfig.json',
): string[] {
  const { service } = coldLanguageService(root, configRel);
  const abs = path.join(root, fileRel);
  const source = readFileSync(abs, 'utf8');
  const at = new RegExp(`\\b${symbolName}\\b`).exec(source);
  assert.ok(at !== null, `oracle could not find ${symbolName} in ${fileRel}`);
  const refs = service.getReferencesAtPosition(abs, at.index) ?? [];
  const files = new Set(refs.map((r) => path.relative(root, r.fileName).split(path.sep).join('/')));
  return [...files].sort();
}

/** Line-level reference sites (`file:line`, sorted) a cold LS finds for the symbol whose
 *  declaration is the first word-boundary occurrence of `symbolName` in `fileRel`. The independent
 *  oracle for `mergeDeclarations`: union this over each same-named declaration's file and compare to
 *  the merged op output — proves the merge is exactly the union of the per-declaration reference
 *  sets, computed by a DIFFERENT (cold, whole-program) LS than the warm daemon's. */
export function coldReferenceSites(
  root: string,
  fileRel: string,
  symbolName: string,
  configRel = 'tsconfig.json',
): string[] {
  const { service } = coldLanguageService(root, configRel);
  const abs = path.join(root, fileRel);
  const source = readFileSync(abs, 'utf8');
  const at = new RegExp(`\\b${symbolName}\\b`).exec(source);
  assert.ok(at !== null, `oracle could not find ${symbolName} in ${fileRel}`);
  const refs = service.getReferencesAtPosition(abs, at.index) ?? [];
  return refs.map((r) => {
    const rel = path.relative(root, r.fileName).split(path.sep).join('/');
    const sf = service.getProgram()?.getSourceFile(r.fileName);
    const line = sf === undefined ? 0 : sf.getLineAndCharacterOfPosition(r.textSpan.start).line + 1;
    return `${rel}:${line}`;
  });
}

/** The declaration site (repo-relative file + 1-based line) the identifier at the `nth` (0-based)
 *  word-boundary occurrence of `needle` in `fileRel` resolves to, via a cold checker — the
 *  independent oracle for capture-safety (§ spec): proof that a (post-edit) reference binds to a
 *  SPECIFIC declaration, e.g. a local shadow rather than the symbol the refactor intended. Cold +
 *  whole-program, never the warm LS that detected the capture. */
export function coldDeclarationAt(
  root: string,
  fileRel: string,
  needle: string,
  nth = 0,
): { file: string; line: number } {
  const { program, checker } = coldProgram(root);
  const abs = path.join(root, fileRel);
  const sf = program.getSourceFile(abs);
  assert.ok(sf !== undefined, `oracle could not load ${fileRel}`);
  let found: ts.Identifier | undefined;
  let count = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === needle) {
      if (count === nth) found = n;
      count++;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(
    found !== undefined,
    `oracle could not find occurrence ${nth} of ${needle} in ${fileRel}`,
  );
  let sym = checker.getSymbolAtLocation(found);
  // Follow an import alias to the REAL declaration in the resolved module — otherwise an imported
  // binding resolves only to its own import specifier, which would hide WHICH module it bound to
  // (the whole point of the move/extract import-capture oracle).
  if (sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0) {
    sym = checker.getAliasedSymbol(sym);
  }
  const decl = sym?.declarations?.[0];
  assert.ok(decl !== undefined, `oracle: ${needle}#${nth} did not resolve to a declaration`);
  const declSf = decl.getSourceFile();
  return {
    file: path.relative(root, declSf.fileName).split(path.sep).join('/'),
    line: declSf.getLineAndCharacterOfPosition(decl.getStart(declSf)).line + 1,
  };
}

/** Independent drift oracle for `construction_sites` (§16): every object literal a
 *  fresh-from-cold `ts.Program` deems assignable to the named type — `{file, line}` sorted for
 *  set comparison. Built with the SAME primitive the op uses (`isTypeAssignableTo` over the
 *  literal's fresh type), so this is the cold-vs-warm DRIFT check (incremental-update bugs), the
 *  SECONDARY net; the PRIMARY correctness oracle is the hand-curated which-sites assertions in
 *  the test (§16 "never golden/circular-only"). */
export function coldAssignableLiterals(
  root: string,
  typeFileRel: string,
  typeName: string,
): { file: string; line: number }[] {
  const { program, checker } = coldProgram(root);
  const typeFile = program.getSourceFile(path.join(root, typeFileRel));
  assert.ok(typeFile !== undefined, `oracle could not load ${typeFileRel}`);
  let nameNode: ts.Identifier | undefined;
  typeFile.forEachChild((node) => {
    if (
      (ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name?.text === typeName
    ) {
      nameNode = node.name;
    }
  });
  assert.ok(nameNode !== undefined, `oracle could not find type ${typeName}`);
  const targetSym = checker.getSymbolAtLocation(nameNode);
  assert.ok(targetSym !== undefined);
  const targetType = checker.getDeclaredTypeOfSymbol(targetSym);
  const out: { file: string; line: number }[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.fileName.includes('/node_modules/') || sf.isDeclarationFile) continue;
    const rel = path.relative(root, sf.fileName).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) {
        if (checker.isTypeAssignableTo(checker.getTypeAtLocation(n), targetType)) {
          out.push({ file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Independent edit-safety oracle (§16.4): the pre-emit diagnostics a cold compile of the
 *  on-disk tree produces — never the warm LS that performed the edit. A missed/wrong import
 *  rewrite surfaces here as a real "no exported member" error, so a clean list IS the
 *  semantic proof the refactor stayed sound. Shared by the `test/e2e/` mutating-op suites. */
export function coldDiagnostics(root: string, configRel = 'tsconfig.json'): string[] {
  const { program } = coldProgram(root, configRel);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}
