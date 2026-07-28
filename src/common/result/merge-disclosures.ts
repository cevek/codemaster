// Union the resolve-time disclosures of several envelopes into one (§3.4), the sibling of
// `mergeFreshness`.
//
// It exists because an envelope is assembled in more than one place: the dispatcher stamps the
// op's own ledger, but a `sql` join builds a NEW envelope over its producers' results and a
// cross-root join merges several engines' answers. Any such factory that forwards `freshness` and
// `truncated` but not `disclosures` would silently drop the claim — and the sql case is the WORST
// place to drop it, since an uncapped producer feeding a `NOT IN` is exactly where a
// possibly-mis-picked target poisons the whole join. Having one named merge makes forwarding the
// obvious thing to do at the next factory rather than something to remember.

import type { Disclosure } from '../../core/result.ts';

/** Dedup by `unsafe|target`: several producers resolving the SAME doubtful name state one claim,
 *  not one per producer. Order follows first appearance, so the result is deterministic. */
export function mergeDisclosures(
  sources: ReadonlyArray<readonly Disclosure[] | undefined>,
): readonly Disclosure[] | undefined {
  const byKey = new Map<string, Disclosure>();
  for (const list of sources) {
    for (const d of list ?? []) {
      const key = `${d.unsafe}|${d.target}`;
      if (!byKey.has(key)) byKey.set(key, d);
    }
  }
  return byKey.size === 0 ? undefined : [...byKey.values()];
}
