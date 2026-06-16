// Oracle (spec-agent-surface-ergonomics DoD): find_unused_exports must not report a
// not-provably-dead export as `certain` unused, and must not report a USED one at all.
// A barrel-/`export *`-/dynamic-`import()`-reached export is `partial` ("could not prove
// dead"); a genuinely unreferenced one stays `certain`; an export used only within its own
// module is not reported (it has a usage). Oracle = a HAND-CURATED fixture whose used/dead
// status is fixed by construction — never derived from findReferences (that would be circular,
// §16). The semantic win over grep gets its own case (a same-named symbol elsewhere).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

type Span = { line: number; col: number; endLine: number; endCol: number; text: string };
type Unused = {
  name: string;
  kind: string;
  file: string;
  confidence: string;
  note?: string;
  span: Span;
};
type View = {
  unused: Unused[];
  scanned: { exports: number; files: number };
  computedDynamicImport?: boolean;
  truncated?: { examined: number; candidates: number };
};

const FIXTURE = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  // A symbol used directly, one used ONLY via an alias (the semantic win — the use site never
  // spells `usedAliased`), a genuinely dead const + dead function, and a local-only export.
  'src/lib.ts':
    'export const usedDirect = 1;\n' +
    'export const usedAliased = 2;\n' +
    'export const trulyDead = 3;\n' +
    'export function deadFn() {\n  return 1;\n}\n' +
    'export const localOnly = 4;\n' +
    'export const localUser = () => localOnly;\n',
  // barreled: declared here, re-exported by a barrel, never imported → partial (barrel).
  'src/provider.ts': 'export const barreled = 5;\n',
  'src/barrel.ts': "export { barreled } from './provider';\n",
  // starExport: reached only through `export *` (findReferences can't trace it) → partial.
  'src/starred.ts': 'export const starExport = 6;\n',
  'src/star.ts': "export * from './starred';\n",
  // dynExport: its module is dynamically imported (literal) → partial (dynamic).
  'src/dyn.ts': 'export const dynExport = 7;\n',
  // Two same-named `Dup` exports in different modules; only dup-a's is imported. A TEXTUAL
  // heuristic that sees `import { Dup }` would wrongly call BOTH used — the semantic LS does not.
  'src/dup-a.ts': "export const Dup = 'a';\n",
  'src/dup-b.ts': "export const Dup = 'b';\n",
  'src/app.ts':
    "import { usedDirect, usedAliased as u, localUser } from './lib';\n" +
    "import { Dup } from './dup-a';\n" +
    'export const useThem = () => usedDirect + u + localUser() + Dup.length;\n' +
    "export async function lazy() {\n  return import('./dyn');\n}\n",
};

test('find_unused_exports: certain dead vs barrel/star/dynamic partial vs used (hand-curated oracle)', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_exports', {});
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const data = r.result.data as View;
    const row = (name: string, file?: string): Unused | undefined =>
      data.unused.find((u) => u.name === name && (file === undefined || u.file === file));

    // ── certain dead: no reference of any kind, no barrel/star/dynamic reach ──
    assert.equal(row('trulyDead')?.confidence, 'certain', 'trulyDead is cleanly dead');
    assert.equal(row('deadFn')?.confidence, 'certain', 'deadFn is cleanly dead');
    assert.equal(row('deadFn')?.kind, 'function', 'kind is reported');

    // ── partial: could not prove dead, each with its stated reason ──
    assert.equal(row('barreled')?.confidence, 'partial', 'barrel re-export → partial');
    assert.match(row('barreled')?.note ?? '', /barrel/, 'barrel reason stated');
    assert.equal(row('starExport')?.confidence, 'partial', 'export * → partial');
    assert.match(row('starExport')?.note ?? '', /export \*/, 'star reason stated');
    assert.equal(row('dynExport')?.confidence, 'partial', 'dynamic import() → partial');
    assert.match(row('dynExport')?.note ?? '', /dynamic/, 'dynamic reason stated');

    // ── used: never reported ──
    assert.equal(row('usedDirect'), undefined, 'directly imported → used');
    assert.equal(row('usedAliased'), undefined, 'imported only via alias → still used (semantic)');
    assert.equal(row('localUser'), undefined, 'imported & used → used');
    assert.equal(row('localOnly'), undefined, 'used only within its own module → has a usage');

    // ── semantic win over grep: same-named `Dup` in two modules, only one imported ──
    assert.equal(row('Dup', 'src/dup-a.ts'), undefined, 'the imported Dup is used');
    assert.equal(
      row('Dup', 'src/dup-b.ts')?.confidence,
      'certain',
      'the OTHER Dup is dead — a text-grep on the name would falsely call it used',
    );

    assert.equal(data.computedDynamicImport, undefined, 'no computed import in this fixture');
  } finally {
    await p.dispose();
  }
});

// A computed `import(expr)` could load ANY module, so every otherwise-certain claim is demoted
// to partial (the i18n-degraded precedent — honest uncertainty, never a false certain dead).
const COMPUTED_FIXTURE = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  'src/a.ts': 'export const aDead = 1;\n',
  'src/loader.ts':
    'export async function load(name: string) {\n  return import(`./pages/${name}`);\n}\n',
};

test('find_unused_exports: a computed import(expr) demotes every claim to partial', async () => {
  const p = await project(COMPUTED_FIXTURE);
  try {
    const r = await p.op('find_unused_exports', {});
    assert.ok('result' in r && r.result.ok);
    const data = r.result.data as View;
    assert.equal(data.computedDynamicImport, true, 'computed import flagged');
    const aDead = data.unused.find((u) => u.name === 'aDead');
    assert.equal(aDead?.confidence, 'partial', 'a computed import could reach it → partial');
    assert.match(aDead?.note ?? '', /computed import/, 'computed-import reason stated');
  } finally {
    await p.dispose();
  }
});

// Bounded compute (§1/§19): the candidate set is hard-capped and the cap is reported as
// explicit truncation, never a silent undercount (§3.4).
const MANY_FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/many.ts':
    Array.from({ length: 5 }, (_, i) => `export const dead${i} = ${i};`).join('\n') + '\n',
};

test('find_unused_exports: the candidate cap is honest truncation, not a silent undercount', async () => {
  const p = await project(MANY_FIXTURE);
  try {
    const r = await p.op('find_unused_exports', { limit: 2 });
    assert.ok('result' in r && r.result.ok);
    const data = r.result.data as View;
    assert.equal(data.scanned.exports, 2, 'examined exactly the cap');
    assert.ok(data.truncated !== undefined, 'truncation reported');
    assert.equal(data.truncated?.examined, 2);
    assert.equal(data.truncated?.candidates, 5, 'the full candidate count is surfaced');
    // The envelope also carries the standard Truncation (so the renderer flags it).
    assert.ok(r.result.truncated !== undefined, 'envelope truncation set');
  } finally {
    await p.dispose();
  }
});

// The highest-value false-certain guards: an export consumed only through a namespace member
// (`import * as M; M.x`), a default import, or a TYPE-ONLY import must all stay alive. A textual
// heuristic misses the first and last; the semantic LS must not. A genuinely dead sibling in each
// module stays certain, proving the test isn't vacuously green.
const CONSUMPTION_FIXTURE = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  'src/ns.ts': 'export const viaNamespace = 1;\nexport const nsDead = 9;\n',
  'src/def.ts': 'export default function viaDefault() {\n  return 1;\n}\n',
  'src/ty.ts':
    'export interface ViaType {\n  x: number;\n}\nexport interface TyDead {\n  y: number;\n}\n',
  'src/app.ts':
    "import * as M from './ns';\n" +
    "import viaDefault from './def';\n" +
    "import type { ViaType } from './ty';\n" +
    'export const a = () => M.viaNamespace + viaDefault();\n' +
    'export const b = (v: ViaType): number => v.x;\n',
};

test('find_unused_exports: namespace-member, default-import, and type-only uses keep exports alive', async () => {
  const p = await project(CONSUMPTION_FIXTURE);
  try {
    const r = await p.op('find_unused_exports', {});
    assert.ok('result' in r && r.result.ok);
    const data = r.result.data as View;
    const name = (n: string): Unused | undefined => data.unused.find((u) => u.name === n);

    assert.equal(name('viaNamespace'), undefined, 'used via M.viaNamespace → alive');
    assert.equal(name('viaDefault'), undefined, 'used via default import → alive');
    assert.equal(name('ViaType'), undefined, 'used via type-only import → alive');
    // The dead siblings prove the op still reports — not vacuously green.
    assert.equal(name('nsDead')?.confidence, 'certain', 'genuinely dead sibling still certain');
    assert.equal(name('TyDead')?.confidence, 'certain', 'genuinely dead type still certain');
  } finally {
    await p.dispose();
  }
});

// A dead export written as a SEPARATE same-file `export { local }` specifier (no `from`) must
// still be found (its export symbol carries SymbolFlags.Alias, but its home declaration is local
// — resolve it, don't skip it). A USED one via the same form stays alive. (bug-reviewer §2/§3)
const SAME_FILE_REEXPORT_FIXTURE = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  'src/m.ts':
    'const deadViaBlock = 1;\n' +
    'const liveViaBlock = 2;\n' +
    'export { deadViaBlock, liveViaBlock };\n',
  'src/app.ts': "import { liveViaBlock } from './m';\nexport const u = () => liveViaBlock;\n",
};

test('find_unused_exports: a dead `export { local }` block re-export is found, not silently skipped', async () => {
  const p = await project(SAME_FILE_REEXPORT_FIXTURE);
  try {
    const r = await p.op('find_unused_exports', { pathInclude: ['src/m.ts'] });
    assert.ok('result' in r && r.result.ok);
    const data = r.result.data as View;
    const dead = data.unused.find((u) => u.name === 'deadViaBlock');
    assert.equal(dead?.confidence, 'certain', 'the unused block-export is reported certain dead');
    assert.equal(dead?.file, 'src/m.ts', 'anchored at the local declaration, not the specifier');
    assert.equal(
      data.unused.find((u) => u.name === 'liveViaBlock'),
      undefined,
      'the imported block-export is used',
    );
  } finally {
    await p.dispose();
  }
});

// Proof-span validity for an escaped-Unicode identifier: the span must cover the RAW source
// token (`fooBar`, 11 chars), not the decoded name length (`fooBar`, 6). (bug-reviewer §1)
test('find_unused_exports: an escaped-identifier export carries a non-drifted proof span', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/esc.ts': 'export const \\u0066ooBar = 1;\n',
  });
  try {
    const r = await p.op('find_unused_exports', {});
    assert.ok('result' in r && r.result.ok);
    const data = r.result.data as View;
    const row = data.unused.find((u) => u.name === 'fooBar');
    assert.ok(row !== undefined, 'decoded name is fooBar');
    // The raw token `fooBar` is 11 source chars; a length-from-decoded-name bug gives 6.
    assert.equal(row.span.endCol - row.span.col, 11, 'span covers the raw escaped token');
    assert.equal(row.span.text, '\\u0066ooBar', 'proof text equals the source token, undrifted');
  } finally {
    await p.dispose();
  }
});

// pathInclude scopes WHICH declaration files are reported; usage discovery still scans the whole
// program, so a symbol used only OUTSIDE the scope is never a scoped-away false dead.
test('find_unused_exports: pathInclude scopes the report without inventing a false dead', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_exports', { pathInclude: ['src/lib.ts'] });
    assert.ok('result' in r && r.result.ok);
    const data = r.result.data as View;
    assert.ok(
      data.unused.every((u) => u.file === 'src/lib.ts'),
      'only the included file is reported on',
    );
    // usedDirect/usedAliased are used from OUT-of-scope app.ts — still not reported (no false dead).
    assert.equal(
      data.unused.find((u) => u.name === 'usedDirect'),
      undefined,
      'cross-scope usage keeps it alive',
    );
    assert.equal(
      data.unused.find((u) => u.name === 'trulyDead')?.confidence,
      'certain',
      'in-scope, truly dead → certain',
    );
  } finally {
    await p.dispose();
  }
});

test('find_unused_exports: a SIBLING tsconfig program is SEEN — a test-only-used export is not dead, a genuinely-dead one is `certain` (Task G: cross-program, no blanket demotion)', async () => {
  // The primary LS loads tsconfig.json (src only); the test program (tsconfig.test.json) adds
  // test/**. An export used ONLY from the test program reads as unreferenced in the primary — the
  // old stopgap blanket-demoted EVERY certain verdict to partial whenever any sibling existed.
  // Task G replaces that with the real fix: usage discovery FANS OUT across both programs, so the
  // test usage is seen (not reported) and a genuinely-dead export is `certain` AGAIN.
  const p = await project({
    'tsconfig.json':
      '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
    'tsconfig.test.json':
      '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"},"include":["src","test"]}',
    'src/lib.ts': 'export const onlyTestUses = 7;\nexport const trulyDead = 8;\n',
    'test/lib.test.ts': "import { onlyTestUses } from '../src/lib';\nconsole.log(onlyTestUses);\n",
  });
  try {
    const r = await p.op('find_unused_exports', {});
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const data = r.result.data as View;
    // Used only from the test program → SEEN as used, never reported (the false-dead this fixes).
    assert.equal(
      data.unused.find((u) => u.name === 'onlyTestUses'),
      undefined,
      'a test-program usage keeps the export alive across programs',
    );
    // Genuinely dead in BOTH programs → `certain` again (no blanket sibling demotion).
    assert.equal(
      data.unused.find((u) => u.name === 'trulyDead')?.confidence,
      'certain',
      'a genuinely-dead export reads certain even with a sibling tsconfig present',
    );
  } finally {
    await p.dispose();
  }
});
