// The default text mode (§12): dense, coded, zero JSON ceremony. No braces, no
// quotes, no escapes — `k=v` lines, `key (N):` list headers, indentation for nesting.
// A list line is one fact; a k=v value runs to end-of-line, so values with spaces stay
// greppable without quoting. `format=json` remains the machine-composition escape
// hatch; this renderer is what an agent reads.

import type { JsonValue } from '../../core/json.ts';

const INLINE_OBJECT_CAP = 100;

export function renderDense(value: JsonValue): string {
  return renderLines(value, 0).join('\n');
}

function renderLines(value: JsonValue, indent: number): string[] {
  const pad = ' '.repeat(indent);
  if (typeof value === 'string') {
    return value.split('\n').map((line) => pad + line);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return [pad + String(value)];
  }
  if (isJsonArray(value)) {
    const lines: string[] = [];
    for (const item of value) {
      if (typeof item === 'object' && item !== null && !isJsonArray(item)) {
        // Object items get a `-` bullet on their first line so entries stay separable.
        const block = renderLines(item, indent + 2);
        const first = block[0];
        if (first !== undefined) lines.push(`${pad}- ${first.trimStart()}`, ...block.slice(1));
      } else {
        lines.push(...renderLines(item, indent));
      }
    }
    return lines;
  }

  // Object: inline when every value is a compact whitespace-free scalar.
  const entries = Object.entries(value);
  if (entries.length === 0) return [`${pad}(empty)`];
  const inline = tryInline(entries, pad);
  if (inline !== undefined) return [inline];

  const lines: string[] = [];
  for (const [key, child] of entries) {
    if (typeof child === 'string' && !child.includes('\n')) {
      lines.push(`${pad}${key}=${child}`);
    } else if (child === null || typeof child === 'number' || typeof child === 'boolean') {
      lines.push(`${pad}${key}=${String(child)}`);
    } else if (isJsonArray(child)) {
      lines.push(`${pad}${key} (${child.length}):`);
      lines.push(...renderLines(child, indent + 2));
    } else {
      lines.push(`${pad}${key}:`);
      lines.push(...renderLines(child, indent + 2));
    }
  }
  return lines;
}

function tryInline(entries: [string, JsonValue][], pad: string): string | undefined {
  const parts: string[] = [];
  for (const [key, child] of entries) {
    const scalar =
      child === null || typeof child === 'number' || typeof child === 'boolean'
        ? String(child)
        : typeof child === 'string' && !/\s/.test(child)
          ? child
          : undefined;
    if (scalar === undefined) return undefined;
    parts.push(`${key}=${scalar}`);
  }
  const line = pad + parts.join(' ');
  return line.length <= INLINE_OBJECT_CAP ? line : undefined;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
