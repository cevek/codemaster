// `functionDeclarations` (scan1, §5-L2) — the generic seam plugins/react consumes. Oracle strategy
// (§16): the SEMANTIC facts (kind · isExported · returnsJsx · confidence) are HAND-CURATED on an
// enumerated fixture (each form present with its expected verdict; never a circular re-walk of the
// same scan). The span half is invariant 1 — every emitted name-token Span.text equals the live
// source at its range, read independently from disk. cold==warm: an edit + reindex must flip the
// memoized result (projectVersion invalidation), and equal a fresh-booted plugin over the same tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { project } from '../helpers/project.ts';
import { createTsPlugin } from '../../src/plugins/ts/plugin.ts';
import { extractText } from '../../src/common/span/extract-text.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';
import type { TsPluginApi } from '../../src/plugins/ts/plugin.ts';
import type { FunctionDecl } from '../../src/plugins/ts/function-declarations.ts';

const COMPILER = '{"strict":true,"jsx":"react-jsx","module":"esnext","moduleResolution":"bundler"}';

const COMPONENTS =
  'declare function forwardRef<T>(r: T): T;\n' +
  'export function Direct() { return <div />; }\n' + // function · direct JSX · certain · exported
  'export const Arrow = () => <span />;\n' + // arrow concise · direct · certain · exported
  'export function Ternary(x: boolean) { return x ? <a /> : <b />; }\n' + // ternary · partial
  'export function Guarded(x: boolean) { if (x) return null; return <p />; }\n' + // mixed · partial
  'const Wrapped = forwardRef(() => <i />);\n' + // call-wrapped · dynamic · NOT exported
  'export function notJsx() { return 42; }\n' + // no JSX
  'export function useThing() { return 1; }\n'; // hook-shaped (react decides) · no JSX

const FILES = {
  'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
  'tsconfig.test.json': `{"compilerOptions":${COMPILER},"include":["src","test"]}`,
  'src/components.tsx': COMPONENTS,
  'src/cls.tsx': 'export class Widget { render() { return <div />; } }\n', // method · direct JSX
  'test/extra.test.tsx': 'export const InTest = () => <div />;\n', // cross-program (sibling only)
};

type DeclMap = Map<string, FunctionDecl>;
const byName = (decls: readonly FunctionDecl[]): DeclMap => new Map(decls.map((d) => [d.name, d]));

function assertSpan(root: string, span: FunctionDecl['span']): void {
  const source = readFileSync(path.join(root, span.file), 'utf8');
  const actual = extractText(source, span);
  assert.equal(actual, span.text, `span text drifted at ${span.file}:${span.line}:${span.col}`);
}

test('enumerated function-like forms: kind / export / returnsJsx / confidence (hand-curated)', async () => {
  const p = await project(FILES);
  const plugin: TsPluginApi = createTsPlugin(p.root);
  try {
    const decls = plugin.functionDeclarations().decls;
    const m = byName(decls);

    const expect = (
      name: string,
      kind: FunctionDecl['kind'],
      isExported: boolean,
      returnsJsx: boolean,
      conf: FunctionDecl['returnsJsxConfidence'],
    ): void => {
      const d = m.get(name);
      assert.ok(d !== undefined, `expected a declaration named ${name}`);
      assert.equal(d.kind, kind, `${name} kind`);
      assert.equal(d.isExported, isExported, `${name} isExported`);
      assert.equal(d.returnsJsx, returnsJsx, `${name} returnsJsx`);
      assert.equal(d.returnsJsxConfidence, conf, `${name} confidence`);
    };

    expect('Direct', 'function', true, true, 'certain');
    expect('Arrow', 'arrow', true, true, 'certain');
    expect('Ternary', 'function', true, true, 'partial');
    expect('Guarded', 'function', true, true, 'partial');
    expect('Wrapped', 'call-wrapped', false, true, 'dynamic');
    expect('notJsx', 'function', true, false, 'certain');
    expect('useThing', 'function', true, false, 'certain');
    expect('render', 'method', false, true, 'certain'); // class member is not a module export
    // Cross-program: a component declared only in the sibling (tsconfig.test.json) program.
    expect('InTest', 'arrow', true, true, 'certain');

    // A class declaration is out of v1 (not function-like) — never emitted.
    assert.ok(!m.has('Widget'), 'class declarations are not reported in v1');

    // Invariant 1: every name-token span equals the live source.
    for (const d of decls) assertSpan(p.root, d.span);
  } finally {
    await plugin.dispose();
    await p.dispose();
  }
});

test('cold == warm: an edit + reindex flips the memoized result and equals a fresh boot', async () => {
  const p = await project(FILES);
  const warm: TsPluginApi = createTsPlugin(p.root);
  try {
    assert.equal(
      warm.functionDeclarations().decls.find((d) => d.name === 'notJsx')?.returnsJsx,
      false,
    );

    // Edit: notJsx now returns JSX. The memo MUST recompute (projectVersion bump on reindex), or it
    // would serve the stale `returnsJsx:false` — the §3.1 lie.
    const edited = COMPONENTS.replace(
      'export function notJsx() { return 42; }',
      'export function notJsx() { return <em />; }',
    );
    p.write('src/components.tsx', edited);
    await warm.reindex(['src/components.tsx' as RepoRelPath]);

    const warmAfter = warm.functionDeclarations().decls;
    assert.equal(warmAfter.find((d) => d.name === 'notJsx')?.returnsJsx, true, 'memo invalidated');

    // A fresh-booted plugin over the edited tree is the cold oracle.
    const cold: TsPluginApi = createTsPlugin(p.root);
    try {
      const sort = (ds: readonly FunctionDecl[]): FunctionDecl[] =>
        [...ds].sort((a, b) =>
          `${a.span.file}:${a.span.line}:${a.span.col}`.localeCompare(
            `${b.span.file}:${b.span.line}:${b.span.col}`,
          ),
        );
      assert.deepEqual(sort(warmAfter), sort(cold.functionDeclarations().decls));
    } finally {
      await cold.dispose();
    }
  } finally {
    await warm.dispose();
    await p.dispose();
  }
});
