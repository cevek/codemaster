// `search_symbol` 0-match file/module hint (t-517121). Lives HERE, not in the shared
// `no-symbol-hint.ts`, on purpose: that file feeds find_usages / find_definition too, and the
// file-hint is search_symbol-only — a name that resolves to no SYMBOL but DOES name a source file is
// almost always the module the agent wants, and a pointer saves a fallback grep. Orthogonal to the
// undiscovered-program hint (both can apply — a file under an unloaded program is exactly this case).

/** The file/module clause to append to a 0-match `search_symbol` note, or `''` when no source file
 *  bears the query's name (the note stays byte-identical — no false hint). Proof-carrying: names the
 *  exact resolved path(s) and steers to `find_definition {file}` / `list`. */
export function fileModuleHint(query: string, files: readonly string[]): string {
  if (files.length === 0) return '';
  const named = files.join(', ');
  return ` — but a source file named '${query}' exists (${named}); if you meant the FILE/module rather than a symbol, try find_definition {file:'${files[0]}'} or the list op.`;
}
