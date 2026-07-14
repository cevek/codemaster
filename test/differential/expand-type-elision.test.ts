// t-481241: the per-string length cap on a rendered signature / member-type must be
// verbosity-aware and carry a §3.4 recovery marker. Oracle = a fresh-from-cold `ts.Program`
// (§16): the cold checker's NoTruncation signature/type IS the complete text `verbosity:full`
// must reproduce, and the exact prefix + full length the default-verbosity marker must report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { coldMembers, coldSignatures } from '../helpers/cold-ls.ts';

type View = { about?: string; signatures?: string[]; members?: { name: string; type: string }[] };

// A top-level function whose param types are large ANONYMOUS object literals — `signatureToString`
// inlines them structurally (as it does for the amiro handler that started the report), so the
// rendered signature is comfortably over the 200-char default cap.
const BIG_SIG = `export function createThing(
  input: {
    data: { resourceType?: 'PATIENT'; operation?: 'OPERATE'; resourceUuid?: string; ttlHours?: number; reason?: string };
    extras?: { headers?: string; signal?: boolean; retries?: number };
  },
  ctx: { userId: string; tenant: string },
): Promise<{ ok: boolean; id: string }> {
  return Promise.resolve({ ok: true, id: '' });
}
`;

// A member whose type is a wide string-literal union — over 200 chars, non-optional (nothing to
// strip), so `typeStr` elides it at the default cap and lifts at full.
const WIDE_MEMBER = `export interface Wide {
  flag: ${Array.from({ length: 20 }, (_, i) => `'option_${i}_xxxxxxxx'`).join(' | ')};
}
`;

const MARKER =
  /… \(signature elided: (\d+) chars — verbosity:full, or expand_type the param type\)$/;
const TYPE_MARKER = /… \(type elided: (\d+) chars — verbosity:full\)$/;

test('signature elision is verbosity-aware: default cuts with a §3.4 marker, full is complete (oracle=cold)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/h.ts': BIG_SIG,
  });
  try {
    // Oracle: the complete, NoTruncation signature a fresh cold checker produces.
    const cold = coldSignatures(p.root, 'src/h.ts', 'createThing');
    assert.equal(cold.length, 1);
    const full = cold[0] ?? '';
    assert.ok(
      full.length > 200,
      `precondition: the signature exceeds the 200 cap (was ${full.length})`,
    );

    // Default verbosity: elided at 200 with an explicit marker reporting the FULL length + recovery.
    const normal = await p.op('expand_type', { name: 'createThing' });
    assert.ok('result' in normal && normal.result.ok, JSON.stringify(normal));
    const sig = (normal.result.data as View).signatures?.[0] ?? '';
    const m = MARKER.exec(sig);
    assert.ok(m !== null, `default signature must carry the elision marker (was: ${sig})`);
    assert.equal(Number(m[1]), full.length, 'marker reports the true full length (§3.4 total)');
    assert.equal(
      sig.slice(0, 200),
      full.slice(0, 200),
      'the shown prefix is the cold signature verbatim up to the cap',
    );

    // verbosity:full lifts the cap: the complete signature, byte-for-byte the cold oracle, no marker.
    const [fullR] = await p.request([
      { name: 'expand_type', args: { name: 'createThing' }, verbosity: 'full' },
    ]);
    assert.ok(fullR !== undefined && 'result' in fullR && fullR.result.ok, JSON.stringify(fullR));
    const fullSig = (fullR.result.data as View).signatures?.[0] ?? '';
    assert.equal(fullSig, full, 'verbosity:full reproduces the complete cold signature');
    assert.ok(!MARKER.test(fullSig), 'no elision marker at verbosity:full');
  } finally {
    await p.dispose();
  }
});

test('member-type elision is verbosity-aware: default cuts with a `type elided` marker, full is complete (oracle=cold)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/w.ts': WIDE_MEMBER,
  });
  try {
    // Oracle: the complete member type a cold checker reports.
    const cold = coldMembers(p.root, 'src/w.ts', 'Wide').find((m) => m.name === 'flag');
    assert.ok(cold !== undefined);
    assert.ok(
      cold.type.length > 200,
      `precondition: the member type exceeds 200 (was ${cold.type.length})`,
    );

    const normal = await p.op('expand_type', { name: 'Wide' });
    assert.ok('result' in normal && normal.result.ok, JSON.stringify(normal));
    const t = (normal.result.data as View).members?.find((mm) => mm.name === 'flag')?.type ?? '';
    const m = TYPE_MARKER.exec(t);
    assert.ok(m !== null, `default member type must carry the type-elided marker (was: ${t})`);
    assert.equal(Number(m[1]), cold.type.length, 'marker reports the true full length');
    assert.equal(
      t.slice(0, 200),
      cold.type.slice(0, 200),
      'shown prefix is the cold type verbatim',
    );

    const [fullR] = await p.request([
      { name: 'expand_type', args: { name: 'Wide' }, verbosity: 'full' },
    ]);
    assert.ok(fullR !== undefined && 'result' in fullR && fullR.result.ok, JSON.stringify(fullR));
    const fullT = (fullR.result.data as View).members?.find((mm) => mm.name === 'flag')?.type ?? '';
    assert.equal(fullT, cold.type, 'verbosity:full reproduces the complete cold member type');
    assert.ok(!TYPE_MARKER.test(fullT), 'no elision marker at verbosity:full');
  } finally {
    await p.dispose();
  }
});
