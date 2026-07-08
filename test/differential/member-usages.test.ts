// `member_usages` (t-000175) — CORE oracle tests. The oracle is hand-curated (§16, never grep/
// golden-only): the enumerated positives — a property read `c.timeout`, a DESTRUCTURE `{timeout}=c`
// (which plain find_usages mislabels `write`), a string-literal element access `c['timeout']`, and the
// writes `c.timeout = …` / `+=` — must appear with the RIGHT disposition; the decoys (a same-named
// `.timeout` on an UNRELATED type, a bare local `timeout`, and a COMPUTED `c[k]` access) must NOT
// (identity-by-construction is the precision guarantee, computed access the honest floor). Inherited
// member resolution (via a subtype) and the missing-member honest fail are pinned too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';

type Site = {
  span: { file: string; line: number; col: number };
  kind: 'read' | 'write' | 'destructure';
  enclosing?: { name: string; kind: string };
  program?: string;
};
type MView = {
  member: { type: string; name: string; span: { file: string; line: number; col: number } };
  sites: Site[];
  dispositions: { read: number; write: number; destructure: number };
  total: number;
  complete: boolean;
  notes: string[];
};

const TYPES = `export interface Config {
  timeout: number;
  name: string;
}
export interface Other {
  timeout: number;
}

interface Base { id: number; }
export interface Derived extends Base { extra: string; }
`;

const USE = `import type { Config, Other, Derived } from './types';

export function readConfig(c: Config): number {
  const t = c.timeout;          // property read      (line 4)
  const { timeout } = c;        // DESTRUCTURE        (line 5)
  const v = c['timeout'];       // element access     (line 6)
  return t + timeout + v;
}

export function writeConfig(c: Config): void {
  c.timeout = 10;               // write              (line 11)
  c.timeout += 5;               // write              (line 12)
}

// DECOY (a): Other.timeout — same name, UNRELATED type. Must NOT match Config.timeout.
export function readOther(o: Other): number {
  return o.timeout;
}

// DECOY (b): a bare local named timeout — not a member access at all.
export function bareLocal(): number {
  const timeout = 99;
  return timeout;
}

// DECOY (c): a COMPUTED element access — the checker can't resolve k to one member; NOT traced.
export function computed(c: Config, k: 'timeout' | 'name'): number {
  return Number(c[k]);
}

// Inherited: Derived.id resolves to Base.id and its access here is found.
export function readInherited(d: Derived): number {
  return d.id;
}

// RENAMED destructure {timeout: t} — the ref lands on the property token, still a destructure.
export function renamedDestr(c: Config): number {
  const { timeout: t } = c;
  return t;
}
`;

function proj() {
  return project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/types.ts': TYPES,
    'src/use.ts': USE,
  });
}

function siteAt(v: MView, line: number): Site | undefined {
  return v.sites.find((s) => s.span.file === 'src/use.ts' && s.span.line === line);
}

test('finds member accesses (read/write/destructure/element) by IDENTITY, excludes same-named + local + computed decoys', async () => {
  const p = await proj();
  try {
    const r = await p.op('member_usages', { name: 'Config', member: 'timeout' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const v = r.result.data as MView;

    // The resolved member (proof of WHAT we scoped to).
    assert.equal(v.member.type, 'Config');
    assert.equal(v.member.name, 'timeout');
    assert.equal(v.member.span.file, 'src/types.ts');

    // Positive sites with the RIGHT disposition — the destructure is the correctness win over
    // find_usages, which labels `const {timeout}=c` a WRITE.
    assert.equal(siteAt(v, 4)?.kind, 'read', 'c.timeout property read');
    assert.equal(siteAt(v, 5)?.kind, 'destructure', '{timeout}=c is destructure, NOT write');
    assert.equal(siteAt(v, 6)?.kind, 'read', "c['timeout'] element access is a read");
    assert.equal(siteAt(v, 11)?.kind, 'write', 'c.timeout = 10 is a write');
    assert.equal(siteAt(v, 12)?.kind, 'write', 'c.timeout += 5 is a write');
    // A RENAMED destructure {timeout: t} still lands on the property token → destructure.
    assert.equal(
      v.sites.find((s) => s.enclosing?.name === 'renamedDestr')?.kind,
      'destructure',
      '{timeout: t}=c is destructure',
    );

    // Dispositions summarize exactly the six Config.timeout accesses.
    assert.deepEqual(v.dispositions, { read: 2, write: 2, destructure: 2 });
    assert.equal(v.total, 6, 'exactly the six Config.timeout accesses');

    // Decoys — none of the Other.timeout / bare-local / computed lines appear (identity + honest floor).
    const otherLine = 18; // readOther's `o.timeout`
    const localLine = 24; // bareLocal's `timeout` usage
    const computedLine = 29; // computed's `c[k]`
    for (const line of [otherLine, localLine, computedLine]) {
      assert.equal(siteAt(v, line), undefined, `decoy at line ${line} must NOT be reported`);
    }

    // The destructure floor is disclosed; computed access is a documented scope limit (catalogue),
    // not a per-result note — so `complete` stays true (no undiscovered program, no cap).
    assert.ok(
      v.notes.some((n) => /destructure/.test(n)),
      'destructure floor disclosed',
    );
    assert.equal(v.complete, true);

    assertSpansValid(p.root, r);
  } finally {
    await p.dispose();
  }
});

test('same-named member on an unrelated type is isolated (identity, not name-match)', async () => {
  const p = await proj();
  try {
    const r = await p.op('member_usages', { name: 'Other', member: 'timeout' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const v = r.result.data as MView;
    // ONLY readOther's o.timeout — never any Config.timeout access.
    assert.equal(v.total, 1);
    assert.equal(v.sites[0]?.enclosing?.name, 'readOther');
    assert.equal(v.dispositions.read, 1);
  } finally {
    await p.dispose();
  }
});

test('inherited member resolves through the subtype (getApparentType flatten)', async () => {
  const p = await proj();
  try {
    const r = await p.op('member_usages', { name: 'Derived', member: 'id', file: 'src/types.ts' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const v = r.result.data as MView;
    assert.equal(v.total, 1, "Base.id's access via Derived is found");
    assert.equal(v.sites[0]?.enclosing?.name, 'readInherited');
  } finally {
    await p.dispose();
  }
});

test('UNION target scans EVERY constituent declaration — no silent single-constituent miss (#1)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/u.ts': `export interface A { shared: number }
export interface B { shared: number }
export type AB = A | B;
export function useAB(x: AB): number { return x.shared; }
export function useAOnly(a: A): number { return a.shared; }
export function useBOnly(b: B): number { return b.shared; }
`,
  });
  try {
    const r = await p.op('member_usages', { name: 'AB', member: 'shared', file: 'src/u.ts' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const v = r.result.data as MView;
    // The B-only access (a DISTINCT symbol B.shared, not covered by A.shared's [0] declaration) must
    // appear — else the op lies `complete:true` over a single-constituent set.
    const enclosers = v.sites.map((s) => s.enclosing?.name).sort();
    assert.deepEqual(enclosers, ['useAB', 'useAOnly', 'useBOnly']);
    assert.equal(v.total, 3);
    assert.equal(v.complete, true);
  } finally {
    await p.dispose();
  }
});

test('ASSIGNMENT destructure ({x}=y) is destructure, not write (#2, shared core)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/a.ts': `export interface Cfg { timeout: number }
export function assigns(c: Cfg): number {
  let timeout = 0;
  ({ timeout } = c);
  return timeout;
}
`,
  });
  try {
    const r = await p.op('member_usages', { name: 'Cfg', member: 'timeout' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const v = r.result.data as MView;
    // `({timeout} = c)` reads c.timeout OUT into a local — a destructure, NOT a write of the member.
    assert.equal(v.dispositions.write, 0, 'never a write of the member');
    assert.equal(v.dispositions.destructure, 1);
    assert.ok(
      v.notes.some((n) => /destructure/.test(n)),
      'the downstream-invisible floor is disclosed',
    );
  } finally {
    await p.dispose();
  }
});

test('missing member fails honestly with a member-list hint', async () => {
  const p = await proj();
  try {
    const r = await p.op('member_usages', { name: 'Config', member: 'nope' });
    assert.ok('result' in r && !r.result.ok, JSON.stringify(r));
    const msg = JSON.stringify(r.result);
    assert.match(msg, /no member 'nope'/);
    assert.match(msg, /timeout/, 'the hint lists the real members');
  } finally {
    await p.dispose();
  }
});
