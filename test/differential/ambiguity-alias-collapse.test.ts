// Collapse-by-definition when the ANSWERING program cannot resolve the alias's module spec
// (t-000524). A loose-root monorepo's primary globs a member's files WITHOUT the member's `paths`,
// so `import { X } from '@/…'` resolves to nothing there and TS reports the import specifier as its
// OWN definition — every consumer's import binding then keyed as a separate "distinct declaration"
// and a barrel-heavy name failed as N-way ambiguous while naming ONE symbol. The member's own
// program resolves that spec, so an alias that resolved to itself is re-asked across the programs
// `resolutionPrograms` admits, and the definition is taken only when those that resolved it agree.
//
// The oracle is the fixture's CONSTRUCTION plus a cross-arm equality, never a second codemaster
// answer (§16): each fixture DECLARES how many real declarations of the name exist, and the
// unresolvable-spec arm must answer identically to its resolvable-spec twin — same symbol, same
// usages — because the two repos differ only in which config declares `paths`.
//
// The negatives carry the weight here, because every way of getting this wrong is a CONFIDENT wrong
// answer rather than a missing one. Each pins a distinct claim the collapse must not make:
//   NEG-1  two genuinely distinct declarations stay ambiguous — and the candidate list is exactly
//          those two, since a list naming aliases steers the agent to pin one (§3.4);
//   NEG-2  a spec NO program resolves stays distinct — two aliases we cannot resolve cannot be
//          PROVEN to name one symbol;
//   NEG-3  two programs resolving one spec differently collapse into neither — otherwise the answer
//          is an artifact of which program was asked first;
//   NEG-4  a config that merely GLOBS the file is not an authority on what its imports mean.
// The cold == warm arm pins the remaining way to be wrong: a verdict that depends on query history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const OPTS = '"strict":true,"module":"esnext","moduleResolution":"bundler"';
/** A member config that declares the `@/*` paths — the resolution the loose root lacks. */
const MEMBER = `{"compilerOptions":{${OPTS},"baseUrl":".","paths":{"@/*":["src/*"]}},"include":["src"]}`;

const DECL = 'export const useX = () => 1;\n';
const BARREL = 'export { useX } from "./hooks";\n';
/** Multi-line import — the shape a formatter produces in a barrel-heavy repo, and the one whose
 *  specifier navto returns as its own `alias` candidate. */
const consumer = (spec: string, n: number) =>
  `import {\n    useX,\n} from '${spec}';\nexport const c${n} = () => useX();\n`;

/** The loose-root monorepo: the root globs `apps/**` and declares NO `paths`; only the member does. */
const LOOSE_ROOT = {
  'tsconfig.json': `{"compilerOptions":{${OPTS}},"include":["apps"]}`,
  'apps/emr/package.json': '{"name":"emr"}',
  'apps/emr/tsconfig.json': MEMBER,
  'apps/emr/src/services/api/hooks.ts': DECL,
  'apps/emr/src/services/api/index.ts': BARREL,
  'apps/emr/src/a.ts': consumer('@/services/api', 1),
  'apps/emr/src/b.ts': consumer('@/services/api', 2),
  'apps/emr/src/c.ts': consumer('@/services/api', 3),
};

type Usage = { span: { file: string; line: number; col: number }; role: string };
type UsagesData = { definition?: { id?: string; span?: { file: string } }; usages?: Usage[] };

function okData(r: OpResult): UsagesData {
  assert.ok('result' in r && r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as UsagesData;
}
function failMessage(r: OpResult): string {
  assert.ok('result' in r && !r.result.ok, `expected a failure, got ${JSON.stringify(r)}`);
  return r.result.failure.message;
}
/** Usages as a comparable set, with the member prefix stripped so the two monorepo arms — whose
 *  files sit at the same paths — compare against the single-program arm's ground truth. */
const usageSet = (d: UsagesData, stripPrefix = ''): string[] =>
  (d.usages ?? [])
    .map((u) => `${u.span.file.replace(stripPrefix, '')}:${u.span.line}:${u.span.col}:${u.role}`)
    .sort();
const defFile = (d: UsagesData): string => d.definition?.span?.file ?? '<none>';

/** Hand-read from the fixture: one declaration, its barrel re-export, and per consumer an import
 *  specifier plus a call. Written here, never read back from a second codemaster answer (§16). */
const GROUND_TRUTH = [
  'services/api/hooks.ts:1:14:decl',
  'services/api/index.ts:1:10:reexport',
  'a.ts:2:5:import',
  'a.ts:4:25:call',
  'b.ts:2:5:import',
  'b.ts:4:25:call',
  'c.ts:2:5:import',
  'c.ts:4:25:call',
].sort();

test('ARM A (control, spec RESOLVES, one program): a barrel chain collapses to its one declaration', async () => {
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":{${OPTS}},"include":["src"]}`,
    'src/services/api/hooks.ts': DECL,
    'src/services/api/index.ts': BARREL,
    'src/a.ts': consumer('./services/api', 1),
    'src/b.ts': consumer('./services/api', 2),
    'src/c.ts': consumer('./services/api', 3),
  });
  try {
    const d = okData(await p.op('find_usages', { name: 'useX', collapseImports: false }));
    assert.equal(defFile(d), 'src/services/api/hooks.ts');
    assert.deepEqual(usageSet(d, 'src/'), GROUND_TRUTH);
  } finally {
    await p.dispose();
  }
});

test('ARM C (control, TWO programs but the spec RESOLVES): multi-program alone does not break the collapse', async () => {
  // The discriminator against "collapse compares identities minted by different programs": this
  // repo has the same two programs as ARM B and differs ONLY in the root also declaring `paths`.
  const p: TestProject = await project({
    ...LOOSE_ROOT,
    'tsconfig.json': `{"compilerOptions":{${OPTS},"baseUrl":"apps/emr","paths":{"@/*":["src/*"]}},"include":["apps"]}`,
  });
  try {
    const d = okData(await p.op('find_usages', { name: 'useX', collapseImports: false }));
    assert.equal(defFile(d), 'apps/emr/src/services/api/hooks.ts');
    assert.deepEqual(usageSet(d, 'apps/emr/src/'), GROUND_TRUTH);
  } finally {
    await p.dispose();
  }
});

test('ARM B (the bug): the spec resolves in NO answering program — the member program proves the collapse', async () => {
  const p: TestProject = await project(LOOSE_ROOT);
  try {
    const r = await p.op('find_usages', { name: 'useX', collapseImports: false });
    const d = okData(r); // was: FAIL "'useX' is ambiguous — 4 distinct declaration sites"
    assert.equal(defFile(d), 'apps/emr/src/services/api/hooks.ts');
    // Identical to its resolvable-spec twin (ARM C) and to the single-program ground truth: the
    // two repos differ only in which config declares `paths`, so the ANSWER must not differ.
    assert.deepEqual(usageSet(d, 'apps/emr/src/'), GROUND_TRUTH);

    // No floor over what is not an ambiguity: the resolution is complete, so dressing it as
    // doubtful would be the §3.6 lie inverted. (A repo with UNDISCOVERED nested configs still
    // discloses — a different cause, with its own remedy.)
    assert.ok('result' in r && r.result.ok);
    assert.equal(r.result.disclosures, undefined, JSON.stringify(r.result.disclosures));
  } finally {
    await p.dispose();
  }
});

/** The same repo with the member's `package.json` REMOVED: its tsconfig is then reachable by none of
 *  the discovery sources (not adjacent to the primary, not in `references`, no package anchor), so it
 *  is UNDISCOVERED — absent from the built set, and loadable only by a read-path file-driven load. */
const UNDISCOVERED_MEMBER = (() => {
  const { 'apps/emr/package.json': _dropped, ...rest } = LOOSE_ROOT;
  return rest;
})();

test('cold == warm: a file-driven program loaded by an EARLIER query cannot change this verdict', async () => {
  // §16 invariant 3, and the reason the selection reads the BUILT set rather than every loaded
  // program. Here the member config is UNDISCOVERED, so it enters the process only via a read-path
  // `ensureProgramFor` — i.e. only in the warm run. Were it allowed to prove the collapse, this repo
  // would answer "ambiguous" cold and "resolved" warm: a verdict depending on query history, on a
  // chokepoint that also gates mutations. So BOTH runs must refuse identically — the honest
  // "cannot prove it" — and the warm run must not be the luckier one.
  const cold: TestProject = await project(UNDISCOVERED_MEMBER);
  const warm: TestProject = await project(UNDISCOVERED_MEMBER);
  try {
    // The two fixtures sit at different temp roots, and a SymbolId carries a per-root tag — strip it
    // so the comparison is about the VERDICT, not about where the fixture was mounted.
    const verdict = (m: string) => m.replace(/~[0-9a-f]{8}/g, '');
    const coldMessage = failMessage(await cold.op('find_usages', { name: 'useX' }));
    // A query PINNED to a file under the member: this is what file-driven-loads its nearest config.
    await warm.op('find_usages', { file: 'apps/emr/src/a.ts', line: 4, col: 25 });
    const warmMessage = failMessage(await warm.op('find_usages', { name: 'useX' }));
    assert.match(coldMessage, /is ambiguous/, coldMessage);
    assert.equal(
      verdict(warmMessage),
      verdict(coldMessage),
      'warm must reach the identical verdict',
    );
  } finally {
    await cold.dispose();
    await warm.dispose();
  }
});

test('a self-answering program alongside a resolving one does not veto the collapse (order cannot decide)', async () => {
  // A THIRD program that also globs the consumer but declares no `paths`: it answers the specifier
  // with ITSELF, exactly as the primary does. Such a non-answer must be skipped, not counted as an
  // opinion — counting it would make the outcome depend on which program `built()` yields first
  // (self first → it becomes the standing answer → the member's real one then "disagrees" → the
  // collapse is lost), which is precisely the iteration-order artifact unanimity exists to exclude.
  const p: TestProject = await project({
    ...LOOSE_ROOT,
    'tsconfig.build.json': `{"compilerOptions":{${OPTS}},"include":["apps"]}`,
  });
  try {
    const d = okData(await p.op('find_usages', { name: 'useX', collapseImports: false }));
    assert.equal(defFile(d), 'apps/emr/src/services/api/hooks.ts');
    assert.deepEqual(usageSet(d, 'apps/emr/src/'), GROUND_TRUTH);
  } finally {
    await p.dispose();
  }
});

test('NEG-4 (anti-lie): a FOREIGN config that merely globs the file is not the authority on its imports', async () => {
  // The file's own nearest tsconfig is undiscovered, and an adjacent root-level config globs the
  // file while mapping `@/*` to a DIFFERENT tree that declares its own `useX`. Its resolution is a
  // real TypeScript answer — but not the one this file is written against, so collapsing on it would
  // answer confidently about the WRONG symbol. Absent the file's own authority the answer must stay
  // "cannot say": ambiguous, with the foreign declaration never presented as this alias's target.
  const p: TestProject = await project({
    ...UNDISCOVERED_MEMBER,
    'tsconfig.alt.json': `{"compilerOptions":{${OPTS},"baseUrl":".","paths":{"@/*":["apps/other/src/*"]}},"include":["apps"]}`,
    'apps/other/src/services/api/hooks.ts': 'export const useX = () => 99;\n',
    'apps/other/src/services/api/index.ts': BARREL,
  });
  try {
    const message = failMessage(await p.op('find_usages', { name: 'useX' }));
    // Five candidates: the two real declarations, and each consumer's alias still standing on its
    // own. Were the foreign config allowed to answer, the three aliases would collapse INTO its
    // declaration and this would read `2 of 2` — a confident merge of these imports into a module
    // they never name. The count is the assertion precisely because the merge is invisible otherwise.
    assert.match(message, /is ambiguous — shown 5 of 5 distinct declaration sites/, message);
    for (const alias of [
      'apps/emr/src/a.ts:2:5',
      'apps/emr/src/b.ts:2:5',
      'apps/emr/src/c.ts:2:5',
    ]) {
      assert.ok(
        message.includes(alias),
        `alias ${alias} must remain its own candidate: ${message}`,
      );
    }
  } finally {
    await p.dispose();
  }
});

test('NEG-1 (anti-lie): two REAL same-named declarations stay ambiguous — and the candidates are exactly those two', async () => {
  // The fixture DECLARES two independent `useX`s, one per member, each reached through its own
  // barrel by its own consumer. Collapsing them would be a lie about identity; listing the two
  // alias bindings beside them would steer the agent to pin an alias (§3.4).
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":{${OPTS}},"include":["apps"]}`,
    'apps/emr/package.json': '{"name":"emr"}',
    'apps/emr/tsconfig.json': MEMBER,
    'apps/emr/src/api/hooks.ts': DECL,
    'apps/emr/src/api/index.ts': BARREL,
    'apps/emr/src/a.ts': consumer('@/api', 1),
    'apps/adm/package.json': '{"name":"adm"}',
    'apps/adm/tsconfig.json': MEMBER,
    'apps/adm/src/api/hooks.ts': 'export const useX = () => 2;\n',
    'apps/adm/src/api/index.ts': BARREL,
    'apps/adm/src/a.ts': consumer('@/api', 2),
  });
  try {
    const message = failMessage(await p.op('find_usages', { name: 'useX' }));
    assert.match(message, /is ambiguous — shown 2 of 2 distinct declaration sites/, message);
    for (const decl of ['apps/emr/src/api/hooks.ts:1:14', 'apps/adm/src/api/hooks.ts:1:14']) {
      assert.ok(message.includes(decl), `candidate list must offer ${decl}: ${message}`);
    }
    // Every alias binding collapsed into the declaration it names — none is offered as a pick.
    for (const alias of ['apps/emr/src/a.ts:2:5', 'apps/adm/src/a.ts:2:5']) {
      assert.ok(!message.includes(alias), `alias ${alias} must not be a candidate: ${message}`);
    }
  } finally {
    await p.dispose();
  }
});

test('NEG-3 (anti-lie): two programs resolving one spec DIFFERENTLY collapse the alias into neither', async () => {
  // `apps/emr` carries two configs (both package-anchored, both discovered) that map `@/*` to
  // DIFFERENT trees, each holding its own `useX`. So the file's own project gives two answers for
  // one specifier. Taking whichever program we asked first would merge the alias into a declaration
  // it may not name AND make the answer an artifact of iteration order; unanimity is required, so
  // the alias stays a distinct candidate beside both real declarations (3, not 2).
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":{${OPTS}},"include":["apps"]}`,
    'apps/emr/package.json': '{"name":"emr"}',
    'apps/emr/tsconfig.json': MEMBER,
    'apps/emr/tsconfig.alt.json': `{"compilerOptions":{${OPTS},"baseUrl":".","paths":{"@/*":["../adm/src/*"]}},"include":["src"]}`,
    'apps/emr/src/api/hooks.ts': DECL,
    'apps/emr/src/api/index.ts': BARREL,
    'apps/emr/src/a.ts': consumer('@/api', 1),
    'apps/adm/package.json': '{"name":"adm"}',
    'apps/adm/tsconfig.json': `{"compilerOptions":{${OPTS}},"include":["src"]}`,
    'apps/adm/src/api/hooks.ts': 'export const useX = () => 2;\n',
    'apps/adm/src/api/index.ts': BARREL,
  });
  try {
    const message = failMessage(await p.op('find_usages', { name: 'useX' }));
    assert.match(message, /is ambiguous — shown 3 of 3 distinct declaration sites/, message);
    assert.ok(message.includes('apps/emr/src/a.ts:2:5'), `the alias stays pickable: ${message}`);
  } finally {
    await p.dispose();
  }
});

test('NEG-2 (anti-lie): an alias NO program can resolve stays a distinct candidate', async () => {
  // Nothing resolves `nowhere/api`, so the binding cannot be PROVEN to name the local `useX`.
  // Collapsing it would claim an identity we never established (§3) — the answer stays ambiguous
  // and offers both, which is the honest pick-list.
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":{${OPTS}},"include":["src"]}`,
    'src/hooks.ts': DECL,
    'src/a.ts':
      "// @ts-nocheck\nimport {\n    useX,\n} from 'nowhere/api';\nexport const c1 = () => useX();\n",
  });
  try {
    const message = failMessage(await p.op('find_usages', { name: 'useX' }));
    assert.match(message, /is ambiguous — shown 2 of 2 distinct declaration sites/, message);
    assert.ok(message.includes('src/hooks.ts:1:14'), message);
    assert.ok(message.includes('src/a.ts:3:5'), message);
  } finally {
    await p.dispose();
  }
});
