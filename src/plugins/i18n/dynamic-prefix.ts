// Prefix-scoped dynamic demotion (§3.6, backlog I-a): a dynamic `t(`a.b.${x}`)` resolves at
// runtime to `a.b.` + value-of-x, so the referenced key ALWAYS startsWith `a.b.`. That static
// head is the only thing the literal scan can prove, and it lets `unusedKeys` demote ONLY the
// matching namespace while unrelated keys stay provably `certain` — instead of one dynamic key
// burying the whole scan in `partial`. A head we cannot trust returns undefined → demote
// GLOBALLY (the safe side; an under-demote would falsely read a key `certain` = a lie).

import type { Span } from '../../core/span.ts';

/**
 * The static key-string head of a dynamic call's first argument, or undefined when none can be
 * safely extracted (so the caller demotes globally). The span is the verbatim source of the arg.
 *
 * undefined (→ global demote) for:
 *  - a non-template argument (`t(k)`, `t(o[x])`) — no static head at all;
 *  - a TRANSFORMING wrapper rooted in a template (`` t(`App.${s}`.toLowerCase()) ``,
 *    `` t(`a.${x}` + s) ``, `` tag`a.${x}` ``) — its runtime value need NOT start with the head,
 *    so the startsWith soundness breaks. The whole argument must be a BARE template literal: its
 *    source both starts AND ends with a backtick (a wrapper ends with `)` / a quote / an
 *    identifier instead). An ELIDED span (ends with `…`) fails the same test → global;
 *  - a leading substitution (`t(`${x}.y`)`) — the head is empty, any key could match;
 *  - an escaped / inner-backtick head — the raw source slice is not a faithful literal prefix.
 */
export function staticDynamicPrefix(span: Span): string | undefined {
  const text = span.text;
  // A bare template literal is the only shape whose runtime value provably startsWith the static
  // head — and its source starts AND ends with a backtick. Anything else demotes globally.
  if (text.length < 2 || !text.startsWith('`') || !text.endsWith('`')) return undefined;
  const subAt = text.indexOf('${');
  return safeHead(subAt === -1 ? text.slice(1, -1) : text.slice(1, subAt));
}

function safeHead(head: string): string | undefined {
  // A backslash escape or an inner backtick means the slice is not a faithful literal prefix —
  // fall back to the safe (global) side rather than guess. A raw CR/LF is the same hazard: a
  // template's runtime value normalizes CRLF→LF, so a head sliced from CRLF source would not be a
  // faithful prefix of the runtime key → a key could escape the namespace and read false `certain`.
  if (head.includes('\\') || head.includes('`') || /[\r\n]/.test(head)) return undefined;
  return head === '' ? undefined : head;
}
