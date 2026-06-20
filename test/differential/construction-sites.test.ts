// `construction_sites` (§7 deferred wish — type-aware "what builds a T?") — CORE oracle tests.
// The PRIMARY oracle is hand-curated (§16 "never golden/circular-only"): the four enumerated
// positive cases (factory return · array element · var initializer · call argument) must appear;
// a literal missing a required field OR carrying an excess one must NOT (the checker's
// fresh-literal excess check is the precision guarantee); an `any`-member literal must read
// `partial`. The SECONDARY net is cold-vs-warm set equality (drift) + proof-span validity.
// Honesty/edge cases (vacuous targets, chainability, truncation, value targets) live in
// construction-sites-honesty.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';
import { coldAssignableLiterals } from '../helpers/cold-ls.ts';
import { USER_TYPE, type CView } from '../helpers/construction.ts';

// Every enumerated construction form, plus the negatives the precision contract must exclude.
const SITES = `import type { User } from './types';

export const declaredUser: User = { id: 1, name: 'a' };          // var initializer
export function makeUser(): User { return { id: 2, name: 'b' }; } // factory return
export const users: User[] = [{ id: 3, name: 'c' }];             // array element
function take(u: User): void { void u; }
take({ id: 4, name: 'd' });                                      // call argument (module-level)

export const nearMiss = { id: 5 };                               // missing required -> absent
export const wider = { id: 6, name: 'e', role: 'admin' };        // excess field -> absent
export const unrelated = { foo: 1, bar: 2 };                     // unrelated -> absent

declare const raw: any;
export const memberAny: User = { id: raw, name: raw };           // any member -> partial
`;

function sitesProject() {
  return project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/types.ts': USER_TYPE,
    'src/sites.ts': SITES,
  });
}

test('finds every construction form (factory · array · var init · call arg) and only those', async () => {
  const p = await sitesProject();
  try {
    const r = await p.op('construction_sites', { name: 'User' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as CView;

    // Target descriptor (proof of WHAT T is).
    assert.equal(view.target.name, 'User');
    assert.equal(view.target.kind, 'interface');
    assert.equal(view.target.span.file, 'src/types.ts');

    const byEncloser = new Map(view.sites.map((s) => [s.encloser.name, s]));

    // The four enumerated positives — each present and `certain`.
    for (const name of ['declaredUser', 'makeUser', 'users']) {
      assert.ok(byEncloser.has(name), `expected a construction site enclosed by ${name}`);
      assert.equal(byEncloser.get(name)?.confidence, 'certain', `${name} is a concrete build`);
    }
    // The call argument rolls up to module scope (no named declaration encloses it).
    const moduleSite = view.sites.find((s) => s.encloser.kind === 'module');
    assert.ok(moduleSite !== undefined, 'the module-level call argument is reported');
    assert.equal(moduleSite.confidence, 'certain');

    // Negatives — fresh-literal excess/missing checks exclude them (precision, not a flood).
    for (const name of ['nearMiss', 'wider', 'unrelated']) {
      assert.ok(!byEncloser.has(name), `${name} must NOT be reported (not assignable to User)`);
    }

    // The any-member literal is assignable but honestly demoted to partial, never certain.
    const memberAny = byEncloser.get('memberAny');
    assert.ok(memberAny !== undefined, 'the any-member literal is still reported');
    assert.equal(
      memberAny.confidence,
      'partial',
      'an any-satisfied field is not concretely proven',
    );
    assert.match(memberAny.note ?? '', /any/);

    // Proof-span validity (§16 inv.1): every literal span equals the live source.
    const validated = assertSpansValid(p.root, r);
    assert.ok(validated >= 5, `expected proof spans to be validated, got ${validated}`);
  } finally {
    await p.dispose();
  }
});

test('warm op agrees with a cold ts.Program on the assignable-literal set (drift check)', async () => {
  const p = await sitesProject();
  try {
    const r = await p.op('construction_sites', { name: 'User' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as CView;
    const warm = view.sites
      .map((s) => ({ file: s.span.file, line: s.span.line }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    assert.deepEqual(warm, coldAssignableLiterals(p.root, 'src/types.ts', 'User'));
  } finally {
    await p.dispose();
  }
});

test('enclosing-declaration SymbolId chains into another op', async () => {
  const p = await sitesProject();
  try {
    const r = await p.op('construction_sites', { name: 'User' });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as CView;
    const site = view.sites.find((s) => s.encloser.name === 'declaredUser');
    assert.ok(site !== undefined);

    const def = await p.op('find_definition', { symbolId: site.encloser.id });
    assert.ok('result' in def && def.result.ok, JSON.stringify(def));
    const defs = (def.result.data as { definitions?: { name: string }[] }).definitions ?? [];
    assert.ok(
      defs.some((d) => d.name === 'declaredUser'),
      'the encloser id resolves to its decl',
    );
  } finally {
    await p.dispose();
  }
});

test('candidate cap is honest truncation, never a silent undercount', async () => {
  const many = Array.from(
    { length: 12 },
    (_, i) => `export const u${i}: User = { id: ${i}, name: 'n${i}' };`,
  ).join('\n');
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/types.ts': USER_TYPE,
    'src/many.ts': `import type { User } from './types';\n${many}\n`,
  });
  try {
    const r = await p.op('construction_sites', { name: 'User', limit: 5 });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as CView;
    assert.ok(view.truncated !== undefined, 'the cap is reported');
    assert.equal(view.truncated.examined, 5, 'examined exactly the cap');
    assert.ok(view.truncated.candidates >= 12, 'all candidates counted past the cap');
    assert.ok(view.sites.length <= 5, 'no more sites than examined');
    // The op envelope carries the truncation so sql-batch marks the table partial.
    assert.ok(
      'truncated' in r.result && r.result.truncated !== undefined,
      'envelope truncation present',
    );
  } finally {
    await p.dispose();
  }
});
