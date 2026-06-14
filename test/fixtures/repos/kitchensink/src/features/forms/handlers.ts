// traps: T4 (`handle` collision source #2 of 3 — also in core/handle.ts and shadowed locally
// in Form.tsx) · M6 (default export `submit` + named exports, consumed as
// `import submit, { handle as formHandle }`). Stub bodies.
import { Code } from '@/core/codes.ts';

export function handle(event: string): void {
  void event;
}

export function validate(value: string): boolean {
  return value.length > 0;
}

/** T13 — const-enum member refs in a 2nd file (members inlined, no runtime enum object). */
export function statusCode(value: string): Code {
  return value.length > 0 ? Code.Ok : Code.Retry;
}

export default function submit(payload: string): void {
  void payload;
}
