// §text-overlay: `find_usages text:true` joins semantic refs with textual occurrences,
// deduped, the textual half flagged `unresolved`. Oracles: an INDEPENDENT naive scanner
// written here (line-split + \b regex — a different algorithm than the impl) for
// completeness; span-overlap for the anti-join; assertSpansValid against the raw files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { project, assertSpansValid } from '../helpers/project.ts';
import { fail } from '../../src/common/result/construct.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
type SpanLike = { file: string; line: number; col: number; endLine: number; endCol: number };
type Usage = { span: SpanLike; role: string };
type TextOnly = { span: SpanLike; confidence: string };
type View = { usages?: Usage[]; textOnly?: TextOnly[]; textTotal?: number };

const FILES = {
  'tsconfig.json': TSCONFIG,
  'src/widget.ts': 'export const widget = (n: number) => n + 1;\n',
  'src/use.ts': [
    "import { widget } from './widget.ts';",
    '/** widget helper — see widget for details */',
    'export const a = widget(1); // widget call site',
    "export const s = 'a widget in a string';",
    '',
  ].join('\n'),
  'README.md': '# widget usage\n\nThe widget is great. Use widget everywhere.\n',
};

/** Independent oracle: every word-boundary occurrence of `name` across the fixture, by a
 *  line-split scan (a different algorithm than the impl's whole-file regex). */
function naiveOccurrences(root: string, name: string): SpanLike[] {
  const out: SpanLike[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const lines = readFileSync(abs, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const re = new RegExp(`\\b${name}\\b`, 'g');
        for (let m = re.exec(line); m !== null; m = re.exec(line)) {
          out.push({
            file: rel,
            line: i + 1,
            col: m.index + 1,
            endLine: i + 1,
            endCol: m.index + 1 + name.length,
          });
        }
      });
    }
  };
  walk(root);
  return out;
}

function overlaps(a: SpanLike, b: SpanLike): boolean {
  if (a.file !== b.file || a.line !== b.line) return false;
  return a.col < b.endCol && b.col < a.endCol;
}

test('completeness: every occurrence is covered by a semantic ref or present in textOnly', async () => {
  const p = await project(FILES);
  try {
    // collapseImports:false so the semantic `usages` holds EVERY ref (the dedup set is the
    // full ref set; with collapse off the displayed set equals it — clean oracle base).
    const r = await p.op('find_usages', { name: 'widget', text: true, collapseImports: false });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as View;
    const semantic = (view.usages ?? []).map((u) => u.span);
    const textOnly = (view.textOnly ?? []).map((t) => t.span);

    for (const occ of naiveOccurrences(p.root, 'widget')) {
      const coveredSemantic = semantic.some((s) => overlaps(occ, s));
      const inTextOnly = textOnly.some((t) => overlaps(occ, t));
      assert.ok(
        coveredSemantic || inTextOnly,
        `occurrence ${occ.file}:${occ.line}:${occ.col} is neither semantic nor text-only`,
      );
    }

    // Anti-join: a text-only hit never overlaps a semantic ref.
    for (const t of textOnly) {
      assert.ok(!semantic.some((s) => overlaps(t, s)), 'textOnly ∩ semantic must be ∅');
    }

    // The comment/jsdoc/string/markdown mentions land in textOnly, unresolved.
    assert.ok((view.textOnly ?? []).every((t) => t.confidence === 'unresolved'));
    const textFiles = new Set((view.textOnly ?? []).map((t) => t.span.file));
    assert.ok(textFiles.has('README.md'), 'markdown mention is a text-only hit');
    assert.ok(textFiles.has('src/use.ts'), 'comment/jsdoc/string mentions are text-only hits');

    assertSpansValid(p.root, r); // §16 invariant 1, against the raw files
  } finally {
    await p.dispose();
  }
});

test('a text-only hit and a semantic ref on the SAME line are deduped, not double-counted', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/m.ts': 'export const thing = 1;\nexport const u = thing; /* thing again here */\n',
  });
  try {
    const r = await p.op('find_usages', { name: 'thing', text: true, collapseImports: false });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as View;
    const semantic = (view.usages ?? []).map((u) => u.span);
    const textOnly = (view.textOnly ?? []).map((t) => t.span);
    // Line 2 holds both the semantic read `thing` AND the comment `thing` — the read is
    // covered, the comment is text-only, and they don't overlap.
    assert.ok(
      semantic.some((s) => s.line === 2),
      'the read on line 2 is semantic',
    );
    assert.ok(
      textOnly.some((t) => t.line === 2),
      'the comment on line 2 is text-only',
    );
    for (const t of textOnly) {
      assert.ok(!semantic.some((s) => overlaps(t, s)), 'no overlap between the two on line 2');
    }
  } finally {
    await p.dispose();
  }
});

test('text-scan failure → semantic result returns partial, daemon stays up', async () => {
  const p = await project(FILES, {
    createTextScanner: () => ({
      scan: () => fail({ tool: 'fs', message: 'injected scan failure' }),
    }),
  });
  try {
    const r = await p.op('find_usages', { name: 'widget', text: true });
    assert.ok('result' in r && !r.result.ok, 'a failed scan makes the result partial/failure');
    assert.equal(r.result.failure.tool, 'fs');
    // The semantic half still came back (partial recovery), never a whole-call blank.
    assert.ok(r.result.data !== undefined, 'semantic data survives a text-scan failure');
    const view = r.result.data as View;
    assert.ok((view.usages ?? []).length >= 1, 'semantic refs present despite text failure');
  } finally {
    await p.dispose();
  }
});

test('sql: text rows appear only under text:true, with provenance and NULL role', async () => {
  const p = await project(FILES);
  try {
    const withText = await p.request(
      [{ name: 'find_usages', as: 't', args: { name: 'widget', text: true } }],
      {
        sql: 'SELECT provenance, role FROM t',
      },
    );
    const sql = withText[0] as OpResult;
    assert.ok('result' in sql && sql.result.ok);
    const rows = (sql.result.data as { rows: [string, string | null][] }).rows;
    const text = rows.filter((r) => r[0] === 'text');
    assert.ok(text.length > 0, 'text rows present under text:true');
    assert.ok(
      text.every((r) => r[1] === null),
      'text rows carry NULL role (not our domain)',
    );
    assert.ok(
      rows.some((r) => r[0] === 'semantic' && r[1] !== null),
      'semantic rows keep their role',
    );

    // Same query WITHOUT text:true must not grow text rows under the agent's feet.
    const noText = await p.request([{ name: 'find_usages', as: 't', args: { name: 'widget' } }], {
      sql: "SELECT count(*) AS n FROM t WHERE provenance = 'text'",
    });
    const sql2 = noText[0] as OpResult;
    assert.ok('result' in sql2 && sql2.result.ok);
    assert.equal(
      (sql2.result.data as { rows: number[][] }).rows[0]?.[0],
      0,
      'no text rows without text:true',
    );
  } finally {
    await p.dispose();
  }
});

test('an aliased import usage is found semantically, never as a text-only hit', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/x.ts': 'export const foo = 1;\n',
    'src/use.ts': "import { foo as bar } from './x.ts';\nexport const a = bar;\n",
  });
  try {
    const r = await p.op('find_usages', { name: 'foo', text: true, collapseImports: false });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as View;
    // The aliased read `bar` is a SEMANTIC ref of foo (grep for "foo" would miss it).
    assert.ok(
      (view.usages ?? []).some((u) => u.span.file === 'src/use.ts' && u.role === 'read'),
      'aliased read is semantic',
    );
    // The import-site "foo" text occurrence is deduped (it IS a semantic ref) → not text-only.
    assert.ok(
      !(view.textOnly ?? []).some((t) => t.span.file === 'src/use.ts'),
      'no text-only hit at the aliased import — the textual "foo" there is a semantic ref',
    );
  } finally {
    await p.dispose();
  }
});

test('a same-named UNRELATED symbol lands in textOnly, never the semantic section', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': 'export const dup = 1;\nexport const x = dup;\n',
    'src/b.ts': 'const dup = 99;\nexport const y = dup;\n',
  });
  try {
    // Target a.ts's `dup` unambiguously by position; b.ts's `dup` is a different symbol.
    const r = await p.op('find_usages', { file: 'src/a.ts', line: 1, col: 14, text: true });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as View;
    assert.ok(
      !(view.usages ?? []).some((u) => u.span.file === 'src/b.ts'),
      "b.ts's dup is NOT a semantic ref of a.ts's dup",
    );
    assert.ok(
      (view.textOnly ?? []).some((t) => t.span.file === 'src/b.ts'),
      "b.ts's same-named dup surfaces as a text-only hit (identity unproven — the feature)",
    );
  } finally {
    await p.dispose();
  }
});

test('ripgrep cross-check: every word match is accounted for (skipped when rg absent)', async () => {
  let rgAvailable = true;
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
  } catch {
    rgAvailable = false;
  }
  if (!rgAvailable) return; // independent oracle unavailable on this box — skip, don't fail

  const p = await project(FILES);
  try {
    const r = await p.op('find_usages', { name: 'widget', text: true, collapseImports: false });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as View;
    // No aliases in this fixture → every semantic ref is also a literal "widget", so the
    // total word-boundary occurrences = semantic refs + text-only hits.
    const opTotal = (view.usages ?? []).length + (view.textOnly ?? []).length;
    const rgOut = execFileSync('rg', ['-w', '-o', '--no-filename', 'widget', p.root], {
      encoding: 'utf8',
    });
    const rgCount = rgOut.split('\n').filter((l) => l === 'widget').length;
    assert.equal(opTotal, rgCount, 'op accounts for exactly ripgrep’s word-boundary matches');
  } finally {
    await p.dispose();
  }
});
