import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ProcessLock {
  release(): void;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireProcessLock(
  lockPath: string,
  pid = process.pid,
  isAlive: (candidatePid: number) => boolean = processIsAlive,
): ProcessLock | null {
  mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(lockPath, 'wx');
      writeFileSync(handle, `${pid}\n`, 'utf8');
      closeSync(handle);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            const owner = Number(readFileSync(lockPath, 'utf8').trim());
            if (owner === pid) unlinkSync(lockPath);
          } catch {
            // The supervisor can remove a stale lock on the next start.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner = 0;
      try {
        owner = Number(readFileSync(lockPath, 'utf8').trim());
      } catch {
        owner = 0;
      }
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) return null;
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
    }
  }

  return null;
}
