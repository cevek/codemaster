---
id: t-141874
title: CLI `op batch` answers `unknown op 'batch'` with a list of known ops — true about that surface, false about the tool, which is the §3.6 shape the project catches elsewhere
status: in-progress
priority: low
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-28T11:57:57.417Z'
---
`codemaster op batch '…'` replies `unknown op 'batch'` followed by the list of ops it does know.

`batch` is not unknown — it exists, it is documented, it is one of the two composition surfaces the tool
advertises (§11). It simply lives on the MCP surface and not on the CLI one. The message is true about the
CLI and false about codemaster, and the reader has no way to tell which claim was made.

That is precisely the §3.6 failure the project polices everywhere else: report capability honestly, and
never let "I cannot do this here" read as "this does not exist". An agent that takes the message at face
value concludes the composition feature is not real.

Fix is one clause: `batch` is an MCP-surface tool, not a CLI op — and, once t-631032 lands, name the CLI
form that does work instead.

Found while the worker was being pushed onto the CLI by the self-dev loop (t-631032), i.e. by exactly the
population most likely to hit it.
