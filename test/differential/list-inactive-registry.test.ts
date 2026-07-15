// §3.6 silent-miss honesty for `list {registry}` (t-857923): a bare `found=false / available(0)` at
// a root where NO registry-owning plugin is active reads as "this repo has no components" — but the
// registry's owning framework plugin (autodetected off the ROOT package.json) may be active ONLY in
// an UNINDEXED nested package. `list` must disclose that, plugin-neutrally, and suggest `root:<dir>`.
//
// Oracle (§16): an INDEPENDENT engine rooted at the nested package (react active over ITS own
// program — a program the root engine never loaded) returns the components. So the root's bare
// found=false, without disclosure, is a §3.6 silent miss. Never grep, never golden-only.
//
// The never-lie core is the NEGATIVE assertions: react ACTIVE-but-empty (found:true, no note) and a
// clean single-repo with no nested config (found:false, byte-identical bare answer, no false hint).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

// Root: NO react dependency → the react plugin is INACTIVE here. A nested `web/` package DOES depend
// on react and holds a component — a tsconfig codemaster never loads as a program from the root.
const NESTED_REACT_PKG = {
  'package.json': '{"name":"root","dependencies":{}}',
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
  'src/core.ts': 'export const helper = 1;\n',
  'web/package.json': '{"name":"web","dependencies":{"react":"^18.0.0"}}',
  'web/tsconfig.json':
    '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"esnext","moduleResolution":"bundler"},"include":["."]}',
  'web/Card.tsx': 'export const Card = () => <div/>;\n',
};

// React ACTIVE at root (react dep present) but ZERO components in src — a GENUINELY empty registry.
const REACT_ON_EMPTY = {
  'package.json': '{"name":"root","dependencies":{"react":"^18.0.0"}}',
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
  'src/core.ts': 'export const helper = 1;\n',
};

// No owning plugin AND no nested config — the clean single-repo. A bare found=false is HONEST here.
const NO_OWNER_NO_NESTED = {
  'package.json': '{"name":"root","dependencies":{}}',
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
  'src/core.ts': 'export const helper = 1;\n',
};

interface ListData {
  found?: boolean;
  available?: string[];
  note?: string;
  entries?: { key?: string; name?: string }[];
}
function listData(r: OpResult): ListData {
  const res = (r as { result: { ok: boolean; data: ListData } }).result;
  assert.equal(res.ok, true, 'list returns ok');
  return res.data;
}

test('list silent-miss (t-857923): found=false/available(0) at a root where the owning plugin is inactive discloses the unindexed nested package + a root:<dir> remedy', async () => {
  const p = await project(NESTED_REACT_PKG);
  try {
    // Independent oracle: a SEPARATE engine rooted at web/ (react active over its OWN program — never
    // loaded by the root engine) DOES list the component. So components genuinely exist in an
    // unindexed program → the root's bare found=false is a §3.6 silent miss.
    const webRoot = path.join(p.root, 'web');
    const [webRes] = await p.request([
      { name: 'list', args: { registry: 'components' }, root: webRoot },
    ]);
    const web = listData(webRes as OpResult);
    assert.equal(web.found, true, 'ground truth: react IS active at the nested root');
    assert.ok(
      (web.entries ?? []).some((e) => (e.name ?? e.key) === 'Card'),
      'ground truth: the component IS detected in the nested package',
    );

    // The behaviour under test: at the ROOT, the same query finds no owner — and must NOT read as
    // "no components", but disclose the unindexed nested package.
    const root = listData(await p.op('list', { registry: 'components' }));
    assert.equal(root.found, false, 'no owning plugin active at the root');
    assert.deepEqual(root.available, [], 'available(0): react produced no registry here');
    assert.match(
      root.note ?? '',
      /no plugin owning registry 'components' is active/,
      'plugin-not-active disclosure',
    );
    assert.match(root.note ?? '', /web\/tsconfig\.json/, 'names the unindexed nested config');
    assert.match(root.note ?? '', /root:<web>/, 'suggests the actionable root:<dir> remedy');
  } finally {
    await p.dispose();
  }
});

test('list disclosure is PLUGIN-NEUTRAL: keyed on the requested registry (routes/queries/…), not hard-coded to react', async () => {
  const p = await project(NESTED_REACT_PKG);
  try {
    const d = listData(await p.op('list', { registry: 'routes' }));
    assert.equal(d.found, false);
    assert.match(
      d.note ?? '',
      /registry 'routes' is active/,
      "the disclosure names 'routes', not 'components'",
    );
    assert.match(d.note ?? '', /root:<web>/, 'still suggests the nested root');
  } finally {
    await p.dispose();
  }
});

test('list NEGATIVE: react ACTIVE but zero components → found=TRUE (genuinely empty), no nested disclosure', async () => {
  const p = await project(REACT_ON_EMPTY);
  try {
    const d = listData(await p.op('list', { registry: 'components' }));
    assert.equal(d.found, true, 'the registry EXISTS (react active) — an empty result is genuine');
    assert.deepEqual(d.entries ?? [], [], 'zero components');
    // found=true may carry the registry's OWN note (react's detection caveat) — that is legitimate;
    // what must NOT fire is the inactive-plugin silent-miss disclosure (this is a real empty).
    assert.doesNotMatch(
      d.note ?? '',
      /no plugin owning registry .* is active/,
      'no silent-miss disclosure — this is a real empty, not an inactive plugin',
    );
  } finally {
    await p.dispose();
  }
});

test('list NEGATIVE: no owning plugin AND no nested config → bare found=false is byte-identical (no false hint)', async () => {
  const p = await project(NO_OWNER_NO_NESTED);
  try {
    const d = listData(await p.op('list', { registry: 'components' }));
    assert.equal(d.found, false);
    assert.deepEqual(d.available, [], 'available(0)');
    assert.equal(
      d.note,
      undefined,
      'nothing unindexed → no disclosure, the answer is byte-identical to pre-fix',
    );
  } finally {
    await p.dispose();
  }
});
