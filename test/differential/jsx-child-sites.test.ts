// `ts.jsxChildSites` (the body-scoped JSX scan, §5-L2) — the seam trace_prop_through_tree consumes
// to follow a value DOWN a tree. Oracle (§16): an INDEPENDENT cold `ts.Program` + a naive AST walk
// of the target's body (NOT the seam — that would be circular) re-derives the set of `<Tag/>` sites
// rendered in the body, each tag's attribute names, and each attribute's VALUE SHAPE (bare ident /
// member access / other / none) + spread presence. The two must agree. The span half is invariant 1
// — every emitted tag-name `Span.text` equals the live source at its range, read from disk.
//
// Discriminators (red→green): a scan that (a) STOPS at nested callbacks would drop the `.map(...)`
// `<Item/>` (a closure-captured flow — a §3.4 completeness lie); (b) skips attribute-VALUE-position
// JSX would drop the render-prop `<Badge/>`; (c) confuses `{a.b}` (member) with `{ident}` (bare)
// would mislabel a non-destructured forward — each fails a distinct assertion below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { project } from '../helpers/project.ts';
import { createTsPlugin } from '../../src/plugins/ts/plugin.ts';
import { extractText } from '../../src/common/span/extract-text.ts';
import type { TsPluginApi } from '../../src/plugins/ts/plugin.ts';
import type { JsxChildSitesView } from '../../src/plugins/ts/plugin.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"preserve"}}';

// Diverse child sites in ONE body: a destructured forward `{userId}`, a member forward
// `{props.userId}`, a rename `{userId}` under a different attr name, a derived `{userId.length}`, a
// string literal, a `{...spread}`, a `.map(...)` CALLBACK child, and an attribute-VALUE render prop.
const PANEL =
  'declare const Profile: any, Header: any, Meta: any, Spreadible: any, List: any, Item: any,\n' +
  '  Layout: any, Badge: any, Derived: any, Lit: any, props: { userId: string };\n' +
  'export const Panel = ({ userId, title }: { userId: string; title: string }) => {\n' +
  '  const items = [1, 2, 3];\n' +
  '  return (\n' +
  '    <section title={title}>\n' +
  '      <Profile userId={userId} />\n' +
  '      <Meta id={props.userId} />\n' +
  '      <Header name={userId} />\n' +
  '      <Derived x={userId.length} />\n' +
  '      <Lit a="literal" />\n' +
  '      <Spreadible {...{ userId }} />\n' +
  '      <List>{items.map((i) => <Item key={i} userId={userId} />)}</List>\n' +
  '      <Layout slot={<Badge userId={userId} />} />\n' +
  '      <span data-x="x" />\n' +
  '    </section>\n' +
  '  );\n' +
  '};\n';

type AttrShape = 'ident' | 'member' | 'other' | 'none';
type OracleSite = { tag: string; attrs: Map<string, AttrShape>; hasSpread: boolean };

/** Independent cold-Program oracle: every JSX opening in Panel's body, walked naively. */
function oracle(root: string): OracleSite[] {
  const cfgPath = path.join(root, 'tsconfig.json');
  const raw = ts.parseConfigFileTextToJson(cfgPath, readFileSync(cfgPath, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(raw.config as object, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const sf = program.getSourceFiles().find((f) => f.fileName.endsWith('Panel.tsx'));
  assert.ok(sf !== undefined, 'fixture source in program');

  // Find Panel's arrow body.
  let body: ts.Node | undefined;
  const findBody = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'Panel') {
      const init = n.initializer;
      if (init !== undefined && ts.isArrowFunction(init)) body = init.body;
    }
    ts.forEachChild(n, findBody);
  };
  ts.forEachChild(sf, findBody);
  assert.ok(body !== undefined, 'Panel body found');

  const sites: OracleSite[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const attrs = new Map<string, AttrShape>();
      let hasSpread = false;
      for (const a of n.attributes.properties) {
        if (ts.isJsxSpreadAttribute(a)) {
          hasSpread = true;
          continue;
        }
        if (!ts.isJsxAttribute(a)) continue;
        attrs.set(a.name.getText(sf), shapeOf(a.initializer));
      }
      sites.push({ tag: n.tagName.getText(sf), attrs, hasSpread });
    }
    ts.forEachChild(n, collect); // descend through EVERYTHING — the seam must too
  };
  ts.forEachChild(body, collect);
  return sites;
}

function shapeOf(init: ts.JsxAttributeValue | undefined): AttrShape {
  if (init === undefined) return 'none';
  if (ts.isStringLiteralLike(init)) return 'other';
  if (ts.isJsxExpression(init) && init.expression !== undefined) {
    if (ts.isIdentifier(init.expression)) return 'ident';
    if (ts.isPropertyAccessExpression(init.expression)) return 'member';
    return 'other';
  }
  return 'other';
}

function seamShape(view: JsxChildSitesView): OracleSite[] {
  return view.sites.map((s) => {
    const attrs = new Map<string, AttrShape>();
    for (const a of s.attrs) {
      const shape: AttrShape =
        a.valueIdent !== undefined
          ? 'ident'
          : a.valueMember !== undefined
            ? 'member'
            : a.valueText !== undefined
              ? 'other'
              : 'none';
      attrs.set(a.name, shape);
    }
    return { tag: s.tagName, attrs, hasSpread: s.hasSpread };
  });
}

const keyOf = (s: OracleSite): string =>
  `${s.tag}|${[...s.attrs]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(',')}|spread=${s.hasSpread}`;

test('jsxChildSites: body JSX + attr value shapes match an independent cold-Program walk', async () => {
  const p = await project({ 'tsconfig.json': TSCONFIG, 'src/Panel.tsx': PANEL });
  const plugin: TsPluginApi = createTsPlugin(p.root);
  try {
    const out = plugin.jsxChildSites({ name: 'Panel' });
    assert.ok(typeof out !== 'string' && 'view' in out, 'resolved');
    const got = seamShape(out.view);
    const want = oracle(p.root);

    // Same multiset of sites (tag + attr shapes + spread).
    assert.deepEqual(
      got.map(keyOf).sort(),
      want.map(keyOf).sort(),
      'seam sites == cold-Program sites',
    );

    // Discriminator (a): the `.map(...)` callback child is present (closure-captured flow).
    assert.ok(
      got.some((s) => s.tag === 'Item' && s.attrs.get('userId') === 'ident'),
      '<Item/>',
    );
    // Discriminator (b): the render-prop in attribute-value position is present.
    assert.ok(
      got.some((s) => s.tag === 'Badge' && s.attrs.get('userId') === 'ident'),
      '<Badge/>',
    );
    // Discriminator (c): member access `{props.userId}` is 'member', not 'ident'.
    assert.equal(got.find((s) => s.tag === 'Meta')?.attrs.get('id'), 'member');
    assert.equal(got.find((s) => s.tag === 'Profile')?.attrs.get('userId'), 'ident');
    // Derived `{userId.length}` → trailing member 'length' (≠ a forward of userId).
    assert.equal(got.find((s) => s.tag === 'Derived')?.attrs.get('x'), 'member');
    assert.ok(got.find((s) => s.tag === 'Spreadible')?.hasSpread, '{...} spread flagged');

    // Invariant 1: every tag-name proof span equals the live source.
    for (const s of out.view.sites) {
      const src = readFileSync(path.join(p.root, s.tagSpan.file), 'utf8');
      assert.equal(extractText(src, s.tagSpan), s.tagSpan.text, `span drift at ${s.tagName}`);
    }
  } finally {
    await p.dispose();
  }
});
