// The single owner of the "name the first K, then say how many more" idiom (§3.4): a bounded
// preview of a label set that never reads as the whole set. Formerly copy-pasted byte-for-byte
// across the undiscovered-program floor notes (importers / usages / definition / unused-exports)
// and the did-you-mean hints. A pure string join over labels — no cap constant, `k` is the caller's.

/** `label0, label1, …, label(k-1)` and, when more remain, `, +N more`. An at-or-under-`k` set is
 *  joined whole (no marker). Empty in → empty string (the caller emits no note, so a clean single
 *  repo stays byte-identical — no false hint). */
export function nameWithMore(labels: readonly string[], k: number): string {
  const named = labels.slice(0, k).join(', ');
  return labels.length > k ? `${named}, +${labels.length - k} more` : named;
}
