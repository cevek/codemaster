---
id: t-115173
title: 'Doc delta for the envelope-disclosure channel: §3.4 / §3.6 / §5-L0 / §5-L0.5 / §5-L3 / §12 / §15 / §16 + src/README L0.5 are closed enumerations that no longer match the code'
status: done
priority: high
tags:
  - docs
type: doc
complexity: S
area: docs
source: dogfood-jul
created: '2026-07-28T11:26:36.106Z'
---
`Result.disclosures` (core/result.ts) is a new agent-visible envelope honesty channel: resolve-time
claims the answer does NOT support, produced at the ts plugin's resolve chokepoint
(`plugins/ts/disclose-resolution.ts`), carried by a request-scoped ledger
(`support/disclosure/ledger.ts`), stamped by `daemon/engine.ts` `runOne`, merged across producers by
`common/result/merge-disclosures.ts`, rendered first in the cap-reserved tail.

The doc statements below are CLOSED enumerations or universal claims that the change makes
incomplete. Ready-to-paste replacements follow each.

**Do NOT add a new numbered §3 item (e.g. "§3.8 — disclosures").** Five code sites already cite
`(§3.4/§3.6)` — `core/result.ts`, `support/disclosure/ledger.ts`, `plugins/ts/disclose-resolution.ts`,
`format/render/render-result.ts`, `daemon/engine.ts`. A new number makes all five false on the day it
lands. Extend §3.4 and §3.6 in place; do not move the numbering.

---

### 1. ARCHITECTURE.md §3 item 4 — replace

```md
4. **No silent truncation — including a cut UPSTREAM of the answer.** Capped result sets always
   report `{ shown, total, hint }`. A cut the answer's own counters cannot express — the
   name→declaration candidate page sliced before the target was even resolved — rides the envelope
   instead, as `Result.disclosures: Disclosure[]` ([`src/core/result.ts`](src/core/result.ts)): a
   closed `UnsafeClaim` vocabulary naming WHAT THE ANSWER MAY NOT BE READ AS CLAIMING
   (`target-is-the-only-symbol-of-this-name`), never the upstream EVENT that made it unsafe — the
   cause and the remedy live in the entry's `note`, in prose, for the agent. Truncation that looks
   like completeness is a form of lying; so is a confident count over a target we may have mis-picked.
```

### 2. ARCHITECTURE.md §3 item 6 — append this paragraph

```md
   **Disclosure is a property of the RESOLUTION, not of an op's payload.** A claim established
   where the target was resolved (the `ts` plugin's resolve chokepoint,
   [`plugins/ts/disclose-resolution.ts`](src/plugins/ts/disclose-resolution.ts) — plus the
   `mergeDeclarations` resolver, which resolves outside it and states the same claim itself) is
   carried by a request-scoped ambient ledger
   ([`support/disclosure/ledger.ts`](src/support/disclosure/ledger.ts) — `AsyncLocalStorage`, never a
   module global: one process hosts several engines whose ops interleave, and attaching one repo's
   doubt to another's answer is the same lie inverted) and stamped onto the envelope by the
   dispatcher ([`daemon/engine.ts`](src/daemon/engine.ts) `runOne` — the tree's ONLY `op.run` call
   site, so no execution path slips past the stamp). An envelope assembled OVER other envelopes (the
   `sql` join, the cross-root join) forwards the channel through
   [`common/result/merge-disclosures.ts`](src/common/result/merge-disclosures.ts); a factory that
   forwarded `freshness` and `truncated` but not this would drop the claim exactly where an uncapped
   producer feeds a `NOT IN`. So every op answering about one target says the SAME thing about it; a
   NEW op inherits the claim by being dispatched, never by remembering to consume it; and two ops can
   never report contradictory confidence about one resolution. Stamped on BOTH arms (a `0`-shaped
   miss reads as absence just as a success does), merged never overwritten, and invisible when empty
   (an op that discloses nothing gets a byte-identical envelope). The inverse is enforced just as
   hard: an EXACT target (`symbolId` at its recorded position / `file:line:col` / `name+file`) ranks
   nothing, so it inherits no doubt — dressing a complete answer as partial is the same lie inverted.
   The WRITE path does not disclose but REFUSE: a mutation may not ride an ambiguity gate that
   silently did not run (§7). And a resolution that FAILED is not disclosed but returned as a
   failure: an op may not convert a "couldn't determine" into an `ok` answer shaped like a proven
   absence.
```

### 3. ARCHITECTURE.md §5-L0 — replace the `result` bullet

```md
- **`result`** — `Result<T>` envelope: `Fact`, `FreshnessNote`, `ToolFailure`, `Truncation`,
  `Disclosure` + the closed `UnsafeClaim` union (resolve-time claims the answer does NOT support,
  §3.4/§3.6).
```

### 4. ARCHITECTURE.md §5-L0.5 — the topic list gains an entry

```md
- **`result/`** — … plus `mergeDisclosures` (union the resolve-time claims of several envelopes —
  the `sql`/cross-root joins, which assemble a new envelope over producers' results).
```

*(The list is also missing `hash/`, `glob/`, `json/`, `condition/`, `shape-tag/`, `truncate/` — worth
closing while the line is being edited.)*

### 5. ARCHITECTURE.md §5-L1 (`support/`) — the subfolder list gains

```md
- **`disclosure/`** — the request-scoped disclosure ledger (`disclose` at the producer,
  `runWithDisclosures` at the dispatcher): ambient bookkeeping that carries a resolve-time
  `Disclosure` to the envelope of whatever op is answering (§3.4/§3.6). It sits here rather than in
  `common/` for the same reason the debug `req#N` ALS does: `common/` is pure logic over `core/`
  types, and per-request mutable state is not that.
```

### 6. ARCHITECTURE.md §5-L3 — replace the tail of "Ops never bypass plugins"

```md
every `Result<T>` envelope's proof spans, freshness, and `ToolFailure` come up through
plugin boundaries, not from internal pokes. One channel is plugin-PRODUCED but deliberately does
not ride the return value: a resolve-time `Disclosure` (§3.4/§3.6) is stated at the plugin's resolve
chokepoint into a request-scoped ledger and stamped on the envelope by the dispatcher. The op
neither consumes nor forwards it — which is precisely why no op can answer about a doubtful target
and stay silent, and why a new op needs no wiring to inherit the claim.
```

### 7. ARCHITECTURE.md §12 — replace the tail of "Verdict-before-bulk ordering"

```md
  ordering. **The verdict-first contract orders keys WITHIN `data`; the envelope-seam cap is a
  separate guarantee** — the renderer caps only the `data` region and reserves the envelope's
  honesty channels (disclosures / truncation / handle-rebind / freshness / intake) against the
  budget so they ALWAYS survive the cut, never trimmed off the tail (dropping a
  `freshness: UNVERIFIED`, a partial handle rebind, or a `!! CANNOT CLAIM` is the silent-stale /
  §6-misidentification / false-confidence lie). **Disclosures lead the tail**: they qualify what the
  WHOLE answer may be read as asserting (its target may not be the symbol the agent meant), where
  truncation qualifies only the listed set; entries sharing one claim collapse to a single line
  listing their targets, so a 20-target op does not spend the reserved budget restating one fact.
  Debug (a dev trace, not an honesty channel) is the only segment the cap may drop.
```

### 8. ARCHITECTURE.md §15 — three tree lines

```md
      result.ts              # proof-carrying envelope (Fact, FreshnessNote, ToolFailure, Truncation, Disclosure/UnsafeClaim)
```
```md
      disclosure/            # request-scoped disclosure ledger: disclose() at the producer, runWithDisclosures() at the dispatcher (§3.4/§3.6)
```
*(under `support/`)*
```md
      ts/                    # … ; disclose-resolution.ts: the resolve-time §3.4 envelope disclosure
```

### 9. ARCHITECTURE.md §16 — add invariant 8

```md
8. **Envelope-disclosure agreement** _(guards the §3.4/§3.6 resolve-time channel)_ — every op
   answering about ONE resolved target carries the IDENTICAL `Result.disclosures` entry. The oracle
   is the fixture's construction, never another codemaster answer: the repo DECLARES N same-named
   symbols, so "this is the only symbol of that name" is unsupportable for all of them equally, and
   the assertion is cross-op EQUALITY — a per-op verdict cannot satisfy it by accident. Four negative
   arms carry the same weight: an EXACT target inherits nothing (false partiality is the same lie
   inverted), an upstream cut that hid no same-named declaration discloses nothing (the CLAIM, not
   the EVENT), a neighbouring request in one batch never inherits another's claim (bleed is the
   ambient ledger's characteristic failure), and a name the cut hid ENTIRELY fails rather than
   answering `found:0` (a laundered "couldn't" is a proven absence the repo never established).
   `test/differential/envelope-disclosure.test.ts`, `test/unit/disclosure-ledger.test.ts`.
```

### 10. src/README.md — the L0.5 and L1 rows

L0.5 `result/` gains `mergeDisclosures`; L1 (`support/`) gains
`disclosure/` (the request-scoped resolve-time disclosure ledger — `disclose` at the producer,
`runWithDisclosures` at the dispatcher, §3.4/§3.6).

### 11. CONTRIBUTING.md — optional, one line under "Prime directive — never lie"

```md
A doubt established while RESOLVING a target belongs on the envelope (`Result.disclosures`,
§3.4/§3.6), not in one op's `data`: state it once at the resolve and every op answering about that
target inherits it — a per-op obligation is one an op can silently forget. A resolution that FAILED
is not disclosed but returned as a failure; an `ok` shaped like a proven absence is worse than an
incomplete answer.
```

---

Already applied in-branch (not for the doc track): `test/README.md`'s `differential/` line, and the
in-code enumerations in `format/render/render-result.ts`, `mcp/schema.ts` SERVER_INSTRUCTIONS, and the
`targets:` + new `disclosure:` lines in `format/render/concepts.ts`.
