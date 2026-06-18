// Differential (§16): the `react` plugin's component / hook / dialog detection, via the generic
// `list` op, against an INDEPENDENT cold-`ts.Program` oracle written here — NOT the plugin's own
// `functionDeclarations` scan (importing that would be circular, §16). The oracle re-derives the
// component / hook name sets with its own AST walk; per-case confidence + provenance + the
// syntactic under-report are hand-curated truth. Proof spans are validated against source.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { project, assertSpansValid } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"preserve"}}';
const PKG = JSON.stringify({ dependencies: { react: '18' } });

/** Independent cold-Program oracle: PascalCase functions that SYNTACTICALLY return JSX (directly,
 *  through a ternary/`&&`, or wrapped in a HOC call) = components; `use[A-Z]…` = hooks. A function
 *  returning a JSX value only INDIRECTLY (`const el=<x/>; return el`) is NOT a component — the same
 *  syntactic boundary the plugin honors, implemented separately here. */
function oracle(root: string): { components: Set<string>; hooks: Set<string> } {
  const cfgPath = path.join(root, 'tsconfig.json');
  const raw = ts.parseConfigFileTextToJson(cfgPath, readFileSync(cfgPath, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(raw.config as object, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const components = new Set<string>();
  const hooks = new Set<string>();
  const isPascal = (n: string): boolean => /^[A-Z]/.test(n);
  const isHook = (n: string): boolean => /^use[A-Z]/.test(n);

  const exprHasJsx = (e: ts.Expression): boolean => {
    if (ts.isJsxElement(e) || ts.isJsxFragment(e) || ts.isJsxSelfClosingElement(e)) return true;
    if (ts.isParenthesizedExpression(e)) return exprHasJsx(e.expression);
    if (ts.isConditionalExpression(e)) return exprHasJsx(e.whenTrue) || exprHasJsx(e.whenFalse);
    if (ts.isBinaryExpression(e)) return exprHasJsx(e.left) || exprHasJsx(e.right);
    return false;
  };
  const returnsJsx = (body: ts.ConciseBody | undefined): boolean => {
    if (body === undefined) return false;
    if (!ts.isBlock(body)) return exprHasJsx(body);
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))
        return;
      if (ts.isReturnStatement(n) && n.expression !== undefined && exprHasJsx(n.expression)) {
        found = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(body, visit);
    return found;
  };
  const wrapped = (init: ts.CallExpression): boolean =>
    init.arguments.some(
      (a) => (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && returnsJsx(a.body),
    );

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('/node_modules/')) continue;
    if (path.relative(root, sf.fileName).startsWith('..')) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name !== undefined) {
        if (isHook(n.name.text)) hooks.add(n.name.text);
        if (isPascal(n.name.text) && returnsJsx(n.body)) components.add(n.name.text);
      } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const name = n.name.text;
        const init = n.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          if (isHook(name)) hooks.add(name);
          if (isPascal(name) && returnsJsx(init.body)) components.add(name);
        } else if (ts.isCallExpression(init) && isPascal(name) && wrapped(init)) {
          components.add(name);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { components, hooks };
}

interface Entry {
  key: string;
  kind: string;
  confidence: string;
  provenance: string;
  detail?: string;
}

function listData(r: OpResult): Record<string, JsonValue> {
  if ('error' in r) throw new Error(`dispatch error: ${r.error.message}`);
  assert.ok(r.result.ok, 'expected ok result');
  return r.result.data as Record<string, JsonValue>;
}

const FILES = {
  'package.json': PKG,
  'tsconfig.json': TSCONFIG,
  // Components — direct JSX return (certain)
  'src/Button.tsx': 'export const Button = () => <button/>;\n',
  'src/Card.tsx': 'export function Card() { return <div/>; }\n',
  // Conditional return → partial
  'src/Maybe.tsx': 'export const Maybe = (p: { x: boolean }) => (p.x ? <div/> : null);\n',
  // HOC-wrapped → call-wrapped, dynamic (no react import needed — a local wrapper)
  'src/Wrapped.tsx':
    'const memo = <T,>(f: T): T => f;\nexport const Wrapped = memo(() => <div/>);\n',
  // Indirect return — JSX via a binding → syntactic under-report, NOT a component
  'src/Indirect.tsx': 'export const Indirect = () => { const el = <div/>; return el; };\n',
  // lowercase name returning JSX → host-element-named, not a component
  'src/lower.tsx': 'export const lowerThing = () => <div/>;\n',
  // Hooks
  'src/hooks.ts': 'export const useCounter = () => 1;\nexport function useThing() { return 2; }\n',
  // Dialog convention: a component rendering a dialog primitive
  'src/ui.tsx':
    'export const DialogContent = (p: { children?: unknown }) => <div>{p.children as never}</div>;\n',
  'src/MyDialog.tsx':
    "import { DialogContent } from './ui';\nexport const MyDialog = () => <DialogContent/>;\n",
};

test('components: warm list == independent cold-Program oracle (incl. call-wrapped); honest under-report', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('list', { registry: 'components' });
    const data = listData(r);
    assert.equal(data['found'], true);
    assert.equal(data['owner'], 'react');

    const entries = data['entries'] as unknown as Entry[];
    const names = new Set(entries.map((e) => e.key));
    const { components } = oracle(p.root);
    assert.deepEqual([...names].sort(), [...components].sort(), 'warm == oracle component set');
    // The point of the fixture: Indirect (indirect JSX) and lowerThing (lowercase) are absent;
    // DialogContent + MyDialog ARE components (both return JSX) and Wrapped is the call-wrapped one.
    assert.deepEqual([...names].sort(), [
      'Button',
      'Card',
      'DialogContent',
      'Maybe',
      'MyDialog',
      'Wrapped',
    ]);
    assert.ok(!names.has('Indirect') && !names.has('lowerThing'), 'under-report cases excluded');

    // Confidence tracks the underlying JSX fact (hand-curated); provenance is ALWAYS heuristic:react.
    const byName = new Map(entries.map((e) => [e.key, e]));
    assert.equal(byName.get('Button')?.confidence, 'certain');
    assert.equal(byName.get('Card')?.confidence, 'certain');
    assert.equal(byName.get('Maybe')?.confidence, 'partial');
    assert.equal(byName.get('Wrapped')?.confidence, 'dynamic');
    for (const e of entries) assert.equal(e.provenance, 'heuristic:react', e.key);

    // The syntactic under-report is disclosed, never silent.
    assert.match(String(data['note']), /indirectly/i);
    assert.ok(assertSpansValid(p.root, r) >= 4, 'component proof spans validated');
  } finally {
    await p.dispose();
  }
});

test('hooks: warm list == oracle; use[A-Z] only', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('list', { registry: 'hooks' });
    const entries = listData(r)['entries'] as unknown as Entry[];
    const names = new Set(entries.map((e) => e.key));
    const { hooks } = oracle(p.root);
    assert.deepEqual([...names].sort(), [...hooks].sort());
    assert.deepEqual([...names].sort(), ['useCounter', 'useThing']);
    for (const e of entries) {
      assert.equal(e.confidence, 'certain');
      assert.equal(e.provenance, 'heuristic:react');
    }
  } finally {
    await p.dispose();
  }
});

test('dialogs: a component rendering DialogContent is flagged; proof span valid', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('list', { registry: 'dialogs' });
    const entries = listData(r)['entries'] as unknown as Entry[];
    const my = entries.find((e) => e.key === 'MyDialog');
    assert.ok(my !== undefined, 'MyDialog detected as a dialog');
    assert.match(my.detail ?? '', /DialogContent/);
    assert.equal(my.provenance, 'heuristic:react');
    assert.ok(assertSpansValid(p.root, r) >= 1);
  } finally {
    await p.dispose();
  }
});

test('dialogs: honest empty when the repo has no dialog primitives', async () => {
  const p = await project({
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'src/Button.tsx': 'export const Button = () => <button/>;\n',
  });
  try {
    const entries = listData(await p.op('list', { registry: 'dialogs' }))[
      'entries'
    ] as unknown as Entry[];
    assert.deepEqual(entries, []);
  } finally {
    await p.dispose();
  }
});

test('react plugin is autodetected from package.json; list registries gated dynamically', async () => {
  // No react dep → react plugin absent → its registries are not enumerated, list is honest.
  const noReact = await project({
    'tsconfig.json': TSCONFIG,
    'src/Button.tsx': 'export const Button = () => <button/>;\n',
  });
  try {
    const data = listData(await noReact.op('list', { registry: 'components' }));
    assert.equal(data['found'], false);
    assert.ok(!(data['available'] as string[]).includes('components'));
  } finally {
    await noReact.dispose();
  }
});
