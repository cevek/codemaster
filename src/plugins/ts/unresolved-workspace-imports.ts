// The search-completeness floor for workspace imports that resolve to nothing (t-403708): a static
// import/export naming one of the repo's OWN workspace packages that no loaded program resolves — no
// link on disk and none emulated (an undeclared dependency, a non-`workspace:` range, an entry
// pointing at an unbuilt `dist`). A file importing through such a specifier never joins the
// program that holds the declaration, so every usage behind it is invisible to the reference fan-out
// — the answer is a floor, and this names WHICH specifiers make it one. A sibling of the
// `undiscoveredPrograms` floor with a different cause; folding the two would misattribute it.
//
// Computed over the programs the caller's fan-out already BUILT (`host.programs()`; §5-L2 admission —
// call it only where every program is built anyway), memoized on the program set + their versions.

import { nameWithMore } from '../../common/truncate/name-with-more.ts';
import type { TsProjectHost } from './ls-host.ts';
import ts from 'typescript';
import { packageNameOf } from './phantom-imports.ts';

export type UnresolvedWorkspacePackage = {
  /** The workspace package the specifiers name (`@scope/pkg`). */
  package: string;
  /** Distinct import sites (`file:line`) naming it that resolve nowhere. */
  sites: number;
  /** The first few sites, `file:line` (sorted), for a grep to start from. */
  examples: string[];
  /** The distinct specifiers as written (`@scope/pkg`, `@scope/pkg/sub`). */
  specifiers: string[];
};

const EXAMPLES = 2;

interface Memo {
  key: string;
  value: readonly UnresolvedWorkspacePackage[];
}
const memos = new WeakMap<TsProjectHost, Memo>();

export function unresolvedWorkspaceImports(
  host: TsProjectHost,
): readonly UnresolvedWorkspacePackage[] {
  const members = host.workspaceLinks().memberNames();
  if (members.size === 0) return [];
  const programs = host.programs();
  const key = `${host.workspaceLinks().generation()}|${host.projectVersion()}|${programs.map((p) => p.label).join(',')}`;
  const memo = memos.get(host);
  if (memo?.key === key) return memo.value;

  // Keyed by the specifier's own `file:offset` (two imports on one line are two sites); `at` is only
  // how a site is shown.
  const unresolved = new Map<string, { pkg: string; spec: string; at: string }>();
  const resolved = new Set<string>(); // a site some program resolves is not lost
  for (const p of programs) {
    const program = p.getProgram();
    if (program === undefined) continue;
    const options = program.getCompilerOptions();
    const sys = host.workspaceLinks().resolutionHost(options);
    const resolvedBy = new Map<string, boolean>(); // per-program: `dir|spec|mode` → resolves
    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.fileName.includes('/node_modules/')) continue;
      const rel = host.relOf(sourceFile.fileName);
      for (const stmt of sourceFile.statements) {
        const literal = specifierLiteral(stmt);
        if (literal === undefined) continue;
        const spec = literal.text;
        if (spec.startsWith('.') || spec.startsWith('/')) continue;
        const pkg = packageNameOf(spec);
        if (!members.has(pkg)) continue;
        const site = `${rel}:${literal.getStart(sourceFile)}`;
        // The site's own resolution mode: under NodeNext an ESM import reads the `import` export
        // condition, a CJS one `require` — resolving without it can find a file the program did not.
        const mode = ts.getModeForUsageLocation(sourceFile, literal, options);
        const memoKey = `${sourceFile.fileName.slice(0, sourceFile.fileName.lastIndexOf('/'))}|${spec}|${String(mode)}`;
        let hit = resolvedBy.get(memoKey);
        if (hit === undefined) {
          hit =
            ts.resolveModuleName(
              spec,
              sourceFile.fileName,
              options,
              sys,
              undefined,
              undefined,
              mode,
            ).resolvedModule !== undefined;
          resolvedBy.set(memoKey, hit);
        }
        if (hit) {
          resolved.add(site);
        } else {
          const line = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile)).line;
          unresolved.set(site, { pkg, spec, at: `${rel}:${line + 1}` });
        }
      }
    }
  }

  const byPackage = new Map<string, { sites: string[]; specifiers: Set<string> }>();
  for (const [site, { pkg, spec, at }] of unresolved) {
    if (resolved.has(site)) continue;
    const entry = byPackage.get(pkg) ?? { sites: [], specifiers: new Set<string>() };
    entry.sites.push(at);
    entry.specifiers.add(spec);
    byPackage.set(pkg, entry);
  }
  const value = [...byPackage]
    .map(([pkg, e]) => ({
      package: pkg,
      sites: e.sites.length,
      examples: e.sites.sort(compareText).slice(0, EXAMPLES),
      specifiers: [...e.specifiers].sort(compareText),
    }))
    .sort((a, b) => b.sites - a.sites || compareText(a.package, b.package));
  memos.set(host, { key, value });
  return value;
}

/** The module-specifier literal of a static import/export, if it has one. */
function specifierLiteral(stmt: ts.Statement): ts.StringLiteral | undefined {
  const spec =
    ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) ? stmt.moduleSpecifier : undefined;
  return spec !== undefined && ts.isStringLiteral(spec) ? spec : undefined;
}

const NAMED = 3;

/** The `!!` LOWER-BOUND note for a non-empty floor. There is no in-tool remedy (the fix is an
 *  install or a declared `workspace:` dependency, neither callable here), so it names what to grep. */
export function unresolvedWorkspaceNote(
  lost: readonly UnresolvedWorkspacePackage[],
  noun: string,
): string {
  const sites = lost.reduce((n, p) => n + p.sites, 0);
  const named = nameWithMore(
    lost.map((p) => `${p.package} (${p.sites}: ${p.examples.join(', ')})`),
    NAMED,
  );
  return `!! LOWER BOUND — ${sites} import site(s) of this repo's own workspace package(s) resolve to NO file: ${named} (no node_modules link, and none the declared dependencies make certain — an undeclared or non-\`workspace:\` dependency, or an entry into an unbuilt output); ${noun}s reached through them were NOT counted. No in-tool remedy — grep these specifiers.`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
