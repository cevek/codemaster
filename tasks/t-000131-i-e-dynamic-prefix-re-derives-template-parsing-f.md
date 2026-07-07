---
id: t-000131
title: I-e — dynamic-prefix re-derives template parsing from raw source (§4 boundary)
status: backlog
priority: medium
type: dx
complexity: M
area: i18n
created: '2026-07-08T00:02:10.000Z'
---
**I-e — dynamic-prefix re-derives template parsing from raw source (§4 boundary)** —
`staticDynamicPrefix` (`src/plugins/i18n/dynamic-prefix.ts`) extracts a dynamic `t(\`a.b.${x}\`)`
static head by backtick-counting + `indexOf('${')`over`span.text`— a second, text-based slice
of TS template parsing living outside`plugins/ts`(the §4 "one parser per domain" line). It errs
SAFE (an unfaithful head — escapes, inner backtick, raw CR/LF — bails to global demote, never a
false`certain`), but must conservatively drop legit prefixes the cooked value would keep. Proper
fix: have `plugins/ts` `literalArgFields`emit`staticPrefix`from`arg0.head.text`(the cooked
value) when`ts.isTemplateExpression(arg0)`; i18n consumes that proof-carrying field. `dx`·`med`·`cx:M`
