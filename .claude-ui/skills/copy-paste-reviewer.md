## codemaster — where existing code lives

Before accepting any new utility, search `core/`, `support/`, `common/`, `format/` — it often exists.
Frequent near-duplicates: parallel `switch` / `if` chains over one discriminated union (`Confidence`,
op-result unions, plugin-internal kind enums). Any proposed abstraction lands in the LOWEST layer every
one of its callers imports (src/README table) — extracting up or sideways breaks layering.
