// Isolation vocabulary (§2/§9): HOW a workspace engine is hosted, and WHY it ended up that way.
// Lives in `core/` because both sides need it and neither owns it — the daemon DECIDES it at spawn
// (`daemon/escalate.ts`), while an op READS it off `OpContext.daemon` to explain a refusal.

/** Engine transport: `in-process` shares the daemon's heap (an OOM there is uncatchable and kills
 *  the daemon), `process` is a killable forked child. */
export type Isolation = 'in-process' | 'process';

/** The causes behind a workspace's resolved isolation. A CLOSED union: a consumer switches
 *  exhaustively, so a new cause is a compile error rather than a silently-misread old one. */
export type IsolationReason =
  /** `daemon.isolation` was set explicitly — honored verbatim, never escalated. */
  | 'configured'
  /** Oversized repo, auto-raised into a killable child under the `in-process` default. */
  | 'auto-escalated'
  /** Oversized, but `daemon.autoEscalate: false` pinned the mode. */
  | 'auto-escalate-disabled'
  /** Oversized and escalation was wanted, but this build provides no process-host factory. */
  | 'no-process-host'
  /** Oversized and escalation was attempted, but forking the child engine FAILED. */
  | 'escalation-failed'
  /** Within the size budget — the plain `in-process` default. */
  | 'within-budget'
  /** The cheap git size estimate failed, so size was UNKNOWN — never escalate on unknown. */
  | 'estimate-failed';
