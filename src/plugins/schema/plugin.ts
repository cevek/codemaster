// The `schema` plugin (§5-L2): owner of generated-API-surface knowledge. Reads the
// configured openapi-typescript entrypoint(s) into endpoint cards (method · path · params ·
// query · body · response) with proof spans — its own parser (`parseEndpoints` over
// `ts.createSourceFile`, §4), no checker, so NO `deps: ['ts']`. State is per-entrypoint
// file, rebuilt per-file on reindex (the scss/i18n precedent).
//
// Enabled iff `config.schema` is present (no autodetection v1); the gate lives in the
// composition root's `pluginsFor`, never in `opsFor` — the op registers unconditionally
// with `requires: ['schema']`, gated by plugin presence (the i18n precedent).

import type { FreshnessFingerprint, Plugin } from '../../core/plugin.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import { walkFiles } from '../../support/fs/walk.ts';
import { fileExists } from '../../support/fs/exists.ts';
import { readTextOrAbsent } from '../../support/fs/read-or-absent.ts';
import { matchesAnyGlob } from '../../common/glob/match.ts';
import { parseEndpoints, type EndpointCard } from './parse.ts';

export type { EndpointCard } from './parse.ts';

export interface SchemaPluginApi extends Plugin {
  /** All endpoint cards across every entrypoint, sorted by path then method. */
  endpoints(): EndpointCard[];
  /** The card for one path+method, or `undefined` if absent. */
  endpoint(path: string, method: string): EndpointCard | undefined;
  /** Entrypoint files that failed to parse, file → message (surfaced in op envelopes). */
  parseFailures(): ReadonlyMap<RepoRelPath, string>;
}

export function createSchemaPlugin(
  root: string,
  entrypointGlobs: readonly string[],
): SchemaPluginApi {
  let state: Map<RepoRelPath, EndpointCard[]> | undefined;
  const failures = new Map<RepoRelPath, string>();
  let version = 0;

  const parseOne = (rel: RepoRelPath): EndpointCard[] => {
    const read = readTextOrAbsent(root, rel);
    // ENOENT (vanished between listing and reading — a watcher race) is absence, not a
    // failure; a real IO error (EACCES/EISDIR/…) is recorded so it can never read as
    // "no endpoints here" (§3.6).
    if (read.kind === 'absent') {
      failures.delete(rel);
      return [];
    }
    if (read.kind === 'error') {
      failures.set(rel, read.message);
      return [];
    }
    const parsed = parseEndpoints(rel, read.text);
    if (!parsed.ok) {
      failures.set(rel, parsed.message);
      return [];
    }
    failures.delete(rel);
    return parsed.cards;
  };

  const warm = (): Map<RepoRelPath, EndpointCard[]> => {
    if (state === undefined) {
      state = new Map();
      const walked = walkFiles(root);
      const files = walked.ok ? walked.data : (walked.data ?? []);
      for (const f of files) {
        if (!matchesAnyGlob(f.path, entrypointGlobs)) continue;
        state.set(f.path, parseOne(f.path));
      }
      version++;
    }
    return state;
  };

  const allCards = (): EndpointCard[] => {
    const cards = [...warm().values()].flat();
    cards.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    return cards;
  };

  return {
    id: 'schema',
    version: '0.1.0',
    deps: [],

    init() {
      return Promise.resolve();
    },
    dispose() {
      state = undefined;
      return Promise.resolve();
    },
    freshness(): FreshnessFingerprint {
      return state === undefined ? 'cold' : `v${version}`;
    },
    reindex(changed) {
      if (state === undefined) return Promise.resolve();
      let touched = false;
      for (const rel of changed) {
        if (!matchesAnyGlob(rel, entrypointGlobs)) continue;
        touched = true;
        if (fileExists(root, rel)) state.set(rel, parseOne(rel));
        else {
          state.delete(rel);
          failures.delete(rel);
        }
      }
      if (touched) version++;
      return Promise.resolve();
    },
    pending: () => [],

    endpoints: allCards,

    endpoint(p, method) {
      const wanted = method.toUpperCase();
      return allCards().find((c) => c.path === p && c.method === wanted);
    },

    parseFailures: () => failures,
  };
}
