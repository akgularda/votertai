import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogSong, JingleTrack, PlaybackPlan, PlaybackStatus, VotingRound } from '../agent/types';
import type { PlaybackController } from '../agent/icecastStreamer';

const songs: CatalogSong[] = [
  { id: 'song-1', title: 'One', artist: 'Artist', filePath: 'C:/Music/one.mp3' },
  { id: 'song-2', title: 'Two', artist: 'Artist', filePath: 'C:/Music/two.mp3' },
  { id: 'song-3', title: 'Three', artist: 'Artist', filePath: 'C:/Music/three.mp3' },
];

const jingles: JingleTrack[] = [
  { id: 'jingle-1', title: 'Station ID', filePath: 'C:/Jingles/station-id.wav', enabled: true },
];

describe('local voting API', () => {
  it('reports health and catalog size without exposing local paths', async () => {
    const app = createApp({ songs, rng: () => 0 });

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      service: 'radiotedu-local-voting-agent',
      catalogTracks: 3,
      playbackState: 'disabled',
      backendConnection: 'disabled',
    });
    expect(JSON.stringify(response.body)).not.toContain('C:/Music');
  });

  it('returns idle state before any round starts', async () => {
    const app = createApp({ songs, rng: () => 0 });

    const response = await request(app).get('/api/state');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      candidateCount: 3,
      round: null,
      attribution: null,
      playbackCommandPreview: null,
    });
  });

  it('starts a voting round with requested candidate count', async () => {
    const app = createApp({ songs, rng: () => 0 });

    const response = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });

    expect(response.status).toBe(201);
    expect(response.body.round.candidates).toHaveLength(2);
    expect(response.body.round.candidates.map((candidate: { songId: string }) => candidate.songId)).toEqual([
      'song-1',
      'song-2',
    ]);
  });

  it('accepts votes and returns the idempotent voting reward key', async () => {
    const app = createApp({ songs, rng: () => 0 });
    const roundResponse = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });
    const roundId = roundResponse.body.round.id;
    const candidateId = roundResponse.body.round.candidates[0].id;

    const vote = await request(app).post(`/api/rounds/${roundId}/votes`).send({ userId: 'user-1', candidateId });

    expect(vote.status).toBe(200);
    expect(vote.body.rewardKey).toBe(`${roundId}:user-1:voting_reward`);
    expect(vote.body.round.candidates[0].votes).toBe(1);
  });

  it('resolves no-vote fallback without user-facing random attribution', async () => {
    const app = createApp({ songs, rng: () => 0 });
    const roundResponse = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });
    const roundId = roundResponse.body.round.id;

    const resolved = await request(app).post(`/api/rounds/${roundId}/resolve`).send();

    expect(resolved.status).toBe(200);
    expect(resolved.body.round.resolutionMode).toBe('no-vote-fallback');
    expect(resolved.body.attribution).toBeNull();
    expect(JSON.stringify(resolved.body)).not.toMatch(/randomly selected|rastgele seçildi/i);
  });

  it('serves album art by song id without exposing local image paths in the URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'radiotedu-art-route-'));
    const artPath = join(root, 'cover.jpg');
    writeFileSync(artPath, 'fake jpg');
    const app = createApp({
      songs: [{ id: 'song-art', title: 'Art', artist: 'Artist', filePath: join(root, 'art.mp3'), albumArtPath: artPath }],
      rng: () => 0,
    });

    const response = await request(app).get('/album-art/song-art');

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('fake jpg');
  }, 15_000);

  it('returns a jingle and winner playback plan after resolving a round', async () => {
    const app = createApp({ songs, jingles, jingleBeforeWinner: true, rng: () => 0 });
    const roundResponse = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });
    const roundId = roundResponse.body.round.id;

    const resolved = await request(app).post(`/api/rounds/${roundId}/resolve`).send();

    expect(resolved.status).toBe(200);
    expect(resolved.body.playbackPlanPreview.entries.map((entry: { kind: string }) => entry.kind)).toEqual([
      'jingle',
      'winner',
    ]);
    expect(resolved.body.playbackCommandPreview).toEqual([
      '-hide_banner',
      '-nostdin',
      '-re',
      '-i',
      'C:/Music/one.mp3',
      '-f',
      'null',
      '-',
    ]);
  });

  it('resolves using backend-synced mobile vote counts', async () => {
    let activeRoundId = '';
    const app = createApp({
      songs,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          activeRoundId = round.id;
        },
        fetchActiveRound: async () => ({
          id: activeRoundId,
          status: 'open',
          openedAt: new Date().toISOString(),
          lockedAt: null,
          resolvedAt: null,
          candidates: [
            {
              id: 'candidate-song-1',
              songId: 'song-1',
              title: 'One',
              artist: 'Artist',
              filePath: 'C:/Music/one.mp3',
              albumArtUrl: null,
              votes: 0,
            },
            {
              id: 'candidate-song-2',
              songId: 'song-2',
              title: 'Two',
              artist: 'Artist',
              filePath: 'C:/Music/two.mp3',
              albumArtUrl: null,
              votes: 4,
            },
          ],
          votes: [],
          winnerCandidateId: null,
          resolutionMode: null,
        }),
      },
    });
    const roundResponse = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });
    const roundId = roundResponse.body.round.id;

    await request(app).get('/api/state');
    const resolved = await request(app).post(`/api/rounds/${roundId}/resolve`).send();

    expect(resolved.body.round.winnerCandidateId).toBe('candidate-song-2');
    expect(resolved.body.round.candidates[1].votes).toBe(4);
  });

  it('reports a backend candidate mismatch instead of trusting wrong mobile round data', async () => {
    let publishedRound: VotingRound | null = null;
    const app = createApp({
      songs,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          publishedRound = round;
        },
        fetchActiveRound: async () => {
          if (!publishedRound) {
            return null;
          }
          return {
            ...publishedRound,
            candidates: publishedRound.candidates.map((candidate, index) =>
              index === 0 ? { ...candidate, title: 'Wrong backend title', votes: 99 } : candidate,
            ),
          };
        },
      },
    });

    const response = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });

    expect(response.status).toBe(201);
    expect(response.body.backendSyncError).toBe('backend_candidate_mismatch_after_publish');
    expect(response.body.round.candidates[0].title).toBe('One');
    expect(response.body.round.candidates[0].votes).toBe(0);
  });

  it('accepts backend candidate reordering and mirrors the mobile-facing order locally', async () => {
    let publishedRound: VotingRound | null = null;
    const app = createApp({
      songs,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          publishedRound = round;
        },
        fetchActiveRound: async () => {
          if (!publishedRound) {
            return null;
          }
          return {
            ...publishedRound,
            candidates: [...publishedRound.candidates].reverse(),
          };
        },
      },
    });

    const response = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });

    expect(response.status).toBe(201);
    expect(response.body.backendSyncError).toBeNull();
    expect(response.body.round.candidates.map((candidate: { title: string }) => candidate.title)).toEqual([
      'Two',
      'One',
    ]);
  });

  it('resumes a future backend round after restart using only local catalog paths', async () => {
    const future = Date.now() + 50_000;
    const published: VotingRound[] = [];
    const localSongs: CatalogSong[] = [
      { ...songs[0], albumArtPath: 'C:/Local Art/one.jpg' },
      { ...songs[1], albumArtPath: 'C:/Local Art/two.jpg' },
      songs[2],
    ];
    const activeRound: VotingRound = {
      id: 'round-before-restart',
      status: 'open',
      openedAt: new Date(Date.now() - 10_000).toISOString(),
      lockAt: new Date(future - 10_000).toISOString(),
      resolveAt: new Date(future).toISOString(),
      lockedAt: null,
      resolvedAt: null,
      candidates: [
        {
          id: 'candidate-song-1',
          songId: 'song-1',
          title: 'One',
          artist: 'Artist',
          filePath: 'C:/Untrusted Backend/one.mp3',
          albumArtUrl: 'file:///C:/Untrusted Backend/one.jpg',
          albumArtPath: 'C:/Untrusted Backend/one.jpg',
          votes: 3,
        },
        {
          id: 'candidate-song-2',
          songId: 'song-2',
          title: 'Two',
          artist: 'Artist',
          filePath: 'C:/Untrusted Backend/two.mp3',
          albumArtUrl: null,
          albumArtPath: 'C:/Untrusted Backend/two.jpg',
          votes: 1,
        },
      ],
      votes: [],
      winnerCandidateId: null,
      resolutionMode: null,
    };
    const app = createApp({
      songs: localSongs,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          published.push(round);
        },
        fetchActiveRound: async () => activeRound,
      },
    });

    const response = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });

    expect(response.status).toBe(201);
    expect(response.body.round.id).toBe('round-before-restart');
    expect(response.body.round.candidates[0]).toMatchObject({
      filePath: 'C:/Music/one.mp3',
      albumArtPath: 'C:/Local Art/one.jpg',
      albumArtUrl: '/album-art/song-1',
      votes: 3,
    });
    expect(JSON.stringify(response.body)).not.toContain('C:/Untrusted Backend');
    expect(published).toHaveLength(0);
  });

  it('cancels an expired backend round before publishing a fresh round', async () => {
    let activeRound: VotingRound | null = {
      id: 'expired-round',
      status: 'open',
      openedAt: new Date(Date.now() - 90_000).toISOString(),
      lockAt: new Date(Date.now() - 40_000).toISOString(),
      resolveAt: new Date(Date.now() - 30_000).toISOString(),
      lockedAt: null,
      resolvedAt: null,
      candidates: [
        {
          id: 'candidate-song-1',
          songId: 'song-1',
          title: 'One',
          artist: 'Artist',
          filePath: 'C:/Untrusted Backend/one.mp3',
          albumArtUrl: null,
          albumArtPath: 'C:/Untrusted Backend/one.jpg',
          votes: 2,
        },
        {
          id: 'candidate-song-2',
          songId: 'song-2',
          title: 'Two',
          artist: 'Artist',
          filePath: 'C:/Untrusted Backend/two.mp3',
          albumArtUrl: null,
          albumArtPath: 'C:/Untrusted Backend/two.jpg',
          votes: 1,
        },
      ],
      votes: [],
      winnerCandidateId: null,
      resolutionMode: null,
    };
    const published: VotingRound[] = [];
    const app = createApp({
      songs,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          published.push(round);
          activeRound = round.status === 'cancelled' ? null : round;
        },
        fetchActiveRound: async () => activeRound,
      },
    });

    const response = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });

    expect(response.status).toBe(201);
    expect(response.body.round.id).not.toBe('expired-round');
    expect(published.map((round) => round.status)).toEqual(['cancelled', 'open']);
    expect(published[0].candidates.every((candidate) => candidate.filePath === '')).toBe(true);
    expect(published[0].candidates.every((candidate) => candidate.albumArtPath === null)).toBe(true);
  });

  it('cancels an incompatible backend round and starts with compatible local candidates', async () => {
    let activeRound: VotingRound | null = {
      id: 'incompatible-round',
      status: 'open',
      openedAt: new Date().toISOString(),
      lockAt: new Date(Date.now() + 40_000).toISOString(),
      resolveAt: new Date(Date.now() + 50_000).toISOString(),
      lockedAt: null,
      resolvedAt: null,
      candidates: [
        {
          id: 'candidate-song-1',
          songId: 'song-1',
          title: 'One',
          artist: 'Artist',
          filePath: 'C:/Untrusted Backend/one.mp3',
          albumArtUrl: null,
          albumArtPath: 'C:/Untrusted Backend/one.jpg',
          votes: 0,
        },
        {
          id: 'candidate-missing-song',
          songId: 'missing-song',
          title: 'Missing',
          artist: 'Artist',
          filePath: 'C:/Untrusted Backend/missing.mp3',
          albumArtUrl: null,
          albumArtPath: 'C:/Untrusted Backend/missing.jpg',
          votes: 0,
        },
      ],
      votes: [],
      winnerCandidateId: null,
      resolutionMode: null,
    };
    const published: VotingRound[] = [];
    const app = createApp({
      songs,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          published.push(round);
          activeRound = round.status === 'cancelled' ? null : round;
        },
        fetchActiveRound: async () => activeRound,
      },
    });

    const response = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });

    expect(response.status).toBe(201);
    expect(response.body.round.id).not.toBe('incompatible-round');
    expect(response.body.round.candidates.map((candidate: { songId: string }) => candidate.songId)).toEqual([
      'song-1',
      'song-2',
    ]);
    expect(published.map((round) => round.status)).toEqual(['cancelled', 'open']);
    expect(JSON.stringify(published[0])).not.toContain('C:/Untrusted Backend');
  });

  it('continues syncing an open local round after the backend reconnects', async () => {
    let connected = false;
    let activeRound: VotingRound | null = null;
    const publishedRounds: VotingRound[] = [];
    const app = createApp({
      songs,
      rng: () => 0,
      backendPollIntervalMs: 5,
      backendClient: {
        publishRound: async (round) => {
          activeRound = round;
          publishedRounds.push(round);
        },
        fetchActiveRound: async () => {
          if (!connected) {
            throw new Error('radio_agent_websocket_not_connected');
          }
          return activeRound;
        },
        connectionState: () => (connected ? 'connected' : 'connecting'),
      },
    });
    const started = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });
    expect(started.status).toBe(201);
    const publishedRound = publishedRounds.at(-1);
    expect(publishedRound).toBeDefined();
    if (!publishedRound) {
      throw new Error('expected a locally published round before reconnect');
    }

    activeRound = {
      ...publishedRound,
      candidates: publishedRound.candidates.map((candidate, index) => ({
        ...candidate,
        votes: index === 1 ? 5 : 0,
      })),
    };
    connected = true;
    await new Promise((resolve) => setTimeout(resolve, 30));

    const state = await request(app).get('/api/state');
    expect(state.body.backendConnection).toBe('connected');
    expect(state.body.backendSyncError).toBeNull();
    expect(state.body.round.candidates[1].votes).toBe(5);
  });

  it('adopts the authoritative backend round after a startup connection race', async () => {
    let connected = false;
    let activeRound: VotingRound | null = null;
    const app = createApp({
      songs,
      rng: () => 0,
      backendPollIntervalMs: 5,
      backendClient: {
        publishRound: async () => undefined,
        fetchActiveRound: async () => {
          if (!connected) throw new Error('radio_agent_websocket_not_connected');
          return activeRound;
        },
        connectionState: () => (connected ? 'connected' : 'connecting'),
      },
    });
    const local = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });
    expect(local.status).toBe(201);

    activeRound = {
      id: 'server-authoritative-round',
      status: 'open',
      openedAt: new Date().toISOString(),
      lockAt: new Date(Date.now() + 40_000).toISOString(),
      resolveAt: new Date(Date.now() + 50_000).toISOString(),
      lockedAt: null,
      resolvedAt: null,
      candidates: [
        { ...local.body.round.candidates[1], filePath: '', albumArtPath: null, votes: 4 },
        { ...local.body.round.candidates[0], filePath: '', albumArtPath: null, votes: 1 },
      ],
      votes: [],
      winnerCandidateId: null,
      resolutionMode: null,
    };
    connected = true;
    await new Promise((resolve) => setTimeout(resolve, 30));

    const state = await request(app).get('/api/state');
    expect(state.body.round.id).toBe('server-authoritative-round');
    expect(state.body.round.candidates.map((candidate: { votes: number }) => candidate.votes)).toEqual([4, 1]);
    expect(state.body.round.candidates.every((candidate: { filePath: string }) => candidate.filePath.startsWith('C:/Music/'))).toBe(true);
    expect(state.body.backendSyncError).toBeNull();
  });

  it('keeps a live round locked and retries when authoritative resolve is too early', async () => {
    const now = Date.now();
    let playbackStatus: PlaybackStatus = {
      state: 'playing',
      codec: 'icecast-mp3',
      streamUrl: 'http://stream.example.test/ai',
      currentKind: 'filler',
      currentTitle: 'Current',
      currentFilePath: 'C:/Music/current.mp3',
      currentSongId: 'song-current',
      currentDurationSeconds: 120,
      currentStartedAt: new Date(now - 70_000).toISOString(),
      currentEndsAt: new Date(now + 50_000).toISOString(),
      queuedEntries: 0,
      lastError: null,
      updatedAt: new Date(now - 70_000).toISOString(),
    };
    let activeRound: VotingRound | null = null;
    let resolveCalls = 0;
    const enqueued: PlaybackPlan[] = [];
    const playbackController: PlaybackController = {
      enqueue(plan) {
        enqueued.push(plan);
        return playbackStatus;
      },
      status: () => playbackStatus,
    };
    const app = createApp({
      songs: [
        ...songs,
        { id: 'song-current', title: 'Current', artist: 'Artist', filePath: 'C:/Music/current.mp3', durationSeconds: 120 },
      ],
      playbackMode: 'live',
      playbackController,
      automationTickMs: 5,
      votingOpenBeforeEndMs: 60_000,
      votingLockBeforeEndMs: 10_000,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          activeRound = round;
        },
        fetchActiveRound: async () => activeRound,
        resolveRound: async () => {
          resolveCalls += 1;
          throw new Error('radio_agent_request_failed:too_early');
        },
        connectionState: () => 'connected',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    playbackStatus = { ...playbackStatus, currentEndsAt: new Date(Date.now() + 5_000).toISOString() };
    await new Promise((resolve) => setTimeout(resolve, 40));

    const state = await request(app).get('/api/state');
    expect(state.body.round.status).toBe('locked');
    expect(state.body.round.winnerCandidateId).toBeNull();
    expect(state.body.backendSyncError).toContain('too_early');
    expect(resolveCalls).toBeGreaterThan(1);
    expect(enqueued).toHaveLength(0);
    expect(playbackStatus.currentTitle).toBe('Current');
  });

  it('does not use local fallback when the configured live backend is disconnected', async () => {
    let activeRound: VotingRound | null = null;
    const enqueued: PlaybackPlan[] = [];
    const playbackStatus: PlaybackStatus = {
      state: 'playing',
      codec: 'icecast-mp3',
      streamUrl: 'http://stream.example.test/ai',
      currentKind: 'filler',
      currentTitle: 'Current',
      currentFilePath: 'C:/Music/current.mp3',
      currentSongId: 'song-current',
      currentDurationSeconds: 120,
      currentStartedAt: new Date().toISOString(),
      currentEndsAt: new Date(Date.now() + 5_000).toISOString(),
      queuedEntries: 0,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const app = createApp({
      songs,
      playbackMode: 'live',
      playbackController: {
        enqueue(plan) {
          enqueued.push(plan);
          return playbackStatus;
        },
        status: () => playbackStatus,
      },
      automationTickMs: 0,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          activeRound = round;
        },
        fetchActiveRound: async () => activeRound,
        resolveRound: async () => {
          throw new Error('radio_agent_websocket_not_connected');
        },
        connectionState: () => 'connecting',
      },
    });
    const started = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });

    const resolved = await request(app).post(`/api/rounds/${started.body.round.id}/resolve`).send();

    expect(resolved.body.round.status).toBe('locked');
    expect(resolved.body.round.winnerCandidateId).toBeNull();
    expect(resolved.body.backendSyncError).toContain('not_connected');
    expect(enqueued).toHaveLength(0);
  });

  it('rejects an authoritative winner outside the candidate set without enqueueing', async () => {
    let activeRound: VotingRound | null = null;
    const enqueued: PlaybackPlan[] = [];
    const playbackStatus: PlaybackStatus = {
      state: 'playing',
      codec: 'icecast-mp3',
      streamUrl: 'http://stream.example.test/ai',
      currentKind: 'filler',
      currentTitle: 'Current',
      currentFilePath: 'C:/Music/current.mp3',
      currentSongId: 'song-current',
      currentDurationSeconds: 120,
      currentStartedAt: new Date().toISOString(),
      currentEndsAt: new Date(Date.now() + 50_000).toISOString(),
      queuedEntries: 0,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const app = createApp({
      songs,
      playbackMode: 'live',
      playbackController: {
        enqueue(plan) {
          enqueued.push(plan);
          return playbackStatus;
        },
        status: () => playbackStatus,
      },
      automationTickMs: 0,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          activeRound = round;
        },
        fetchActiveRound: async () => activeRound,
        resolveRound: async () => ({
          ...(activeRound as VotingRound),
          status: 'resolved',
          resolvedAt: new Date().toISOString(),
          winnerCandidateId: 'candidate-not-in-round',
          resolutionMode: 'user-vote',
        }),
        connectionState: () => 'connected',
      },
    });
    const started = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });

    const resolved = await request(app).post(`/api/rounds/${started.body.round.id}/resolve`).send();

    expect(resolved.body.round.status).toBe('locked');
    expect(resolved.body.round.winnerCandidateId).toBeNull();
    expect(resolved.body.backendSyncError).toBe('backend_authoritative_resolution_invalid');
    expect(enqueued).toHaveLength(0);
  });

  it('enqueues one authoritative winner idempotently without cutting the current song', async () => {
    let activeRound: VotingRound | null = null;
    const publishedStatuses: VotingRound['status'][] = [];
    const enqueued: PlaybackPlan[] = [];
    const playbackStatus: PlaybackStatus = {
      state: 'playing',
      codec: 'icecast-mp3',
      streamUrl: 'http://stream.example.test/ai',
      currentKind: 'filler',
      currentTitle: 'Current',
      currentFilePath: 'C:/Music/current.mp3',
      currentSongId: 'song-current',
      currentDurationSeconds: 120,
      currentStartedAt: new Date().toISOString(),
      currentEndsAt: new Date(Date.now() + 50_000).toISOString(),
      queuedEntries: 0,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const app = createApp({
      songs,
      playbackMode: 'live',
      playbackController: {
        enqueue(plan) {
          enqueued.push(plan);
          return playbackStatus;
        },
        status: () => playbackStatus,
      },
      automationTickMs: 0,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          publishedStatuses.push(round.status);
          activeRound = round;
        },
        fetchActiveRound: async () => activeRound,
        resolveRound: async () => {
          const round = activeRound as VotingRound;
          return {
            ...round,
            status: 'resolved',
            resolvedAt: new Date().toISOString(),
            candidates: round.candidates.map((candidate, index) => ({ ...candidate, votes: index === 1 ? 4 : 0 })),
            winnerCandidateId: round.candidates[1].id,
            resolutionMode: 'user-vote',
          };
        },
        connectionState: () => 'connected',
      },
    });
    const started = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });
    const roundId = started.body.round.id;

    const first = await request(app).post(`/api/rounds/${roundId}/resolve`).send();
    const second = await request(app).post(`/api/rounds/${roundId}/resolve`).send();

    expect(first.body.round.winnerCandidateId).toBe('candidate-song-2');
    expect(second.body.round.winnerCandidateId).toBe('candidate-song-2');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].entries.find((entry) => entry.kind === 'winner')?.filePath).toBe('C:/Music/two.mp3');
    expect(playbackStatus.currentTitle).toBe('Current');
    expect(publishedStatuses).not.toContain('resolved');
  });

  it('restores and resolves an elapsed locked round on startup even when the new track schedule differs', async () => {
    const localSongs: CatalogSong[] = [
      { ...songs[0], albumArtPath: 'C:/Local Art/one.jpg' },
      { ...songs[1], albumArtPath: 'C:/Local Art/two.jpg' },
      songs[2],
      { id: 'song-current', title: 'Current', artist: 'Artist', filePath: 'C:/Music/current.mp3', durationSeconds: 3_600 },
    ];
    let activeRound: VotingRound = {
      id: 'elapsed-locked-round',
      status: 'locked',
      openedAt: new Date(Date.now() - 180_000).toISOString(),
      lockAt: new Date(Date.now() - 120_000).toISOString(),
      resolveAt: new Date(Date.now() - 120_000).toISOString(),
      lockedAt: new Date(Date.now() - 120_000).toISOString(),
      resolvedAt: null,
      candidates: [
        {
          id: 'candidate-song-1',
          songId: 'song-1',
          title: 'One',
          artist: 'Artist',
          filePath: 'C:/Untrusted Backend/one.mp3',
          albumArtUrl: null,
          albumArtPath: 'C:/Untrusted Backend/one.jpg',
          votes: 1,
        },
        {
          id: 'candidate-song-2',
          songId: 'song-2',
          title: 'Two',
          artist: 'Artist',
          filePath: 'C:/Untrusted Backend/two.mp3',
          albumArtUrl: null,
          albumArtPath: 'C:/Untrusted Backend/two.jpg',
          votes: 5,
        },
      ],
      votes: [],
      winnerCandidateId: null,
      resolutionMode: null,
    };
    const published: VotingRound[] = [];
    const enqueued: PlaybackPlan[] = [];
    const playbackStatus: PlaybackStatus = {
      state: 'playing',
      codec: 'icecast-mp3',
      streamUrl: 'http://stream.example.test/ai',
      currentKind: 'filler',
      currentTitle: 'Current',
      currentFilePath: 'C:/Music/current.mp3',
      currentSongId: 'song-current',
      currentDurationSeconds: 3_600,
      currentStartedAt: new Date().toISOString(),
      currentEndsAt: new Date(Date.now() + 3_000_000).toISOString(),
      queuedEntries: 0,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const app = createApp({
      songs: localSongs,
      playbackMode: 'live',
      playbackController: {
        enqueue(plan) {
          enqueued.push(plan);
          return playbackStatus;
        },
        status: () => playbackStatus,
      },
      automationTickMs: 5,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          published.push(round);
          activeRound = round;
        },
        fetchActiveRound: async () => activeRound,
        resolveRound: async () => ({
          ...activeRound,
          status: 'resolved',
          resolvedAt: new Date().toISOString(),
          winnerCandidateId: 'candidate-song-2',
          resolutionMode: 'user-vote',
        }),
        connectionState: () => 'connected',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    const response = await request(app).get('/api/state');

    expect(response.body.round, JSON.stringify(response.body)).not.toBeNull();
    expect(response.body.round.status).toBe('resolved');
    expect(response.body.round.winnerCandidateId).toBe('candidate-song-2');
    expect(response.body.round.candidates[1].filePath).toBe('C:/Music/two.mp3');
    expect(response.body.round.candidates[1].albumArtPath).toBe('C:/Local Art/two.jpg');
    expect(JSON.stringify(response.body)).not.toContain('C:/Untrusted Backend');
    expect(published.some((round) => round.status === 'cancelled')).toBe(false);
    expect(enqueued).toHaveLength(1);
    expect(playbackStatus.currentTitle).toBe('Current');
  });

  it('recovers a recent authoritative result and enqueues it once without republishing', async () => {
    const localSongs: CatalogSong[] = [
      { ...songs[0], albumArtPath: 'C:/Local Art/one.jpg' },
      { ...songs[1], albumArtPath: 'C:/Local Art/two.jpg' },
      songs[2],
    ];
    const resolvedAt = new Date(Date.now() - 500).toISOString();
    const activeRound: VotingRound = {
      id: 'recent-resolved-round',
      status: 'resolved',
      openedAt: new Date(Date.now() - 60_000).toISOString(),
      lockAt: resolvedAt,
      resolveAt: resolvedAt,
      lockedAt: resolvedAt,
      resolvedAt,
      candidates: [
        {
          id: 'candidate-song-1',
          songId: 'song-1',
          title: 'One',
          artist: 'Artist',
          filePath: 'C:/Untrusted Backend/one.mp3',
          albumArtUrl: null,
          albumArtPath: 'C:/Untrusted Backend/one.jpg',
          votes: 1,
        },
        {
          id: 'candidate-song-2',
          songId: 'song-2',
          title: 'Two',
          artist: 'Artist',
          filePath: 'C:/Untrusted Backend/two.mp3',
          albumArtUrl: null,
          albumArtPath: 'C:/Untrusted Backend/two.jpg',
          votes: 5,
        },
      ],
      votes: [],
      winnerCandidateId: 'candidate-song-2',
      resolutionMode: 'user-vote',
    };
    const published: VotingRound[] = [];
    const enqueued: PlaybackPlan[] = [];
    const playbackStatus: PlaybackStatus = {
      state: 'playing',
      codec: 'icecast-mp3',
      streamUrl: 'http://stream.example.test/ai',
      currentKind: 'filler',
      currentTitle: 'Current',
      currentFilePath: 'C:/Music/current.mp3',
      currentSongId: 'song-current',
      currentDurationSeconds: 120,
      currentStartedAt: new Date().toISOString(),
      currentEndsAt: new Date(Date.now() + 5_000).toISOString(),
      queuedEntries: 0,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const app = createApp({
      songs: localSongs,
      playbackMode: 'live',
      playbackController: {
        enqueue(plan) {
          enqueued.push(plan);
          return playbackStatus;
        },
        status: () => playbackStatus,
      },
      automationTickMs: 0,
      rng: () => 0,
      backendClient: {
        publishRound: async (round) => {
          published.push(round);
        },
        fetchActiveRound: async () => activeRound,
        connectionState: () => 'connected',
      },
    });

    const first = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });
    const second = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });

    expect(first.body.round.status).toBe('resolved');
    expect(first.body.round.winnerCandidateId).toBe('candidate-song-2');
    expect(first.body.round.candidates[1].filePath).toBe('C:/Music/two.mp3');
    expect(first.body.round.candidates[1].albumArtPath).toBe('C:/Local Art/two.jpg');
    expect(JSON.stringify(first.body)).not.toContain('C:/Untrusted Backend');
    expect(second.body.round.id).toBe('recent-resolved-round');
    expect(enqueued).toHaveLength(1);
    expect(published).toHaveLength(0);
    expect(playbackStatus.currentTitle).toBe('Current');
  });

  it('enqueues the exact winner file for live playback and exposes playback status', async () => {
    let enqueuedEntries: PlaybackPlan['entries'] = [];
    const playingStatus: PlaybackStatus = {
      state: 'playing',
      codec: 'test',
      streamUrl: 'http://127.0.0.1:4320/stream.aac',
      currentKind: 'winner',
      currentTitle: 'One',
      currentFilePath: 'C:/Music/one.mp3',
      queuedEntries: 0,
      lastWinnerTitle: 'One',
      lastWinnerFilePath: 'C:/Music/one.mp3',
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const playbackController: PlaybackController = {
      enqueue: (plan) => {
        enqueuedEntries = plan.entries;
        return playingStatus;
      },
      status: () => playingStatus,
    };
    const app = createApp({
      songs,
      rng: () => 0,
      playbackMode: 'live',
      playbackController,
    });
    const roundResponse = await request(app).post('/api/rounds/start').send({ candidateCount: 2 });
    const roundId = roundResponse.body.round.id;

    const resolved = await request(app).post(`/api/rounds/${roundId}/resolve`).send();

    expect(resolved.status).toBe(200);
    const winnerEntry = enqueuedEntries.at(-1);
    expect(winnerEntry).toMatchObject({
      kind: 'winner',
      title: 'One',
      filePath: 'C:/Music/one.mp3',
    });
    expect(resolved.body.playbackStatus).toMatchObject({
      state: 'playing',
      currentTitle: 'One',
      currentFilePath: 'C:/Music/one.mp3',
      streamUrl: 'http://127.0.0.1:4320/stream.aac',
    });
  });

  it('opens at T-60, locks at T-10, and queues the winner without cutting the current song', async () => {
    const now = Date.now();
    let playbackStatus: PlaybackStatus = {
      state: 'playing',
      codec: 'icecast-mp3',
      streamUrl: 'http://stream.example.test/ai',
      currentKind: 'filler',
      currentTitle: 'Current',
      currentFilePath: 'C:/Music/current.mp3',
      currentSongId: 'song-current',
      currentDurationSeconds: 120,
      currentStartedAt: new Date(now - 70_000).toISOString(),
      currentEndsAt: new Date(now + 50_000).toISOString(),
      queuedEntries: 0,
      lastError: null,
      updatedAt: new Date(now - 70_000).toISOString(),
    };
    const enqueued: PlaybackPlan[] = [];
    const playbackController: PlaybackController = {
      enqueue(plan) {
        enqueued.push(plan);
        return playbackStatus;
      },
      status: () => playbackStatus,
    };
    const app = createApp({
      songs: [
        ...songs,
        { id: 'song-current', title: 'Current', artist: 'Artist', filePath: 'C:/Music/current.mp3', durationSeconds: 120 },
      ],
      playbackMode: 'live',
      playbackController,
      automationTickMs: 5,
      votingOpenBeforeEndMs: 60_000,
      votingLockBeforeEndMs: 10_000,
      rng: () => 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const opened = await request(app).get('/api/state');
    expect(opened.body.round.status).toBe('open');
    expect(Date.parse(opened.body.round.lockAt)).toBeGreaterThan(Date.now());
    expect(opened.body.round.resolveAt).toBe(opened.body.round.lockAt);
    expect(opened.body.round.candidates.map((candidate: { songId: string }) => candidate.songId)).not.toContain(
      'song-current',
    );
    expect(enqueued).toHaveLength(0);

    playbackStatus = { ...playbackStatus, currentEndsAt: new Date(Date.now() + 5_000).toISOString() };
    await new Promise((resolve) => setTimeout(resolve, 30));
    const resolved = await request(app).get('/api/state');
    expect(resolved.body.round.status).toBe('resolved');
    expect(enqueued).toHaveLength(1);
    expect(playbackStatus.currentTitle).toBe('Current');
  });

  it('gives a manually started production round the current track deadline', async () => {
    const now = Date.now();
    const currentEndsAt = new Date(now + 180_000).toISOString();
    const playbackStatus: PlaybackStatus = {
      state: 'playing',
      codec: 'icecast-aac',
      streamUrl: 'https://stream.example.test/ai',
      currentKind: 'filler',
      currentTitle: 'Current',
      currentFilePath: 'C:/Music/current.mp3',
      currentSongId: 'song-current',
      currentDurationSeconds: 240,
      currentStartedAt: new Date(now - 60_000).toISOString(),
      currentEndsAt,
      queuedEntries: 0,
      lastError: null,
      updatedAt: new Date(now - 60_000).toISOString(),
    };
    const published: VotingRound[] = [];
    const app = createApp({
      songs,
      playbackMode: 'live',
      playbackController: {
        enqueue: () => playbackStatus,
        status: () => playbackStatus,
      },
      backendClient: {
        async publishRound(round) {
          published.push(round);
        },
        async fetchActiveRound() {
          return published.at(-1) ?? null;
        },
        connectionState: () => 'connected',
      },
      automationTickMs: 5,
      votingLockBeforeEndMs: 10_000,
      rng: () => 0,
    });

    const response = await request(app).post('/api/rounds/start').send({ candidateCount: 3 });

    expect(response.status).toBe(201);
    expect(response.body.backendSyncError).toBeNull();
    expect(response.body.round.lockAt).toBe(new Date(Date.parse(currentEndsAt) - 10_000).toISOString());
    expect(response.body.round.resolveAt).toBe(response.body.round.lockAt);
    expect(published).toHaveLength(1);
  });
});
