---
id: t-288409
title: No op reaches string-literal config identity (env var names, config keys) — the last honest grep gap, and it decided a design because the negative question ("is OPENAI_BASE_URL referenced at all?") has no reliable answer
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
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
