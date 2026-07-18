import type { AgentConfig, CandidateCount, PlaybackMode } from './types';

const DEFAULT_CATALOG_PATH = 'data/songs.sample.json';
const DEFAULT_ART_CACHE_DIR = 'var/album-art';
const DEFAULT_MUSIC_ROOTS = ['C:/Music'];
const DEFAULT_SERVER_PORT = 4317;

export function normalizeCandidateCount(value: unknown): CandidateCount {
  return Number(value) === 2 ? 2 : 3;
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePlaybackMode(value: string | undefined): PlaybackMode {
  return value === 'live' ? 'live' : 'dry-run';
}

function normalizeBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function normalizePort(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SERVER_PORT;
}

function normalizeBitrate(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 64 && parsed <= 320 ? parsed : 192;
}

function normalizeIcecastCodec(value: string | undefined): 'aac' | 'mp3' {
  return value?.trim().toLowerCase() === 'mp3' ? 'mp3' : 'aac';
}

function normalizeIcecastTransport(value: string | undefined): 'auto' | 'http' | 'icecast' {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'http' || normalized === 'icecast' ? normalized : 'auto';
}

function normalizeNonNegativeSeconds(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed * 1000) : 0;
}

function normalizeSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed * 1000) : fallback * 1000;
}

function normalizePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBackendTransport(value: string | undefined, connectUrl: string): 'http' | 'websocket' {
  return value === 'websocket' || connectUrl ? 'websocket' : 'http';
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const musicRoots = splitList(env.MUSIC_LIBRARY_DIR).length > 0 ? splitList(env.MUSIC_LIBRARY_DIR) : splitList(env.MUSIC_ROOTS);
  const jingleRoots =
    splitList(env.JINGLE_LIBRARY_DIR).length > 0 ? splitList(env.JINGLE_LIBRARY_DIR) : splitList(env.JINGLE_ROOTS);
  const apiBaseUrl = env.BACKEND_API_BASE_URL?.trim() ?? '';
  const agentToken = env.BACKEND_AGENT_TOKEN?.trim() ?? '';
  const deviceId = env.BACKEND_DEVICE_ID?.trim() ?? '';
  const connectUrl = env.RADIO_AGENT_CONNECT_URL?.trim() ?? '';
  const radioAgentId = env.RADIO_AGENT_ID?.trim() || 'school-radio-pc';
  const radioAgentSecret = env.RADIO_AGENT_REQUEST_SECRET?.trim() ?? '';
  const backendTransport = normalizeBackendTransport(env.RADIO_AGENT_TRANSPORT, connectUrl);
  const icecastUrl = env.ICECAST_SOURCE_URL?.trim() ?? '';
  const icecastUsername = env.ICECAST_SOURCE_USERNAME?.trim() ?? '';
  const icecastPassword = env.ICECAST_SOURCE_PASSWORD?.trim() ?? '';

  return {
    candidateCount: normalizeCandidateCount(env.CANDIDATE_COUNT),
    catalogPath: env.LOCAL_SONG_CATALOG?.trim() || DEFAULT_CATALOG_PATH,
    musicRoots: musicRoots.length > 0 ? musicRoots : DEFAULT_MUSIC_ROOTS,
    jingleRoots,
    jingleBeforeWinner: normalizeBoolean(env.JINGLE_BEFORE_WINNER),
    artCacheDir: env.ALBUM_ART_CACHE_DIR?.trim() || DEFAULT_ART_CACHE_DIR,
    ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH?.trim() || 'ffprobe',
    playbackMode: normalizePlaybackMode(env.VOTING_AGENT_PLAYBACK_MODE),
    serverPort: normalizePort(env.PORT),
    catalogRefreshMs: normalizeSeconds(env.MUSIC_LIBRARY_REFRESH_SECONDS, 60),
    autoResolveAfterMs: normalizeNonNegativeSeconds(env.VOTING_ROUND_AUTO_RESOLVE_SECONDS),
    votingOpenBeforeEndMs: normalizeSeconds(env.VOTING_OPEN_BEFORE_END_SECONDS, 60),
    votingLockBeforeEndMs: normalizeSeconds(env.VOTING_LOCK_BEFORE_END_SECONDS, 10),
    automationTickMs: normalizeSeconds(env.VOTING_AUTOMATION_TICK_SECONDS, 1),
    recentTrackLimit: normalizePositiveInteger(env.VOTING_RECENT_TRACK_LIMIT, 8),
    backend: {
      transport: backendTransport,
      apiBaseUrl,
      agentToken,
      deviceId,
      connectUrl,
      agentId: radioAgentId,
      requestSecret: radioAgentSecret,
      reconnectMs: normalizePositiveInteger(env.RADIO_AGENT_RECONNECT_MS, 5000),
      enabled:
        env.BACKEND_SYNC_ENABLED !== 'false' &&
        (backendTransport === 'websocket'
          ? Boolean(connectUrl && radioAgentId && radioAgentSecret)
          : Boolean(apiBaseUrl && agentToken && deviceId)),
    },
    icecast: {
      enabled: normalizeBoolean(env.ICECAST_STREAM_ENABLED) && Boolean(icecastUrl && icecastUsername && icecastPassword),
      url: icecastUrl,
      username: icecastUsername,
      password: icecastPassword,
      bitrateKbps: normalizeBitrate(env.ICECAST_BITRATE_KBPS),
      codec: normalizeIcecastCodec(env.ICECAST_CODEC),
      sourceTransport: normalizeIcecastTransport(env.ICECAST_SOURCE_TRANSPORT),
      ...(env.ICECAST_LEGACY_SOURCE === undefined
        ? {}
        : { legacySource: normalizeBoolean(env.ICECAST_LEGACY_SOURCE) }),
      name: env.ICECAST_STREAM_NAME?.trim() || 'RadioTEDU Spark',
      genre: env.ICECAST_STREAM_GENRE?.trim() || 'RadioTEDU',
      description: env.ICECAST_STREAM_DESCRIPTION?.trim() || 'RadioTEDU next-song voting stream',
    },
  };
}
