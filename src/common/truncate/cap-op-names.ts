// The bounded op-name list carried by a crash breadcrumb (§3.4). Both producers of that record need
// it — the agent-facing span (`mcp/inflight-ops.ts`, L5) and the daemon's own span
// (`daemon/daemon-server.ts`, L4) — and L4 cannot import L5, so the idiom lives here rather than
// being copy-pasted with two chances to drift.
//
// A LIST, not a joined string (that is `name-with-more.ts`): the `ops` field is `string[]`, and the
// overflow marker rides in it as a final element so a consumer reading the array still sees the
// truncation. A silently short list is the §3.4 lie — a 40-op batch killed by its last op would
// read as 32 innocent names and nothing else.

/** The default breadcrumb cap. Generous: a real batch is a handful of ops, so this only ever bites
 *  a pathological one, and the marker discloses it when it does. */
export const MAX_BREADCRUMB_OPS = 32;

/** First `cap` of `names`, plus a `+N more` element when `total` exceeded the cap.
 *
 *  `total` is separate from `names.length` on purpose: the agent-facing span reads names out of raw
 *  envelopes and an unparseable one yields no name, so the count that must drive the marker is the
 *  REQUEST count, not how many names survived parsing — otherwise a 40-request batch with a few
 *  unreadable envelopes would report no truncation at all. A `total` at or under `cap` returns the
 *  names unchanged, so the ordinary call is byte-identical. */
export function capOpNames(
  names: readonly string[],
  total: number,
  cap: number = MAX_BREADCRUMB_OPS,
): string[] {
  const kept = names.slice(0, cap);
  return total > cap ? [...kept, `+${total - cap} more`] : kept;
}
