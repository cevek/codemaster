// Wrong-ADDRESSING-MODE reject for a module-PATH op (§7 Postel, §3.6 honesty) — the per-op
// `OpIntake.moduleTarget` flag's implementation, mirroring `smartName` for `locationTarget`.
//
// A module-target op (e.g. `importers_of`) takes a module PATH; an agent carrying `query`/`name`
// from a search means a SYMBOL name, which never resolves to a path — aliasing it to `module`
// would turn a loud `bad_args` into a silent "0 importers" (a §3.6 never-lie violation). So its
// presence yields a POINTED reject that steers the agent to the right shape, never a silent
// coercion. The reject is loud (the canonical zod gate is still the authority; this only sharpens
// the message). Declared ON the op via `moduleTarget: true`, not a central name-keyed table — so a
// later-added alias on the op can never be silently shadowed by a rule living elsewhere.

/** Symbol-name spellings that signal the caller used the wrong addressing mode on a module-target
 *  op. A module-target op has no `query`/`name` canonical field, so either key's presence is a
 *  misfit, never a legitimate arg. */
const SYMBOL_NAME_KEYS = ['query', 'name'] as const;

/** The pointed reject for a symbol-name key on a `moduleTarget` op, or `undefined` when none is
 *  present. The dispatcher appends the canonical `argsHint`; this only sharpens the message. */
export function moduleMisfitReject(args: Record<string, unknown>): string | undefined {
  const present = SYMBOL_NAME_KEYS.filter((k) => k in args);
  if (present.length === 0) return undefined;
  return (
    `${present.map((k) => `'${k}'`).join('/')} looks like a symbol name — this op takes a` +
    ` module PATH (a repo-relative path or an import specifier the project uses, e.g.` +
    ` 'src/x.ts' or '@/x'), not a symbol name`
  );
}
