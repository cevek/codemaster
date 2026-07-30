// The raw-type-string oracle, split from `cold-ls.ts` at its 300-line cap. It answers ONE question —
// "what does a fresh cold checker call the type at this identifier, under THIS tsconfig" — which is
// the ground truth every `trace_type_widening` assertion is judged against.
//
// The `configRel` parameter is what makes it a CROSS-PROGRAM oracle: a sink that lives only in a
// sibling program must be typed by that sibling's own options, and asking the primary would answer
// about a file it does not even contain.

import assert from 'node:assert/strict';
import * as path from 'node:path';
import ts from 'typescript';
import { coldProgram } from './cold-ls.ts';

/** Independent raw-type-string oracle for `trace_type_widening` (§16): the cold checker's
 *  `typeToString` at the nth occurrence of an identifier — the GROUND TRUTH the op's widening
 *  classifier is judged against (the op is the classifier under test; this is just the type strings
 *  at each chain position, so the comparison is non-circular). Reads the type at the identifier's
 *  OWN location, mirroring the op's "type at the value's own declaration" rule. */
export function coldTypeStringAt(
  root: string,
  fileRel: string,
  needle: string,
  nth = 0,
  configRel = 'tsconfig.json',
): string {
  const { program, checker } = coldProgram(root, configRel);
  const sf = program.getSourceFile(path.join(root, fileRel));
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
  assert.ok(found !== undefined, `oracle could not find occurrence ${nth} of ${needle}`);
  const type = checker.getTypeAtLocation(found);
  return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
}
