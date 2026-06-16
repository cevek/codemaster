// Unit tests for `buildMembership` — the glob predicate that decides which program OWNS a
// not-yet-created move/extract DEST (so the program whose tsconfig glob covers the dest joins the
// cross-program write gate). It is trust-critical: under-include = a missed cross-program dangle
// (a false success), over-include = a false refusal on a legitimate move. Exercised on the
// tsconfig-include shapes that break naive normalization — bare directory, explicit glob, exclude,
// files-list, a nested config dir, and the no-config fallback — on paths that do NOT exist (the
// whole point: `containsFile`/`isTracked` already cover existing files).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type ts from 'typescript';
import { buildMembership } from '../../src/plugins/ts/program/membership.ts';

const ROOT = '/repo';

/** A minimal ParsedCommandLine — only the fields `buildMembership` reads. */
function parsed(
  raw: Record<string, unknown>,
  options: ts.CompilerOptions = {},
  fileNames: string[] = [],
): ts.ParsedCommandLine {
  return { options, fileNames, errors: [], raw } as unknown as ts.ParsedCommandLine;
}

test('bare-directory include expands to dir/**/* (a not-yet-existing dest under it is owned)', () => {
  const m = buildMembership(parsed({ include: ['src'] }), ROOT, ROOT);
  assert.equal(m('/repo/src/new.ts'), true, 'a new file directly under src');
  assert.equal(m('/repo/src/deep/nested/b.tsx'), true, 'recursively under src');
  assert.equal(m('/repo/test/x.ts'), false, 'a sibling-owned dir is NOT this config’s');
  assert.equal(m('/repo/src/notes.md'), false, 'a non-TS extension under src');
});

test('explicit-glob include is matched precisely (extension narrowing respected)', () => {
  const m = buildMembership(parsed({ include: ['src/**/*.ts'] }), ROOT, ROOT);
  assert.equal(m('/repo/src/a.ts'), true);
  assert.equal(m('/repo/src/deep/a.ts'), true);
  assert.equal(m('/repo/src/a.tsx'), false, 'glob restricts to .ts — .tsx is not included');
});

test('exclude is honoured (no over-refusal on an excluded path)', () => {
  const m = buildMembership(parsed({ include: ['src'], exclude: ['src/generated'] }), ROOT, ROOT);
  assert.equal(m('/repo/src/a.ts'), true);
  assert.equal(m('/repo/src/generated/api.ts'), false, 'inside the excluded subtree');
  assert.equal(m('/repo/src/generated'), false, 'the excluded dir itself');
});

test('files-list config (no wildcard include) owns only its listed files', () => {
  // tsconfig resolves `files` into fileNames; buildMembership treats fileNames as the explicit set.
  const m = buildMembership(
    parsed({ files: ['src/entry.ts'] }, {}, ['/repo/src/entry.ts']),
    ROOT,
    ROOT,
  );
  assert.equal(m('/repo/src/entry.ts'), true, 'the listed file');
  assert.equal(
    m('/repo/src/other.ts'),
    false,
    'no wildcard include → an arbitrary new path is NOT owned',
  );
});

test('nested config dir: include resolves against the config dir, not the repo root', () => {
  const configDir = '/repo/packages/app';
  const m = buildMembership(parsed({ include: ['src'] }), configDir, ROOT);
  assert.equal(m('/repo/packages/app/src/a.ts'), true);
  assert.equal(
    m('/repo/src/a.ts'),
    false,
    'the repo-root src is the ROOT config’s, not the nested one’s',
  );
});

test('no-config fallback (no include, no files) owns everything under root by extension', () => {
  const tsOnly = buildMembership(parsed({}), ROOT, ROOT);
  assert.equal(tsOnly('/repo/anywhere/deep/x.ts'), true);
  assert.equal(tsOnly('/repo/x.js'), false, 'allowJs off → .js is not owned');

  const withJs = buildMembership(parsed({}, { allowJs: true }), ROOT, ROOT);
  assert.equal(withJs('/repo/x.js'), true, 'allowJs on → .js is owned');
  assert.equal(withJs('/repo/x.jsx'), true);
});

test('a path outside the repo root is never owned', () => {
  const m = buildMembership(parsed({ include: ['src'] }), ROOT, ROOT);
  assert.equal(m('/other/src/a.ts'), false);
});
