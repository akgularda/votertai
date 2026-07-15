import { describe, expect, it } from 'vitest';
import {
  buildAgentHeaders,
  backendReconnectDelayMs,
  buildBackendRoundPayload,
  createBackendVotingClient,
  signRadioAgentHandshake,
} from './backendClient';
import type { AgentBackendConfig } from './types';
import type { VotingRound } from './types';

const round: VotingRound = {
  id: 'round-1',
  status: 'resolved',
  openedAt: '2026-07-01T10:00:00.000Z',
  lockAt: '2026-07-01T10:00:50.000Z',
  resolveAt: '2026-07-01T10:01:00.000Z',
  lockedAt: '2026-07-01T10:00:50.000Z',
  resolvedAt: '2026-07-01T10:01:00.000Z',
  winnerCandidateId: 'candidate-song-1',
  resolutionMode: 'user-vote',
  votes: [
    {
      userId: 'user-1',
      candidateId: 'candidate-song-1',
      acceptedAt: '2026-07-01T10:00:10.000Z',
      rewardKey: 'round-1:user-1:voting_reward',
    },
  ],
  candidates: [
    {
      id: 'candidate-song-1',
      songId: 'song-1',
      title: 'Winner',
      artist: 'Artist',
      filePath: 'C:/Music/winner.mp3',
      albumArtUrl: '/album-art/song-1',
      votes: 1,
    },
  ],
};

const httpConfig: AgentBackendConfig = {
  transport: 'http',
  apiBaseUrl: 'https://rt.example.test',
  agentToken: 'secret-token',
  deviceId: 'studio-pc',
  connectUrl: '',
  agentId: 'school-radio-pc',
  requestSecret: '',
  reconnectMs: 5000,
  enabled: true,
};

describe('backend client helpers', () => {
  it('builds device-scoped auth headers for the backend agent client', () => {
    expect(
      buildAgentHeaders(httpConfig),
    ).toEqual({
      Authorization: 'Bearer secret-token',
      'Content-Type': 'application/json',
      'X-RT-Device-Id': 'studio-pc',
    });
  });

  it('builds a public-safe round payload without local filesystem paths', () => {
    const payload = buildBackendRoundPayload(round);

    expect(JSON.stringify(payload)).not.toContain('C:/Music');
    expect(payload.candidates).toEqual([
      {
        id: 'candidate-song-1',
        songId: 'song-1',
        title: 'Winner',
        artist: 'Artist',
        albumArtUrl: null,
        albumArtAsset: null,
        votes: 1,
      },
    ]);
    expect(payload.winnerCandidateId).toBe('candidate-song-1');
    expect(payload.lockAt).toBe('2026-07-01T10:00:50.000Z');
    expect(payload.resolveAt).toBe('2026-07-01T10:01:00.000Z');
  });

  it('publishes rounds to the separate next-song voting backend namespace', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const client = createBackendVotingClient(
      { ...httpConfig, apiBaseUrl: 'https://rt.example.test/' },
      async (url, init) => {
        calls.push([String(url), init]);
        return { ok: true } as Response;
      },
    );

    await client?.publishRound(round);

    expect(calls[0][0]).toBe('https://rt.example.test/api/v1/next-song-voting/agent/rounds');
    expect(calls[0][1]?.headers).toMatchObject({ 'X-RT-Device-Id': 'studio-pc' });
  });

  it('signs the dedicated radio-agent handshake without reusing Juke headers', () => {
    expect(signRadioAgentHandshake('school-radio-pc', 1234, 'secret')).toBe(
      signRadioAgentHandshake('school-radio-pc', 1234, 'secret'),
    );
    expect(signRadioAgentHandshake('school-radio-pc', 1234, 'secret')).not.toContain('secret');
  });

  it('reconnects indefinitely with a bounded delay', () => {
    expect([1, 2, 3, 4, 5, 20].map((attempt) => backendReconnectDelayMs(attempt, 5000))).toEqual([
      5000, 10000, 20000, 40000, 60000, 60000,
    ]);
  });
});
