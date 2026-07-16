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

const PCM_SAMPLE_RATE = 48_000;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SAMPLE = 2;
const SILENCE_FRAME_MS = 20;
const SILENCE_FRAME = Buffer.alloc(
  Math.floor((PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE * SILENCE_FRAME_MS) / 1000),
);

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
  let encoder: ChildProcessWithoutNullStreams | null = null;
  let currentKind: StreamEntry['kind'] | null = null;
  let loopStarted = false;
  let encoderRestartTimer: NodeJS.Timeout | null = null;
  let pcmBackpressured = false;
  let lastPcmWriteAt = 0;
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
      if (client.destroyed) {
        clients.delete(client);
        continue;
      }
      if (client.writableLength > 1024 * 1024) {
        client.destroy();
        clients.delete(client);
        continue;
      }
      client.write(chunk);
    }
  }

  function startEncoder(): void {
    if (encoder && encoder.exitCode === null && !encoder.killed) return;
    if (encoderRestartTimer) {
      clearTimeout(encoderRestartTimer);
      encoderRestartTimer = null;
    }

    encoder = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-f',
      's16le',
      '-ar',
      String(PCM_SAMPLE_RATE),
      '-ac',
      String(PCM_CHANNELS),
      '-i',
      'pipe:0',
      '-vn',
      ...settings.encoderArgs,
      'pipe:1',
    ], { windowsHide: true });
    pcmBackpressured = false;
    encoder.stdout.on('data', (chunk: Buffer) => broadcast(chunk));
    encoder.stdin.on('drain', () => {
      pcmBackpressured = false;
      current?.stdout.resume();
    });
    encoder.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) console.error(`Local HTTP stream encoder: ${line}`);
    });
    encoder.on('error', (error) => {
      status = {
        ...status,
        state: 'error',
        lastError: `local_stream_encoder:${error.message}`,
        updatedAt: new Date().toISOString(),
      };
    });
    encoder.on('close', () => {
      encoder = null;
      pcmBackpressured = false;
      if (!encoderRestartTimer) {
        encoderRestartTimer = setTimeout(startEncoder, 500);
      }
    });
  }

  function writePcm(chunk: Buffer): void {
    startEncoder();
    if (!encoder || encoder.stdin.destroyed || !encoder.stdin.writable || pcmBackpressured) return;
    lastPcmWriteAt = Date.now();
    if (!encoder.stdin.write(chunk)) {
      pcmBackpressured = true;
      current?.stdout.pause();
    }
  }

  // Keep the encoder and every connected listener alive while a decoder starts,
  // a file is skipped, or the next selected track is being opened.
  const silenceTimer = setInterval(() => {
    if (Date.now() - lastPcmWriteAt >= SILENCE_FRAME_MS * 2) {
      writePcm(SILENCE_FRAME);
    }
  }, SILENCE_FRAME_MS);
  silenceTimer.unref();
  startEncoder();

  async function play(entry: StreamEntry): Promise<void> {
    currentKind = entry.kind;
    const startedAt = new Date();
    status = {
      ...status,
      state: 'queued',
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
      '-c:a',
      'pcm_s16le',
      '-ar',
      String(PCM_SAMPLE_RATE),
      '-ac',
      String(PCM_CHANNELS),
      '-f',
      's16le',
      'pipe:1',
    ], { windowsHide: true });

    let started = false;
    current.stdout.on('data', (chunk: Buffer) => {
      if (!started) {
        started = true;
        status = {
          ...status,
          state: 'playing',
          currentStartedAt: new Date().toISOString(),
          lastError: null,
          updatedAt: new Date().toISOString(),
        };
      }
      writePcm(chunk);
    });
    current.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) {
        console.error(`Local HTTP stream ffmpeg: ${line}`);
      }
    });

    try {
      const [code] = (await once(current, 'close')) as [number | null];
      if (code !== 0 && code !== 255 && !current.killed) {
        throw new Error(`local_stream_decoder_exit_${code ?? 'unknown'}`);
      }
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
    if (![streamPath, '/ai', '/stream.mp3', '/stream.aac', '/stream'].includes(requestPath)) {
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
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
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
