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
 *  top-level key set; `nested` maps an object field to the array subfields it declares (derived
 *  from the schema, `nestedArrayFieldsOf`) — the alias fires only when the target is a real field
 *  of the op, at either level. */
export function applyGlobalAliases(
  args: Record<string, unknown>,
  canonical: ReadonlySet<string>,
  nested?: ReadonlyMap<string, ReadonlySet<string>>,
): GlobalAliasResult {
  const notes: string[] = [];
  for (const [from, to] of Object.entries(GLOBAL_ALIASES)) {
    if (!(from in args) || canonical.has(from)) continue;
    // Only rewrite when `to` is a genuine field of this op and is not already present (an explicit
    // canonical value always wins).
    if (canonical.has(to)) {
      if (to in args) continue;
      args[to] = args[from];
      delete args[from];
      notes.push(`${from}→${to}`);
      continue;
    }
    // …or a field ONE LEVEL DOWN. `find_usages` keeps its path filters under `filter`, so a
    // top-level-only guard silently skipped the very op the alias exists for — and skipping means a
    // hard reject on the most-called op, not a graceful fallback. The destination is derived from
    // the schema, never a per-op allowlist, so it can't miss another op that nests the same field.
    const host = nestedHost(to, nested);
    if (host === undefined) continue;
    const existing = args[host];
    const obj =
      existing !== null && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : undefined;
    // A non-object `filter` is the caller's own error — leave it for the gate to report honestly
    // rather than overwriting it here.
    if (existing !== undefined && obj === undefined) continue;
    const target = obj ?? {};
    if (to in target) continue;
    target[to] = args[from];
    delete args[from];
    args[host] = target;
    notes.push(`${from}→${host}.${to}`);
  }
  return { notes };
}

/** The object field declaring `key` as an array subfield, if exactly one does. Ambiguity (two
 *  hosts) yields `undefined`: guessing which one the caller meant would be the silent-wrong-filter
 *  outcome this alias exists to prevent (§3). */
function nestedHost(
  key: string,
  nested: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): string | undefined {
  if (nested === undefined) return undefined;
  const hosts = [...nested].filter(([, subs]) => subs.has(key)).map(([host]) => host);
  return hosts.length === 1 ? hosts[0] : undefined;
}
