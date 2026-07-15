import http from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import type { PlaybackController } from './icecastStreamer';
import type { CatalogSong, PlaybackPlan, PlaybackPlanEntry, PlaybackStatus } from './types';

interface StreamEntry {
  kind: PlaybackPlanEntry['kind'] | 'filler';
  title: string;
  filePath: string;
  songId?: string;
  artist?: string;
  durationSeconds?: number;
}

type LocalStreamCodec = 'mp3' | 'aac';

function normalizeCodec(raw: string | undefined): LocalStreamCodec {
  return raw?.toLowerCase() === 'aac' ? 'aac' : 'mp3';
}

function codecSettings(codec: LocalStreamCodec): {
  bitrate: string;
  contentType: string;
  encoderArgs: string[];
  extension: string;
} {
  if (codec === 'aac') {
    return {
      bitrate: '192',
      contentType: 'audio/aac',
      encoderArgs: ['-c:a', 'aac', '-b:a', '192k', '-f', 'adts'],
      extension: 'aac',
    };
  }

  return {
    bitrate: '128',
    contentType: 'audio/mpeg',
    encoderArgs: ['-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3'],
    extension: 'mp3',
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSong(songs: CatalogSong[]): StreamEntry | null {
  const enabled = songs.filter((song) => song.enabled !== false);
  if (enabled.length === 0) {
    return null;
  }
  const song = enabled[Math.floor(Math.random() * enabled.length)];
  return {
    kind: 'filler',
    title: song.title,
    filePath: song.filePath,
    songId: song.id,
    artist: song.artist,
    durationSeconds: song.durationSeconds,
  };
}

export function createLocalHttpPlaybackController(
  ffmpegPath: string,
  songs: CatalogSong[],
  port = Number(process.env.LOCAL_HTTP_STREAM_PORT || 4320),
): PlaybackController {
  const codec = normalizeCodec(process.env.LOCAL_HTTP_STREAM_CODEC);
  const settings = codecSettings(codec);
  const streamPath = process.env.LOCAL_HTTP_STREAM_PATH || `/stream.${settings.extension}`;
  const streamUrl = `http://127.0.0.1:${port}${streamPath}`;
  const clients = new Set<http.ServerResponse>();
  const queue: StreamEntry[] = [];
  let current: ChildProcessWithoutNullStreams | null = null;
  let currentKind: StreamEntry['kind'] | null = null;
  let loopStarted = false;
  let status: PlaybackStatus = {
    state: 'idle',
    codec,
    streamUrl,
    queuedEntries: 0,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };

  function broadcast(chunk: Buffer): void {
    for (const client of clients) {
      if (!client.destroyed) {
        client.write(chunk);
      }
    }
  }

  async function play(entry: StreamEntry): Promise<void> {
    currentKind = entry.kind;
    const startedAt = new Date();
    status = {
      ...status,
      state: 'playing',
      currentKind: entry.kind,
      currentTitle: entry.title,
      currentArtist: entry.artist,
      currentFilePath: entry.filePath,
      currentSongId: entry.songId,
      currentDurationSeconds: entry.durationSeconds,
      currentStartedAt: startedAt.toISOString(),
      currentEndsAt: entry.durationSeconds
        ? new Date(startedAt.getTime() + entry.durationSeconds * 1000).toISOString()
        : undefined,
      queuedEntries: queue.length,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    console.log(`Local HTTP stream: ${entry.kind} ${entry.title}`);
    current = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-re',
      '-i',
      entry.filePath,
      '-vn',
      '-ar',
      '48000',
      '-ac',
      '2',
      ...settings.encoderArgs,
      'pipe:1',
    ]);

    current.stdout.on('data', (chunk: Buffer) => broadcast(chunk));
    current.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) {
        console.error(`Local HTTP stream ffmpeg: ${line}`);
      }
    });

    try {
      await once(current, 'close');
    } finally {
      current = null;
      currentKind = null;
      status = {
        ...status,
        state: queue.length > 0 ? 'queued' : 'idle',
        queuedEntries: queue.length,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async function loop(): Promise<void> {
    while (true) {
      const entry = queue.shift() ?? randomSong(songs);
      if (!entry) {
        await wait(1000);
        continue;
      }

      try {
        await play(entry);
      } catch (error) {
        status = {
          ...status,
          state: 'error',
          queuedEntries: queue.length,
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        };
        console.error(`Local HTTP stream failed: ${error instanceof Error ? error.message : String(error)}`);
        await wait(1000);
      }
    }
  }

  const server = http.createServer((req, res) => {
    const requestPath = req.url?.split('?')[0] ?? '';
    if (![streamPath, '/stream.mp3', '/stream.aac', '/stream'].includes(requestPath)) {
      res.writeHead(404).end('not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': settings.contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'icy-name': 'RadioTEDU Local Voting',
      'icy-genre': 'Events',
      'icy-br': settings.bitrate,
    });
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Local HTTP ${codec.toUpperCase()} stream listening on ${streamUrl}`);
  });

  if (!loopStarted) {
    loopStarted = true;
    void loop();
  }

  return {
    enqueue(plan: PlaybackPlan) {
      const entries = plan.entries.map((entry) => ({
        kind: entry.kind,
        title: entry.title,
        filePath: entry.filePath,
        songId: entry.songId,
        artist: entry.artist,
        durationSeconds: entry.durationSeconds,
      }));
      const missingEntry = entries.find((entry) => !existsSync(entry.filePath));
      if (missingEntry) {
        status = {
          ...status,
          state: 'error',
          lastError: `playback_file_missing:${missingEntry.filePath}`,
          updatedAt: new Date().toISOString(),
        };
        return status;
      }

      queue.unshift(...entries);
      const winner = [...entries].reverse().find((entry) => entry.kind === 'winner');
      status = {
        ...status,
        state: current && currentKind !== 'filler' ? status.state : 'queued',
        queuedEntries: queue.length,
        lastWinnerTitle: winner?.title ?? status.lastWinnerTitle,
        lastWinnerFilePath: winner?.filePath ?? status.lastWinnerFilePath,
        lastError: null,
        updatedAt: new Date().toISOString(),
      };
      if (current && currentKind === 'filler') {
        current.kill();
      }
      return status;
    },
    status() {
      return { ...status, queuedEntries: queue.length };
    },
  };
}
