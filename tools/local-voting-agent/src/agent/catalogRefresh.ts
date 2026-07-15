import type { CatalogSong } from './types';

export interface CatalogRefreshOptions {
  songs: CatalogSong[];
  intervalMs: number;
  scan: () => CatalogSong[];
  onChanged?: (songs: CatalogSong[]) => void;
  onError?: (error: unknown) => void;
}

function catalogSignature(songs: CatalogSong[]): string {
  return songs
    .map((song) => [song.id, song.title, song.artist, song.filePath, song.albumArtPath ?? '', song.durationSeconds ?? ''].join('\u0000'))
    .join('\u0001');
}

export function refreshCatalogInPlace(songs: CatalogSong[], nextSongs: CatalogSong[]): boolean {
  if (catalogSignature(songs) === catalogSignature(nextSongs)) {
    return false;
  }

  songs.splice(0, songs.length, ...nextSongs);
  return true;
}

export function startCatalogRefresh(options: CatalogRefreshOptions): () => void {
  if (options.intervalMs <= 0) {
    return () => undefined;
  }

  const refresh = () => {
    try {
      const nextSongs = options.scan();
      if (refreshCatalogInPlace(options.songs, nextSongs)) {
        options.onChanged?.(options.songs);
      }
    } catch (error) {
      options.onError?.(error);
    }
  };

  const timer = setInterval(refresh, options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
