// Repeated static prose an agent needs once per MCP session (§12 "prose folding"). A producer
// interpolates `full` verbatim, so the `Result` it builds is unchanged; only the MCP facade, which
// remembers what one client connection has already been shown, may replace a repeat with `short`.

export interface Lesson {
  /** Stable handle — `status {concept:"<id>"}` prints `full` for it. */
  readonly id: string;
  /** The exact substring producers emit. Static: facts (counts, names, targets) stay outside it. */
  readonly full: string;
  /** What replaces a repeat — still an assertion, never a bare pointer. */
  readonly short: string;
  /** `root`: the same words state a different fact per repo, so a repeat is folded per root. */
  readonly scope: 'session' | 'root';
}

export function defineLesson(lesson: {
  id: string;
  full: string;
  short: string;
  scope?: 'session' | 'root';
}): Lesson {
  return Object.freeze({ ...lesson, scope: lesson.scope ?? 'session' });
}

/** The folded form: the short assertion plus the id that expands it. */
export function lessonRef(lesson: Lesson): string {
  return `${lesson.short} [${lesson.id}]`;
}
