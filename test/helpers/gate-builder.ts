// Real-host fixtures for the write gate's diagnostics builder (program-gate-builder.ts). Oracle for
// every verdict: the same gate run on a FRESH host with no builders — the full LS pass. Work is
// measured the way the spike t-820012 did: a spy on every Program the LS hands out counts the files
// whose checker really ran, so "skipped" means skipped, not "drained elsewhere".

import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type ts from 'typescript';
import type { RepoRelPath } from '../../src/core/brands.ts';
import { createTsProjectHost, type TsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import {
  diagnosticsAcross,
  gateAcross,
  type GateHostCtx,
  type GateScope,
} from '../../src/plugins/ts/program-gate.ts';
import type { TsDiagnostic } from '../../src/plugins/ts/diagnostics.ts';

export type Files = Record<string, string>;

const BASE = {
  strict: true,
  noEmit: true,
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  types: [],
  lib: ['ES2022'],
};

/** Unrelated to every trap: if a pass rechecks THEM, it did full work and its EQUAL proves nothing. */
export const DECOYS: Files = {
  'z.ts': 'export const z = 1;',
  'zu.ts': "import { z } from './z';\nexport const zz: number = z;",
};

export function project(files: Files, options: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-gate-builder-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { ...BASE, ...options }, include: ['src'] }),
  );
  writeFileSync(path.join(dir, 'package.json'), '{"name":"p"}');
  for (const [name, text] of Object.entries(files))
    writeFileSync(path.join(dir, 'src', name), text);
  return dir;
}

export const src = (name: string) => `src/${name}` as RepoRelPath;
export const edits = (files: Files) =>
  Object.entries(files).map(([name, content]) => ({ path: src(name), content }));

export function scopeOf(
  names: readonly string[],
  edit: Files,
  removed: readonly string[] = [],
): GateScope {
  const all = [...new Set([...names, ...Object.keys(edit)])].sort();
  return {
    anchor: [...Object.keys(edit), ...removed].map(src),
    check: all.map(src),
    ...(removed.length > 0 ? { removed: removed.map(src) } : {}),
  };
}

export const sorted = (ds: readonly TsDiagnostic[]) =>
  ds.map((d) => `${d.file}|${d.line}|${d.message}`).sort();

/** A host context with neither builders nor the result memo — every pass is the full LS pass. */
function lsOnly(host: TsProjectHost): GateHostCtx {
  const { builders: _b, cache: _c, ...rest } = host.gateHostCtx();
  return rest;
}

export function oracleGate(dir: string, files: Files, scope: GateScope) {
  const host = createTsProjectHost(dir);
  try {
    return gateAcross(lsOnly(host), edits(files), scope);
  } finally {
    host.dispose();
  }
}

export function oracleDisk(dir: string, scope: GateScope) {
  const host = createTsProjectHost(dir);
  try {
    return diagnosticsAcross(lsOnly(host), scope);
  } finally {
    host.dispose();
  }
}

/** `getBindAndCheckDiagnostics` is @internal: the per-file checker run the builder skips or reuses. */
interface CheckedProgram {
  getBindAndCheckDiagnostics(
    sf: ts.SourceFile,
    ct?: ts.CancellationToken,
  ): readonly ts.Diagnostic[];
}

/** Every checker run on a source file of `dir/src`, across every Program the LS builds from now on. */
export function spy(host: TsProjectHost, dir: string): { checked: string[] } {
  const out = { checked: [] as string[] };
  const service = host.gateHostCtx().primary.service;
  const seen = new WeakSet<ts.Program>();
  const orig = service.getProgram.bind(service);
  const prefix = `${path.join(dir, 'src')}/`;
  service.getProgram = () => {
    const p = orig();
    if (p !== undefined && !seen.has(p)) {
      seen.add(p);
      const target = p as unknown as CheckedProgram;
      const check = target.getBindAndCheckDiagnostics.bind(target);
      target.getBindAndCheckDiagnostics = (sf, ct) => {
        if (sf.fileName.startsWith(prefix)) out.checked.push(sf.fileName.slice(prefix.length));
        return check(sf, ct);
      };
    }
    return p;
  };
  return out;
}

export function writeDisk(
  dir: string,
  files: Files,
  removed: readonly string[] = [],
): RepoRelPath[] {
  for (const [name, text] of Object.entries(files))
    writeFileSync(path.join(dir, 'src', name), text);
  for (const name of removed) unlinkSync(path.join(dir, 'src', name));
  return [...Object.keys(files), ...removed].map(src);
}
