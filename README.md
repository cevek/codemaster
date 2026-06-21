# codemaster

**A stateful, always-on codebase inspector for TypeScript/React repos — built for AI agents.**

Codemaster runs as a daemon: it loads a flat federation of **plugins** (one per
domain — TS, SCSS, i18n, schema, framework adapters), each with its own internal
state and a small public API. Agents call **ops** — named, parameterized functions
that compose plugins — each exposed as its own MCP tool. There is no shared graph and no
disk cache; the plugins live in memory only.

It exists to stop agents from grepping their way through large codebases — handing
them dense, **proof-carrying** answers instead.

```
agent ──MCP tool──▶ facade ──IPC──▶ daemon (plugins + ops per workspace, multi-repo)
```

## The one rule

**Never lie to the agent.** A tool that contradicts what the agent can verify by
grepping is a tool the agent abandons. So:

- consistency beats speed (a 5–60 s answer is fine; a wrong one is fatal),
- every fact ships with the exact `file:line` + verbatim source that proves it,
- uncertainty is explicit (`unresolved` / `partial` / `dynamic`), never silent.

## The public surface

One MCP tool **per op**, plus `status` and `batch` — so the capability catalogue lives
permanently in the agent's tool-list and each op's args are a typed, visible schema:

| Tool                        | Purpose                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `<op>({...args, ...flags})` | one tool per op (`find_usages`, `rename_symbol`, …) — flat args + flags, generated `inputSchema` |
| `status()`                  | first-contact manifest — active plugins, per-op notes + concepts, freshness                      |
| `batch(requests)`           | many ops in one round-trip (`{name, args}` envelope; carries `sql`)                              |

The tool-list is the static union of every op (per-connection); an op whose plugin isn't
active for the resolved repo answers with an honest `unavailable`. `status` is the per-repo
deep dive (notes, concepts).

## Status

Early scaffold. The full design lives in **[ARCHITECTURE.md](ARCHITECTURE.md)**;
typed contracts in [`src/core`](src/core) are the source of truth for the shapes.
See the MVP roadmap (ARCHITECTURE.md §17) for build order.

## License

MIT.
