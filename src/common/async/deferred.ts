// A promise with its resolvers exposed — the standard shape for request/response
// correlation (the IPC client keys pending requests by id and resolves them as
// responses arrive). Thin alias over `Promise.withResolvers` that keeps call sites on
// one named concept.

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}
