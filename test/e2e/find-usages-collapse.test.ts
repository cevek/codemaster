// §2 read-side find_usages upgrades: reexport role, conditional import collapse, role
// breakdown on filtered results. Oracle = the fixture we wrote (which file uses Widget
// how is known by construction) + assertSpansValid (every emitted span equals the live
// file) as the independent "the site is real" check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';

type Usage = { span: { file: string; text: string }; role: string };
type View = {
  usages?: Usage[];
  enclosers?: { kind: string; file: string; name: string; roles: string }[];
  total: number;
  importsCollapsed?: number;
  roleBreakdown?: Record<string, number>;
};

// Widget: defined once; used (call) in uses.ts; imported-but-unused in imports-only.ts;
// re-exported from barrel.ts. Covers collapse, import-only, and reexport in one fixture.
const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/widget.ts': 'export const Widget = (n: number) => n + 1;\n',
  'src/uses.ts': "import { Widget } from './widget.ts';\nexport const a = Widget(1);\n",
  'src/imports-only.ts': "import { Widget } from './widget.ts';\nexport const unused = 1;\n",
  'src/barrel.ts': "export { Widget } from './widget.ts';\n",
};

test('import+call file → import collapsed and counted; import-only + reexport stay', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('find_usages', { name: 'Widget' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as View;
    const usages = view.usages ?? [];
    const importRefs = usages.filter((u) => u.role === 'import');

    // The import in uses.ts (which also calls Widget) is collapsed; the import-only file's
    // import survives — collapse is conditional, never a filter.
    assert.ok(
      !importRefs.some((u) => u.span.file === 'src/uses.ts'),
      'import alongside a real usage must be collapsed',
    );
    assert.ok(
      importRefs.some((u) => u.span.file === 'src/imports-only.ts'),
      'an import-only file must always be shown',
    );
    assert.equal(view.importsCollapsed, 1, 'exactly the one redundant import was collapsed');

    // The barrel re-export is a distinct role and is never collapsed (load-bearing surface).
    const reexport = usages.find((u) => u.role === 'reexport');
    assert.ok(reexport !== undefined, 'reexport must appear with its own role');
    assert.equal(reexport.span.file, 'src/barrel.ts');
    assert.equal(reexport.span.text, 'Widget', 'reexport span is the real identifier site');
    assertSpansValid(p.root, r); // independent oracle: every span equals the live file
  } finally {
    await p.dispose();
  }
});

test('sql table sees ALL import rows despite collapse (NOT IN stays trustworthy §2.2)', async () => {
  const p = await project(FILES);
  try {
    const [sqlResult] = await p.request(
      [{ as: 't', name: 'find_usages', args: { name: 'Widget' } }],
      { sql: "SELECT count(*) AS n FROM t WHERE role = 'import'" },
    );
    assert.ok(sqlResult !== undefined && 'result' in sqlResult && sqlResult.result.ok);
    const { rows } = sqlResult.result.data as { rows: number[][] };
    // Both imports (uses.ts + imports-only.ts) must be in the table — the projection runs
    // on the UNCOLLAPSED ref set, even though text mode would collapse one of them.
    assert.equal(rows[0]?.[0], 2, 'sql table carries every import row, uncollapsed');
  } finally {
    await p.dispose();
  }
});

test('grouped: the synthetic module row vanishes only when its file has real refs', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/widget.ts': 'export const Widget = (n: number) => n + 1;\n',
    // import at module level + a real call INSIDE render(): the import would roll up to a
    // synthetic module row; collapse removes it, leaving only the `render` encloser.
    'src/comp.ts':
      "import { Widget } from './widget.ts';\nexport function render() {\n  return Widget(2);\n}\n",
  });
  try {
    const collapsed = await p.op('find_usages', { name: 'Widget', groupBy: 'enclosing' });
    assert.ok('result' in collapsed && collapsed.result.ok);
    const enc = (collapsed.result.data as View).enclosers ?? [];
    assert.ok(
      enc.some((e) => e.name === 'render'),
      'the real usage rolls up to render()',
    );
    assert.ok(
      !enc.some((e) => e.kind === 'module' && e.file === 'src/comp.ts'),
      'the collapsed import leaves no synthetic module row for comp.ts',
    );

    const kept = await p.op('find_usages', {
      name: 'Widget',
      groupBy: 'enclosing',
      collapseImports: false,
    });
    assert.ok('result' in kept && kept.result.ok);
    const encKept = (kept.result.data as View).enclosers ?? [];
    assert.ok(
      encKept.some((e) => e.kind === 'module' && e.file === 'src/comp.ts'),
      'collapseImports:false brings the module-import row back',
    );
  } finally {
    await p.dispose();
  }
});

test('listable is emitted only when the listed rows are truncated (density)', async () => {
  const p = await project(FILES);
  try {
    // Not truncated: an import IS collapsed, but every listable row is shown → `listable` is omitted
    // (it would just repeat the `usages (N):` count; `total` + `importsCollapsed` explain the gap).
    const full = await p.op('find_usages', { name: 'Widget' });
    assert.ok('result' in full && full.result.ok, JSON.stringify(full));
    const fv = full.result.data as View & { listable?: number };
    assert.ok((fv.importsCollapsed ?? 0) > 0, 'precondition: an import was collapsed');
    assert.equal(fv.listable, undefined, 'no listable when nothing is truncated');

    // Truncated: a small limit cuts the listed rows below `listable` → it now carries the real Y
    // (the `… shown X/Y` denominator) that the header count no longer does.
    const capped = await p.op('find_usages', { name: 'Widget', limit: 2 });
    assert.ok('result' in capped && capped.result.ok);
    const cv = capped.result.data as View & { listable?: number };
    assert.equal(
      cv.listable,
      cv.total - (cv.importsCollapsed ?? 0),
      'listable = total − collapsed',
    );
    assert.ok((cv.usages ?? []).length < (cv.listable ?? 0), 'fewer rows shown than listable');
  } finally {
    await p.dispose();
  }
});

test('a single role filter hoists role to a header (text/json) but sql keeps it per-row', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('find_usages', { name: 'Widget', role: 'import', collapseImports: false });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as View & { role?: string };
    assert.equal(view.role, 'import', 'the pinned role is stated once in a header field');
    const usages = (view.usages ?? []) as { role?: string }[];
    assert.ok(usages.length > 0, 'has import usages');
    assert.ok(
      usages.every((u) => u.role === undefined),
      'role dropped from every row (rides header)',
    );

    // sql-mode must NOT hoist — the table projects `role` per row, else a NOT IN would lie (§2.3).
    const [sql] = await p.request(
      [
        {
          as: 't',
          name: 'find_usages',
          args: { name: 'Widget', role: 'import', collapseImports: false },
        },
      ],
      { sql: "SELECT count(*) AS n FROM t WHERE role = 'import'" },
    );
    assert.ok(sql !== undefined && 'result' in sql && sql.result.ok);
    assert.ok(
      ((sql.result.data as { rows: number[][] }).rows[0]?.[0] ?? 0) > 0,
      'sql keeps per-row role (no hoist in sql-mode)',
    );
  } finally {
    await p.dispose();
  }
});

test('role-filtered empty result shows the role breakdown + a suggestion; counts correct', async () => {
  const p = await project(FILES);
  try {
    // Widget is never written → role:'write' is empty. The breakdown must still show what
    // the unfiltered answer looked like, so "0" is not mistaken for "none exist" (§3.4).
    const empty = await p.op('find_usages', { name: 'Widget', role: 'write' });
    assert.ok('result' in empty && empty.result.ok);
    const view = empty.result.data as View & { notes?: string[] };
    assert.equal(view.total, 0);
    assert.ok(view.roleBreakdown !== undefined, 'an empty role filter must carry the breakdown');
    assert.ok(
      (view.notes ?? []).some(
        (n) => n.startsWith('0 usages role=write') && n.includes('try role:'),
      ),
      'the empty answer suggests the dominant role',
    );

    // Oracle: the breakdown equals a per-role count of the role-UNFILTERED answer (same
    // path filters), with collapse off so every ref is present.
    const all = await p.op('find_usages', { name: 'Widget', collapseImports: false });
    assert.ok('result' in all && all.result.ok);
    const counts: Record<string, number> = {};
    for (const u of (all.result.data as View).usages ?? [])
      counts[u.role] = (counts[u.role] ?? 0) + 1;
    assert.deepEqual(view.roleBreakdown, counts, 'breakdown counts match the unfiltered answer');
  } finally {
    await p.dispose();
  }
});
