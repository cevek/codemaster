# codemaster

**A stateful, always-on codebase inspector for TypeScript/React repos — built for AI agents.**

Codemaster runs as a daemon: it loads a flat federation of **plugins** (one per
domain — TS, SCSS, i18n, schema, framework adapters), each with its own internal
state and a small public API. Agents call **ops** — named, parameterized functions
that compose plugins — through a single MCP tool. There is no shared graph and no
disk cache; the plugins live in memory only.

It exists to stop agents from grepping their way through large codebases — handing
them dense, **proof-carrying** answers instead.

```
agent ──MCP op──▶ facade ──IPC──▶ daemon (plugins + ops per workspace, multi-repo)
```

## The one rule

**Never lie to the agent.** A tool that contradicts what the agent can verify by
grepping is a tool the agent abandons. So:

- consistency beats speed (a 5–60 s answer is fine; a wrong one is fatal),
- every fact ships with the exact `file:line` + verbatim source that proves it,
- uncertainty is explicit (`unresolved` / `partial` / `dynamic`), never silent.

## The public surface

Exactly three MCP tools — the agent's token tax is bounded:

| Tool                    | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `op({name, args, ...})` | run a named op (`find_usages`, `rename_symbol`, …; per-repo catalogue) |
| `status()`              | first-contact manifest — active plugins, op catalogue, freshness       |
| `batch(requests)`       | many ops in one round-trip                                             |

Ops are discovered through `status` — they cost zero standing context, only the
three tools above do.

## Status

Early scaffold. The full design lives in **[ARCHITECTURE.md](ARCHITECTURE.md)**;
typed contracts in [`src/core`](src/core) are the source of truth for the shapes.
See the MVP roadmap (ARCHITECTURE.md §17) for build order.

## License

MIT.
