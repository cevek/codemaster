// Non-primary find_definition + rename honesty (t-773499). A declaration living only in a SIBLING /
// isolated-package program (not the primary) must be located by find_definition (a READ), and a
// rename of it must REFUSE-and-REDIRECT (a MUTATION whose capture gate can't run against a foreign
// target) — never the opaque "Could not find source file" throw both paths produced before.
//
// Oracle: the ops' OWN structured results on an assembled two-program fixture (§16) — a resolved
// definition span, a refuse verdict + git-tree byte-identity — plus a standalone mount of the package
// proving the redirect target (the owning package as `root`) runs the FULL capture-safety gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';

const C = '"strict":true,"module":"esnext","moduleResolution":"bundler","skipLibCheck":true';

// Root primary globs ONLY scripts/; the "frontend" lives under the isolated package web/ (own
// package.json + tsconfig), so its symbols resolve only in the NON-PRIMARY web program.
const ISO = {
  'package.json': '{"name":"root","private":true}',
  'tsconfig.json': `{"compilerOptions":{${C}},"include":["scripts"]}`,
  'scripts/build.ts': 'export const buildTag = 1;\n',
  'web/package.json': '{"name":"web","private":true}',
  'web/tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
  'web/src/widget.ts':
    'export function widgetHelper(x: number): number {\n  return x + 1;\n}\nexport const usesIt: number = widgetHelper(41);\n',
};

function okData(r: OpResult): Record<string, JsonValue> {
  assert.ok('result' in r && r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as Record<string, JsonValue>;
}
function failMessage(r: OpResult): string {
  assert.ok('result' in r && !r.result.ok, `expected a FAIL, got ${JSON.stringify(r)}`);
  return r.result.failure.message;
}

test('find_definition: a bare-NAME target declared only in an isolated package RESOLVES (was FAIL "Could not find source file")', async () => {
  const p: TestProject = await project(ISO);
  try {
    const d = okData(await p.op('find_definition', { name: 'widgetHelper' }));
    const defs = d.definitions as { span: { file: string } }[];
    assert.equal(defs.length, 1, JSON.stringify(defs));
    assert.equal(defs[0]?.span.file, 'web/src/widget.ts', 'the sibling-only decl is located');

    // Byte-identical for a primary-resident target (sourceFileAcross is primary-first + lazy).
    const dp = okData(await p.op('find_definition', { name: 'buildTag' }));
    assert.equal(
      (dp.definitions as { span: { file: string } }[])[0]?.span.file,
      'scripts/build.ts',
    );
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: a non-primary target is REFUSED with an actionable root:<pkg> redirect, tree untouched', async () => {
  const p: TestProject = await project(ISO);
  try {
    const msg = failMessage(
      await p.op('rename_symbol', {
        name: 'widgetHelper',
        file: 'web/src/widget.ts',
        newName: 'widgetHelper2',
      }),
    );
    // Refuse-and-redirect: the capture-safety gate is primary-only, so the mutation refuses (not the
    // opaque "Could not find source file" throw) and points at the safe fully-checked path.
    assert.match(msg, /outside the primary program/i, msg);
    assert.match(msg, /REFUSED/i, msg);
    assert.match(msg, /root:web/, `names the owning package as the redirect: ${msg}`);
    assert.doesNotMatch(msg, /Could not find source file/i, 'not the opaque LS throw');
    assert.equal(p.git('status', '--porcelain'), '', 'the repo tree is byte-identical');
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: a ROOT-LEVEL sibling target refuses WITHOUT a bogus root:. redirect', async () => {
  // A symbol declared only under a root-level `tsconfig.test.json` (no sub-package) is outside the
  // primary too — but re-rooting cannot make a root-level sibling primary, so the refuse must NOT
  // suggest a useless `root:.`.
  const CC = '"strict":true,"module":"esnext","moduleResolution":"bundler","skipLibCheck":true';
  const p: TestProject = await project({
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":{${CC}},"include":["src"]}`,
    'tsconfig.test.json': `{"compilerOptions":{${CC}},"include":["src","test"]}`,
    'src/s.ts': 'export const s = 1;\n',
    'test/h.ts': 'export const helperOnlyInTest = 2;\n',
  });
  try {
    const msg = failMessage(
      await p.op('rename_symbol', { name: 'helperOnlyInTest', file: 'test/h.ts', newName: 'x2' }),
    );
    assert.match(msg, /REFUSED/i, msg);
    assert.match(msg, /tsconfig\.test\.json/, 'names the root-level owner');
    assert.doesNotMatch(msg, /root:\.(?:\s|$)/, `no bogus root:. redirect: ${msg}`);
    assert.equal(p.git('status', '--porcelain'), '', 'tree byte-identical');
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: the SAFE path (owning package as root) runs the FULL capture-safety gate', async () => {
  // The web package mounted as its OWN root → web/tsconfig is primary → the capture gate CAN run.
  // A real forward-capture (`slugify`→`upper` where a local `upper` shadows the call site) must be
  // DETECTED — proof the redirect target is genuinely capture-checked, not merely throw-free.
  const p: TestProject = await project({
    'package.json': '{"name":"web","private":true}',
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
    'src/capture.ts':
      'export function slugify(s: string): string {\n  return s.toLowerCase();\n}\n' +
      'export function run(): string {\n  const upper = (x: string): string => x.toUpperCase();\n  return slugify("A") + upper("b");\n}\n',
  });
  try {
    const d = okData(
      await p.op('rename_symbol', { name: 'slugify', file: 'src/capture.ts', newName: 'upper' }),
    );
    const captures = d.captures as { kind: string }[] | undefined;
    assert.ok(
      captures !== undefined && captures.length >= 1,
      `the full gate detected the forward capture: ${JSON.stringify(d.captures)}`,
    );
    assert.equal(captures[0]?.kind, 'forward');
    assert.equal(p.git('status', '--porcelain'), '', 'dry-run wrote nothing');
  } finally {
    await p.dispose();
  }
});
