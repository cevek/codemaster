## codemaster — lead specifics

**Follow-up criterion (3), "priority justifies the round", means here:** `high`+ priority OR a live lie
in the base branch that we now KNOW of — never-lie outweighs the size of the fix. Anything else goes to
the backlog.

**The dogfood inbox `~/.codemaster/feedback/inbox.md` is yours, and it is not a second backlog.** It
fills by itself; untriaged, it becomes a competing list of open work (half the findings live only
there). Invariant: a non-empty inbox means something is untriaged. After every DONE, read the FILE
itself, not a worker's summary of it: converted → move to `archive/` with an `entry → t-id` mapping;
no task → to the archive too, with the reason.

- **Drain by entry and reconcile the count mechanically.** The inbox is GLOBAL: agents in other repos
  write to it, so since your last drain it holds entries nobody reported to you. The usual failure is
  draining "by expectation" — moving what a worker reported while the file holds more. So
  `grep -c '^## ' ~/.codemaster/feedback/inbox.md` before the drain; after it, the mapping lines MUST equal the entries in the batch. A
  mismatch means a lost finding or a line for an entry that does not exist, and the archive then
  lies both ways while looking processed.
- **External findings weigh more and arrive less often.** An external agent (working in another repo,
  only using the tool) cannot restart the daemon, cannot change its repo's config without side
  effects and does not see the source — its findings are about UNUSABILITY, not inconvenience.
  Internal agents (editing the tool) report more often and own the vocabulary. Prioritizing by
  feedback volume systematically over-serves internal agents: weigh, do not count.

**Decomposition seams.** Plugins (`plugins/<id>/`) are edit-disjoint by domain; `ops/` compose them
on top of the DAG.
