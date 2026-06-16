// Cheap, bounded "is this a TypeScript project?" guard (spec-stresstest §4c). The orchestrator
// runs it before warming an engine for a config-less root: codemaster inspects TS/React repos, so
// warming a non-TS folder (a Java/Go repo, an empty dir) indexes nothing useful and the silent
// warm reads as success. Kept out of orchestrator.ts to hold that file under its line cap.

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { isOk } from '../common/result/narrow.ts';
import { gitLsFiles } from '../support/git/ls-files.ts';

/** A root tsconfig (the canonical signal) OR at least one tracked `.ts/.tsx/.mts/.cts` (covers a
 *  monorepo whose configs live per-package). A non-git root can't be cheaply enumerated, so we
 *  DON'T false-reject it — warming proceeds and the empty index speaks for itself. Cost: a stat +
 *  one `git ls-files` (a local index read, normally sub-second, output-bounded by `maxBuffer`). It
 *  is NOT deadline-capped, but it runs async (off the orchestrator loop, so it can't freeze other
 *  agents) and only ONCE per root at first spawn — the engine's own indexing reads the same listing
 *  anyway, so it adds no new class of exposure (§1, §8). */
async function looksLikeTsProject(root: string): Promise<boolean> {
  if (existsSync(path.join(root, 'tsconfig.json'))) return true;
  const ls = await gitLsFiles(root);
  if (!isOk(ls)) return true; // non-git / git unavailable → don't false-reject
  return ls.data.some((f) => /\.(tsx?|mts|cts)$/.test(f));
}

/** The refusal message when `root` isn't a TS project (else `undefined`). A codemaster.config opts
 *  in explicitly (`configSource !== undefined` → trust it), so the heuristic only gates config-less
 *  roots. Returned as a string so the orchestrator stays a one-line guard (under its line cap). */
export async function tsProjectRefusal(
  root: string,
  configSource: string | undefined,
): Promise<string | undefined> {
  if (configSource !== undefined || (await looksLikeTsProject(root))) return undefined;
  return `no TS project at ${root} — no tsconfig.json and no tracked .ts/.tsx files (codemaster inspects TypeScript/React repos; point at a TS repo root, or add a codemaster.config to opt in)`;
}
