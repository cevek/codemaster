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
  // `path` means "restrict to this folder" — the NARROWING intent (two hits in 42 dogfood fail
  // records). Without the alias it reached the gate as an unknown key whose did-you-mean tied
  // between `pathInclude` and `pathExclude` and could steer the agent to the OPPOSITE semantics: a
  // filter that removes exactly the folder they meant to search, returning a plausible EMPTY with
  // no error (t-175046). A bare directory is safe here — the shared path-filter expands a
  // wildcard-less entry to `<entry>/**` (common/glob/expand-dir.ts), so `path:'src/x'` matches the
  // subtree rather than only the literal path.
  path: 'pathInclude',
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
