import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshCatalogInPlace, startCatalogRefresh } from './catalogRefresh';
import type { CatalogSong } from './types';

const first: CatalogSong = {
  id: 'song-1',
  title: 'First',
  artist: 'RadioTEDU',
  filePath: 'C:/Music/first.mp3',
  enabled: true,
};

const second: CatalogSong = {
  id: 'song-2',
  title: 'Second',
  artist: 'RadioTEDU',
  filePath: 'C:/Music/second.mp3',
  enabled: true,
};

afterEach(() => vi.useRealTimers());

describe('live music catalog refresh', () => {
  it('replaces the shared catalog in place so playback and voting see new files', () => {
    const songs = [first];

    expect(refreshCatalogInPlace(songs, [first, second])).toBe(true);
    expect(songs).toEqual([first, second]);
    expect(refreshCatalogInPlace(songs, [first, second])).toBe(false);
  });

  it('keeps scanning after a transient folder error', () => {
    vi.useFakeTimers();
    const songs = [first];
    const onError = vi.fn();
    const scan = vi.fn()
      .mockImplementationOnce(() => { throw new Error('folder temporarily unavailable'); })
      .mockReturnValueOnce([first, second]);
    const stop = startCatalogRefresh({ songs, intervalMs: 1000, scan, onError });

    vi.advanceTimersByTime(2000);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(songs).toEqual([first, second]);
    stop();
  });
});
