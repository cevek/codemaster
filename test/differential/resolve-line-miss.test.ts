// Differential (§16): the col-less (`file+line`) MISS message — `plugins/ts/resolve-line-message.ts`.
// Split from `resolve-target-addressing.test.ts` (300-line cap); the resolution behaviour itself
// lives there, this file is about what the REFUSAL says when nothing resolves.
//
// The oracle is execution, not prose: every remedy a refusal names is RUN here and asserted to
// resolve, and every remedy it declines to name is run and asserted to fail. That is what makes
// these discriminating — a message can be reworded into a lie without any string assertion
// noticing, but not without one of these round-trips breaking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { defId, failMsg } from '../helpers/ambiguity.ts';

const M = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/m.ts':
    'export const alpha = 1;\n' + // line 1: one decl `alpha` (col 14)
    'export const beta = 2, gamma = 3;\n' + // line 2: TWO decls (beta col 14, gamma col 24)
    'export function helper(): number {\n' + // line 3: one decl `helper`
    '  return alpha + beta + gamma;\n' + // line 4: ZERO decls (only usages)
    '}\n',
};

test('a declaration-less line says so — and still names the column, which resolves a USE there', async () => {
  const p: TestProject = await project(M);
  try {
    const msg = failMsg(await p.op('find_usages', { name: 'zzz', file: 'src/m.ts', line: 4 }));
    assert.match(msg, /anchors no declaration/, 'says WHY the name missed, not just that it did');
    assert.match(msg, /resolves a symbol USED there/, 'and that the column is not a dead end');
    assert.ok(!/or a 'name'/.test(msg), "still does not re-suggest the caller's own addressing");
    assert.ok(
      !/declares nothing/.test(msg),
      'and never claims the SOURCE declares nothing — only that we anchor no declaration there: ' +
        'a destructuring `export const {a,b} = obj` declares symbols this resolver cannot anchor',
    );
  } finally {
    await p.dispose();
  }
});

test('a destructuring line: no anchorable declaration, yet the named remedy still resolves', async () => {
  // The trap the wording exists for: `declarationsOnLine` anchors a narrow set of declaration
  // kinds, so a line that genuinely DOES declare (a binding pattern) reads as declaration-less
  // here. The refusal must therefore not assert anything about the source — and the column it
  // names must work, which is asserted by running it.
  const p: TestProject = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/d.ts':
      'export const obj = { a: 1, b: 2, render(): number { return 1; } };\n' + // line 1
      'export const { a, b } = obj;\n' + // line 2: declares a + b, not anchorable
      'export const sum = a + b + obj.render();\n', // line 3
  });
  try {
    const msg = failMsg(await p.op('find_usages', { file: 'src/d.ts', line: 2 }));
    assert.match(msg, /pass file:line:col/, 'the column stays the remedy');
    const viaColumn = defId(await p.op('find_usages', { file: 'src/d.ts', line: 2, col: 16 }));
    assert.match(viaColumn, /a@src\/d\.ts:/, 'and it resolves the destructured binding');

    // A line PAST THE END of the file: here no column resolves anything, so the column must NOT
    // be the remedy — the line number is. (The in-range hint above would be a false promise.)
    const past = failMsg(await p.op('find_usages', { file: 'src/d.ts', line: 99 }));
    assert.match(past, /line 99 is outside src\/d\.ts/, 'says why, quoting no line count');
    assert.match(past, /check the line number/, 'names the remedy that applies');
    assert.ok(!/pass file:line:col/.test(past), `no column remedy past EOF: ${past}`);

    // A `name` the file declares elsewhere: the column on THIS line cannot reach it, so the
    // refusal also names the addressing that can — pinned by running it.
    const wrongLine = failMsg(
      await p.op('find_usages', { name: 'sum', file: 'src/d.ts', line: 2 }),
    );
    assert.match(wrongLine, /drop 'line'/, 'names an addressing that reaches the target');
    assert.ok(!/or a 'name'/.test(wrongLine), 'but never the bare name the caller already used');
    const viaNameFile = defId(await p.op('find_usages', { name: 'sum', file: 'src/d.ts' }));
    assert.match(viaNameFile, /sum@src\/d\.ts:3:/, 'the advised call resolves the symbol');

    // The line-independent remedy is offered on the OUT-OF-RANGE arm too — that is precisely
    // where a caller with a `name` needs it, and it is pinned by running it (above).
    const nameOutside = failMsg(
      await p.op('find_usages', { name: 'sum', file: 'src/d.ts', line: 99 }),
    );
    assert.match(nameOutside, /drop 'line'/, 'the reaching remedy survives the out-of-range arm');

    // The offer is NOT gated on a probe of whether it would land, and these two shapes are why.
    // (1) A MEMBER: the top-level walk does not see `render`, but `find_usages` retries a
    // name+file miss through its member fallback — a probe here would withhold a call that
    // resolves. Asserted by running it.
    const member = failMsg(
      await p.op('find_usages', { name: 'render', file: 'src/d.ts', line: 2 }),
    );
    assert.match(member, /drop 'line'/, 'the offer survives for a name the top-level walk misses');
    const viaMember = defId(await p.op('find_usages', { name: 'render', file: 'src/d.ts' }));
    assert.match(viaMember, /render@src\/d\.ts:/, 'because the advised call does resolve it');

    // (2) A top-level BINDING PATTERN: `a` is declared top-level, but that same walk skips it —
    // so a probe's negative would have been a false claim about the source. No arm may say the
    // file declares no such symbol.
    const pattern = failMsg(await p.op('find_usages', { name: 'a', file: 'src/d.ts', line: 1 }));
    assert.ok(!/declares no top-level/.test(pattern), `no false claim about source: ${pattern}`);
    assert.ok(!/does not reach it/.test(pattern), `and no false dead-end: ${pattern}`);
    assert.match(pattern, /pass file:line:col/, 'the addressing that does reach it is named');

    // A name nothing in the file declares still gets the offer — the OP then fails with its own
    // honest message, which is the cheap error; withholding a working call is the expensive one.
    const noSuch = failMsg(await p.op('find_usages', { name: 'zzz', file: 'src/d.ts', line: 2 }));
    assert.match(noSuch, /drop 'line'/, 'offered without a promise about the outcome');
    const proof = failMsg(await p.op('find_usages', { name: 'zzz', file: 'src/d.ts' }));
    assert.match(proof, /'zzz'/, 'and the op that cannot land it says so itself, naming the name');
  } finally {
    await p.dispose();
  }
});
