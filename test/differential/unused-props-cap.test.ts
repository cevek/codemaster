// Differential (§16): `find_unused_props` under the ts seam's declared-member cap
// (`first-param-members.ts` MEMBER_CAP=500), which slices UPSTREAM of the view filters.
//
// Two independent guarantees, deliberately tested apart — the second does NOT follow from the
// first (bug-review round 1):
//   · REACHABILITY — when the cap bites, the members that survive it are the project's OWN, so a
//     repo-declared dead prop behind a dependency's 600-member DOM surface is still answered.
//     Before that ordering the same input returned `found:0, unused:[]` while the prop was live,
//     and NO argument recovered it (`includeExternal` returns the external members, not the cut).
//   · HONESTY — a bitten cap still makes the whole answer a floor: the external members ARE cut,
//     so the verdict demotes to `partial` and `hiddenExternal` is marked a lower bound in DATA
//     (a sql/json consumer never reads the prose).
// Plus the ordering's own precondition: with the cap NOT bitten, member order is the checker's
// own, byte-for-byte — a later "just sort always" would break it here, not silently in the field.
//
// Oracle: the independent cold `ts.Program` in `helpers/unused-props.ts` (its own checker), which
// re-derives each member's declaration file and the checker's own member ORDER.

import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { PKG, TSCONFIG, data, oracle, unusedNames } from '../helpers/unused-props.ts';

/** A dependency-declared props type with `count` members, none of them passed anywhere. */
const depWith = (count: number): string =>
  `export interface DepProps { ${Array.from({ length: count }, (_, i) => `d${i}?: string`).join('; ')} }\n`;

const capFixture = (depCount: number): Record<string, string> => ({
  'package.json': PKG,
  'tsconfig.json': TSCONFIG,
  'node_modules/dep/package.json': '{"name":"dep","version":"1.0.0","types":"index.d.ts"}',
  'node_modules/dep/index.d.ts': depWith(depCount),
  'src/Widget.tsx':
    "import type { DepProps } from 'dep';\n" +
    'export const Widget = (props: DepProps & { ownDead?: boolean }) => <div/>;\n',
  'src/App.tsx': "import { Widget } from './Widget';\n" + 'export const App = () => <Widget/>;\n',
});

test('cap BITES: the repo-declared prop survives it — the answer is not a false "no dead props"', async () => {
  const p = await project(capFixture(600));
  try {
    const o = oracle(p.root, 'Widget');
    assert.equal(o.declared.size, 601, 'oracle: 601 declared members, past the 500 cap');
    assert.ok(o.unused.has('ownDead'), 'oracle: ownDead is genuinely dead');
    assert.ok(!o.external.has('ownDead'), 'oracle: ownDead is declared by the repo');

    const d = data(await p.op('find_unused_props', { component: 'Widget' }));
    assert.deepEqual([...unusedNames(d)], ['ownDead'], 'reachable despite 600 members ahead of it');
    assert.equal(d['found'], 1);

    // …and the answer is STILL a floor: the external members were cut, so nothing here may read
    // as a complete verdict.
    assert.equal(d['demoted'], true, 'a bitten cap demotes the set, like a spread does');
    assert.equal(d['hiddenExternalIsLowerBound'], true, 'the floor is in DATA, not only in prose');
    const notes = d['notes'] as string[];
    assert.ok(
      notes.some((n) => n.includes('capped at 500/601')),
      'the cap states itself with both numbers',
    );
    assert.ok(
      notes.some((n) => n.includes('floor') && n.includes('no argument recovers it')),
      'the cap note does not offer a remedy that cannot recover the cut members',
    );
  } finally {
    await p.dispose();
  }
});

test('cap NOT bitten: member order is the checker’s own (the ordering is cap-only)', async () => {
  const p = await project(capFixture(4));
  try {
    const o = oracle(p.root, 'Widget');
    assert.equal(o.declared.size, 5, 'oracle: under the cap');
    assert.ok(o.external.has('d0') && !o.external.has('ownDead'), 'oracle: mixed origins');
    // The checker puts the dependency's members FIRST here, so a project-own-first sort applied
    // unconditionally would hoist `ownDead` to the front — that is what this pins against.
    assert.ok(o.external.has(String(o.order[0])), 'oracle: the checker leads with a dep member');
    const d = data(await p.op('find_unused_props', { component: 'Widget', includeExternal: true }));
    const emitted = (d['unused'] as { name: string }[]).map((u) => u.name);
    const expected = o.order.filter((n) => o.unused.has(n));
    assert.deepEqual(emitted, expected, 'uncapped order is byte-for-byte the checker’s');
    assert.notEqual(emitted[0], 'ownDead', 'an unconditional own-first sort would lead with it');
    assert.equal(d['demoted'], false, 'no cap, no spread → nothing to demote');
    assert.equal(d['hiddenExternalIsLowerBound'], undefined);
  } finally {
    await p.dispose();
  }
});

test('a repo-owned .d.ts is repo-declared — the discriminator is the FILE, not "is a declaration file"', async () => {
  const p = await project({
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'node_modules/dep/package.json': '{"name":"dep","version":"1.0.0","types":"index.d.ts"}',
    'node_modules/dep/index.d.ts': 'export interface DepProps { depDead?: string }\n',
    // The repo's OWN generated types — a .d.ts, but under `src/`. An implementation keyed on
    // `sourceFile.isDeclarationFile` would hide `genDead` from the default view; the whole point
    // is that provenance is the declaration FILE.
    'src/generated/api.d.ts': 'export interface GenProps { genDead?: number }\n',
    'src/Widget.tsx':
      "import type { DepProps } from 'dep';\n" +
      "import type { GenProps } from './generated/api';\n" +
      'export const Widget = (props: DepProps & GenProps & { ownDead?: boolean }) => <div/>;\n',
    'src/App.tsx': "import { Widget } from './Widget';\n" + 'export const App = () => <Widget/>;\n',
  });
  try {
    const o = oracle(p.root, 'Widget');
    assert.ok(!o.external.has('genDead'), 'oracle: the repo’s own .d.ts is not external');
    assert.ok(o.external.has('depDead'), 'oracle: the dependency’s .d.ts is');

    const d = data(await p.op('find_unused_props', { component: 'Widget' }));
    assert.deepEqual([...unusedNames(d)].sort(), ['genDead', 'ownDead'], 'own .d.ts prop kept');
    assert.equal(d['hiddenExternal'], 1, 'only the dependency-declared one is hidden');
  } finally {
    await p.dispose();
  }
});
