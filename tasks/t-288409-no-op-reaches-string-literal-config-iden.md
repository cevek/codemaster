---
id: t-288409
title: No op reaches string-literal config identity (env var names, config keys) — the last honest grep gap, and it decided a design because the negative question ("is OPENAI_BASE_URL referenced at all?") has no reliable answer
status: backlog
priority: high
parent: t-647309
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-100043
  - t-162650
  - t-194771
  - t-228385
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-07-28T19:49:03.012Z'
---
External report, `/Users/cody/Dev/claude-ui`. Task: add a per-model custom OpenAI-compatible endpoint to a
codex backend.

Worth recording the positive half first, because it is the shape we want: the symbol work was covered well
— `symbols_overview` → `source` → `member_usages` carried it. The gap was the part that **decided the
design**: "where does this repo set a backend's auth/config dir env, and which env var names are already
load-bearing?"

The answers — `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and crucially the ABSENCE of `OPENAI_BASE_URL` — are
string literals inside an env object literal. No symbol op reaches them, so the decision was made by grep.

**These literals are not prose.** They are config identity with a well-defined syntactic shape: keys of an
object literal assigned to a spawn/env parameter, `process.env.X` reads, `ProcessEnv` index accesses. That
is exactly the kind of structure the ts plugin already scans for other purposes (`literalCalls`,
`callArgShapes`).

Ask: an op (`env_keys` / `config_keys`) listing them with their sites, distinguishing WRITTEN from READ and
naming which spawn call each flows into.

**The negative question is what makes this load-bearing.** "Is `OPENAI_BASE_URL` referenced anywhere in
this repo?" is the question the design turned on, and grep answers it only as well as the agent's guess at
spellings — a miss reads exactly like a real absence. This is the same family as the three proven-absence
findings from this session (t-100043, t-162650, t-194771): an absence that nothing establishes as
measured.

CLAUDE.md already states the honest scope — grep is correct for "literal non-symbol text: log lines,
TODOs, config keys, prose". This report says config KEYS do not belong in that list: they have structure,
they are load-bearing, and their absence is a decision input.

## Field evidence — the same class as a store-collection key, with the read/write split as the load-bearing half (dogfood-inbox-aug)

The class is not env vars specifically: it is **a string literal in a known accessor position that IS the
identity of an entity**, with no symbol anywhere. Generalised shape asked for by the field: a configurable
**string-keyed accessor** — `{function, argIndex}` — after which the literal in that position is indexed as
a symbol. One rule then covers `collection('payments_v2')`, `store.get('x')`, `table('users')`,
`queryKeys.x`, `overrideHandler('<operationId>')`, `t('<key>')`, and `process.env.X` alike.

**Direction is the half grep cannot supply and the half decisions rest on.** The report is explicit: who
WRITES a key versus who READS it is what decides whether the data can be trusted, and a text search says
nothing about it. So write-sites (push/splice/assignment to an element field) and read-sites must be
separated in the answer, grouped by enclosing declaration like `find_usages`.

### Свидетельство

2026-08-03, `amiro/local-api-fixtures`. The whole mock backend addresses data by string:
`localStore.collection<PaymentV2Dto>('payments_v2')`, `collection('sales_v2')`, `'encounter_files'`,
`'medication_revisions'`. The type parameter is shared by a dozen sites, and the collection itself is not a
symbol. Questions asked "literally dozens of times" in one track, none expressible:

- who WRITES to `'payments_v2'` (does every payment go through `payV2Sale`, or is there a direct push past
  the handler — which decides whether a payment can exist without a line snapshot);
- who READS `'sales_v2'` after `sale.total` changed meaning;
- which collections the seed fills and which stay empty — "no fixture" being indistinguishable from
  "nothing to show" is the exact defect class that track was fixing.

Fallback: grep on the string literal plus separating declaration from use by eye. `find_usages` on
`localStore.collection` returns 200+ call sites with no discrimination between collections. Cost: a
consumer was MISSED (`bi-reports.ts`, a second reader of the changed semantics) and found only by
adversarial review; the same track reports two of its review findings were "a second consumer of the same
key the author did not know about".

Priority raised `high → urgent`: a second independent external report, a missed consumer that review had to
catch, and a generalisation that subsumes several separately-requested ops.

Priority note: the raise to `urgent` is withdrawn — this class errs toward OMISSION (a missed consumer, a
silent read/write asymmetry), which is the `high` band. The evidence above stands unchanged.
