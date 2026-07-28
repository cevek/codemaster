// argv flag extraction for the one-shot CLI path. Splitting it out of `bin.ts` keeps the entry
// point at composition-root size and lets the compose surface (`cli/compose.ts`) parse its own
// flags with the SAME helpers — one spelling of "how a CLI flag is read", never two.
//
// Every helper SPLICES what it consumed out of `args`, so after the known flags are read whatever
// `--`-prefixed token remains is unread input — `flagIssue` is the §3 no-silent-drop backstop the
// CLI leans on, and it distinguishes the two causes (a known flag missing its value vs a genuinely
// unrecognized one) because reporting the first as the second is the §3.6 lie shape (t-141874).

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

/** After every KNOWN flag has been spliced out, any residual `--`-prefixed token is unread input.
 *  Returns the message to reject with (§3: a silent drop is the exact intake anti-pattern the tool
 *  forbids), or `undefined` when nothing is stray. `valueFlags` are the value-bearing flags this
 *  command accepts: one still present means it was written without a value, which is a DIFFERENT
 *  fact from "unrecognized" and gets its own message. */
export function flagIssue(
  args: readonly string[],
  valueFlags: readonly string[],
): string | undefined {
  const stray = args.filter((a) => a.startsWith('--'));
  if (stray.length === 0) return undefined;
  const known = stray.filter(
    (a) => valueFlags.includes(a) || valueFlags.includes(a.split('=')[0] ?? a),
  );
  if (known.length > 0) return `flag(s) written without a value: ${known.join(', ')}`;
  return `unrecognized flag(s): ${stray.join(', ')}`;
}
