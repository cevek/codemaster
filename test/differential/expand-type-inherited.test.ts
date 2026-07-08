// t-754757: the `inherited` flag is meaningful ONLY when the type pulls foreign members in via a
// HERITAGE clause (class extends/implements, interface extends) — the sole shape whose member decls
// land OUTSIDE the type's own decl nodes. A mapped/utility type (Pick/Omit/Partial/Required)
// synthesizes members from a source interface WITHOUT heritage — its `getSymbol()` is the lib
// `MappedType` node (or absent, for an intersection), so a raw containment test flagged EVERY member
// (inherited): a claim we can't prove (§3). Oracle = a fresh cold `ts.Program` for the member SET;
// the `inherited` classification (codemaster's own derived semantic, not an LS fact) is asserted on
// discriminating fixtures — mapped→own, interface-extends→inherited, class-extends→base inherited.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { coldMembers } from '../helpers/cold-ls.ts';

type Member = { name: string; optional: boolean; type: string; inherited?: boolean };
type View = { members?: Member[] };

const MAPPED = `export interface A { a: number; shared: string; other: string }
export type PickA = Pick<A, 'a' | 'shared'>;
export type OmitA = Omit<A, 'other'>;
export type PartialA = Partial<A>;
export type RequiredA = Required<A>;
export interface Ext extends A { extra: boolean }
`;

test('t-754757: mapped/utility members are OWN, not inherited; interface-extends still flags inherited', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/mapped.ts': MAPPED,
  });
  try {
    // A mapped/utility type has NO heritage → every member is own (no `inherited`), and the set
    // still equals a cold ts.Program view (oracle: the members ARE those of the source interface).
    for (const name of ['PickA', 'OmitA', 'PartialA', 'RequiredA']) {
      const r = await p.op('expand_type', { name });
      assert.ok('result' in r && r.result.ok, JSON.stringify(r));
      const members = (r.result.data as View).members ?? [];
      assert.ok(members.length > 0, `${name} lists its members`);
      assert.ok(
        members.every((m) => m.inherited !== true),
        `${name}: mapped/utility members are OWN, never falsely (inherited)`,
      );
      const warm = members.map((m) => m.name).sort();
      const cold = coldMembers(p.root, 'src/mapped.ts', name)
        .map((m) => m.name)
        .sort();
      assert.deepEqual(warm, cold, `${name}: member set equals a cold ts.Program view`);
    }

    // Discriminator: an interface that DOES extend keeps flagging its inherited members — the fix
    // narrows the flag to genuine heritage, it does not disable it.
    const rExt = await p.op('expand_type', { name: 'Ext' });
    assert.ok('result' in rExt && rExt.result.ok);
    const extMembers = (rExt.result.data as View).members ?? [];
    assert.equal(
      extMembers.find((m) => m.name === 'extra')?.inherited,
      undefined,
      '`extra` is declared on Ext itself → own',
    );
    for (const inheritedName of ['a', 'shared', 'other']) {
      assert.equal(
        extMembers.find((m) => m.name === inheritedName)?.inherited,
        true,
        `\`${inheritedName}\` comes from the extended interface A → inherited`,
      );
    }
  } finally {
    await p.dispose();
  }
});
