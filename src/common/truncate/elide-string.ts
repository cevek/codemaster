// The single owner of the scalar `slice + …` idiom (§3.4). A string longer than `cap` is cut with
// a VISIBLE `…` marker and the FULL length is reported — a silent cut (or a checker's silent `...`)
// would read as completeness, the exact lie the trust contract forbids. Every ad-hoc
// `s.length > cap ? \`${s.slice(0, cap)}…\` : s` in the tree routes here (enforced by the ESLint
// guard, CONTRIBUTING.md); the typed rich-marker layer for type/signature strings sits on top in
// `elide-type.ts`.

/** A char-elided string plus its honesty metadata. `total` is the pre-cut length so a caller can
 *  report "N chars" without re-measuring the source, and `elided` lets a caller attach a
 *  domain-specific recovery marker only when a cut actually happened. */
export interface Elided {
  /** The (possibly cut) text — carries a trailing `…` iff `elided`. */
  text: string;
  /** True when the source exceeded `cap` and was cut. */
  elided: boolean;
  /** The FULL length of the source, before any cut. */
  total: number;
}

/** Cut `s` at `cap` with a trailing `…` (never a silent drop, §3.4). At or under the cap the text
 *  is returned verbatim (`elided:false`). The `…` is the base marker every char-truncation shares;
 *  a richer recovery marker (report length + how to recover) is the caller's — see `elideType`. */
export function elideString(s: string, cap: number): Elided {
  if (s.length <= cap) return { text: s, elided: false, total: s.length };
  return { text: `${s.slice(0, cap)}…`, elided: true, total: s.length };
}
