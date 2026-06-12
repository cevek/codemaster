// The `DebugSystem` implementation (contract: core/debug.ts; design: §13).
// Namespaced, hot-togglable, request-correlated via `AsyncLocalStorage`. A disabled
// namespace no-ops after one boolean check and never builds its `k=v` strings — zero
// hot-path cost.
//
// Sinks come in two flavors: global (stderr; a daemon-wide file) receive every
// enabled line; routed sinks receive only lines of requests tagged with their key —
// this is how each workspace gets its own `~/.codemaster/<repoId>/debug.log` while
// one process serves many workspaces.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { DebugNamespace, Debugger, DebugSystem } from '../../core/debug.ts';
import type { Clock } from '../../common/async/clock.ts';
import { parseDebugSpec, type DebugMatcher } from '../../common/debug-spec/parse.ts';
import { formatDebugLine } from './line.ts';
import type { DebugSink } from './file-sink.ts';

interface RequestContext {
  id: number;
  /** Routed-sink key (the engine's repo key) this request belongs to. */
  route?: string;
  /** Per-request inline trace buffer, present when the request asked for it. */
  capture?: string[];
}

export interface RequestOptions {
  /** Collect this request's lines for the inline `Result.debug` trailer (§13). */
  capture?: boolean;
  /** Tag lines with a routed-sink key (per-repo debug.log). */
  route?: string;
}

export interface DebugSystemHandle extends DebugSystem {
  addSink(sink: DebugSink): void;
  addRoutedSink(key: string, sink: DebugSink): void;
  removeRoutedSink(key: string): void;
  /** Run `fn` under a fresh `req#N` context. */
  runWithRequest<T>(options: RequestOptions, fn: () => T): T;
  /** Drain the current request's captured lines (empty when capture was off). */
  takeCapture(): string[];
  dispose(): void;
}

const CAPTURE_CAP = 500;

export function createDebugSystem(clock: Clock, initialSpec = ''): DebugSystemHandle {
  const storage = new AsyncLocalStorage<RequestContext>();
  let matcher: DebugMatcher = parseDebugSpec(initialSpec);
  const sinks: DebugSink[] = [];
  const routedSinks = new Map<string, DebugSink>();
  const known = new Set<DebugNamespace>();
  const loggers = new Map<DebugNamespace, Debugger>();
  let nextRequestId = 1;

  const makeLogger = (ns: DebugNamespace): Debugger => {
    const fn = (message: string, data?: () => Record<string, unknown>): void => {
      const ctx = storage.getStore();
      const globallyOn = matcher.enabled(ns);
      const capturing = ctx?.capture !== undefined;
      if (!globallyOn && !capturing) return;
      const line = formatDebugLine(clock.now(), ctx?.id, ns, message, data?.());
      // Global sinks receive only globally-enabled namespaces; a per-call capture
      // sees the full trace of its own request without spamming the shared log.
      if (globallyOn) {
        for (const sink of sinks) sink.write(line);
        if (ctx?.route !== undefined) routedSinks.get(ctx.route)?.write(line);
      }
      if (ctx?.capture !== undefined && ctx.capture.length < CAPTURE_CAP) ctx.capture.push(line);
    };
    return Object.assign(fn, {
      ns,
      get enabled() {
        return matcher.enabled(ns) || storage.getStore()?.capture !== undefined;
      },
    }) as Debugger;
  };

  return {
    ns(ns) {
      known.add(ns);
      let logger = loggers.get(ns);
      if (logger === undefined) {
        logger = makeLogger(ns);
        loggers.set(ns, logger);
      }
      return logger;
    },
    isEnabled: (ns) => matcher.enabled(ns),
    configure(spec) {
      matcher = parseDebugSpec(spec);
    },
    topics: () => [...known].sort(),
    requests: storage,
    addSink(sink) {
      sinks.push(sink);
    },
    addRoutedSink(key, sink) {
      routedSinks.get(key)?.dispose();
      routedSinks.set(key, sink);
    },
    removeRoutedSink(key) {
      routedSinks.get(key)?.dispose();
      routedSinks.delete(key);
    },
    runWithRequest(options, fn) {
      const ctx: RequestContext = {
        id: nextRequestId++,
        ...(options.route !== undefined ? { route: options.route } : {}),
        ...(options.capture === true ? { capture: [] } : {}),
      };
      return storage.run(ctx, fn);
    },
    takeCapture() {
      const ctx = storage.getStore();
      if (ctx?.capture === undefined) return [];
      const lines = ctx.capture;
      ctx.capture = [];
      return lines;
    },
    dispose() {
      for (const sink of sinks) sink.dispose();
      for (const sink of routedSinks.values()) sink.dispose();
      sinks.length = 0;
      routedSinks.clear();
    },
  };
}
