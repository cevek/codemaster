// Ties an MCP answer's side effects to its actual delivery: an action registered for a request id
// runs only after the transport SENT that request's result — never for a cancelled call (the SDK
// does not send it) or a send that failed.

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface Delivery {
  onSent(requestId: string | number, signal: AbortSignal, action: () => void): void;
}

/** Wraps `transport.send` in place; call before `server.connect(transport)`. */
export function trackDelivery(transport: Transport): Delivery {
  const pending = new Map<string | number, () => void>();
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const id = 'id' in message && 'result' in message ? message.id : undefined;
    try {
      await send(message, options);
      if (id !== undefined) pending.get(id)?.();
    } finally {
      if (id !== undefined) pending.delete(id);
    }
  };
  return {
    onSent(requestId, signal, action) {
      if (signal.aborted) return;
      pending.set(requestId, action);
      signal.addEventListener('abort', () => pending.delete(requestId));
    },
  };
}
