// Render one debug event as one compact, greppable line (§13):
//
//   12:00:01.234 req#42 op:search_symbol q=Button hits=1 3ms
//
// `k=v` pairs are machine-greppable; big payloads are elided with a length marker
// (`type=…(214ch)`). Values are rendered flat — this is a trace line, not a JSON dump.

const VALUE_CAP = 120;

export function formatDebugLine(
  timeMs: number,
  reqId: number | undefined,
  ns: string,
  message: string,
  data?: Record<string, unknown>,
): string {
  const parts = [formatTime(timeMs)];
  if (reqId !== undefined) parts.push(`req#${reqId}`);
  parts.push(ns, message);
  if (data !== undefined) {
    for (const [key, value] of Object.entries(data)) {
      parts.push(`${key}=${formatValue(value)}`);
    }
  }
  return parts.join(' ');
}

function formatTime(timeMs: number): string {
  const d = new Date(timeMs);
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

function formatValue(value: unknown): string {
  const rendered = render(value);
  if (rendered.length > VALUE_CAP) {
    return `${rendered.slice(0, VALUE_CAP)}…(${rendered.length}ch)`;
  }
  return rendered;
}

function render(value: unknown): string {
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(render).join(',')}]`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}
