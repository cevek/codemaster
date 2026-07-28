// Best-effort op names for a crash breadcrumb (t-807677), read from the RAW tool arguments BEFORE
// dispatch parses them. For a per-op tool the tool-name IS the op-name; for `batch` the ops live in
// the request envelopes, and naming them is the whole point of the breadcrumb — "which op killed
// the process" is the first triage question.
//
// The envelope's shape is NOT re-parsed here: `normalizeBatchEnvelope` (op-tools.ts) is its single
// owner — it already knows that the flat `{op:'find_usages', name:'Button'}` spelling puts the op
// under `op` and an ARGUMENT under `name`. Reading `name` ourselves would be a second oracle that
// silently drifts the day a new spelling is accepted, attributing a fatal to a symbol name.
// Purely defensive: unparseable arguments yield an empty list, never a throw and never a guess.

import { capOpNames, MAX_BREADCRUMB_OPS } from '../common/truncate/cap-op-names.ts';
import { normalizeBatchEnvelope } from './op-tools.ts';

export function inflightOps(tool: string, rawArgs: unknown): string[] {
  if (tool !== 'batch') return tool === 'status' ? [] : [tool];
  if (typeof rawArgs !== 'object' || rawArgs === null) return [];
  const requests = (rawArgs as { requests?: unknown }).requests;
  if (!Array.isArray(requests)) return [];
  const names: string[] = [];
  for (const request of requests.slice(0, MAX_BREADCRUMB_OPS)) {
    const canonical = normalizeBatchEnvelope(request);
    if (typeof canonical !== 'object' || canonical === null) continue;
    const name = (canonical as { name?: unknown }).name;
    if (typeof name === 'string') names.push(name);
  }
  // §3.4 (`capOpNames`, shared with the daemon's own span so the two producers of this record cannot
  // drift): never a silently short list. The marker counts REQUESTS, not the names that survived
  // parsing, so an unparseable envelope cannot mask the overflow.
  return capOpNames(names, requests.length);
}
