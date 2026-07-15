// Cross-op input-key aliases (§7 Postel) — spellings that mean the SAME canonical field on
// every op that has it, so they need no per-op map. `max_results`/`maxResults`→`limit` is the
// ToolSearch-habit spelling seen on search_symbol/find_usages in the dogfood fail log.
//
// GUARDED by the schema, not a blind rename: the alias fires ONLY when the canonical target is
// an actual field of THIS op (`limit ∈ canonicalKeys`) and the source key is not itself
// canonical. So an op WITHOUT a `limit` field leaves `max_results` untouched → it flows to the
// gate and fails with an honest did-you-mean, never a stray `limit` key manufactured for an op
// that has none (that would be a worse, misleading reject). The guard means this can't silently
// misfire across the whole surface.

/** input-key → canonical-key, applied to every op whose schema HAS the canonical key. */
const GLOBAL_ALIASES: Readonly<Record<string, string>> = {
  max_results: 'limit',
  maxResults: 'limit',
};

export interface GlobalAliasResult {
  notes: string[];
}

/** Apply the guarded global aliases to `args`, mutating it. `canonical` is this op's canonical
 *  top-level key set — the alias fires only when the target is a real field of the op. */
export function applyGlobalAliases(
  args: Record<string, unknown>,
  canonical: ReadonlySet<string>,
): GlobalAliasResult {
  const notes: string[] = [];
  for (const [from, to] of Object.entries(GLOBAL_ALIASES)) {
    if (!(from in args)) continue;
    // Only rewrite when `to` is a genuine field of this op, `from` is not itself canonical, and
    // the canonical key is not already present (an explicit value wins).
    if (!canonical.has(to) || canonical.has(from) || to in args) continue;
    args[to] = args[from];
    delete args[from];
    notes.push(`${from}→${to}`);
  }
  return { notes };
}
