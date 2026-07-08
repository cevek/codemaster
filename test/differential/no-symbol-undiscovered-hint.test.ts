// §3.4 honesty: the symbol-addressed ops (find_usages / find_definition / search_symbol) that resolve
// a NAME to nothing must not read as "genuinely gone" when a nested tsconfig codemaster did NOT load
// as a program exists — the symbol may be declared under that unindexed program. On a 0-match with a
// non-empty `undiscoveredProgramLabels()`, each op appends a NAMED hint (never claiming the symbol IS
// there — only that it COULD be, unindexed). Mirrors the `find_unused_exports` floor precedent.
//
// Oracle (§16): a fresh-from-cold `ts.LanguageService` over the NESTED tsconfig — a program the warm
// daemon never loaded — proving the symbol genuinely lives there. So "no symbol named 'X'" (flat)
// would be a §3.4 completeness lie. Never grep, never golden-only.
//
// The never-lie core is the NEGATIVE assertion: on a clean single-repo (nothing unloaded) the miss
// message is BYTE-IDENTICAL — no false hint. And an AMBIGUITY (the symbol WAS resolved) gets no hint
// even with an unloaded program present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';

// web/ is a nested-package tsconfig — NOT adjacent to the root config and NOT in `references`, so
// codemaster never loads it as a program. `webOnlySymbol` is declared ONLY there.
const UNDISCOVERED = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
  'web/tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  'web/only.ts': 'export const webOnlySymbol = 42;\n',
  'src/app.ts': 'export const rootSymbol = 1;\n',
};

// A clean single-repo — every program loaded, nothing undiscovered.
const CLEAN = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
  'src/app.ts': 'export const rootSymbol = 1;\n',
};

// Two DISTINCT declarations of one name, both in the loaded primary → an ambiguity (a resolution,
// not a miss) — PLUS an unloaded nested config, to prove the hint is gated on ABSENCE not on labels.
const AMBIGUOUS = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
  'web/tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  'web/only.ts': 'export const webOnlySymbol = 42;\n',
  'src/a.ts': 'export const dupName = 1;\n',
  'src/b.ts': 'export const dupName = 2;\n',
};

const HINT = /nested tsconfig\(s\) are NOT loaded as programs \(web\/tsconfig\.json\)/;

function failMessage(r: unknown): string {
  const res = (r as { result: { ok: boolean; failure?: { message: string } } }).result;
  assert.equal(res.ok, false, 'op fails on a name absence');
  return res.failure?.message ?? '';
}
function okNote(r: unknown): string {
  const res = (r as { result: { ok: boolean; data: { note?: string } } }).result;
  assert.equal(res.ok, true, 'search_symbol returns ok with a note on 0-match');
  return res.data.note ?? '';
}

test('undiscovered hint: find_usages / find_definition / search_symbol name the unloaded config on a genuine 0-match', async () => {
  const p = await project(UNDISCOVERED);
  try {
    // Independent oracle: a cold LS over the NESTED tsconfig resolves the symbol there — so the flat
    // "no symbol named" the loaded programs give is INCOMPLETE, not proof of absence.
    const oracle = coldFindReferences(p.root, 'web/only.ts', 'webOnlySymbol', 'web/tsconfig.json');
    assert.deepEqual(
      oracle,
      ['web/only.ts'],
      'cold ground truth: the symbol IS declared under web/ (a program the daemon never loaded)',
    );

    const fu = failMessage(await p.op('find_usages', { name: 'webOnlySymbol' }));
    assert.match(fu, /no symbol named 'webOnlySymbol'/, 'find_usages still states the absence');
    assert.match(fu, HINT, 'find_usages appends the NAMED unloaded config');
    assert.match(
      fu,
      /NOT proof it is gone/,
      'find_usages is conservative — does not claim presence',
    );

    const fd = failMessage(await p.op('find_definition', { name: 'webOnlySymbol' }));
    assert.match(fd, HINT, 'find_definition appends the NAMED unloaded config');

    const ss = okNote(await p.op('search_symbol', { query: 'webOnlySymbol' }));
    assert.match(ss, /no symbols matching 'webOnlySymbol'/, 'search_symbol states the absence');
    assert.match(ss, HINT, 'search_symbol appends the NAMED unloaded config');

    // symbols[] batch: the per-element unresolved reason carries the hint too.
    const batch = await p.op('find_usages', { symbols: ['webOnlySymbol'] });
    const reason = ((batch as { result: { data: { unresolved?: { reason?: string }[] } } }).result
      .data.unresolved ?? [])[0]?.reason;
    assert.match(reason ?? '', HINT, 'symbols[] per-element reason carries the hint');
  } finally {
    await p.dispose();
  }
});

test('undiscovered hint: NEVER fires on a clean single-repo — the miss message is byte-identical', async () => {
  const p = await project(CLEAN);
  try {
    const fu = failMessage(await p.op('find_usages', { name: 'ghost' }));
    assert.equal(
      fu,
      "no symbol named 'ghost'",
      'find_usages miss is byte-identical (no false hint)',
    );

    const fd = failMessage(await p.op('find_definition', { name: 'ghost' }));
    assert.equal(fd, "no symbol named 'ghost'", 'find_definition miss is byte-identical');

    const ss = okNote(await p.op('search_symbol', { query: 'ghost' }));
    assert.equal(ss, "no symbols matching 'ghost'", 'search_symbol note is byte-identical');
  } finally {
    await p.dispose();
  }
});

test('undiscovered hint: an AMBIGUITY resolved the symbol — no hint even with an unloaded config present', async () => {
  const p = await project(AMBIGUOUS);
  try {
    const msg = failMessage(await p.op('find_usages', { name: 'dupName' }));
    assert.match(msg, /is ambiguous/, 'the name resolved to multiple declarations');
    assert.doesNotMatch(
      msg,
      HINT,
      'no undiscovered hint on an ambiguity — the symbol WAS resolved, hinting would be a lie',
    );
  } finally {
    await p.dispose();
  }
});
