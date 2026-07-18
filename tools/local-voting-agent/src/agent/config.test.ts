import { describe, expect, it } from 'vitest';
import { loadAgentConfig, normalizeCandidateCount } from './config';

describe('agent config', () => {
  it('defaults candidate count to 3', () => {
    expect(normalizeCandidateCount(undefined)).toBe(3);
  });

  it('accepts only 2 or 3 candidates', () => {
    expect(normalizeCandidateCount('2')).toBe(2);
    expect(normalizeCandidateCount(3)).toBe(3);
    expect(normalizeCandidateCount('9')).toBe(3);
  });

  it('loads dry-run playback by default', () => {
    const config = loadAgentConfig({
      LOCAL_SONG_CATALOG: 'data/songs.sample.json',
      MUSIC_ROOTS: 'C:/Music;D:/Radio',
    });

    expect(config.playbackMode).toBe('dry-run');
    expect(config.musicRoots).toEqual(['C:/Music', 'D:/Radio']);
    expect(config.candidateCount).toBe(3);
  });

  it('defaults music roots to the sample catalog root', () => {
    expect(loadAgentConfig({}).musicRoots).toEqual(['C:/Music']);
  });

  it('loads folder database, jingle, and backend client settings from env', () => {
    const config = loadAgentConfig({
      MUSIC_LIBRARY_DIR: 'D:/Radio/Music',
      JINGLE_LIBRARY_DIR: 'D:/Radio/Jingles',
      JINGLE_BEFORE_WINNER: 'true',
      BACKEND_API_BASE_URL: 'https://rt.example.test',
      BACKEND_AGENT_TOKEN: 'secret-token',
      BACKEND_DEVICE_ID: 'studio-pc',
    });

    expect(config.musicRoots).toEqual(['D:/Radio/Music']);
    expect(config.jingleRoots).toEqual(['D:/Radio/Jingles']);
    expect(config.jingleBeforeWinner).toBe(true);
    expect(config.backend).toEqual({
      transport: 'http',
      apiBaseUrl: 'https://rt.example.test',
      agentToken: 'secret-token',
      deviceId: 'studio-pc',
      connectUrl: '',
      agentId: 'school-radio-pc',
      requestSecret: '',
      reconnectMs: 5000,
      enabled: true,
    });
  });

  it('loads a separate outbound WSS identity for the radio agent', () => {
    const config = loadAgentConfig({
      BACKEND_SYNC_ENABLED: 'true',
      RADIO_AGENT_TRANSPORT: 'websocket',
      RADIO_AGENT_CONNECT_URL: 'wss://radiotedu.com/jukebox/api/v1/next-song-voting/agent/connect',
      RADIO_AGENT_ID: 'school-radio-pc',
      RADIO_AGENT_REQUEST_SECRET: 'radio-only-secret',
    });

    expect(config.backend).toMatchObject({
      transport: 'websocket',
      enabled: true,
      agentId: 'school-radio-pc',
    });
  });

  it('loads direct Icecast source settings from env', () => {
    const config = loadAgentConfig({
      ICECAST_STREAM_ENABLED: 'true',
      ICECAST_SOURCE_URL: 'http://10.98.98.75:11154/spark',
      ICECAST_SOURCE_USERNAME: 'source',
      ICECAST_SOURCE_PASSWORD: 'source-password',
      ICECAST_BITRATE_KBPS: '160',
      ICECAST_CODEC: 'mp3',
      ICECAST_LEGACY_SOURCE: 'false',
      ICECAST_SOURCE_TRANSPORT: 'http',
    });

    expect(config.icecast).toMatchObject({
      enabled: true,
      url: 'http://10.98.98.75:11154/spark',
      username: 'source',
      password: 'source-password',
      bitrateKbps: 160,
      codec: 'mp3',
      legacySource: false,
      sourceTransport: 'http',
    });
  });
});
