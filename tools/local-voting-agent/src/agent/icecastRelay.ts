import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IcecastSourceConfig } from './types';
import { buildAuthenticatedIcecastOutputUrl, reconnectDelayMs, usesLegacyIcecastSource } from './icecastStreamer';

export interface IcecastSinkStatus {
  state: 'connecting' | 'connected' | 'retrying';
  attempt: number;
  lastError: string | null;
  updatedAt: string;
}

export interface IcecastPcmSink {
  writePcm(chunk: Buffer): void;
  status(): IcecastSinkStatus;
}

// This is intentionally the same continuous PCM -> AAC Icecast sink used by
// RadioTEDU BroadcastAI. The only station-specific difference is mount /ai.
export function buildIcecastPcmSinkArgs(config: IcecastSourceConfig): string[] {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-i',
    'pipe:0',
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    `${config.bitrateKbps}k`,
    '-profile:a',
    'aac_low',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-content_type',
    'audio/aac',
    '-f',
    'adts',
  ];
  if (usesLegacyIcecastSource(config)) {
    args.push('-legacy_icecast', '1');
  }
  args.push(
    '-user_agent',
    'RadioTEDU Broadcast Wall',
    '-ice_name',
    config.name,
    '-ice_description',
    config.description,
    '-ice_genre',
    config.genre,
    '-ice_public',
    '1',
    buildAuthenticatedIcecastOutputUrl(config),
  );
  return args;
}

export function startIcecastPcmSink(config: IcecastSourceConfig, ffmpegPath: string): IcecastPcmSink | null {
  if (!config.enabled) return null;

  let child: ChildProcessWithoutNullStreams | null = null;
  let backpressured = false;
  let failures = 0;
  let status: IcecastSinkStatus = {
    state: 'connecting',
    attempt: 1,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };

  const run = () => {
    const startedAt = Date.now();
    status = {
      state: 'connecting',
      attempt: failures + 1,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const connectingChild = spawn(ffmpegPath, buildIcecastPcmSinkArgs(config), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = connectingChild;
    backpressured = false;

    // FFmpeg may echo its authenticated output URL. Match BroadcastAI's sink
    // behavior while never retaining or printing the credential-bearing line.
    connectingChild.stdout.resume();
    connectingChild.stderr.resume();
    // Icecast can reset the source socket while PCM is being written. FFmpeg
    // then closes stdin and Node emits EPIPE on this stream. That is a sink
    // reconnect event, not a reason to crash the voting agent.
    connectingChild.stdin.on('error', () => undefined);
    connectingChild.stdin.on('drain', () => {
      backpressured = false;
    });
    const connectedTimer = setTimeout(() => {
      if (connectingChild.exitCode === null && !connectingChild.killed) {
        status = {
          state: 'connected',
          attempt: failures + 1,
          lastError: null,
          updatedAt: new Date().toISOString(),
        };
        const target = new URL(config.url);
        console.log(`[ICECAST PCM SINK] connected to ${target.host}${target.pathname}`);
      }
    }, 300);

    connectingChild.once('error', () => {
      status = {
        state: 'retrying',
        attempt: failures + 1,
        lastError: 'icecast_pcm_sink_spawn_failed',
        updatedAt: new Date().toISOString(),
      };
    });
    connectingChild.once('close', () => {
      clearTimeout(connectedTimer);
      if (child === connectingChild) child = null;
      backpressured = false;
      failures = Date.now() - startedAt >= 15_000 ? 1 : failures + 1;
      const retryMs = reconnectDelayMs(failures, 1_000, 30_000);
      status = {
        state: 'retrying',
        attempt: failures + 1,
        lastError: 'icecast_pcm_sink_disconnected',
        updatedAt: new Date().toISOString(),
      };
      console.error(`[ICECAST PCM SINK] disconnected; retrying in ${Math.ceil(retryMs / 1000)}s`);
      const timer = setTimeout(run, retryMs);
      timer.unref();
    });
  };

  run();
  return {
    writePcm(chunk) {
      if (!child || child.exitCode !== null || child.killed || child.stdin.destroyed || backpressured) return;
      try {
        if (!child.stdin.write(chunk)) backpressured = true;
      } catch {
        // The close handler owns retry scheduling. A synchronous EPIPE here is
        // the same source-disconnect race as the async stdin error above.
      }
    },
    status: () => ({ ...status }),
  };
}
