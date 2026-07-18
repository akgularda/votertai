import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { loadAgentConfig } from '../agent/config';
import { createBackendVotingClient } from '../agent/backendClient';
import { refreshCatalogInPlace, startCatalogRefresh } from '../agent/catalogRefresh';
import { createIcecastPlaybackController } from '../agent/icecastStreamer';
import { startIcecastPcmSink } from '../agent/icecastRelay';
import { createLocalHttpPlaybackController } from '../agent/localHttpStreamer';
import { acquireProcessLock } from '../agent/processLock';
import { createWallRuntimePlaybackController } from '../agent/wallRuntimePlaybackController';
import { scanFolderCatalog, scanJingleCatalog } from '../agent/folderCatalog';
import { loadSongCatalog } from '../agent/songCatalog';
import { synchronizeYoutubeCoverArt } from '../agent/youtubeCoverSync';
import { createApp } from './app';

const processLock = acquireProcessLock(path.resolve(process.cwd(), 'var', 'voting-agent.lock'));
if (!processLock) {
  console.log('RadioTEDU local voting agent is already running; duplicate start ignored');
  process.exit(0);
}
const activeProcessLock = processLock;
process.once('exit', () => activeProcessLock.release());
console.log('[BOOT] process lock acquired');

const config = loadAgentConfig();
console.log('[BOOT] configuration loaded');
const scanMusicLibrary = () => process.env.LOCAL_SONG_CATALOG
  ? loadSongCatalog(config.catalogPath, config.musicRoots)
  : scanFolderCatalog(config.musicRoots, {
      ffprobePath: config.ffprobePath,
      ffmpegPath: process.env.EXTRACT_EMBEDDED_ALBUM_ART === 'true' ? config.ffmpegPath : undefined,
      artCacheDir: config.artCacheDir,
    });
console.log('[BOOT] scanning music catalog');
const songs = scanMusicLibrary();
console.log(`[BOOT] music catalog ready (${songs.length} tracks)`);
const stopCatalogRefresh = startCatalogRefresh({
  songs,
  intervalMs: config.catalogRefreshMs,
  scan: scanMusicLibrary,
  onChanged: (updatedSongs) => {
    console.log(`Voting library refreshed: ${updatedSongs.length} track(s), ${updatedSongs.filter((song) => song.albumArtPath).length} cover(s)`);
  },
  onError: () => {
    console.error('[CATALOG] music library refresh failed; keeping the last valid catalog');
  },
});
const jingles = scanJingleCatalog(config.jingleRoots);
console.log(`[BOOT] jingle catalog ready (${jingles.length} tracks)`);
const backendClient = createBackendVotingClient(config.backend);
console.log('[BOOT] backend client ready');
const localHttpStreamEnabled = process.env.LOCAL_HTTP_STREAM_ENABLED === 'true';
const icecastPcmSink = localHttpStreamEnabled ? startIcecastPcmSink(config.icecast, config.ffmpegPath) : null;
console.log('[BOOT] Icecast sink initialized');
const playbackController =
  localHttpStreamEnabled
    ? createLocalHttpPlaybackController(config.ffmpegPath, songs, undefined, icecastPcmSink)
    : process.env.WALL_RUNTIME_PLAYBACK_ENABLED === 'true'
    ? createWallRuntimePlaybackController()
    : createIcecastPlaybackController(config.icecast, config.ffmpegPath, songs);
console.log('[BOOT] playback controller initialized');
const app = createApp({
  songs,
  jingles,
  candidateCount: config.candidateCount,
  playbackMode: config.playbackMode,
  jingleBeforeWinner: config.jingleBeforeWinner,
  backendClient,
  playbackController,
  streamSourceStatus: icecastPcmSink?.status,
  backendPollIntervalMs: config.backend.enabled ? 3000 : 0,
  autoResolveAfterMs: config.autoResolveAfterMs,
  votingOpenBeforeEndMs: config.votingOpenBeforeEndMs,
  votingLockBeforeEndMs: config.votingLockBeforeEndMs,
  automationTickMs: config.automationTickMs,
  recentTrackLimit: config.recentTrackLimit,
});
console.log('[BOOT] voting application initialized');

const panelBuildDir = path.resolve(process.cwd(), 'dist');
const panelIndexPath = path.join(panelBuildDir, 'index.html');

if (existsSync(panelIndexPath)) {
  app.use(express.static(panelBuildDir));
  app.get('*', (_req, res) => res.sendFile(panelIndexPath));
}

const server = app.listen(config.serverPort, '127.0.0.1', () => {
  console.log(`RadioTEDU local voting agent listening on http://127.0.0.1:${config.serverPort}`);
  console.log(`Voting library ready: ${songs.length} track(s), ${songs.filter((song) => song.albumArtPath).length} cover(s)`);
});

let coverSyncRunning = false;
const coverSyncEnabled = !process.env.LOCAL_SONG_CATALOG && process.env.YOUTUBE_COVER_SYNC_ENABLED !== 'false';
const configuredCoverSyncMinutes = Number(process.env.YOUTUBE_COVER_SYNC_MINUTES);
const coverSyncIntervalMs =
  (Number.isFinite(configuredCoverSyncMinutes) && configuredCoverSyncMinutes > 0
    ? Math.max(1, configuredCoverSyncMinutes)
    : 15) * 60_000;
async function synchronizeCovers(): Promise<void> {
  if (!coverSyncEnabled || coverSyncRunning) return;
  coverSyncRunning = true;
  try {
    const result = await synchronizeYoutubeCoverArt({
      songs,
      musicRoots: config.musicRoots,
      artCacheDir: config.artCacheDir,
    });
    if (result.downloaded > 0) {
      refreshCatalogInPlace(songs, scanMusicLibrary());
      console.log(
        `[COVERS] downloaded ${result.downloaded} cover(s); catalog now has ${songs.filter((song) => song.albumArtPath).length}`,
      );
    } else if (result.failed > 0) {
      console.error(`[COVERS] ${result.failed} cover request(s) failed; automatic retry remains active`);
    }
  } catch {
    console.error('[COVERS] synchronization failed; voting continues and the next retry remains scheduled');
  } finally {
    coverSyncRunning = false;
  }
}
const coverSyncTimer = coverSyncEnabled
  ? setInterval(() => void synchronizeCovers(), coverSyncIntervalMs)
  : null;
coverSyncTimer?.unref();
if (coverSyncEnabled) setTimeout(() => void synchronizeCovers(), 1_000).unref();

let shuttingDown = false;
function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopCatalogRefresh();
  if (coverSyncTimer) clearInterval(coverSyncTimer);
  playbackController?.stop?.();
  icecastPcmSink?.stop();
  server.close(() => {
    activeProcessLock.release();
    process.exit(exitCode);
  });
  setTimeout(() => process.exit(exitCode), 5_000).unref();
}

server.once('error', () => {
  console.error('[FATAL] local agent listener failed; supervisor will restart it');
  shutdown(1);
});
process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));
process.once('uncaughtException', () => {
  console.error('[FATAL] uncaught agent exception; supervisor will restart it');
  shutdown(1);
});
process.once('unhandledRejection', () => {
  console.error('[FATAL] unhandled agent rejection; supervisor will restart it');
  shutdown(1);
});
