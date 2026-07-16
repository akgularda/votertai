import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireProcessLock } from './processLock';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryLockPath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'radiotedu-voting-lock-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'voting-agent.lock');
}

describe('voting agent process lock', () => {
  it('allows one owner and rejects a second live owner', () => {
    const lockPath = temporaryLockPath();
    const first = acquireProcessLock(lockPath, 101, (pid) => pid === 101);
    const second = acquireProcessLock(lockPath, 202, (pid) => pid === 101);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(readFileSync(lockPath, 'utf8').trim()).toBe('101');
    first?.release();
  });

  it('replaces a stale lock and only lets its owner release it', () => {
    const lockPath = temporaryLockPath();
    const stale = acquireProcessLock(lockPath, 101, () => false);
    expect(stale).not.toBeNull();

    const replacement = acquireProcessLock(lockPath, 202, () => false);
    expect(replacement).not.toBeNull();
    stale?.release();
    expect(readFileSync(lockPath, 'utf8').trim()).toBe('202');
    replacement?.release();
  });
});
