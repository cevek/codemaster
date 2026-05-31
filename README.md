# codemaster

**A stateful, always-on codebase inspector for TypeScript/React repos — built for AI agents.**

Codemaster runs as a daemon: it indexes your project, watches the filesystem,
keeps a TypeScript Language Service warm, and answers structural, semantic, and
refactor queries through a handful of universal verbs. It exists to stop agents
from grepping their way through large codebases — handing them dense, semantic,
**proof-carrying** answers instead.

```
agent ──MCP tool──▶ facade ──IPC──▶ daemon (index + live TS LS, multi-repo)
```

## The one rule

**Never lie to the agent.** A tool that contradicts what the agent can verify by
grepping is a tool the agent abandons. So:

- consistency beats speed (a 5–60 s answer is fine; a wrong one is fatal),
- every fact ships with the exact `file:line` + verbatim source that proves it,
- uncertainty is explicit (`unresolved` / `partial` / `dynamic`), never silent.

## The six verbs

| Verb      | Purpose                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `search`  | find symbols / text / JSX by rich filters                                       |
| `resolve` | expanded type, signature, members, assignability (live TS LS)                   |
| `refs`    | semantic find-usages, faceted by call/jsx/import/type                           |
| `trace`   | control- and data-flow (field→render, mutation→invalidation, prop-through-tree) |
| `list`    | domain registries (routes, mutations, stores, dialogs…) via adapters            |
| `edit`    | refactors + shape codemods, dry-run-first, git-aware, atomic                    |

Higher-level "recipes" (`component_card`, `feature_map`, …) are pure compositions
of these six.

## Status

Early scaffold. The full design lives in **[ARCHITECTURE.md](ARCHITECTURE.md)**;
the typed contracts in [`src/core`](src/core) and
[`src/primitives/contracts.ts`](src/primitives/contracts.ts) are the source of
truth for the shapes. See the MVP roadmap (ARCHITECTURE.md §17) for build order.

## License

MIT.
