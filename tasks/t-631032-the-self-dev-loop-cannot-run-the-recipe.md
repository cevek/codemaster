---
id: t-631032
title: "The self-dev loop cannot run the recipe it documents: `batch`/`sql` are MCP-only, the MCP daemon is a machine-global singleton serving pre-edit code, and `daemon restart` is an action on other agents' warm LS"
status: backlog
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
