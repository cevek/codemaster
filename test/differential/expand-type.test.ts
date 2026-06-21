// §3.3 deep expand_type, oracle = a fresh-from-cold `ts.Program` (§16). NOT circular:
// we check the warm daemon's structural view agrees with an independent cold build of the
// same fixture — catching incremental-update drift, not the checker against itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { coldMembers, coldSignatures, type ColdMember } from '../helpers/cold-ls.ts';

type Member = {
  name: string;
  optional: boolean;
  type: string;
  inherited?: boolean;
  members?: Member[];
};
type View = {
  about?: string;
  type?: string;
  members?: Member[];
  constituents?: string[];
  signatures?: string[];
  notes?: string[];
};

// Overloaded function (2 call sigs + 1 impl) and a function/namespace merge whose return type is a
// multi-line object literal — the two callable shapes Bug A/B lose facts on.
const CALLABLE = `export function coerce(value: number): string;
export function coerce(value: string): number;
export function coerce(value: number | string): string | number {
  return typeof value === 'number' ? String(value) : value.length;
}
export function box(label: string): { label: string } {
  return { label };
}
export namespace box {
  export const of = (label: string): { label: string } => box(label);
  export const empty = '';
}
`;

const DTO = `export interface Base { id: number; }
export interface User extends Base {
  name: string;
  email?: string;
  address: { city: string; zip: number };
}
export type Status = 'active' | 'inactive';
`;

test('expand_type members equal a cold ts.Program view; optional + inherited correct', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/dto.ts': DTO,
  });
  try {
    const r = await p.op('expand_type', { name: 'User', depth: 2 });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as View;
    const members = view.members ?? [];

    // Oracle comparison: same {name, optional, type} set as a cold build. The warm view strips the
    // redundant ` | undefined` an optional member injects (non-EOPT; `?` already implies it), so the
    // cold oracle — which keeps coldMembers pristine/independent — is normalized the SAME way here
    // before the set comparison (the density normalization is mirrored at the test, not in the helper).
    const stripOpt = (m: ColdMember): ColdMember =>
      m.optional && m.type.endsWith(' | undefined')
        ? { ...m, type: m.type.slice(0, -' | undefined'.length) }
        : m;
    const warmSet = members
      .map((m) => ({ name: m.name, optional: m.optional, type: m.type }))
      .sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(warmSet, coldMembers(p.root, 'src/dto.ts', 'User').map(stripOpt));

    // `id` is inherited from Base; `email` is optional.
    assert.equal(members.find((m) => m.name === 'id')?.inherited, true);
    assert.equal(members.find((m) => m.name === 'email')?.optional, true);

    // depth:2 expanded the anonymous `address` object literal into its own members.
    const address = members.find((m) => m.name === 'address');
    assert.deepEqual(
      (address?.members ?? []).map((m) => m.name).sort(),
      ['city', 'zip'],
      'nested object literal expanded at depth 2',
    );
  } finally {
    await p.dispose();
  }
});

test('`type` is omitted when it would repeat `about` (named single-line declarations)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/dto.ts': DTO,
  });
  try {
    // Named interface: quick-info is the single line `interface User` — about carries it,
    // a duplicate `type` line is noise, not information (field feedback, patient-portal).
    const named = await p.op('expand_type', { name: 'User' });
    assert.ok('result' in named && named.result.ok);
    const namedView = named.result.data as View;
    assert.equal(namedView.about, 'interface User');
    assert.equal(namedView.type, undefined, 'type must be omitted when identical to about');

    // Alias: the resolved union differs from the first line — `type` must stay.
    const alias = await p.op('expand_type', { name: 'Status' });
    assert.ok('result' in alias && alias.result.ok);
    const aliasView = alias.result.data as View;
    if (aliasView.type !== undefined) {
      assert.notEqual(aliasView.type, aliasView.about, 'a present type must add information');
    }
  } finally {
    await p.dispose();
  }
});

test('a small union: `constituents` is SUPPRESSED because the head already lists every arm verbatim', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/dto.ts': DTO,
  });
  try {
    const r = await p.op('expand_type', { name: 'Status' });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as View;
    // The head (`about`/`type`) prints `"active" | "inactive"` in full — a `constituents` array would
    // repeat the exact arms (the `ShapeTag`-twice noise the density audit found), so it is dropped.
    const head = view.type ?? view.about ?? '';
    assert.ok(head.includes('"active"') && head.includes('"inactive"'), 'head carries every arm');
    assert.equal(view.constituents, undefined, 'constituents suppressed when the head covers them');
  } finally {
    await p.dispose();
  }
});

test('a large union whose head the LS TRUNCATES keeps `constituents` (the load-bearing full list)', async () => {
  // 60 distinct string-literal arms — wide enough that the LS quick-info truncates the head with
  // `...`; the NoTruncation `constituents` is then the only complete arm list and MUST stay (§3.4).
  const arms = Array.from({ length: 60 }, (_, i) => `"opt_${i}_xxxxxxxxxxxxxxxx"`).join(' | ');
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/u.ts': `export type Big = ${arms};\n`,
  });
  try {
    const r = await p.op('expand_type', { name: 'Big' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as View;
    const head = view.type ?? view.about ?? '';
    // Oracle: the head is genuinely truncated (so suppressing would HIDE arms) → constituents kept,
    // and it carries all 60 arms in full.
    assert.ok(
      head.includes('...') || head.includes('…'),
      'precondition: the LS truncated the head',
    );
    assert.equal((view.constituents ?? []).length, 60, 'all arms preserved in constituents');
  } finally {
    await p.dispose();
  }
});

test('enum expands to its members, not union arms (enum dispatched before union)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/e.ts': 'export enum Color {\n  Red,\n  Green,\n  Blue,\n}\n',
  });
  try {
    const r = await p.op('expand_type', { name: 'Color' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as View;
    assert.deepEqual(
      (view.members ?? []).map((m) => m.name),
      ['Red', 'Green', 'Blue'],
      'enum members listed in declaration order',
    );
    assert.equal(view.constituents, undefined, 'an enum is not rendered as union constituents');
  } finally {
    await p.dispose();
  }
});

test('optional member: ` | undefined` is stripped (non-EOPT) — `?` already implies it, no fact lost', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}', // non-EOPT
    'src/o.ts': 'export interface O { id?: number; tag: string; }\n',
  });
  try {
    const r = await p.op('expand_type', { name: 'O' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const members = (r.result.data as View).members ?? [];
    const id = members.find((m) => m.name === 'id');
    assert.equal(id?.optional, true, 'id is optional');
    // Independent oracle: a cold checker reports the optional member WITH the injected ` | undefined`.
    const cold = coldMembers(p.root, 'src/o.ts', 'O').find((m) => m.name === 'id');
    assert.equal(cold?.type, 'number | undefined', 'oracle: cold keeps the injected undefined');
    // Warm strips it — the result is exactly the cold type minus the redundant arm (fact-preserving).
    assert.equal(id?.type, 'number', 'warm strips the redundant `| undefined`');
  } finally {
    await p.dispose();
  }
});

test('optional member under exactOptionalPropertyTypes: an EXPLICIT ` | undefined` is PRESERVED', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true,"exactOptionalPropertyTypes":true}}',
    'src/o.ts': 'export interface O { id?: number; name?: string | undefined; }\n',
  });
  try {
    const r = await p.op('expand_type', { name: 'O' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const members = (r.result.data as View).members ?? [];
    // Under EOPT the injected undefined never appears (id?: number → number) — nothing to strip…
    assert.equal(members.find((m) => m.name === 'id')?.type, 'number');
    // …and an EXPLICIT `| undefined` is a DISTINCT type (assignable undefined) — never stripped (§3).
    assert.equal(
      members.find((m) => m.name === 'name')?.type,
      'string | undefined',
      'EOPT explicit undefined preserved',
    );
  } finally {
    await p.dispose();
  }
});

test('Bug B: an overloaded function lists EVERY call signature (full), matching a cold checker', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/c.ts': CALLABLE,
  });
  try {
    const r = await p.op('expand_type', { name: 'coerce' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as View;
    // Oracle: the same overload set a fresh-from-cold checker produces (same getSignaturesOfType
    // Call + signatureToString) — the impl signature is NOT a call signature, so both see exactly 2.
    const cold = coldSignatures(p.root, 'src/c.ts', 'coerce');
    assert.equal(cold.length, 2, 'oracle: two overload signatures');
    assert.deepEqual(view.signatures, cold, 'warm lists every overload, equal to the cold oracle');
    // The count surfaced in `about` (`(+1 overload)`) is consistent with the full list — both say 2.
    assert.match(view.about ?? '', /\+1 overload/, 'about count stays correct');
  } finally {
    await p.dispose();
  }
});

test('Bug A: a fn/namespace merge keeps the full return type — never truncated after the colon', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/c.ts': CALLABLE,
  });
  try {
    const r = await p.op('expand_type', { name: 'box' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as View;
    // The return type (`{ label: string }`) must survive — Bug A chopped `about` to `function box(label:
    // string):`. The headline no longer carries a dangling/truncated signature; the call shape lives
    // verbatim in `signatures`, agreeing with a cold checker.
    const head = view.about ?? '';
    assert.ok(!/:\s*$/.test(head), `headline must not end at a dangling colon (was: ${head})`);
    const cold = coldSignatures(p.root, 'src/c.ts', 'box');
    assert.deepEqual(view.signatures, cold, 'the full signature equals the cold oracle');
    assert.ok(
      (view.signatures?.[0] ?? '').includes('label: string') &&
        /:\s*\{[^}]*label: string/.test(view.signatures?.[0] ?? ''),
      `return type {label:string} preserved in the signature (was: ${view.signatures?.[0]})`,
    );
    // The namespace half is still listed — neither truncates the other.
    assert.deepEqual(
      (view.members ?? []).map((m) => m.name).sort(),
      ['empty', 'of'],
      'namespace exports listed alongside the call signature',
    );
  } finally {
    await p.dispose();
  }
});

test('Bug C: a type alias resolves by name+file exactly as by file+line+col (resolver gap)', async () => {
  // RED until the addressing track lands the name+file → resolveNameInFile branch (resolve-target.ts,
  // a shared seam owned by that track). The defect: name+file silently ignores `file` and falls into
  // workspace-wide fuzzy navto, where a case-insensitive flood of unrelated names buries the exact
  // type past the cap → "no symbol named". This op-level test pins the contract the fix must meet.
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    // Many lowercase `span` PROPERTIES: each is a case-insensitive EXACT navto match to `Span`, so
    // they tie at the top match rank and crowd the exact type past the resolver's view cap — the
    // real-repo condition (132 `span` props bury `Span`). 12 already reproduces the FAIL.
    'src/span.ts':
      'export type Span = { start: number; end: number };\n' +
      Array.from({ length: 15 }, (_, i) => `export interface I${i} { span: number; }`).join('\n') +
      '\n',
  });
  try {
    const byName = await p.op('expand_type', { name: 'Span', file: 'src/span.ts' });
    const byPos = await p.op('expand_type', { file: 'src/span.ts', line: 1, col: 13 });
    assert.ok('result' in byPos && byPos.result.ok, JSON.stringify(byPos));
    assert.ok(
      'result' in byName && byName.result.ok,
      `name+file must resolve the alias as file+line+col does: ${JSON.stringify(byName)}`,
    );
    // Same declaration → same structural view (members of the alias body).
    const named = byName.result.data as View;
    const positioned = byPos.result.data as View;
    assert.deepEqual(
      (named.members ?? []).map((m) => m.name).sort(),
      (positioned.members ?? []).map((m) => m.name).sort(),
      'name+file and file+line+col resolve to the same alias',
    );
    // Oracle: that member set is what a cold checker reports for the alias.
    assert.deepEqual(
      (named.members ?? []).map((m) => m.name).sort(),
      coldMembers(p.root, 'src/span.ts', 'Span').map((m) => m.name),
      'resolved alias members equal the cold oracle',
    );
  } finally {
    await p.dispose();
  }
});

test('member cap is explicit, never silent', async () => {
  const wide = `export interface Wide { ${Array.from({ length: 8 }, (_, i) => `f${i}: number;`).join(' ')} }\n`;
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/w.ts': wide,
  });
  try {
    const r = await p.op('expand_type', { name: 'Wide', memberLimit: 3 });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as View;
    assert.equal((view.members ?? []).length, 3, 'only memberLimit members listed');
    assert.ok(
      (view.notes ?? []).some((n) => /… 5 more member\(s\) \(raise memberLimit\)/.test(n)),
      'the 5 hidden members are reported, never silently dropped',
    );
  } finally {
    await p.dispose();
  }
});
