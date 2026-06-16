// §1a regression — the LS host MUST canonicalize symlinks the way `tsc`/`createProgram` do
// (`realpath: sys.realpath`). pnpm lays `node_modules/<pkg>` out as symlinks into `.pnpm/`; a
// LanguageServiceHost that omits `realpath` loads a package under its SYMLINK path while the
// cold `createProgram` oracle (and the project's own `tsc`/`tsgo`) loads it under its REAL path.
// When the same package is reached two ways its types stop unifying, manufacturing hundreds of
// phantom errors on a byte-clean repo — which then poison every mutation gate's baseline
// (spec-stresstest §1: "the LS reports ~600 phantom errors the project's own tsc does not").
//
// Oracle: a fresh-from-cold `ts.createProgram` over the same fixture — two INDEPENDENT TS views.
// The warm host's program must resolve the symlinked import to the SAME (real) path the oracle
// does, and report the SAME (zero) diagnostics. Without the fix the warm program keeps the
// symlink path → the assertion bites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { createTsProjectHost } from '../../src/plugins/ts/ls-host.ts';

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** Mount a tiny pnpm-shaped project: a package living in `pkgs/widget`, exposed at
 *  `node_modules/widget` ONLY through a directory symlink, imported by `src/a.ts`. */
function mountSymlinkedProject(): string {
  // realpath the tmp root so the only symlink under test is node_modules/widget (macOS /var → /private/var).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cm-symlink-')));
  mkdirSync(path.join(dir, 'pkgs/widget'), { recursive: true });
  writeFileSync(
    path.join(dir, 'pkgs/widget/index.d.ts'),
    'export interface Widget { id: number }\nexport declare const w: Widget;\n',
  );
  writeFileSync(
    path.join(dir, 'pkgs/widget/package.json'),
    '{"name":"widget","types":"index.d.ts"}',
  );
  mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  symlinkSync(path.join(dir, 'pkgs/widget'), path.join(dir, 'node_modules/widget'), 'dir');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'src/a.ts'),
    "import { w } from 'widget';\nexport const id = w.id;\n",
  );
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    '{"compilerOptions":{"strict":true,"moduleResolution":"bundler","noEmit":true,"module":"esnext"},"include":["src"]}',
  );
  return dir;
}

/** Independent oracle: a cold `ts.createProgram` over the fixture (it canonicalizes symlinks via
 *  its default host's `sys.realpath`, exactly like `tsc`/`tsgo`). */
function oracleProgram(root: string): ts.Program {
  const configPath = path.join(root, 'tsconfig.json');
  const config: unknown = ts.parseConfigFileTextToJson(
    configPath,
    ts.sys.readFile(configPath) ?? '{}',
  ).config;
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

/** The real paths of the `widget`-bearing source files the oracle resolves. */
function oracleWidgetPaths(root: string): string[] {
  return oracleProgram(root)
    .getSourceFiles()
    .map((s) => toPosix(s.fileName))
    .filter((f) => f.includes('widget'))
    .sort();
}

test('LS host canonicalizes symlinked modules to their real path (§1a phantom-error root)', () => {
  const dir = mountSymlinkedProject();
  try {
    const host = createTsProjectHost(dir);
    const program = host.service.getProgram();
    assert.ok(program !== undefined, 'LS produced no program');

    const warmWidget = program
      .getSourceFiles()
      .map((s) => toPosix(s.fileName))
      .filter((f) => f.includes('widget'))
      .sort();
    const oracleWidget = oracleWidgetPaths(dir);

    // The crux: the warm program must reach widget through its REAL path (pkgs/widget), exactly
    // like the oracle — never through the node_modules/widget symlink. Without `realpath` on the
    // host this is `node_modules/widget/index.d.ts` and the assertion fails.
    assert.deepEqual(warmWidget, oracleWidget);
    for (const f of warmWidget) {
      assert.ok(
        !f.includes('/node_modules/widget/'),
        `symlinked module leaked into the program under its symlink path (uncanonicalized): ${f}`,
      );
    }

    // And the honesty property the spec cares about: no phantom diagnostics vs the cold oracle.
    const warmDiags = ts.getPreEmitDiagnostics(program).length;
    const oracleDiags = ts.getPreEmitDiagnostics(oracleProgram(dir)).length;
    assert.equal(
      warmDiags,
      oracleDiags,
      'warm LS diagnostics diverge from the cold createProgram oracle',
    );

    host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
