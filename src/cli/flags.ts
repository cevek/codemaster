// argv flag extraction for the one-shot CLI path. Splitting it out of `bin.ts` keeps the entry
// point at composition-root size and lets the compose surface (`cli/compose.ts`) parse its own
// flags with the SAME helpers — one spelling of "how a CLI flag is read", never two.
//
// Every helper SPLICES what it consumed out of `args`, so after the known flags are read whatever
// `--`-prefixed token remains is unread input — `flagIssue` is the §3 no-silent-drop backstop the
// CLI leans on, and it names WHICH of the three causes applied (missing value / given twice /
// genuinely unrecognized), because a residual token looks the same in all three and asserting the
// wrong one is a small false statement about the caller's own argv — the §3.6 shape (t-141874).

/** A `--flag value` pair: returns the value and splices BOTH tokens. A next token that is itself
 *  `--`-prefixed is NOT consumed — `--root --format json` would otherwise silently read `--format`
 *  as the root and drop the real flag. Left unconsumed, it surfaces through `flagIssue` as
 *  "needs a value". */
export function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  args.splice(idx, 2);
  return value;
}

/** A value-bearing flag accepting BOTH spellings — `--flag value` and `--flag=value` — and
 *  spliced out either way (the `=` form is one token). The equals form is checked first so a
 *  `--format=json` never falls through to the space-form lookup and gets left behind. An empty
 *  `--flag=` yields `''`, which callers reject as missing rather than as a valid value. */
export function flagValue(args: string[], flag: string): string | undefined {
  const eqPrefix = `${flag}=`;
  const eqIdx = args.findIndex((a) => a.startsWith(eqPrefix));
  if (eqIdx !== -1) {
    const value = args[eqIdx]?.slice(eqPrefix.length) ?? '';
    // An empty `--flag=` is left IN `args` on purpose: spliced out it would read as "not passed"
    // and the command would run on defaults the caller never asked for. Left in, `flagIssue`
    // reports it as written-without-a-value.
    if (value === '') return undefined;
    args.splice(eqIdx, 1);
    return value;
  }
  return argValue(args, flag);
}

/** A valueless boolean flag (`--apply`, `--summaryOnly`): present → true, and spliced out so it
 *  never collides with the positional JSON-args lookup. */
export function hasFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

/** Narrow a value-flag to one of `allowed`. `undefined` = the flag was absent; `null` = it was
 *  present carrying something else, which the caller must REJECT — coercing it to a default would
 *  run the command on a shape the caller never asked for (§3 silent-swallow). */
export function enumFlag<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined | null {
  if (raw === undefined) return undefined;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** The flags a command accepts, so a residual token can be diagnosed by CAUSE rather than by name
 *  alone. Both lists matter: a repeated boolean is recognized-but-duplicated, and reporting it as
 *  "unrecognized" is the same class of false statement this helper exists to avoid. */
export interface KnownFlags {
  value: readonly string[];
  bool?: readonly string[];
  /** Flags whose reader ALREADY took a copy on this call — so a residual occurrence of one of them
   *  is a second copy, observed rather than inferred. The callers know this exactly (their read
   *  returned a value / `true`); reconstructing it from argv shape instead would guess, and a
   *  guessed cause is what this whole helper exists not to state. */
  consumed?: readonly string[];
}

/** After every KNOWN flag has been spliced out, any residual `--`-prefixed token is unread input.
 *  Returns the message to reject with (§3: a silent drop is the exact intake anti-pattern the tool
 *  forbids), or `undefined` when nothing is stray.
 *
 *  Three distinct causes, three distinct statements — because the residual token alone does not say
 *  which happened, and asserting the wrong one is a small lie about the caller's own argv (the
 *  t-141874 shape, inverted): a known flag with nothing after it was written without a value; a
 *  known flag whose reader already consumed an earlier copy was given more than once; anything else
 *  is genuinely unrecognized. */
export function flagIssue(args: readonly string[], known: KnownFlags): string | undefined {
  const stray = args.filter((a) => a.startsWith('--'));
  if (stray.length === 0) return undefined;
  const isValue = (a: string): boolean =>
    known.value.includes(a) || known.value.includes(a.split('=')[0] ?? a);
  const isBool = (a: string): boolean => (known.bool ?? []).includes(a);
  // A residual copy of a flag the reader already took IS a duplicate — the reader splices the first
  // occurrence, so anything left over is a second one. Read off what the caller observed, never
  // inferred from whether the next argv token happens to look like a value.
  const taken = new Set(known.consumed ?? []);
  const repeated = stray.filter((a) => taken.has(a.split('=')[0] ?? a));
  if (repeated.length > 0) return `flag(s) given more than once: ${unique(repeated).join(', ')}`;
  // A boolean the reader did NOT take cannot be here (`hasFlag` splices on sight and needs no
  // value), so a residual one is a duplicate too — same statement, reached without a `consumed`
  // entry the boolean readers would otherwise have to thread.
  const duplicateBool = stray.filter(isBool);
  if (duplicateBool.length > 0) {
    return `flag(s) given more than once: ${unique(duplicateBool).join(', ')}`;
  }
  const valueless = stray.filter(isValue);
  if (valueless.length > 0) return `flag(s) written without a value: ${valueless.join(', ')}`;
  return `unrecognized flag(s): ${stray.join(', ')}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
