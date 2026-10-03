// One disk version per path per host (program/file-versions.ts): the shared DocumentRegistry and the
// write gate's diagnostics builder both reuse a body on an equal version, so an equal version must
// mean an equal body in EVERY program of the host. Oracle: a fresh host on the same disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import type { RepoRelPath } from '../../src/core/brands.ts';
import { createSingleProgram } from '../../src/plugins/ts/program/single.ts';
import { createFileVersions } from '../../src/plugins/ts/program/file-versions.ts';
import { createTsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import { gateAcross } from '../../src/plugins/ts/program-gate.ts';

const rel = (s: string) => s as RepoRelPath;
const OPTS =
  '"strict":true,"types":[],"lib":["ES2022"],"module":"ESNext","moduleResolution":"Bundler"';

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(tmpdir(), 'cm-file-versions-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(d, name)), { recursive: true });
    writeFileSync(path.join(d, name), text);
  }
  return d;
}

const messages = (service: ts.LanguageService, abs: string) =>
  service
    .getSemanticDiagnostics(abs)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));

test('a program that re-globs a path out and back never shares a stale body with another program', () => {
  const d = dir({
    'a.json': `{"compilerOptions":{${OPTS}},"include":["*.ts"]}`,
    'tsconfig.b.json': `{"compilerOptions":{${OPTS}},"include":["*.ts"]}`,
    'tsconfig.json': `{"compilerOptions":{${OPTS}},"include":["*.ts"]}`,
    'p.ts': 'export const v: number = 1;',
    'use.ts': "import { v } from './p';\nexport const u: number = v;",
  });
  const registry = ts.createDocumentRegistry();
  const versions = createFileVersions();
  const make = (config: string) =>
    createSingleProgram(d, path.join(d, config), config, registry, () => new Set(), versions);
  const a = make('tsconfig.json');
  const b = make('tsconfig.b.json');
  const reindex = (paths: string[]) => {
    versions.advance(paths.map((p) => path.join(d, p)));
    a.reindex(paths.map(rel));
    b.reindex(paths.map(rel));
  };
  try {
    a.getProgram();
    b.getProgram();
    // A's glob drops p.ts, then takes it back; B holds it throughout.
    writeFileSync(
      path.join(d, 'tsconfig.json'),
      `{"compilerOptions":{${OPTS}},"files":["use.ts"]}`,
    );
    reindex(['tsconfig.json']);
    a.getProgram();
    writeFileSync(
      path.join(d, 'tsconfig.json'),
      `{"compilerOptions":{${OPTS}},"include":["*.ts"]}`,
    );
    reindex(['tsconfig.json']);
    b.getProgram();
    a.getProgram();
    writeFileSync(path.join(d, 'p.ts'), "export const v: string = 'x';");
    reindex(['p.ts']);
    const use = path.join(d, 'use.ts');
    assert.ok(messages(a.service, use).length > 0, 'A sees the new body');
    assert.deepEqual(messages(b.service, use), messages(a.service, use), 'B sees the same body');
  } finally {
    a.dispose();
    b.dispose();
    rmSync(d, { recursive: true, force: true });
  }
});

test('a file reached only through an import is re-read once a reindex names it', () => {
  const d = dir({
    'tsconfig.json': `{"compilerOptions":{${OPTS}},"include":["src"]}`,
    'shared/x.ts': 'export type T = number;',
    'src/u.ts': "import type { T } from '../shared/x';\nexport const k: T = 1;",
    'src/z.ts': 'export const z = 1;',
  });
  const host = createTsProjectHost(d);
  const scope = { anchor: [rel('src/z.ts')], check: [rel('src/u.ts'), rel('src/z.ts')] };
  try {
    gateAcross(host.gateHostCtx(), [], scope);
    writeFileSync(path.join(d, 'shared/x.ts'), 'export type T = string;');
    host.reindex([rel('shared/x.ts')]);
    assert.ok(messages(host.service, path.join(d, 'src/u.ts')).length > 0, 'the LS sees it');
    const warm = gateAcross(host.gateHostCtx(), [], scope);
    const fresh = createTsProjectHost(d);
    try {
      assert.ok(warm.baseline.length > 0);
      assert.deepEqual(warm.baseline, gateAcross(fresh.gateHostCtx(), [], scope).baseline);
    } finally {
      fresh.dispose();
    }
  } finally {
    host.dispose();
    rmSync(d, { recursive: true, force: true });
  }
});
