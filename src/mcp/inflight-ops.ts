// Best-effort op names for a crash breadcrumb (t-807677), read from the RAW tool arguments BEFORE
// dispatch parses them. For a per-op tool the tool-name IS the op-name; for `batch` the ops live in
// `requests[].name` (or the flat `{op}` spelling the batch normalizer accepts), and naming them is
// the whole point of the breadcrumb — "which op killed the process" is the first triage question.
// Purely defensive: unparseable arguments yield an empty list, never a throw and never a guess.

const MAX_OPS = 32;

export function inflightOps(tool: string, rawArgs: unknown): string[] {
  if (tool !== 'batch') return tool === 'status' ? [] : [tool];
  if (typeof rawArgs !== 'object' || rawArgs === null) return [];
  const requests = (rawArgs as { requests?: unknown }).requests;
  if (!Array.isArray(requests)) return [];
  const names: string[] = [];
  for (const request of requests.slice(0, MAX_OPS)) {
    if (typeof request !== 'object' || request === null) continue;
    const r = request as { name?: unknown; op?: unknown };
    // `op` wins over `name`: in the flat spelling (`{op:'find_usages', name:'Button'}`) `name`
    // holds the op's ARGUMENT, so reading it first would attribute the crash to a symbol name.
    const name = typeof r.op === 'string' ? r.op : typeof r.name === 'string' ? r.name : undefined;
    if (name !== undefined) names.push(name);
  }
  return names;
}
