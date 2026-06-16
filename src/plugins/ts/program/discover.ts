// Discover the repo's OTHER tsconfigs so their programs can be loaded beside the primary one
// (spec Task G scope-IN 1). The warm LS compiles ONE tsconfig; a symbol used only from a file in
// a sibling program (the near-universal `tsconfig.test.json`, Vite's `tsconfig.app.json` +
// `tsconfig.node.json`, build scripts) reads as having NO usage — the honesty gap this closes.
//
// Two sources, both bounded (a fixed cap + a visited set — discovery runs ONCE and is cached by
// the host, never per query: a per-query directory scan is the §19 hang this project forbids):
//   1. sibling `tsconfig*.json` files in the primary config's directory;
//   2. `references` followed transitively from each discovered config (what a composite repo wires).
// This is plain DISCOVERY — we load each as its own independent program. The project-reference
// REDIRECT machinery (composite build graph) is the monorepo story the spec scopes OUT.

import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { toPosix } from '../../../support/fs/canonicalize.ts';

export interface DiscoveredConfig {
  /** Absolute path to the sibling tsconfig. */
  path: string;
  /** Repo-relative posix label for status/provenance (e.g. `tsconfig.test.json`). */
  label: string;
}

/** Hard cap on sibling configs (§1 bounded): far above any real repo's tsconfig count, a runaway
 *  backstop for a pathological `references` cycle the visited-set should already break. */
const MAX_SIBLING_CONFIGS = 32;

/** Sibling tsconfigs to load beside `primaryConfigPath`, EXCLUDING it. Empty when there is no
 *  primary config (the no-tsconfig fallback program stands alone) or nothing else is found. */
export function discoverSiblingConfigs(
  root: string,
  primaryConfigPath: string | undefined,
): DiscoveredConfig[] {
  if (primaryConfigPath === undefined) return [];
  const primary = toPosix(primaryConfigPath);
  const seen = new Set<string>([primary]);
  const found: string[] = [];

  const add = (abs: string): void => {
    const posix = toPosix(abs);
    if (seen.has(posix) || found.length >= MAX_SIBLING_CONFIGS) return;
    seen.add(posix);
    found.push(posix);
  };

  // Source 1: `tsconfig*.json` beside the primary config.
  const dir = path.dirname(primaryConfigPath);
  try {
    for (const entry of readdirSync(dir)) {
      if (/^tsconfig\..+\.json$/.test(entry) || entry === 'tsconfig.json') {
        add(path.join(dir, entry));
      }
    }
  } catch {
    // Unreadable dir → just skip source 1; references (source 2) may still yield siblings.
  }

  // Source 2: BFS `references` from the primary and every config found so far.
  const queue = [primary, ...found];
  while (queue.length > 0 && seen.size <= MAX_SIBLING_CONFIGS) {
    const config = queue.shift();
    if (config === undefined) continue;
    for (const ref of referencePaths(config)) {
      if (!seen.has(ref)) {
        add(ref);
        queue.push(ref);
      }
    }
  }

  return found.map((abs) => ({ path: abs, label: relLabel(root, abs) }));
}

/** Resolved tsconfig paths a config `references` (a dir → its `tsconfig.json`, a `.json` as-is).
 *  Best-effort: a malformed/unreadable config yields no references rather than throwing. */
function referencePaths(configPath: string): string[] {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const config = read.config as { references?: unknown } | undefined;
  const refs = config?.references;
  if (!Array.isArray(refs)) return [];
  const dir = path.dirname(configPath);
  const out: string[] = [];
  for (const ref of refs) {
    const p = (ref as { path?: unknown }).path;
    if (typeof p !== 'string') continue;
    const resolved = path.resolve(dir, p);
    out.push(toPosix(resolved.endsWith('.json') ? resolved : path.join(resolved, 'tsconfig.json')));
  }
  return out;
}

function relLabel(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? toPosix(abs) : toPosix(rel);
}
