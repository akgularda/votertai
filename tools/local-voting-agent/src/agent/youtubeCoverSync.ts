import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {CatalogSong} from './types';

const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav', '.webm']);
const ARCHIVE_LINE = /^youtube\s+([A-Za-z0-9_-]{6,32})$/;
const MAX_IMAGE_BYTES = 1_500_000;

interface CachedVideoMetadata {
  title: string;
  thumbnailUrl: string;
}

export interface YoutubeCoverSyncResult {
  archiveIds: number;
  downloaded: number;
  alreadyPresent: number;
  unmatched: number;
  failed: number;
}

export interface YoutubeCoverSyncOptions {
  songs: CatalogSong[];
  musicRoots: string[];
  artCacheDir: string;
  fetchImpl?: typeof fetch;
}

export function normalizeCoverMatchTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

async function readableFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

async function loadArchiveIds(musicRoots: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const root of musicRoots) {
    try {
      const archive = await fs.readFile(path.join(root, 'downloaded.txt'), 'utf8');
      for (const rawLine of archive.split(/\r?\n/)) {
        const match = ARCHIVE_LINE.exec(rawLine.trim());
        if (match) ids.add(match[1]);
      }
    } catch {
      // A plain music folder without a yt-dlp archive is valid.
    }
  }
  return [...ids];
}

async function loadMetadataCache(cachePath: string): Promise<Record<string, CachedVideoMetadata>> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as Record<string, CachedVideoMetadata>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function fetchVideoMetadata(videoId: string, fetchImpl: typeof fetch): Promise<CachedVideoMetadata> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const response = await fetchImpl(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
      {signal: controller.signal},
    );
    if (!response.ok) throw new Error(`youtube_oembed_${response.status}`);
    const payload = await response.json() as {title?: unknown; thumbnail_url?: unknown};
    if (typeof payload.title !== 'string' || !payload.title.trim()) throw new Error('youtube_title_missing');
    return {
      title: payload.title.trim(),
      thumbnailUrl: typeof payload.thumbnail_url === 'string' && payload.thumbnail_url.startsWith('https://')
        ? payload.thumbnail_url
        : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function downloadImage(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(url, {signal: controller.signal});
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!response.ok || !contentType.startsWith('image/')) throw new Error(`cover_download_${response.status}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) throw new Error('cover_too_large');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('cover_size_invalid');
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

function targetSidecar(song: CatalogSong): string {
  return path.join(path.dirname(song.filePath), `${path.basename(song.filePath, path.extname(song.filePath))}.jpg`);
}

function buildSongIndex(songs: CatalogSong[]): Map<string, CatalogSong[]> {
  const index = new Map<string, CatalogSong[]>();
  for (const song of songs) {
    if (!AUDIO_EXTENSIONS.has(path.extname(song.filePath).toLowerCase())) continue;
    const keys = new Set([
      normalizeCoverMatchTitle(song.title),
      normalizeCoverMatchTitle(path.basename(song.filePath, path.extname(song.filePath))),
    ]);
    for (const key of keys) {
      if (!key) continue;
      const matches = index.get(key) ?? [];
      matches.push(song);
      index.set(key, matches);
    }
  }
  return index;
}

async function writeSidecar(filePath: string, bytes: Uint8Array): Promise<void> {
  if (await readableFile(filePath)) return;
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, bytes, {flag: 'wx'});
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, {force: true}).catch(() => undefined);
  }
}

export async function synchronizeYoutubeCoverArt(options: YoutubeCoverSyncOptions): Promise<YoutubeCoverSyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const archiveIds = await loadArchiveIds(options.musicRoots);
  const result: YoutubeCoverSyncResult = {
    archiveIds: archiveIds.length,
    downloaded: 0,
    alreadyPresent: 0,
    unmatched: 0,
    failed: 0,
  };
  if (archiveIds.length === 0 || options.songs.length === 0) return result;

  const cacheDirectory = path.resolve(options.artCacheDir);
  const cachePath = path.join(cacheDirectory, 'youtube-cover-metadata.json');
  await fs.mkdir(cacheDirectory, {recursive: true});
  const metadataCache = await loadMetadataCache(cachePath);
  const songIndex = buildSongIndex(options.songs);
  let cacheChanged = false;

  for (const videoId of archiveIds) {
    try {
      let metadata = metadataCache[videoId];
      if (!metadata?.title) {
        metadata = await fetchVideoMetadata(videoId, fetchImpl);
        metadataCache[videoId] = metadata;
        cacheChanged = true;
      }

      const matches = songIndex.get(normalizeCoverMatchTitle(metadata.title)) ?? [];
      const targets = [...new Set(matches.map(targetSidecar))];
      if (targets.length === 0) {
        result.unmatched += 1;
        continue;
      }

      const missing: string[] = [];
      for (const target of targets) {
        if (await readableFile(target)) result.alreadyPresent += 1;
        else missing.push(target);
      }
      if (missing.length === 0) continue;

      const image = await downloadImage(metadata.thumbnailUrl, fetchImpl);
      for (const target of missing) {
        await writeSidecar(target, image);
        result.downloaded += 1;
      }
    } catch {
      result.failed += 1;
    }
  }

  if (cacheChanged) {
    const temporaryPath = `${cachePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(metadataCache, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, cachePath);
  }
  return result;
}
