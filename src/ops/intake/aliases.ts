// Rename a known off-canonical input key to its canonical name (§7 Postel) — `symbol`→`name`,
// `path`→`module`, `sites`→`targets`, etc. Per-op (the map lives on `OpDefinition.intake`),
// because the same spelling is canonical for one op and an alias for another (`file` is
// canonical on find_usages, an alias to `module` on importers_of). A canonical key already
// present is never clobbered — the explicit canonical value wins and the stray alias key
// flows on to the canonical gate, which rejects it honestly rather than silently dropping it.

export interface AliasResult {
  notes: string[];
}

/** Apply the per-op alias map to `args` (a fresh clone owned by the caller), mutating it. */
export function applyAliases(
  args: Record<string, unknown>,
  aliases: Readonly<Record<string, string>> | undefined,
): AliasResult {
  const notes: string[] = [];
  if (aliases === undefined) return { notes };
  for (const [from, to] of Object.entries(aliases)) {
    if (!(from in args) || to in args) continue;
    args[to] = args[from];
    delete args[from];
    notes.push(`${from}→${to}`);
  }
  return { notes };
}
