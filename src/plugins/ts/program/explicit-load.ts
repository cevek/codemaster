// The `programs:` per-call lever (t-228533): an agent can widen a READ over an otherwise-UNDISCOVERED
// nested config by naming its tsconfig, recovering a complete count without editing the repo. The
// requested configs are NOT a parallel load-and-gate path: they are injected into the SAME
// `computeCoverage` discovered set (so the union, member-stray injection, and the covered-vs-floored
// subtraction all come from the ONE canonical correct-resolution proof — a partial-coverage config
// STAYS floored, never a false lift), plus built as READ-only extra programs (search fan-out). They
// are deliberately kept OUT of `built()`/`builtContaining`: the §5-L2 write-site fan-out must be
// session-order-INDEPENDENT, so a read-time programs: load must never change a later mutation's
// edit-set. This module owns the whole lever — path resolution, the extra-program lifecycle, and the
// three-state report — so ls-host holds only thin wiring.

import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { RepoRelPath } from '../../../core/brands.ts';
import { toPosix } from '../../../support/fs/canonicalize.ts';
import { relLabel, type DiscoveredConfig } from './discover.ts';
import type { Coverage } from './coverage.ts';
import type { SingleProgram } from './single.ts';

/** What `loadPrograms` did with each requested path — disclosed so the agent is never silently
 *  second-guessed (§3.6). `loaded` = the config's files are searched correctly (subtracted from the
 *  undiscovered floor); `floored` = loaded as a program but still floored (partial coverage — an
 *  un-injectable stray / a file outside the correct-resolution union remains, so it does NOT lift the
 *  completeness floor); `notFound` = the path did not resolve to a tsconfig under the repo root. */
export interface ProgramsLoadReport {
  loaded: string[];
  floored: string[];
  notFound: string[];
}

/** ls-host wiring the lever needs. `coverage()` forces the (memoized) coverage recompute after a new
 *  config is injected; `invalidateCoverage()` drops the coverage/floor memos; `buildProgram` mints a
 *  read-only SingleProgram (with member strays) via ls-host's registry/ignored closures. */
export interface ExplicitLoadDeps {
  root: string;
  configPath: string | undefined;
  /** Base discovery (primary siblings) — for the primary/sibling skip AND the coverage merge. */
  discover(): readonly DiscoveredConfig[];
  coverage(): Coverage;
  invalidateCoverage(): void;
  buildProgram(config: string, strays: readonly string[]): SingleProgram;
}

export interface ExplicitPrograms {
  /** Base discovery ∪ the requested configs — the set `computeCoverage` proves over. */
  discoveredForCoverage(): DiscoveredConfig[];
  /** The requested config paths (posix abs). The floor consults this so a config the agent NAMED is
   *  decided by the coverage proof (correct-resolution), never silently lifted by the looser
   *  file-driven membership subtraction — the two mechanisms can otherwise disagree on ONE config. */
  configs(): ReadonlySet<string>;
  load(paths: readonly string[]): ProgramsLoadReport;
  /** The loaded read-only programs (for the READ fan-out; never `built()`/writes). */
  programs(): readonly SingleProgram[];
  reindex(changed: readonly RepoRelPath[]): void;
  /** Dispose + forget all loaded programs (a structural tsconfig reindex may have moved them). */
  clear(): void;
}

export function createExplicitPrograms(deps: ExplicitLoadDeps): ExplicitPrograms {
  const configs = new Set<string>(); // requested config paths (posix abs, under root)
  const programs = new Map<string, SingleProgram>(); // config posix path → its read-only program

  const isPrimaryOrSibling = (config: string): boolean =>
    (deps.configPath !== undefined && config === toPosix(deps.configPath)) ||
    deps.discover().some((c) => toPosix(c.path) === config);

  return {
    discoveredForCoverage() {
      if (configs.size === 0) return [...deps.discover()];
      return [
        ...deps.discover(),
        ...[...configs].map((abs) => ({ path: abs, label: relLabel(deps.root, abs) })),
      ];
    },
    configs: () => configs,
    load(paths) {
      const resolved = paths.map((raw) => ({ raw, config: resolveConfigArg(deps.root, raw) }));
      let added = false;
      for (const { config } of resolved) {
        if (config === undefined || isPrimaryOrSibling(config) || configs.has(config)) continue;
        configs.add(config);
        added = true;
      }
      if (added) deps.invalidateCoverage(); // a new config changes the correct-resolution union
      const cov = deps.coverage();
      for (const { config } of resolved) {
        if (config === undefined || isPrimaryOrSibling(config) || programs.has(config)) continue;
        programs.set(config, deps.buildProgram(config, cov.memberStrays.get(config) ?? []));
      }
      return classifyPrograms(resolved, deps.configPath, cov.safe, deps.root);
    },
    programs: () => [...programs.values()],
    reindex(changed) {
      for (const program of programs.values()) program.reindex(changed);
    },
    clear() {
      for (const program of programs.values()) program.dispose();
      programs.clear();
      configs.clear();
    },
  };
}

/** Resolve a requested `programs:` entry to an absolute-posix tsconfig path UNDER the repo root, or
 *  `undefined` (→ notFound). Liberal like the rest of the intake: a relative path joins the root, a
 *  DIRECTORY resolves to its `tsconfig.json`. MUST land inside the root — a path escaping it is not
 *  this repo's config (cross-repo is the `root:` lever, not `programs:`), so it is honestly notFound,
 *  never silently loaded from a sibling tree. Existence-gated (a typo → notFound, not a phantom
 *  subtraction). */
function resolveConfigArg(root: string, raw: string): string | undefined {
  const abs = path.isAbsolute(raw) ? raw : path.join(root, raw);
  let candidate = abs;
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) candidate = path.join(abs, 'tsconfig.json');
  } catch {
    return undefined;
  }
  const posix = toPosix(candidate);
  const prefix = `${toPosix(root)}/`;
  if (!posix.startsWith(prefix)) return undefined; // outside the repo root
  if (posix.includes('/node_modules/')) return undefined; // a dependency's config, never project coverage
  if (!existsSync(candidate)) return undefined;
  return posix;
}

/** Classify each resolved request off the ALREADY-computed coverage `safe` set (the correct-resolution
 *  subtraction set) + the primary config. Pure: the loading + coverage happened above; this only
 *  reports. Deduped by resolved config so a repeated path reports once. */
function classifyPrograms(
  resolved: readonly { raw: string; config: string | undefined }[],
  primaryConfig: string | undefined,
  safe: ReadonlySet<string>,
  root: string,
): ProgramsLoadReport {
  const report: ProgramsLoadReport = { loaded: [], floored: [], notFound: [] };
  const primary = primaryConfig !== undefined ? toPosix(primaryConfig) : undefined;
  const seen = new Set<string>();
  for (const { raw, config } of resolved) {
    if (config === undefined) {
      report.notFound.push(raw);
      continue;
    }
    if (seen.has(config)) continue;
    seen.add(config);
    const label = relLabel(root, config);
    if (config === primary || safe.has(config)) report.loaded.push(label);
    else report.floored.push(label);
  }
  return report;
}
