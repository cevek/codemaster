// The independent cold-LS oracle home (§16). A fresh-from-cold `ts.Program` built over the
// whole fixture repo — never the warm daemon's own Language Service — so a differential test
// compares two independent TS views and catches incremental-update drift, not the checker
// against itself. Stage 1 ships `coldMembers` (lifted out of `expand-type.test.ts`, which now
// imports it — its still-green run is the behaviour-preserving proof). `coldFindReferences`
// (Stage 3) lands here too, on the same `coldProgram`, when a consumer imports it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
function coldProgram(root: string): ColdView {
  const configPath = path.join(root, 'tsconfig.json');
  const raw: unknown = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
  const { config, error } = raw as { config: unknown; error?: unknown };
  assert.ok(error === undefined, `oracle could not read tsconfig: ${JSON.stringify(error)}`);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
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

/** Independent edit-safety oracle (§16.4): the pre-emit diagnostics a cold compile of the
 *  on-disk tree produces — never the warm LS that performed the edit. A missed/wrong import
 *  rewrite surfaces here as a real "no exported member" error, so a clean list IS the
 *  semantic proof the refactor stayed sound. Shared by the `test/e2e/` mutating-op suites. */
export function coldDiagnostics(root: string): string[] {
  const { program } = coldProgram(root);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}
