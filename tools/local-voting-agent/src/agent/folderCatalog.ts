import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildAlbumArtExtractionArgs, buildFfprobeMetadataArgs, parseFfprobeMetadata } from './ffmpeg';
import type { CatalogSong, JingleTrack } from './types';

const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav', '.webm']);
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const GENERIC_ART_NAMES = ['cover', 'folder', 'front', 'album'];

function stableId(prefix: string, filePath: string): string {
  return `${prefix}-${createHash('sha1').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 12)}`;
}

export function metadataFromFileName(filePath: string): { title: string; artist: string } {
  const base = path.basename(filePath, path.extname(filePath)).replaceAll('_', ' ').trim();
  const separator = base.indexOf(' - ');
  if (separator > 0 && separator < base.length - 3) {
    return {
      artist: base.slice(0, separator).trim(),
      title: base.slice(separator + 3).trim(),
    };
  }

  return { title: base.replaceAll(/\s*-\s*/g, ' ').trim(), artist: artistFromFolder(filePath) };
}

function artistFromFolder(filePath: string): string {
  const folder = path.basename(path.dirname(filePath)).trim();
  return folder || 'RadioTEDU';
}

function walkAudioFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const found: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkAudioFiles(fullPath));
      continue;
    }

    if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      found.push(fullPath);
    }
  }

  return found;
}

function findAlbumArt(audioPath: string): string | null {
  const folder = path.dirname(audioPath);
  const baseName = path.basename(audioPath, path.extname(audioPath)).toLowerCase();
  const entries = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile());
  const byLowerName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry.name]));

  for (const extension of IMAGE_EXTENSIONS) {
    const exact = byLowerName.get(`${baseName}${extension}`);
    if (exact) {
      return path.join(folder, exact);
    }
  }

  for (const name of GENERIC_ART_NAMES) {
    for (const extension of IMAGE_EXTENSIONS) {
      const exact = byLowerName.get(`${name}${extension}`);
      if (exact) {
        return path.join(folder, exact);
      }
    }
  }

  return null;
}

function isReadableFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export interface CatalogScanOptions {
  ffprobePath?: string;
  ffmpegPath?: string;
  artCacheDir?: string;
}

function extractEmbeddedArt(filePath: string, songId: string, options: CatalogScanOptions): string | null {
  if (!options.ffmpegPath || !options.artCacheDir) {
    return null;
  }

  mkdirSync(options.artCacheDir, { recursive: true });
  const outputPath = path.resolve(options.artCacheDir, `${songId}.jpg`);
  if (existsSync(outputPath) && statSync(outputPath).size > 0) {
    return outputPath;
  }

  const result = spawnSync(options.ffmpegPath, buildAlbumArtExtractionArgs(filePath, outputPath), {
    windowsHide: true,
    timeout: 15_000,
    stdio: 'ignore',
  });
  return result.status === 0 && existsSync(outputPath) && statSync(outputPath).size > 0 ? outputPath : null;
}

function probeMetadata(filePath: string, ffprobePath?: string) {
  if (!ffprobePath) {
    return {};
  }

  const result = spawnSync(ffprobePath, buildFfprobeMetadataArgs(filePath), {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  return result.status === 0 ? parseFfprobeMetadata(result.stdout) : {};
}

export function scanFolderCatalog(musicRoots: string[], options: CatalogScanOptions = {}): CatalogSong[] {
  return musicRoots
    .flatMap(walkAudioFiles)
    .filter(isReadableFile)
    .sort((a, b) => a.localeCompare(b))
    .map((filePath) => {
      const id = stableId('song', filePath);
      const fallback = metadataFromFileName(filePath);
      const probed = probeMetadata(filePath, options.ffprobePath);
      const albumArtPath = findAlbumArt(filePath) ??
        (probed.hasArtwork ? extractEmbeddedArt(filePath, id, options) : null);
      return {
        id,
        title: probed.title?.trim() || fallback.title,
        artist: probed.artist?.trim() || fallback.artist,
        filePath,
        ...(albumArtPath ? { albumArtPath } : {}),
        ...(probed.durationSeconds ? { durationSeconds: probed.durationSeconds } : {}),
        enabled: true,
      };
    });
}

export function scanJingleCatalog(jingleRoots: string[]): JingleTrack[] {
  return jingleRoots
    .flatMap(walkAudioFiles)
    .filter(isReadableFile)
    .sort((a, b) => a.localeCompare(b))
    .map((filePath) => ({
      id: stableId('jingle', filePath),
      title: metadataFromFileName(filePath).title,
      filePath,
      enabled: true,
    }));
}
