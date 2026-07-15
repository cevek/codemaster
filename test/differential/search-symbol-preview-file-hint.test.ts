// t-517121 — two `search_symbol` ergonomics, each oracle-backed (§16), never golden-only:
//
//  1. At `verbosity:'full'` a match carries a small HEADER-only decl preview (the signature line),
//     marked `elided` when the body continues. Oracle: the preview text must equal the ACTUAL first
//     source line of the declaration (read from disk) — a drifted preview is a proof lie. The
//     never-lie NEGATIVE: at terse/normal the data carries NO `decl`, so those answers are byte-stable.
//  2. On a 0-match NAME that is a SOURCE FILE's basename, the note names the file + steers to
//     find_definition/list. Oracle: the file genuinely exists in the git tree. NEGATIVE: a 0-match
//     with no such file leaves the note byte-identical (no false hint).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { project } from '../helpers/project.ts';
import { renderResult } from '../../src/format/render/render-result.ts';
import type { Verbosity } from '../../src/core/result.ts';

// A multi-line declaration (preview must be its FIRST line + `elided`) and a single-line one (full
// decl, NO elision). A FILE whose basename has no same-named symbol drives the part-2 hint.
const REPO = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
  'src/lib.ts':
    'export function makeWidget(size: number): number {\n  return size + 1;\n}\nexport const WIDGET_MAX = 42;\n',
  // A file named `buildView` whose ONLY export is `render` — so `buildView` resolves to no SYMBOL,
  // only a FILE. This is the motivating shape (t-517121: `buildView` → a file whose exports differ).
  'src/buildView.ts': 'export const render = 1;\n',
};

interface Match {
  id: string;
  decl?: { text: string; line: number; elided?: boolean };
}
function matchesOf(r: unknown): Match[] {
  const res = (r as { result: { ok: boolean; data: { matches?: Match[] } } }).result;
  assert.equal(res.ok, true, 'search_symbol ok');
  return res.data.matches ?? [];
}
function noteOf(r: unknown): string {
  const res = (r as { result: { ok: boolean; data: { note?: string } } }).result;
  assert.equal(res.ok, true, 'search_symbol ok');
  return res.data.note ?? '';
}
type P = Awaited<ReturnType<typeof project>>;
async function search(p: P, query: string, verbosity?: Verbosity): Promise<unknown> {
  const reqs = [{ name: 'search_symbol', args: { query }, ...(verbosity ? { verbosity } : {}) }];
  return (await p.request(reqs))[0];
}

test('preview: verbosity:full attaches a HEADER-only decl span whose text equals the real first source line', async () => {
  const p = await project(REPO);
  try {
    // Independent oracle: the actual first physical line of each declaration, straight from disk.
    const src = readFileSync(path.join(p.root, 'src/lib.ts'), 'utf8').split('\n');
    const fnHeader = src[0]; // `export function makeWidget(size: number): number {`
    const constDecl = src[3]; // `export const WIDGET_MAX = 42;`
    assert.equal(fnHeader, 'export function makeWidget(size: number): number {');
    assert.equal(constDecl, 'export const WIDGET_MAX = 42;');

    const fn = matchesOf(await search(p, 'makeWidget', 'full'))[0];
    assert.ok(fn?.decl, 'full carries a decl preview');
    assert.equal(fn.decl.text, fnHeader, 'preview text IS the declaration signature line (oracle)');
    assert.equal(
      fn.decl.elided,
      true,
      'a multi-line body is marked elided (§3.4, not a silent cut)',
    );
    // Text channel: the rendered full output shows the signature on a continuation line + ` …` marker.
    const r = (await search(p, 'makeWidget', 'full')) as {
      result: Parameters<typeof renderResult>[0];
    };
    assert.match(
      renderResult(r.result, 'full'),
      /export function makeWidget\(size: number\): number \{ …/,
      'render shows the header line with the more-marker',
    );

    const cst = matchesOf(await search(p, 'WIDGET_MAX', 'full'))[0];
    assert.ok(cst?.decl, 'full carries a decl preview for the const');
    assert.equal(cst.decl.text, constDecl, 'single-line preview IS the whole declaration');
    assert.equal(cst.decl.elided, undefined, 'a single-line decl is NOT marked elided (complete)');
  } finally {
    await p.dispose();
  }
});

test('preview NEGATIVE: terse and normal carry NO decl — those answers stay byte-stable', async () => {
  const p = await project(REPO);
  try {
    for (const v of [undefined, 'normal'] as const) {
      const m = matchesOf(await search(p, 'makeWidget', v))[0];
      assert.ok(m, 'the match still resolves');
      assert.equal(
        m.decl,
        undefined,
        `no decl at verbosity=${v ?? 'default(terse)'} — byte-stable`,
      );
    }
  } finally {
    await p.dispose();
  }
});

test('file/module hint: a 0-match NAME that is a source file basename names the file + steers to find_definition/list', async () => {
  const p = await project(REPO);
  try {
    // Oracle: the file genuinely exists in the git-tracked tree (independent of the LS).
    assert.match(p.git('ls-files'), /src\/buildView\.ts/, 'buildView.ts IS in the git tree');

    const note = noteOf(await search(p, 'buildView'));
    assert.match(note, /no symbols matching 'buildView'/, 'states the symbol absence');
    assert.match(
      note,
      /a source file named 'buildView' exists \(src\/buildView\.ts\)/,
      'names the file',
    );
    assert.match(
      note,
      /find_definition \{file:'src\/buildView\.ts'\}/,
      'steers to the file lookup',
    );
  } finally {
    await p.dispose();
  }
});

test('file/module hint NEGATIVE: a 0-match with NO same-named file leaves the note byte-identical (no false hint)', async () => {
  const p = await project(REPO);
  try {
    const note = noteOf(await search(p, 'zzNoSuchNameNoFile'));
    assert.equal(
      note,
      "no symbols matching 'zzNoSuchNameNoFile'",
      'byte-identical — no file/undiscovered hint',
    );
  } finally {
    await p.dispose();
  }
});
