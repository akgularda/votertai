import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { loadAgentConfig } from '../agent/config';
import { createBackendVotingClient } from '../agent/backendClient';
import { startCatalogRefresh } from '../agent/catalogRefresh';
import { createIcecastPlaybackController } from '../agent/icecastStreamer';
import { startIcecastRelay } from '../agent/icecastRelay';
import { createLocalHttpPlaybackController } from '../agent/localHttpStreamer';
import { createWallRuntimePlaybackController } from '../agent/wallRuntimePlaybackController';
import { scanFolderCatalog, scanJingleCatalog } from '../agent/folderCatalog';
import { loadSongCatalog } from '../agent/songCatalog';
import { createApp } from './app';

const config = loadAgentConfig();
const scanMusicLibrary = () => process.env.LOCAL_SONG_CATALOG
  ? loadSongCatalog(config.catalogPath, config.musicRoots)
  : scanFolderCatalog(config.musicRoots, {
      ffprobePath: config.ffprobePath,
      ffmpegPath: config.ffmpegPath,
      artCacheDir: config.artCacheDir,
    });
const songs = scanMusicLibrary();
startCatalogRefresh({
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
const backendClient = createBackendVotingClient(config.backend);
const playbackController =
  process.env.LOCAL_HTTP_STREAM_ENABLED === 'true'
    ? createLocalHttpPlaybackController(config.ffmpegPath, songs)
    : process.env.WALL_RUNTIME_PLAYBACK_ENABLED === 'true'
    ? createWallRuntimePlaybackController()
    : createIcecastPlaybackController(config.icecast, config.ffmpegPath, songs);
if (process.env.LOCAL_HTTP_STREAM_ENABLED === 'true' && playbackController) {
  const localStreamUrl = playbackController.status().streamUrl;
  if (localStreamUrl) {
    startIcecastRelay(config.icecast, config.ffmpegPath, localStreamUrl);
  }
}
const app = createApp({
  songs,
  jingles,
  candidateCount: config.candidateCount,
  playbackMode: config.playbackMode,
  jingleBeforeWinner: config.jingleBeforeWinner,
  backendClient,
  playbackController,
  backendPollIntervalMs: config.backend.enabled ? 3000 : 0,
  autoResolveAfterMs: config.autoResolveAfterMs,
  votingOpenBeforeEndMs: config.votingOpenBeforeEndMs,
  votingLockBeforeEndMs: config.votingLockBeforeEndMs,
  automationTickMs: config.automationTickMs,
  recentTrackLimit: config.recentTrackLimit,
});

const panelBuildDir = path.resolve(process.cwd(), 'dist');
const panelIndexPath = path.join(panelBuildDir, 'index.html');

if (existsSync(panelIndexPath)) {
  app.use(express.static(panelBuildDir));
  app.get('*', (_req, res) => res.sendFile(panelIndexPath));
}

app.listen(config.serverPort, '127.0.0.1', () => {
  console.log(`RadioTEDU local voting agent listening on http://127.0.0.1:${config.serverPort}`);
  console.log(`Voting library ready: ${songs.length} track(s), ${songs.filter((song) => song.albumArtPath).length} cover(s)`);
});
