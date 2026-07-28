---
id: t-631032
title: "The self-dev loop cannot run the recipe it documents: `batch`/`sql` are MCP-only, the MCP daemon is a machine-global singleton serving pre-edit code, and `daemon restart` is an action on other agents' warm LS"
status: done
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-28T08:45:07.052Z'
---
Hit while building the anti-join recipe (t-933867): the worker documented a `batch + sql` recipe as the
pasteable answer to "which ops lack a guard", and then could not run it from the loop CONTRIBUTING
prescribes for self-development.

The bind, three links:
1. `batch` and `sql` exist only on the MCP surface — the CLI `op` path has no way to carry them.
2. The MCP path goes through the machine-global singleton daemon, which serves the code it SPAWNED with —
   i.e. pre-edit code, exactly what the §3.6 self-staleness banner warns about.
3. The documented remedy, `codemaster daemon restart`, is not local: on a machine running several agents
   it discards every other agent's warm LS. During this wave that meant 3-4 concurrent workers, so
   "restart to test my change" is a side effect on colleagues' latency.

So the one composition feature the tool advertises for exactly this class of question is unreachable from
the fresh-code path, and reachable only via an action with cross-agent blast radius. The CLI one-shot
(~1.7 s, always current source — t-034392) is otherwise the right tool and is missing just this.

Cheapest fix, and the one the reporter recommends: accept `--sql` (and the batch shape) on the CLI `op`
path. The evaluator is already a seam (`support/sql/`, lazy better-sqlite3), the producers are ops, and a
one-shot process has no staleness problem by construction.

Worth noting what DID work in the same session, since it is the counterexample: the ambiguity failure
named `mergeDeclarations:true` as the escape, and `!! LOWER BOUND` fired correctly on a live incomplete
query — both landed exactly as designed.

## This is the ROOT of the grep-fallback pattern, not one more instance of it

From worker de6fa39b, which spent an entire track REBUILDING the honesty mechanism and made **zero**
symbol queries to codemaster. All three of its reference-graph questions went to grep. It ran the CLI
constantly — but only as a behavioural probe of op OUTPUT, never once as a question about a symbol.

The causal chain it names, and it is structural rather than behavioural:

1. A worker editing `src/` makes the MCP path stale-by-construction — the daemon serves the code it
   spawned with.
2. The honest remedy is `daemon restart` after every edit; on a multi-agent machine that discards other
   agents' warm LS, so the cheap escape is the CLI one-shot, always fresh.
3. The CLI has no `batch`/`sql`.
4. Therefore the loop pushes the tool-editing worker onto the ONE surface that cannot express composed
   questions — and its third question was by nature a batch/sql question.

So **the agent with the most reason to dogfood is designed away from the richest surface**, and the
standing choice is "fresh answers OR composable ones", where freshness wins every time. That plausibly
explains why four workers across three waves independently reported falling back to grep on
reference-graph questions — it is not four lapses of discipline, it is one property of the loop.

Sharpest single data point: the question that cost this track a `[BLOCK]` (which factories reassemble the
envelope, so which ones could drop an ambient channel) was answerable in one call —
`find_usages {name:'ok', file:'src/common/result/construct.ts', groupBy:'enclosing'}` lists every envelope
factory, `sql-batch.ts assemble` among them. Two reviewers found it by reading; the tool would have found
it by asking. And for the second question the precise op was `member_usages` — one of the four this very
track was fixing.

Related, each a facet of the same loop rather than a separate cause: t-089408 (the symbol question has no
salience amid legitimate greps), t-034392 (the stale banner names only the expensive remedy),
t-933867 (the same population failure measured on another track).

## Scope caveat: this serves ONE of two populations — do not generalize the remedy

codemaster has two distinct user populations, and every finding in the inbox belongs to one of them:

- **Internal** — agents editing codemaster itself. The MCP path is stale-by-construction for them, so the
  loop pushes them onto the CLI. That is the causal chain above, and this task is their fix.
- **External** — agents working in OTHER repos (backoffice2, amiro, task-manager) who merely use the tool.
  Their daemon is fresh, MCP is the correct and richer surface (warm LS, `status`, per-op schemas standing
  in the tool list), and they have no reason to be on the CLI at all.

So the outcome of this task is **parity, not a recommendation**: the CLI stops being a reduced surface, so
whoever is on it by necessity no longer loses composition. It must NOT be phrased anywhere — messages,
notes, docs — as "prefer the CLI". For an external agent that advice is a downgrade: a one-shot pays cold
start on every call to solve a staleness problem they do not have.

Why this distinction matters beyond wording: the external population operates under STRICTER constraints
and reports less often. They cannot restart the daemon (it is machine-global, other agents' warm state),
cannot write a config into the repo they are working in without evicting every other client of it
(t-187018), and have no access to the tool's source to diagnose anything. Prioritizing by volume of
feedback therefore over-serves the internal population, which is prompted to report and knows the
vocabulary. Their findings — t-959904, t-089408, t-109741, t-849286, t-159797 — are the external half, and
they are about the tool being unusable rather than inconvenient.

## Measured limit of this fix: it removed ONE fork, not the cause (from the worker who shipped it)

After `batch --sql` was working on the always-fresh CLI — ~40 minutes into its own track — the same worker
still asked **zero** symbol questions of the tool. So "freshness OR composability" was not the whole
mechanism. Three causes, in its order of bite:

1. **Latency ratio where the grep risk is genuinely LOW.** For "what does this relative specifier resolve
   to", the specifier IS literal text; the silent-miss failure mode barely applies, and an honest cost
   calculation picks grep. The rule "symbol questions go to the tool" is right on average and wrong on
   this instance — and agents evaluate instances.
2. **Location is not the edit.** codemaster returns `file:line`; the agent then opens the file anyway.
   `grep -n` returns the line WITH its surroundings, which is the actual input to an edit.
   `verbosity:'full'` does not close this — it returns the span, not the neighbourhood.
3. **Zero salience at the point of need** (t-089408).

Cause 2 is the one nobody had named: for a question that ENDS in an edit, a precise location is a
partial answer and a fuzzy neighbourhood is a complete one.

So this task's value stands — the CLI is no longer a reduced surface — but it should not be recorded as
having fixed the grep-fallback pattern. See t-089408 (salience) and the discoverability asymmetry filed
alongside it.
