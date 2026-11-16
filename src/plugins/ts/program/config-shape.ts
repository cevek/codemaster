// What a tsconfig's parse says about its role, read off the SAME parse that builds the program: the
// configs it extends and references (as TS resolved them — an array `extends` and a package
// `extends` included), whether its file set is TS's default glob, and whether its package's scripts
// run it. Together they identify an extends-only base config (`tsconfig.base.json` with
// compilerOptions alone), which the write gate does not treat as a typecheck authority
// (program-ownership.ts, t-401540).

import * as path from 'node:path';
import ts from 'typescript';
import { toPosix } from '../../../support/fs/canonicalize.ts';

export interface ConfigShape {
  /** Every config in the `extends` chain, absolute posix. */
  readonly extends: readonly string[];
  /** The configs its `references` name, absolute posix. */
  readonly references: readonly string[];
  /** No `files` / `include` anywhere in the chain → TS globs every file under the config's dir. */
  readonly defaultFileSet: boolean;
  /** A script of a `package.json` in its dir or any dir above it up to the workspace root names its
   *  basename (`tsc -p tsconfig.base.json`, `tsc -p packages/lib/tsconfig.build.json`). */
  readonly runByScript: boolean;
}

/** The no-config fallback primary: it has no config to be extended by or to extend. */
export const NO_CONFIG_SHAPE: ConfigShape = {
  extends: [],
  references: [],
  defaultFileSet: false,
  runByScript: false,
};

/** The `package.json` paths whose scripts decide `runByScript`: the config's dir and each dir above
 *  it up to `root` (a config outside `root` looks at its own dir only). */
export function scriptManifests(configPath: string, root: string): string[] {
  const top = toPosix(root);
  const out: string[] = [];
  let dir = toPosix(path.dirname(configPath));
  for (;;) {
    out.push(`${dir}/package.json`);
    if (dir === top || !dir.startsWith(`${top}/`)) return out;
    dir = path.posix.dirname(dir);
  }
}

/** Re-read on a reindex naming one of `scriptManifests` (single.ts), without re-parsing the config.
 *  A basename match is the conservative reading: a false hit only keeps a config in the gate. */
export function namedByScript(configPath: string, root: string): boolean {
  const base = path.basename(configPath);
  return scriptManifests(configPath, root).some((manifest) => {
    const read = ts.readConfigFile(manifest, ts.sys.readFile);
    const scripts: unknown = (read.config as { scripts?: unknown } | undefined)?.scripts;
    if (typeof scripts !== 'object' || scripts === null) return false;
    return Object.values(scripts).some((s) => typeof s === 'string' && s.includes(base));
  });
}

function declaresFileSet(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && ('files' in raw || 'include' in raw);
}

export function parseConfigFile(
  configPath: string,
  root: string,
  host: ts.ParseConfigHost = ts.sys,
): {
  parsed: ts.ParsedCommandLine;
  shape: ConfigShape;
} {
  const text = ts.readConfigFile(configPath, ts.sys.readFile);
  // Per-call cache: after the parse it holds exactly this config's extends chain.
  const chain = new Map<string, ts.ExtendedConfigCacheEntry>();
  const parsed = ts.parseJsonConfigFileContent(
    text.config ?? {},
    host,
    path.dirname(configPath),
    undefined,
    configPath,
    undefined,
    undefined,
    chain,
  );
  const entries = [...chain.values()];
  return {
    parsed,
    shape: {
      extends: entries.map((e) => toPosix(e.extendedResult.fileName)),
      references: (parsed.projectReferences ?? []).map((r) =>
        toPosix(ts.resolveProjectReferencePath(r)),
      ),
      defaultFileSet:
        !declaresFileSet(text.config) &&
        !entries.some((e) => declaresFileSet(e.extendedConfig?.raw)),
      runByScript: namedByScript(configPath, root),
    },
  };
}
