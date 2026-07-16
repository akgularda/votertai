import { spawn } from 'node:child_process';
import type { IcecastSourceConfig } from './types';
import { buildAuthenticatedIcecastOutputUrl, reconnectDelayMs, usesLegacyIcecastSource } from './icecastStreamer';

export interface IcecastRelayStatus {
  state: 'connecting' | 'connected' | 'retrying';
  attempt: number;
  lastError: string | null;
  updatedAt: string;
}

export function buildIcecastRelayArgs(inputUrl: string, config: IcecastSourceConfig): string[] {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'warning',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5',
    '-i',
    inputUrl,
    '-vn',
    '-c:a',
    'copy',
    '-content_type',
    'audio/mpeg',
    '-user_agent',
    'RadioTEDU Voting Relay',
    '-ice_name',
    config.name,
    '-ice_description',
    config.description,
    '-ice_genre',
    config.genre,
    '-ice_url',
    'https://radiotedu.com/vote/',
    '-ice_public',
    '1',
    '-f',
    'mp3',
  ];
  if (usesLegacyIcecastSource(config)) {
    args.push('-legacy_icecast', '1');
  }
  args.push(buildAuthenticatedIcecastOutputUrl(config));
  return args;
}

export function startIcecastRelay(
  config: IcecastSourceConfig,
  ffmpegPath: string,
  inputUrl: string,
): { status: () => IcecastRelayStatus } | null {
  if (!config.enabled) return null;

  let stopped = false;
  let failures = 0;
  let status: IcecastRelayStatus = {
    state: 'connecting',
    attempt: 1,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };

  const run = () => {
    if (stopped) return;
    const startedAt = Date.now();
    status = {
      state: 'connecting',
      attempt: failures + 1,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const child = spawn(ffmpegPath, buildIcecastRelayArgs(inputUrl, config), {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    // FFmpeg may include the authenticated output URL in stderr. Drain it
    // without retaining or printing credentials.
    child.stderr.resume();
    const connectedTimer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        status = {
          state: 'connected',
          attempt: failures + 1,
          lastError: null,
          updatedAt: new Date().toISOString(),
        };
        console.log(`[ICECAST RELAY] connected to ${new URL(config.url).host}${new URL(config.url).pathname}`);
      }
    }, 3_000);

    child.once('error', () => {
      status = {
        state: 'retrying',
        attempt: failures + 1,
        lastError: 'icecast_relay_spawn_failed',
        updatedAt: new Date().toISOString(),
      };
    });
    child.once('close', () => {
      clearTimeout(connectedTimer);
      if (stopped) return;
      failures = Date.now() - startedAt >= 15_000 ? 1 : failures + 1;
      const retryMs = reconnectDelayMs(failures, 1_000, 30_000);
      status = {
        state: 'retrying',
        attempt: failures + 1,
        lastError: 'icecast_relay_disconnected',
        updatedAt: new Date().toISOString(),
      };
      console.error(`[ICECAST RELAY] disconnected; retrying in ${Math.ceil(retryMs / 1000)}s`);
      const timer = setTimeout(run, retryMs);
      timer.unref();
    });
  };

  run();
  return {
    status: () => ({ ...status }),
  };
}
