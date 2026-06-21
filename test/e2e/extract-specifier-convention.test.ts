// Specifier-convention oracle for the LS-driven relocations (dogfood fix: extract via "Move to
// file"). When the repo imports through a tsconfig-`paths` alias (`@/…`), the importers the refactor
// rewrites — the consumer's import, the source's relink, and the new file's own dep imports — must
// keep the ALIAS form (and extension policy) the file already uses, NOT collapse to a relative
// `./…`/`../…` (which forced the agent to hand-fix every touched file). The fix passes no preference
// and reforms nothing: the LS "Move to file" action mirrors each file's own convention natively.
//
// Oracle: an independent cold ts.Program compile of the APPLIED tree (the alias/relative specifier
// must actually resolve), paired with a FORM assertion on the written files. CONTROL: a relative-
// convention repo must STAY relative — the fix mirrors convention, never forces alias. REGRESSION:
// move_symbol (already alias-correct) must remain so. This test fails on the legacy "Move to a new
// file" action (which emitted `./…` importers regardless of the repo's alias convention).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics as coldTscErrors } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project, type TestProject } from '../helpers/project.ts';

const ALIAS =
  '{"compilerOptions":{"strict":true,"module":"preserve","jsx":"preserve","paths":{"@/*":["./src/*"]}}}';
const REL = '{"compilerOptions":{"strict":true,"module":"preserve","jsx":"preserve"}}';

async function applyOk(p: TestProject, name: string, args: JsonValue): Promise<void> {
  const [r] = await p.request([{ name, args, apply: true }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  const data = r.result.data as unknown as { applied?: boolean; typecheck: { clean: boolean } };
  assert.equal(data.applied, true, `expected applied, got ${JSON.stringify(data)}`);
  assert.equal(data.typecheck.clean, true, 'post-edit typecheck must be clean');
}

const read = (p: TestProject, rel: string): string => readFileSync(path.join(p.root, rel), 'utf8');

test('extract_symbol: an @/-alias repo keeps @/… on every rewritten importer (+ correct dir)', async () => {
  const p = await project({
    'tsconfig.json': ALIAS,
    'src/scss.d.ts':
      "declare module '*.module.scss' { const s: { [k: string]: string }; export default s; }\n",
    'src/jsx.d.ts':
      'declare namespace JSX { interface Element {} interface IntrinsicElements { [e: string]: unknown } }\n',
    'src/util/dep.ts': 'export const dep = 1;\n',
    'src/feature/Panel.module.scss': '.card { color: red; }\n',
    'src/feature/source.tsx':
      "import { dep } from '@/util/dep';\n" +
      "import s from './Panel.module.scss';\n" +
      'export const Card = (): JSX.Element => <div className={s.card}>{dep}</div>;\n' +
      'export const Other = (): JSX.Element => <Card />;\n',
    'src/feature/consumer.tsx':
      "import { Card } from '@/feature/source';\nexport const Use = (): JSX.Element => <Card />;\n",
  });
  try {
    await applyOk(p, 'extract_symbol', {
      name: 'Card',
      file: 'src/feature/source.tsx',
      dest: 'src/widgets/Card.tsx',
    });

    // Consumer: the rewritten import keeps the @/ alias (not `./` / `../`).
    const consumer = read(p, 'src/feature/consumer.tsx');
    assert.match(consumer, /from '@\/widgets\/Card'/, 'consumer import must stay aliased');
    assert.doesNotMatch(consumer, /from '\.\.?\/.*Card'/, 'consumer must NOT collapse to relative');

    // Source relink: the back-import of the moved symbol keeps the alias too.
    const source = read(p, 'src/feature/source.tsx');
    assert.match(
      source,
      /import \{ Card \} from '@\/widgets\/Card'/,
      'source relink must stay aliased',
    );

    // New file: a TS dep keeps the alias; an AMBIENT (.scss) import — which the LS copies verbatim —
    // is rebased for the source→dest directory shift (relative is its original form here).
    const moved = read(p, 'src/widgets/Card.tsx');
    assert.match(moved, /from '@\/util\/dep'/, 'new-file TS dep keeps alias');
    assert.match(
      moved,
      /from '\.\.\/feature\/Panel\.module\.scss'/,
      'ambient import rebased to dest dir',
    );
    assert.doesNotMatch(
      moved,
      /from '\.\/Panel\.module\.scss'/,
      'verbatim ambient path must be rebased',
    );

    // Independent oracle: the applied tree compiles cold (every specifier actually resolves).
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('extract_symbol CONTROL: a relative-convention repo STAYS relative (no forced @/)', async () => {
  const p = await project({
    'tsconfig.json': REL,
    'src/util/dep.ts': 'export const dep = 1;\n',
    'src/feature/source.ts':
      "import { dep } from '../util/dep';\nexport const moved = (): number => dep + 1;\nexport const other = (): number => moved();\n",
    'src/feature/consumer.ts':
      "import { moved } from './source';\nexport const useIt = (): number => moved();\n",
  });
  try {
    await applyOk(p, 'extract_symbol', {
      name: 'moved',
      file: 'src/feature/source.ts',
      dest: 'src/widgets/moved.ts',
    });
    const consumer = read(p, 'src/feature/consumer.ts');
    const source = read(p, 'src/feature/source.ts');
    const moved = read(p, 'src/widgets/moved.ts');
    assert.match(consumer, /from '\.\.\/widgets\/moved'/, 'relative repo: consumer stays relative');
    assert.match(
      source,
      /from '\.\.\/widgets\/moved'/,
      'relative repo: source relink stays relative',
    );
    assert.match(moved, /from '\.\.\/util\/dep'/, 'relative repo: new-file dep stays relative');
    assert.doesNotMatch([consumer, source, moved].join('\n'), /@\//, 'must NOT force an alias');
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('move_symbol REGRESSION: an @/-alias repo stays aliased', async () => {
  const p = await project({
    'tsconfig.json': ALIAS,
    'src/util/dep.ts': 'export const dep = 1;\n',
    'src/feature/source.ts':
      "import { dep } from '@/util/dep';\nexport const moved = (): number => dep + 1;\nexport const other = (): number => moved();\n",
    'src/feature/consumer.ts':
      "import { moved } from '@/feature/source';\nexport const useIt = (): number => moved();\n",
    'src/other/dest.ts': 'export const here = (): number => 2;\n',
  });
  try {
    await applyOk(p, 'move_symbol', {
      name: 'moved',
      file: 'src/feature/source.ts',
      dest: 'src/other/dest.ts',
    });
    const consumer = read(p, 'src/feature/consumer.ts');
    const dest = read(p, 'src/other/dest.ts');
    assert.match(consumer, /from '@\/other\/dest'/, 'move_symbol: consumer stays aliased');
    assert.match(dest, /from '@\/util\/dep'/, 'move_symbol: dep added to dest stays aliased');
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});
