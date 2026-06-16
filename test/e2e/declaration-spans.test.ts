// §3.1 declaration spans: find_definition must return a signature/body, not echo the
// identifier. Oracle = a byte-range compare against the file (the decl span text must
// equal the exact source slice it points at) + assertSpansValid on the whole answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { project, assertSpansValid } from '../helpers/project.ts';
import { renderResult } from '../../src/format/render/render-result.ts';

type Def = {
  decl?: { file: string; line: number; col: number; endLine: number; endCol: number; text: string };
};

const TSCONFIG = '{"compilerOptions":{"strict":true}}';

/** Independent byte-range oracle: lift the span's 1-based loc back to an offset range and
 *  compare the file's own bytes to the emitted text. */
function sliceAt(root: string, span: NonNullable<Def['decl']>): string {
  const source = readFileSync(path.join(root, span.file), 'utf8');
  const lines = source.split('\n');
  const toOffset = (line: number, col: number): number =>
    lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + (col - 1);
  return source.slice(toOffset(span.line, span.col), toOffset(span.endLine, span.endCol));
}

test('decl span covers the full declaration incl `export const … ;` for an arrow', async () => {
  const src = 'export const greet = (name: string): string => `hi ${name}`;\n';
  const p = await project({ 'tsconfig.json': TSCONFIG, 'src/m.ts': src });
  try {
    const r = await p.op('find_definition', { name: 'greet' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const def = (r.result.data as { definitions: Def[] }).definitions[0];
    assert.ok(def?.decl !== undefined, 'definition must carry a decl span');
    // Byte-range oracle: the span text is exactly the source it points at, and it spans
    // the whole statement — the `export const` prefix and the trailing `;`.
    assert.equal(def.decl.text, sliceAt(p.root, def.decl));
    assert.ok(def.decl.text.startsWith('export const greet'), 'covers the export+const prefix');
    assert.ok(def.decl.text.endsWith(';'), 'covers the trailing semicolon');
    assertSpansValid(p.root, r);
  } finally {
    await p.dispose();
  }
});

test('find_definition at full verbosity contains the body, not just the identifier', async () => {
  const src = 'export function compute(n: number): number {\n  return n * 2 + 1;\n}\n';
  const p = await project({ 'tsconfig.json': TSCONFIG, 'src/f.ts': src });
  try {
    const r = await p.op('find_definition', { name: 'compute' });
    assert.ok('result' in r && r.result.ok);
    const rendered = renderResult(r.result, 'full');
    assert.ok(rendered.includes('return n * 2 + 1;'), 'full output carries the body');
    // Terse stays a single clickable location — no echo, no body dump.
    const terse = renderResult(r.result, 'terse');
    assert.ok(!terse.includes('return n * 2'), 'terse is location-only');
    // The id carries an origin-root tag suffix (`~<hash>`, §4b) between the position and the kind.
    assert.match(terse, /ts:compute@src\/f\.ts:1:\d+(?:~[0-9a-f]+)? · function/);
  } finally {
    await p.dispose();
  }
});
