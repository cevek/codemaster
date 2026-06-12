// Parse a debug spec — `'plugin:ts:*,watcher,-eviction'` — into a namespace matcher
// (ARCHITECTURE.md §13, `debug`-library conventions). Comma/space separated patterns;
// `*` matches any run of characters; a leading `-` excludes. Excludes beat includes.
// `DebugSystem.configure` consumes this; the parser stays pure so it is trivially
// testable.

export interface DebugMatcher {
  /** The normalized spec this matcher was built from. */
  readonly spec: string;
  enabled(ns: string): boolean;
}

export function parseDebugSpec(spec: string): DebugMatcher {
  const parts = spec
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const includes: RegExp[] = [];
  const excludes: RegExp[] = [];
  for (const part of parts) {
    if (part.startsWith('-')) {
      const body = part.slice(1);
      if (body.length > 0) excludes.push(patternToRegex(body));
    } else {
      includes.push(patternToRegex(part));
    }
  }

  return {
    spec: parts.join(','),
    enabled(ns) {
      if (excludes.some((re) => re.test(ns))) return false;
      return includes.some((re) => re.test(ns));
    },
  };
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
