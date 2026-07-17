// The SharedArrayBuffer breadcrumb layout — the wire shared by the main-thread beacon (writer,
// `beacon.ts`) and the watchdog worker (reader, `worker.ts`). One process = one wedge domain, so the
// slot holds ONE breadcrumb: the OLDEST live op (the wedge candidate). Under async concurrency
// several ops can be in flight on the one main thread at once; `beacon.ts` owns which one fills the
// slot (see its live-set), and this module is only the codec for that single slot. The worker — on
// its own un-wedged timer — reads it and, if the slot's op has been busy past the threshold,
// concludes the event loop is wedged (§1 never-hang). No I/O here: a pure buffer codec, unit-tested
// against `isWedged` in isolation.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

// Layout (byte offsets): [0..8) BigInt64 startEpochMs · [8..24) Int32 control block · [24..) text.
// BigInt64 lives first so it is 8-byte aligned; the control words and the text tail follow.
const CTRL_BYTE_OFFSET = 8;
const CTRL_WORDS = 4; // BUSY, SEQ, TEXT_LEN, + one spare
const BUSY = 0;
const SEQ = 1;
const TEXT_LEN = 2;
const TEXT_BYTE_OFFSET = CTRL_BYTE_OFFSET + CTRL_WORDS * 4; // 24

/** Max breadcrumb text bytes. `encodeInto` truncates to this — a multibyte char clipped at the
 *  boundary decodes lossy (never throws), which is fine for a diagnostic string. */
export const TEXT_CAP = 512;
export const SAB_BYTES = TEXT_BYTE_OFFSET + TEXT_CAP;

export interface BeaconViews {
  startMs: BigInt64Array;
  ctrl: Int32Array;
  text: Uint8Array;
}

/** Typed-array views over one `SharedArrayBuffer` — built once per side (main + worker). */
export function viewsOf(sab: SharedArrayBuffer): BeaconViews {
  return {
    startMs: new BigInt64Array(sab, 0, 1),
    ctrl: new Int32Array(sab, CTRL_BYTE_OFFSET, CTRL_WORDS),
    text: new Uint8Array(sab, TEXT_BYTE_OFFSET, TEXT_CAP),
  };
}

/** Stamp a breadcrumb (main thread). Start + text are written FIRST, then BUSY is published with an
 *  `Atomics.store` (release), so a reader that observes BUSY=1 via `Atomics.load` (acquire) always
 *  sees the matching start/text — never a torn "busy on a half-written breadcrumb". */
export function writeBusy(v: BeaconViews, startMs: number, text: string): void {
  const { written } = encoder.encodeInto(text, v.text); // inherently bounded by TEXT_CAP
  v.ctrl[TEXT_LEN] = written;
  // `Atomics.store` on the 64-bit start (not a plain assignment) so the worker never reads a torn
  // half-written timestamp on this kill path — cheap, and this is the value the reap decision rests on.
  Atomics.store(v.startMs, 0, BigInt(startMs));
  v.ctrl[SEQ] = ((v.ctrl[SEQ] ?? 0) + 1) | 0;
  Atomics.store(v.ctrl, BUSY, 1);
}

/** Clear the breadcrumb (main thread) — the main loop is idle / between ops. */
export function writeIdle(v: BeaconViews): void {
  Atomics.store(v.ctrl, BUSY, 0);
}

export interface BeaconSnapshot {
  busy: boolean;
  startMs: number;
  seq: number;
  text: string;
}

/** Read the current breadcrumb (worker thread). */
export function readBeacon(v: BeaconViews): BeaconSnapshot {
  const busy = Atomics.load(v.ctrl, BUSY) === 1;
  const startMs = Number(Atomics.load(v.startMs, 0));
  const seq = v.ctrl[SEQ] ?? 0;
  const len = Math.max(0, Math.min(TEXT_CAP, v.ctrl[TEXT_LEN] ?? 0));
  const text = len > 0 ? decoder.decode(v.text.subarray(0, len)) : '';
  return { busy, startMs, seq, text };
}

/** The wedge predicate — pure, shared by the worker and its unit test. The main thread is wedged
 *  when it has been busy on one breadcrumb past the threshold: the un-wedged worker keeps advancing
 *  wall-clock while the wedged main thread cannot reach the `writeIdle` that would clear BUSY. */
export function isWedged(snap: BeaconSnapshot, nowMs: number, thresholdMs: number): boolean {
  return snap.busy && snap.startMs > 0 && nowMs - snap.startMs >= thresholdMs;
}
