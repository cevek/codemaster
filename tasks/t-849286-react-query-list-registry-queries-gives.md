---
id: t-849286
title: 'react-query: `list {registry:''queries''}` gives the registry but not the CONSUMPTION shape — the "loading gate covers only 1 of N queries" defect class stays grep-shaped'
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T08:28:06.770Z'
---
Hunting a bug CLASS — "the rendered row set depends on N queries, but the loading gate covers only one of
them" — there was no op that could express it, so the hunt fell back to grep over `isLoading` / `?? []`:
exactly the silent-miss case the repo tells agents to avoid.

What was needed: `query_sites` listing every `useQuery`/`useSuspenseQuery`/`useQueries` call site with
(a) suspense vs non-suspense, (b) the enclosing component, (c) whether the returned `data` is consumed
through a DEFAULTING expression (`data?.x ?? []`, `data ? f(data) : passthrough`), and (d) whether the
enclosing component reads that query's `isLoading`/`isPending`.

An anti-join over (c) AND NOT (d) is precisely the defect class — and one SQL away if the rows existed
(the anti-join machinery is proven, t-933867).

Instances found by hand in that repo, each fitting the pattern:
- `src/routes/_app/team.tsx:71-90` — second query's `Set|null` passthrough filters the visible rows; the
  gate reads only the first query's `isLoading`.
- `src/features/tasks/TasksView/useTasksWorkspaceFilters.ts:169-177` — employee-name→uuid map from a
  non-suspense query; while empty, the persisted assignee filter is silently dropped from request params.
- `src/features/sales/SalesView/useDetailedSalesEvents.ts:40-46` + `SalesView.tsx:144` — patient names from
  a second query feed a client-side text filter.

Note the shape: all three are SILENT wrong-output bugs, not crashes — the class that survives review
precisely because no query can enumerate it.

## The `file:line` coordinates above are HISTORICAL — verify by name before using them

They were recorded mid-track in a repo under active editing (amiro, ~3 days before this task was filed).
Lines have almost certainly moved, and some instances may have been fixed by that very track or a later
one. Treat them as *shape examples*, not as a repro list.

Before building on this task: re-locate each by SYMBOL NAME against current HEAD and confirm the defect
still exists. A worker that chases a moved line will either find nothing and conclude the task is bogus,
or find unrelated code at that offset and "fix" it — both worse than starting from the name.

What is durable here is the PATTERN, not the coordinates: a component whose rendered rows depend on N
queries while the loading gate reads only one query's `isLoading`, with the second query's data reaching
the render through a defaulting expression. That pattern is what the proposed `query_sites` + anti-join
would enumerate, and it is re-derivable on any current checkout.

Origin session (transcript readable via MCP; the agent is archived and its worktree is gone, so read the
transcript rather than messaging it): `~-Dev-amiro/sessions/786b8171`.
