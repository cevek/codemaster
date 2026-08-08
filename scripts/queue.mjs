#!/usr/bin/env node
// Executable work queue over the task-manager backlog.
//
// evidence is the GATE (it records an observed action — a number, a repro command —
// so it cannot be inflated by judgement); type is the ORDERING axis (a proven live
// lie outranks a measured improvement — ARCHITECTURE.md §1). Inside one type,
// evidence breaks the tie.
//
// Every gate reports what it removed, and the type gate additionally names the
// PROVEN work it makes invisible — a filtered set that does not name its cut reads
// as the whole (§3.4).

import { execFileSync } from 'node:child_process';

const GATES = {
  leaf: 'has children (an epic is an axis, not work)',
  complexity: 'complexity:L (a fat task / needs design)',
  type: 'type not in bug,perf,imp,dx',
  evidence: 'evidence not in measured,repro (unproven)',
};

const TYPE_ORDER = ['bug', 'perf', 'imp', 'dx'];
const EVIDENCE_ORDER = ['measured', 'repro'];
const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'];
const COMPLEXITY_ORDER = ['S', 'M', 'L'];

const HEAD_COHORT_MIN = 20; // bug+measured, leaf, <=M — warn BEFORE the pool empties
const POOL_MIN = 30;

function parseArgs(argv) {
  const opts = { n: 10, json: false, all: false, legacyAxes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n' || a === '--limit') opts.n = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--legacy-axes') opts.legacyAxes = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown flag: ${a} (see --help)`);
  }
  if (!Number.isFinite(opts.n) || opts.n < 1) throw new Error('-n must be a positive integer');
  return opts;
}

const HELP = `usage: node scripts/queue.mjs [-n N] [--all] [--json] [--legacy-axes]

  -n N            show top N (default 10)
  --all           show the whole pool
  --json          machine-readable output
  --legacy-axes   sort evidence before type (comparison only)`;

function loadTasks() {
  let raw;
  try {
    raw = execFileSync('tm', ['--json', 'list', '-status:done -status:rejected'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`tm failed — cannot read the backlog: ${err.message}`);
  }
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error('tm --json did not return an array');
  return rows.map((r) => r.task).filter(Boolean);
}

/** Run the gates in order, recording what each removed. */
function applyGates(tasks) {
  const funnel = [{ gate: 'open', kept: tasks.length }];
  let set = tasks;
  const step = (name, pred) => {
    const before = set.length;
    set = set.filter(pred);
    funnel.push({ gate: name, why: GATES[name], removed: before - set.length, kept: set.length });
  };
  step('leaf', (t) => (t.children?.length ?? 0) === 0);
  step('complexity', (t) => t.fields?.complexity !== 'L');
  const preType = set;
  step('type', (t) => TYPE_ORDER.includes(t.fields?.type));
  step('evidence', (t) => EVIDENCE_ORDER.includes(t.fields?.evidence));
  return { pool: set, funnel, preType };
}

const rank = (order, v) => {
  const i = order.indexOf(v);
  return i === -1 ? order.length : i;
};

function comparator(legacyAxes) {
  const axes = legacyAxes
    ? [(t) => rank(EVIDENCE_ORDER, t.fields?.evidence), (t) => rank(TYPE_ORDER, t.fields?.type)]
    : [(t) => rank(TYPE_ORDER, t.fields?.type), (t) => rank(EVIDENCE_ORDER, t.fields?.evidence)];
  const keys = [
    (t) => (t.priority === 'urgent' ? 0 : 1), // urgent pinned to the top
    ...axes,
    (t) => rank(PRIORITY_ORDER, t.priority),
    (t) => rank(COMPLEXITY_ORDER, t.fields?.complexity),
  ];
  return (a, b) => {
    for (const k of keys) {
      const d = k(a) - k(b);
      if (d !== 0) return d;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // deterministic: same output every run
  };
}

function health(tasks, pool, funnel, preType) {
  const invisible = tasks.filter(
    (t) => !t.fields?.type || !t.fields?.complexity || !t.fields?.evidence,
  );
  // Proven work the type gate hides — named, never silently dropped (§3.4).
  const provenCut = preType.filter(
    (t) => !TYPE_ORDER.includes(t.fields?.type) && EVIDENCE_ORDER.includes(t.fields?.evidence),
  );
  const byType = {};
  for (const t of provenCut)
    byType[t.fields?.type ?? '(none)'] = (byType[t.fields?.type ?? '(none)'] ?? 0) + 1;
  const head = pool.filter((t) => t.fields?.type === 'bug' && t.fields?.evidence === 'measured');
  return {
    open: tasks.length,
    pool: pool.length,
    funnel,
    headCohort: head.length,
    invisible: invisible.length,
    invisibleIds: invisible.map((t) => t.id).sort(),
    provenCutByType: byType,
    warnings: [
      pool.length < POOL_MIN && `POOL LOW: ${pool.length} < ${POOL_MIN} — the queue runs dry soon`,
      head.length < HEAD_COHORT_MIN &&
        `HEAD COHORT LOW: bug+measured = ${head.length} < ${HEAD_COHORT_MIN} — the proven-defect head empties first; refill by reproducing/measuring open bugs`,
    ].filter(Boolean),
  };
}

/** An empty pool names WHICH gate emptied it and a runnable next step (ops/guard/navigate.ts). */
function emptyReport(funnel) {
  let culprit = funnel[funnel.length - 1];
  for (let i = 1; i < funnel.length; i++) {
    if (funnel[i].kept === 0 && funnel[i - 1].kept > 0) {
      culprit = funnel[i];
      break;
    }
  }
  const next = {
    leaf: 'tm list "-status:done" — every open task has children; split an epic into leaf work',
    complexity: 'tm list "-status:done complexity:L" — decompose an L task into S/M subtasks',
    type: 'tm list "-status:done -type:bug,perf,imp,dx" — retype work that is a defect/perf/improvement',
    evidence:
      'tm list "-status:done type:bug,perf,imp,dx -evidence:measured,repro" — reproduce one on current main, then set evidence=repro',
  }[culprit.gate];
  return [
    `!! EMPTY QUEUE — not an empty backlog.`,
    `gate that emptied it: ${culprit.gate} (${culprit.why}) — removed ${culprit.removed}, kept 0`,
    `next: ${next}`,
  ].join('\n');
}

function renderRow(t, i) {
  const f = t.fields ?? {};
  return `${String(i + 1).padStart(2)}. ${t.id}  ${f.type}/${f.evidence}  ${t.priority}/${f.complexity ?? '?'}  ${f.area ?? '—'}  ${t.title}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP + '\n');
    return;
  }
  const tasks = loadTasks();
  const { pool, funnel, preType } = applyGates(tasks);
  const sorted = [...pool].sort(comparator(opts.legacyAxes));
  const h = health(tasks, pool, funnel, preType);
  const shown = opts.all ? sorted : sorted.slice(0, opts.n);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          health: h,
          axes: opts.legacyAxes ? ['evidence', 'type'] : ['type', 'evidence'],
          shown: shown.length,
          queue: shown.map((t) => ({
            id: t.id,
            title: t.title,
            priority: t.priority,
            type: t.fields?.type,
            evidence: t.fields?.evidence,
            complexity: t.fields?.complexity,
            area: t.fields?.area,
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const out = [];
  out.push(
    `pool ${h.pool} of ${h.open} open · sort: ${opts.legacyAxes ? 'urgent → evidence → type' : 'urgent → type → evidence'} → priority → complexity → id`,
  );
  out.push(
    'gates: ' +
      funnel
        .slice(1)
        .map((g) => `${g.gate} -${g.removed} → ${g.kept}`)
        .join(' | '),
  );
  out.push(
    `invisible to the rule (no type|complexity|evidence): ${h.invisible} — never queued at any priority`,
  );
  const cut = Object.entries(h.provenCutByType).sort();
  out.push(
    `proven work cut by the type gate: ${cut.length ? cut.map(([k, v]) => `${k} ${v}`).join(', ') : 'none'}`,
  );
  for (const w of h.warnings) out.push(`!! ${w}`);
  out.push('');
  if (!sorted.length) out.push(emptyReport(funnel));
  else {
    out.push(...shown.map(renderRow));
    if (shown.length < sorted.length)
      out.push(`… ${sorted.length - shown.length} more (-n N | --all)`);
  }
  process.stdout.write(out.join('\n') + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`queue: ${err.message}\n`);
  process.exitCode = 1;
}
