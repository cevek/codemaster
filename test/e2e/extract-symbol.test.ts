// Stage G edit-safety oracle for extract_symbol (§16.4, TS-only — CSS co-extract and the
// patched-LS rescue §4 are deferred). Oracles: a cold ts.Program compile (the extracted
// symbol resolves from its new home, the source imports it back), diff(dry)==diff(apply),
// and the honest-failure path — an extract the LS can't make clean is REFUSED (§2.8),
// never half-written. The `Expected symbol to be a module` assertion recognizer is unit-pinned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';
import {
  isExtractAssertion,
  isLsDebugFailure,
} from '../../src/plugins/ts/refactor/extract/taxonomy.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

function coldTscErrors(root: string): string[] {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (configPath === undefined) return ['no tsconfig'];
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    path.dirname(configPath),
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

type Envelope = {
  mode: string;
  diff: string;
  touched: string[];
  typecheck: { clean: boolean };
  applied?: boolean;
};
type Proj = Awaited<ReturnType<typeof project>>;

async function extract(p: Proj, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([
    { name: 'extract_symbol', args, ...(apply ? { apply: true } : {}) },
  ]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('extract_symbol: a top-level symbol moves to a new file; source imports it back', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/main.ts':
      'export const helper = (x: number): number => x * 2;\nexport const main = (): number => helper(3);\n',
  });
  try {
    const dry = await extract(p, { name: 'helper', dest: 'src/lib/helper.ts' });
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.typecheck.clean, true);
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes
    assert.ok(!existsSync(path.join(p.root, 'src/lib/helper.ts')));

    const applied = await extract(p, { name: 'helper', dest: 'src/lib/helper.ts' }, true);
    assert.equal(applied.mode, 'applied');
    assert.equal(applied.typecheck.clean, true);
    assert.equal(applied.diff, dry.diff); // diff(dry) === diff(apply)

    // Independent cold compile — the symbol resolves from its new home, source imports it back.
    assert.deepEqual(coldTscErrors(p.root), []);
    assert.match(
      readFileSync(path.join(p.root, 'src/lib/helper.ts'), 'utf8'),
      /export const helper/,
    );
    assert.match(
      readFileSync(path.join(p.root, 'src/main.ts'), 'utf8'),
      /import \{ helper \} from ['"]\.\/lib\/helper['"]/,
    );
    assert.doesNotMatch(
      readFileSync(path.join(p.root, 'src/main.ts'), 'utf8'),
      /export const helper/,
    );
  } finally {
    await p.dispose();
  }
});

test('extract_symbol: an unsatisfiable extract fails honestly (no crash, nothing written)', async () => {
  // The `Expected symbol to be a module` LS assertion is version-specific and not
  // reproducible here; the recognizer + wrapping are unit-pinned below. This pins that a
  // refused extract (dest already exists) surfaces a ToolFailure, never a crash / half-write.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/main.ts':
      'export const helper = (x: number): number => x * 2;\nexport const main = (): number => helper(3);\n',
    'src/lib.ts': 'export const other = 1;\n',
  });
  try {
    const [r] = await p.request([
      { name: 'extract_symbol', args: { name: 'helper', dest: 'src/lib.ts' }, apply: true },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'dest-collision must fail');
    if ('result' in r && !r.result.ok) assert.match(r.result.failure.message, /already exists/);
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('extract_symbol: refuses to overwrite a gitignored file at dest, even with dirtyOk', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    '.gitignore': 'src/gen/\n',
    'src/main.ts':
      'export const helper = (x: number): number => x * 2;\nexport const main = (): number => helper(3);\n',
  });
  try {
    // A gitignored file at dest is excluded from ls-files → invisible to the tree's
    // dest-collision guard, but present on disk. Overwriting it is unrecoverable, so the
    // existsSync backstop must refuse REGARDLESS of dirtyOk.
    p.write('src/gen/helper.ts', 'export const precious = 99;\n');
    const [r] = await p.request([
      {
        name: 'extract_symbol',
        args: { name: 'helper', dest: 'src/gen/helper.ts', dirtyOk: true },
        apply: true,
      },
    ]);
    assert.ok(r !== undefined && 'result' in r && r.result.ok);
    const data = r.result.data as unknown as Envelope & { reason?: string };
    assert.equal(data.applied, false);
    assert.match(String(data.reason), /refusing to overwrite/);
    assert.equal(
      readFileSync(path.join(p.root, 'src/gen/helper.ts'), 'utf8'),
      'export const precious = 99;\n',
    );
  } finally {
    await p.dispose();
  }
});

test('extract taxonomy: only the module assertion earns the workaround note', () => {
  assert.equal(isExtractAssertion('Debug Failure. Expected symbol to be a module'), true);
  assert.equal(isExtractAssertion('Some other Debug Failure.'), false); // generic — no false category
  assert.equal(isLsDebugFailure('Some other Debug Failure.'), true);
  assert.equal(isExtractAssertion('Cannot find name foo'), false);
});
