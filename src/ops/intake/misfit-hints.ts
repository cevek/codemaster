// Wrong-ADDRESSING-MODE hints (§7 Postel, §3 honesty) — a key that is NOT an alias because it
// denotes the wrong KIND of value, so coercing it silently would lie. `importers_of` takes a
// module PATH; an agent carrying `query`/`name` from a search means a SYMBOL name, which never
// resolves to a path — aliasing it to `module` would turn a loud `bad_args` into a silent
// "0 importers" (a §3.6 never-lie violation). So instead of an alias, its presence yields a
// POINTED reject that steers the agent to the right shape — consistent with leaving `name`
// un-aliased. The reject is loud (the canonical gate is still the authority; this only sharpens
// the message), never a silent strip.
//
// A central op-name-keyed table (not per-op `OpIntake`) so the rule is declared once beside the
// alias tables; `normalize.ts` consults it before the alias/coercion steps.

interface MisfitHint {
  /** Keys whose mere presence signals the caller used the wrong addressing mode. */
  readonly keys: readonly string[];
  /** Build the reject given the offending keys actually present (the canonical `argsHint` is
   *  appended by the dispatcher). */
  readonly message: (present: readonly string[]) => string;
}

const MISFIT_HINTS: Readonly<Record<string, MisfitHint>> = {
  importers_of: {
    keys: ['query', 'name'],
    message: (present) =>
      `${present.map((k) => `'${k}'`).join('/')} looks like a symbol name — importers_of takes a` +
      ` module PATH (a repo-relative path or an import specifier the project uses, e.g.` +
      ` 'src/x.ts' or '@/x'), not a symbol name`,
  },
};

/** The pointed reject for a wrong-addressing-mode key on `opName`, or `undefined` when none of
 *  the op's misfit keys is present. */
export function misfitReject(opName: string, args: Record<string, unknown>): string | undefined {
  const hint = MISFIT_HINTS[opName];
  if (hint === undefined) return undefined;
  const present = hint.keys.filter((k) => k in args);
  return present.length > 0 ? hint.message(present) : undefined;
}
