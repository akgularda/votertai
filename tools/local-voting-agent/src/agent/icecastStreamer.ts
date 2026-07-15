import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { CatalogSong, IcecastSourceConfig, PlaybackPlan, PlaybackPlanEntry, PlaybackStatus } from './types';

export interface PlaybackController {
  enqueue(plan: PlaybackPlan): PlaybackStatus;
  status(): PlaybackStatus;
}

export type IcecastErrorCode = 'icecast_ffmpeg_failed' | 'icecast_stream_failed';

export function toIcecastErrorCode(error: unknown): IcecastErrorCode {
  return error instanceof Error && error.message === 'icecast_ffmpeg_failed'
    ? 'icecast_ffmpeg_failed'
    : 'icecast_stream_failed';
}

export function sanitizeIcecastStatusUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'icecast_stream';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function reconnectDelayMs(failureCount: number, baseMs = 2000, maximumMs = 60_000): number {
  return Math.min(maximumMs, baseMs * 2 ** Math.max(0, failureCount - 1));
}

function songToEntry(song: CatalogSong): PlaybackPlanEntry {
  return {
    kind: 'winner',
    title: song.title,
    artist: song.artist,
    filePath: song.filePath,
    songId: song.id,
    durationSeconds: song.durationSeconds,
    ffmpegArgs: [],
  };
}

function chooseRandomEntry(fillerSongs: CatalogSong[], recentSongIds: string[]): PlaybackPlanEntry | null {
  const enabledSongs = fillerSongs.filter((song) => song.enabled !== false);
  if (enabledSongs.length === 0) return null;
  const freshSongs = enabledSongs.filter((song) => !recentSongIds.includes(song.id));
  const pool = freshSongs.length > 0 ? freshSongs : enabledSongs;
  return songToEntry(pool[Math.floor(Math.random() * pool.length)]);
}

export function buildAuthenticatedIcecastOutputUrl(config: IcecastSourceConfig): string {
  const publicUrl = new URL(config.url);
  publicUrl.username = config.username;
  publicUrl.password = config.password;
  const port = Number(publicUrl.port || (publicUrl.protocol === 'https:' ? 443 : 80));
  const protocol = port === 443 ? 'https' : port === 80 ? 'http' : publicUrl.protocol === 'https:' ? 'icecasts' : 'icecast';
  const defaultPort = (protocol === 'https' && port === 443) || (protocol === 'http' && port === 80);
  const host = defaultPort ? publicUrl.hostname : publicUrl.host;
  return `${protocol}://${publicUrl.username}:${publicUrl.password}@${host}${publicUrl.pathname}${publicUrl.search}`;
}

export function usesLegacyIcecastSource(config: IcecastSourceConfig): boolean {
  const publicUrl = new URL(config.url);
  const port = Number(publicUrl.port || (publicUrl.protocol === 'https:' ? 443 : 80));
  return port !== 80 && port !== 443;
}

function buildIcecastArgs(entry: PlaybackPlanEntry, config: IcecastSourceConfig): string[] {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'warning',
    '-re',
    '-i',
    entry.filePath,
    '-vn',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-codec:a',
    'aac',
    '-b:a',
    `${config.bitrateKbps}k`,
    '-profile:a',
    'aac_low',
    '-user_agent',
    'RadioTEDU Broadcast Wall',
    '-ice_name',
    config.name,
    '-ice_description',
    config.description,
    '-ice_genre',
    config.genre,
    '-ice_url',
    'https://radiotedu.com',
    '-ice_public',
    '1',
    '-content_type',
    'audio/aac',
    '-f',
    'adts',
  ];
  if (usesLegacyIcecastSource(config)) {
    args.push('-legacy_icecast', '1');
  }
  args.push(buildAuthenticatedIcecastOutputUrl(config));
  return args;
}

async function streamEntry(
  entry: PlaybackPlanEntry,
  config: IcecastSourceConfig,
  ffmpegPath: string,
  onStarted: () => void,
): Promise<void> {
  const child = spawn(ffmpegPath, buildIcecastArgs(entry, config), {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // FFmpeg may echo its fully authenticated output URL, including URL-encoded
  // credentials and query tokens. Drain stderr without retaining or exposing it.
  child.stderr.resume();
  const startedTimer = setTimeout(onStarted, 1500);
  const [code] = (await once(child, 'close')) as [number | null];
  clearTimeout(startedTimer);
  if (code !== 0) {
    throw new Error('icecast_ffmpeg_failed');
  }
}

async function runContinuousSource(
  queue: PlaybackPlanEntry[],
  fillerSongs: CatalogSong[],
  config: IcecastSourceConfig,
  ffmpegPath: string,
  updateStatus: (patch: Partial<PlaybackStatus>) => void,
): Promise<void> {
  const recentSongIds: string[] = [];
  let consecutiveFailures = 0;
  for (;;) {
    const entry = queue.shift() ?? chooseRandomEntry(fillerSongs, recentSongIds);
    if (!entry) {
      await delay(1000);
      continue;
    }

    const startedAt = new Date();
    updateStatus({
      state: 'queued',
      currentKind: entry.kind,
      currentTitle: entry.title,
      currentArtist: entry.artist,
      currentFilePath: entry.filePath,
      currentSongId: entry.songId,
      currentDurationSeconds: entry.durationSeconds,
      currentStartedAt: undefined,
      currentEndsAt: undefined,
      queuedEntries: queue.length,
      lastError: null,
    });

    try {
      console.log(`Streaming to Icecast ${new URL(config.url).pathname}: ${entry.title}`);
      await streamEntry(entry, config, ffmpegPath, () => {
        updateStatus({
          state: 'playing',
          currentStartedAt: startedAt.toISOString(),
          currentEndsAt: entry.durationSeconds
            ? new Date(startedAt.getTime() + entry.durationSeconds * 1000).toISOString()
            : undefined,
          lastError: null,
        });
      });
      if (entry.songId) {
        recentSongIds.unshift(entry.songId);
        recentSongIds.splice(8);
      }
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const errorCode = toIcecastErrorCode(error);
      updateStatus({ state: 'error', queuedEntries: queue.length, lastError: errorCode });
      const retryMs = reconnectDelayMs(consecutiveFailures);
      console.error(`[ICECAST] ${errorCode}; retrying source connection in ${Math.ceil(retryMs / 1000)}s`);
      queue.unshift(entry);
      await delay(retryMs);
    }
  }
}

export function createIcecastPlaybackController(
  config: IcecastSourceConfig,
  ffmpegPath: string,
  fillerSongs: CatalogSong[] = [],
): PlaybackController | null {
  if (!config.enabled) return null;

  const queue: PlaybackPlanEntry[] = [];
  let status: PlaybackStatus = {
    state: 'idle',
    codec: 'icecast-aac',
    streamUrl: sanitizeIcecastStatusUrl(config.url),
    queuedEntries: 0,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
  const updateStatus = (patch: Partial<PlaybackStatus>) => {
    status = {
      ...status,
      ...patch,
      queuedEntries: patch.queuedEntries ?? queue.length,
      updatedAt: new Date().toISOString(),
    };
  };
  void runContinuousSource(queue, fillerSongs, config, ffmpegPath, updateStatus);

  return {
    enqueue(plan) {
      if (plan.mode !== 'live') return status;
      queue.push(...plan.entries);
      const winner = [...plan.entries].reverse().find((entry) => entry.kind === 'winner');
      status = {
        ...status,
        state: status.state === 'playing' ? 'playing' : 'queued',
        queuedEntries: queue.length,
        lastWinnerTitle: winner?.title ?? status.lastWinnerTitle,
        lastWinnerFilePath: winner?.filePath ?? status.lastWinnerFilePath,
        lastError: null,
        updatedAt: new Date().toISOString(),
      };
      return status;
    },
    status() {
      return { ...status, queuedEntries: queue.length };
    },
  };
}
