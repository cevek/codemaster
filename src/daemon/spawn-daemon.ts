// Spawn the singleton daemon as a DETACHED child (spec-daemon-singleton §2/§19). The daemon must
// outlive the bridge that spawned it (it is shared by all bridges), so the child is detached, its
// stdio is discarded (it speaks only over the socket, never stdout — §13), and it is `unref`ed so
// the bridge can exit independently. `process.execPath` + the resolved bin entry make this work
// under a global / npx install too (the daemon's own __dirname is not in the project).

import { spawn } from 'node:child_process';

/** Fire-and-forget: launch `node <bin> daemon`. The child binds the socket (or loses the bind race
 *  and exits — bin.ts `daemon` treats EADDRINUSE as "another daemon won"). `sockDir` forwards the
 *  test socket-dir seam so a spawned daemon shares the bridge's endpoint. */
export function spawnDaemon(binPath: string, sockDir: string | undefined): void {
  const child = spawn(process.execPath, [binPath, 'daemon'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...(sockDir !== undefined ? { CODEMASTER_SOCK_DIR: sockDir } : {}) },
  });
  child.unref();
}
