import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import { normalizeCandidateCount } from '../agent/config';
import { selectRandomCandidates } from '../agent/candidateSelection';
import type { BackendVotingClient } from '../agent/backendClient';
import type { PlaybackController } from '../agent/icecastStreamer';
import { buildWinnerPlaybackPlan } from '../agent/playbackPlan';
import {
  createVotingRound,
  getWinnerAttribution,
  lockRound,
  resolveRound,
  submitVote,
} from '../agent/roundEngine';
import type {
  CandidateCount,
  CatalogSong,
  JingleTrack,
  PlaybackMode,
  PlaybackPlan,
  PlaybackStatus,
  VotingCandidate,
  VotingRound,
} from '../agent/types';

export interface CreateAppOptions {
  songs: CatalogSong[];
  jingles?: JingleTrack[];
  candidateCount?: CandidateCount;
  playbackMode?: PlaybackMode;
  jingleBeforeWinner?: boolean;
  backendClient?: BackendVotingClient | null;
  playbackController?: PlaybackController | null;
  backendPollIntervalMs?: number;
  autoResolveAfterMs?: number;
  votingOpenBeforeEndMs?: number;
  votingLockBeforeEndMs?: number;
  automationTickMs?: number;
  recentTrackLimit?: number;
  rng?: () => number;
}

interface ApiState {
  candidateCount: CandidateCount;
  round: VotingRound | null;
  attribution: string | null;
  playbackCommandPreview: string[] | null;
  playbackPlanPreview: PlaybackPlan | null;
  playbackStatus: PlaybackStatus;
  backendSyncError: string | null;
  backendConnection: 'disabled' | 'connecting' | 'connected';
  automation: {
    enabled: boolean;
    currentSongId: string | null;
    remainingSeconds: number | null;
    roundSourceKey: string | null;
  };
}

function isActiveRound(round: VotingRound | null, roundId: string): round is VotingRound {
  return Boolean(round && round.id === roundId);
}

function disabledPlaybackStatus(): PlaybackStatus {
  return {
    state: 'disabled',
    queuedEntries: 0,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
}

function candidateSignature(candidate: Pick<VotingCandidate, 'id' | 'songId' | 'title' | 'artist'>): string {
  return JSON.stringify({
    id: candidate.id,
    songId: candidate.songId,
    title: candidate.title,
    artist: candidate.artist,
  });
}

function candidateListsMatch(local: VotingCandidate[], remote: Pick<VotingCandidate, 'id' | 'songId' | 'title' | 'artist'>[]): boolean {
  return (
    local.length === remote.length &&
    local.every((candidate, index) => candidateSignature(candidate) === candidateSignature(remote[index]))
  );
}

function candidateSetsMatch(local: VotingCandidate[], remote: Pick<VotingCandidate, 'id' | 'songId' | 'title' | 'artist'>[]): boolean {
  if (local.length !== remote.length) {
    return false;
  }

  const localSignatures = local.map(candidateSignature).sort();
  const remoteSignatures = remote.map(candidateSignature).sort();
  return localSignatures.every((signature, index) => signature === remoteSignatures[index]);
}

function alignCandidatesToBackendOrder(
  local: VotingCandidate[],
  remote: Pick<VotingCandidate, 'id' | 'votes'>[],
): VotingCandidate[] {
  const byId = new Map(local.map((candidate) => [candidate.id, candidate]));
  return remote.map((candidate) => ({
    ...(byId.get(candidate.id) as VotingCandidate),
    votes: candidate.votes,
  }));
}

function safePublicAlbumArtUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeVoteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function backendCandidatesWithoutLocalPaths(round: VotingRound): VotingCandidate[] | null {
  if (!Array.isArray(round.candidates) || round.candidates.length < 2 || round.candidates.length > 3) {
    return null;
  }

  const candidates: VotingCandidate[] = [];
  for (const candidate of round.candidates) {
    if (
      typeof candidate?.id !== 'string' ||
      !candidate.id ||
      typeof candidate.songId !== 'string' ||
      !candidate.songId ||
      typeof candidate.title !== 'string' ||
      typeof candidate.artist !== 'string'
    ) {
      return null;
    }

    candidates.push({
      id: candidate.id,
      songId: candidate.songId,
      title: candidate.title,
      artist: candidate.artist,
      filePath: '',
      albumArtUrl: safePublicAlbumArtUrl(candidate.albumArtUrl),
      albumArtPath: null,
      votes: safeVoteCount(candidate.votes),
    });
  }

  return candidates;
}

function restoreBackendRoundFromLocalCatalog(round: VotingRound, songs: CatalogSong[]): VotingRound | null {
  const pathlessCandidates = backendCandidatesWithoutLocalPaths(round);
  if (!pathlessCandidates) {
    return null;
  }

  const localSongs = new Map(songs.filter((song) => song.enabled !== false).map((song) => [song.id, song]));
  const seenSongIds = new Set<string>();
  const candidates: VotingCandidate[] = [];

  for (const remoteCandidate of pathlessCandidates) {
    const localSong = localSongs.get(remoteCandidate.songId);
    if (!localSong?.filePath || seenSongIds.has(remoteCandidate.songId)) {
      return null;
    }

    seenSongIds.add(remoteCandidate.songId);
    candidates.push({
      id: remoteCandidate.id,
      songId: remoteCandidate.songId,
      title: remoteCandidate.title,
      artist: remoteCandidate.artist,
      filePath: localSong.filePath,
      albumArtUrl: localSong.albumArtPath
        ? `/album-art/${encodeURIComponent(localSong.id)}`
        : remoteCandidate.albumArtUrl,
      albumArtPath: localSong.albumArtPath ?? null,
      votes: remoteCandidate.votes,
      ...(localSong.durationSeconds ? { durationSeconds: localSong.durationSeconds } : {}),
    });
  }

  return {
    id: round.id,
    status: round.status,
    openedAt: round.openedAt,
    lockAt: round.lockAt ?? null,
    resolveAt: round.resolveAt ?? null,
    lockedAt: round.lockedAt ?? null,
    resolvedAt: round.resolvedAt ?? null,
    candidates,
    votes: [],
    winnerCandidateId: round.winnerCandidateId ?? null,
    resolutionMode: round.resolutionMode ?? null,
  };
}

export function createApp(options: CreateAppOptions): express.Express {
  const app = express();
  const rng = options.rng ?? Math.random;
  let candidateCount = options.candidateCount ?? 3;
  let currentRound: VotingRound | null = null;
  let playbackCommandPreview: string[] | null = null;
  let playbackPlanPreview: PlaybackPlan | null = null;
  let playbackStatus: PlaybackStatus = options.playbackController?.status() ?? disabledPlaybackStatus();
  let backendSyncError: string | null = null;
  let autoResolveTimer: ReturnType<typeof setTimeout> | null = null;
  let observedPlaybackKey: string | null = null;
  let observedSongId: string | null = null;
  let observedRemainingSeconds: number | null = null;
  let roundSourceKey: string | null = null;
  let automationBusy = false;
  const recentSongIds: string[] = [];
  const enqueuedRoundIds = new Set<string>();

  async function verifyBackendActiveRoundMatchesLocal() {
    if (!currentRound || currentRound.status !== 'open' || !options.backendClient) {
      return;
    }

    const activeRound = await options.backendClient.fetchActiveRound();
    if (!activeRound || activeRound.id !== currentRound.id) {
      throw new Error('backend_active_round_missing_after_publish');
    }
    if (!candidateSetsMatch(currentRound.candidates, activeRound.candidates)) {
      throw new Error('backend_candidate_mismatch_after_publish');
    }
    if (!candidateListsMatch(currentRound.candidates, activeRound.candidates)) {
      currentRound = {
        ...currentRound,
        candidates: alignCandidatesToBackendOrder(currentRound.candidates, activeRound.candidates),
      };
    }
  }

  async function publishRound() {
    if (!currentRound || !options.backendClient) {
      return;
    }

    try {
      await options.backendClient.publishRound(currentRound);
      await verifyBackendActiveRoundMatchesLocal();
      backendSyncError = null;
      console.log(`Backend accepted voting round ${currentRound.id}`);
    } catch (error) {
      backendSyncError = error instanceof Error ? error.message : 'backend_sync_failed';
    }
  }

  async function syncBackendVotes() {
    if (!currentRound || currentRound.status !== 'open' || !options.backendClient) {
      return;
    }

    try {
      const activeRound = await options.backendClient.fetchActiveRound();
      if (!activeRound || activeRound.id !== currentRound.id) {
        return;
      }
      if (!candidateSetsMatch(currentRound.candidates, activeRound.candidates)) {
        backendSyncError = 'backend_candidate_mismatch_during_vote_sync';
        return;
      }

      const voteCounts = new Map(activeRound.candidates.map((candidate) => [candidate.id, candidate.votes]));
      currentRound = {
        ...currentRound,
        candidates: alignCandidatesToBackendOrder(currentRound.candidates, activeRound.candidates).map((candidate) => ({
          ...candidate,
          votes: voteCounts.get(candidate.id) ?? candidate.votes,
        })),
      };
      backendSyncError = null;
    } catch (error) {
      backendSyncError = error instanceof Error ? error.message : 'backend_vote_sync_failed';
    }
  }

  async function resumeOrCancelBackendActiveRound(
    sourceKey: string | null,
    expectedResolveAtMs?: number,
  ): Promise<boolean> {
    if (!options.backendClient) {
      return false;
    }

    try {
      // The authenticated backend client scopes round.active to this radio agent.
      // Only metadata is accepted from it; playback paths are always rebuilt from
      // this process's local catalog.
      const activeRound = await options.backendClient.fetchActiveRound();
      if (!activeRound) {
        return false;
      }

      const nowMs = Date.now();
      const resolveAtMs = Date.parse(activeRound.resolveAt ?? '');
      const resolvedAtMs = Date.parse(activeRound.resolvedAt ?? '');
      const restoredRound = restoreBackendRoundFromLocalCatalog(activeRound, options.songs);
      const scheduleToleranceMs = Math.max((options.votingLockBeforeEndMs ?? 10_000) + 5_000, 5_000);
      const scheduleMatchesCurrentTrack =
        expectedResolveAtMs === undefined ||
        (Number.isFinite(expectedResolveAtMs) && Math.abs(resolveAtMs - expectedResolveAtMs) <= scheduleToleranceMs);
      const isFutureActiveRound = resolveAtMs > nowMs;
      const isRecoverableElapsedLockedRound =
        activeRound.status === 'locked' &&
        resolveAtMs <= nowMs &&
        nowMs - resolveAtMs <= Math.max(options.votingOpenBeforeEndMs ?? 60_000, 60_000);
      const isRecoverableRecentResolvedRound =
        activeRound.status === 'resolved' &&
        Number.isFinite(resolvedAtMs) &&
        resolvedAtMs <= nowMs &&
        nowMs - resolvedAtMs <= Math.max(options.votingOpenBeforeEndMs ?? 60_000, 60_000) &&
        scheduleMatchesCurrentTrack;

      if (isRecoverableRecentResolvedRound && restoredRound) {
        currentRound = restoredRound;
        candidateCount = normalizeCandidateCount(restoredRound.candidates.length);
        playbackCommandPreview = null;
        playbackPlanPreview = null;
        roundSourceKey = sourceKey;
        if (!applyAuthoritativeResolution(activeRound) || !prepareResolvedPlayback(activeRound.id)) {
          currentRound = null;
          return false;
        }
        backendSyncError = null;
        return true;
      }

      const canResume =
        (activeRound.status === 'open' || activeRound.status === 'locked') &&
        Number.isFinite(resolveAtMs) &&
        scheduleMatchesCurrentTrack &&
        (isFutureActiveRound || isRecoverableElapsedLockedRound) &&
        Boolean(restoredRound);

      if (canResume && restoredRound) {
        currentRound = restoredRound;
        candidateCount = normalizeCandidateCount(restoredRound.candidates.length);
        playbackCommandPreview = null;
        playbackPlanPreview = null;
        roundSourceKey = sourceKey;
        backendSyncError = null;
        if (isRecoverableElapsedLockedRound) {
          await resolveActiveRound(restoredRound.id);
        }
        return true;
      }

      const cancellationCandidates = backendCandidatesWithoutLocalPaths(activeRound);
      if (
        (activeRound.status === 'open' || activeRound.status === 'locked') &&
        typeof activeRound.id === 'string' &&
        activeRound.id &&
        cancellationCandidates
      ) {
        const now = new Date(nowMs).toISOString();
        await options.backendClient.publishRound({
          id: activeRound.id,
          status: 'cancelled',
          openedAt: activeRound.openedAt || now,
          lockAt: activeRound.lockAt ?? null,
          resolveAt: activeRound.resolveAt ?? null,
          lockedAt: activeRound.lockedAt ?? null,
          resolvedAt: now,
          candidates: cancellationCandidates,
          votes: [],
          winnerCandidateId: null,
          resolutionMode: null,
        });
      }
      backendSyncError = null;
    } catch (error) {
      backendSyncError = error instanceof Error ? error.message : 'backend_stale_round_cancel_failed';
    }

    return false;
  }

  function state(): ApiState {
    return {
      candidateCount,
      round: currentRound,
      attribution: currentRound ? getWinnerAttribution(currentRound) : null,
      playbackCommandPreview,
      playbackPlanPreview,
      playbackStatus: options.playbackController?.status() ?? playbackStatus,
      backendSyncError,
      backendConnection: options.backendClient?.connectionState?.() ?? (options.backendClient ? 'connected' : 'disabled'),
      automation: {
        enabled: Boolean(options.playbackController && options.automationTickMs !== 0),
        currentSongId: observedSongId,
        remainingSeconds: observedRemainingSeconds,
        roundSourceKey,
      },
    };
  }

  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    const currentPlayback = options.playbackController?.status() ?? playbackStatus;
    res.json({
      ok: true,
      service: 'radiotedu-local-voting-agent',
      catalogTracks: options.songs.length,
      playbackState: currentPlayback.state,
      backendConnection: options.backendClient?.connectionState?.() ?? (options.backendClient ? 'connected' : 'disabled'),
    });
  });

  if (options.backendPollIntervalMs && options.backendPollIntervalMs > 0) {
    setInterval(() => {
      void syncBackendVotes();
    }, options.backendPollIntervalMs).unref();
  }

  function backendResolveIsAuthoritative(): boolean {
    return options.playbackMode === 'live' && Boolean(options.backendClient);
  }

  function applyAuthoritativeResolution(backendRound: VotingRound | null): boolean {
    if (
      !currentRound ||
      backendRound?.status !== 'resolved' ||
      !backendRound.winnerCandidateId ||
      !backendRound.resolvedAt ||
      !candidateSetsMatch(currentRound.candidates, backendRound.candidates) ||
      !currentRound.candidates.some((candidate) => candidate.id === backendRound.winnerCandidateId) ||
      !['user-vote', 'tie-break', 'no-vote-fallback'].includes(String(backendRound.resolutionMode))
    ) {
      return false;
    }

    currentRound = {
      ...currentRound,
      status: 'resolved',
      lockAt: backendRound.lockAt ?? currentRound.lockAt ?? null,
      resolveAt: backendRound.resolveAt ?? currentRound.resolveAt ?? null,
      lockedAt: backendRound.lockedAt ?? currentRound.lockedAt ?? null,
      resolvedAt: backendRound.resolvedAt,
      candidates: alignCandidatesToBackendOrder(currentRound.candidates, backendRound.candidates),
      winnerCandidateId: backendRound.winnerCandidateId,
      resolutionMode: backendRound.resolutionMode,
    };
    return true;
  }

  function prepareResolvedPlayback(roundId: string): boolean {
    if (!currentRound?.winnerCandidateId) {
      backendSyncError = 'resolved_round_winner_missing';
      return false;
    }

    const winner = currentRound.candidates.find((candidate) => candidate.id === currentRound?.winnerCandidateId);
    if (!winner) {
      backendSyncError = 'resolved_round_winner_not_in_candidate_set';
      return false;
    }

    playbackPlanPreview = buildWinnerPlaybackPlan({
      winner,
      jingles: options.jingles ?? [],
      playbackMode: options.playbackMode ?? 'dry-run',
      jingleBeforeWinner: Boolean(options.jingleBeforeWinner),
      rng,
    });
    playbackCommandPreview = playbackPlanPreview.entries.find((entry) => entry.kind === 'winner')?.ffmpegArgs ?? null;
    if (playbackPlanPreview.mode === 'live' && !enqueuedRoundIds.has(roundId)) {
      enqueuedRoundIds.add(roundId);
      try {
        playbackStatus = options.playbackController?.enqueue(playbackPlanPreview) ?? playbackStatus;
      } catch (error) {
        enqueuedRoundIds.delete(roundId);
        backendSyncError = error instanceof Error ? error.message : 'winner_enqueue_failed';
        return false;
      }
    }
    return true;
  }

  async function resolveActiveRound(roundId: string): Promise<boolean> {
    if (!isActiveRound(currentRound, roundId)) {
      return false;
    }

    await syncBackendVotes();
    const authoritativeBackendRequired = backendResolveIsAuthoritative();
    if (authoritativeBackendRequired && currentRound.status === 'open') {
      currentRound = lockRound(currentRound);
      await publishRound();
    }

    let backendResolvedRound: VotingRound | null = null;
    if (options.backendClient?.resolveRound) {
      try {
        backendResolvedRound = await options.backendClient.resolveRound(roundId);
      } catch (error) {
        backendSyncError = error instanceof Error ? error.message : 'backend_round_resolve_failed';
      }
    }
    const authoritativeResolutionApplied = applyAuthoritativeResolution(backendResolvedRound);
    if (!authoritativeResolutionApplied && authoritativeBackendRequired) {
      backendSyncError ??= options.backendClient?.resolveRound
        ? 'backend_authoritative_resolution_invalid'
        : 'backend_authoritative_resolution_unavailable';
      return false;
    }
    if (!authoritativeResolutionApplied) {
      currentRound = resolveRound(currentRound, rng);
    }
    if (!prepareResolvedPlayback(roundId)) {
      return false;
    }
    backendSyncError = null;
    if (!authoritativeResolutionApplied) {
      await publishRound();
    }
    return true;
  }

  function candidateExclusions(currentSongId: string | null, includeRecent = true): Set<string> {
    return new Set([...(currentSongId ? [currentSongId] : []), ...(includeRecent ? recentSongIds : [])]);
  }

  function selectCandidates(currentSongId: string | null): VotingCandidate[] {
    const preferred = selectRandomCandidates(options.songs, candidateCount, rng, candidateExclusions(currentSongId));
    if (preferred.length >= Math.min(2, candidateCount)) {
      return preferred;
    }
    return selectRandomCandidates(options.songs, candidateCount, rng, candidateExclusions(currentSongId, false));
  }

  async function startRound(sourceKey: string | null, currentSongId: string | null, trackEndsAtMs?: number) {
    const plannedResolveAtMs = trackEndsAtMs
      ? trackEndsAtMs - (options.votingLockBeforeEndMs ?? 10_000)
      : undefined;
    if (await resumeOrCancelBackendActiveRound(sourceKey, plannedResolveAtMs)) {
      return true;
    }
    const candidates = selectCandidates(currentSongId);
    if (candidates.length < Math.min(2, candidateCount)) {
      backendSyncError = 'not_enough_eligible_songs';
      return false;
    }
    const createdRound = createVotingRound(candidates);
    currentRound = plannedResolveAtMs
      ? {
          ...createdRound,
          lockAt: new Date(Math.max(Date.now(), plannedResolveAtMs)).toISOString(),
          resolveAt: new Date(Math.max(Date.now(), plannedResolveAtMs)).toISOString(),
        }
      : createdRound;
    playbackCommandPreview = null;
    playbackPlanPreview = null;
    roundSourceKey = sourceKey;
    scheduleAutoResolve(currentRound.id);
    await publishRound();
    return true;
  }

  async function runAutomationTick() {
    if (automationBusy || !options.playbackController) return;
    automationBusy = true;
    try {
      const status = options.playbackController.status();
      if (status.state !== 'playing' || !status.currentFilePath) {
        observedRemainingSeconds = null;
        return;
      }
      const song = options.songs.find(
        (candidate) => candidate.id === status.currentSongId || candidate.filePath === status.currentFilePath,
      );
      if (!song?.durationSeconds) {
        observedRemainingSeconds = null;
        return;
      }
      const startedAt = Date.parse(status.currentStartedAt ?? status.updatedAt);
      const endsAt = Date.parse(status.currentEndsAt ?? '') || startedAt + song.durationSeconds * 1000;
      const sourceKey = `${song.id}:${status.currentStartedAt ?? status.updatedAt}`;
      observedRemainingSeconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      observedSongId = song.id;
      if (sourceKey !== observedPlaybackKey) {
        observedPlaybackKey = sourceKey;
        recentSongIds.unshift(song.id);
        recentSongIds.splice(options.recentTrackLimit ?? 8);
      }

      const remainingMs = endsAt - Date.now();
      const openBeforeMs = options.votingOpenBeforeEndMs ?? 60_000;
      const lockBeforeMs = options.votingLockBeforeEndMs ?? 10_000;
      if (remainingMs <= openBeforeMs && remainingMs > lockBeforeMs && roundSourceKey !== sourceKey) {
        await startRound(sourceKey, song.id, endsAt);
      }
      if (remainingMs <= lockBeforeMs && roundSourceKey !== sourceKey) {
        await resumeOrCancelBackendActiveRound(sourceKey, endsAt - lockBeforeMs);
      }
      if (
        remainingMs <= lockBeforeMs &&
        roundSourceKey === sourceKey &&
        (currentRound?.status === 'open' || currentRound?.status === 'locked')
      ) {
        if (currentRound.status === 'open') {
          currentRound = lockRound(currentRound);
          await publishRound();
        }
        await resolveActiveRound(currentRound.id);
      }
    } finally {
      automationBusy = false;
    }
  }

  if (options.playbackController && options.automationTickMs !== 0) {
    const interval = setInterval(() => void runAutomationTick(), options.automationTickMs ?? 1000);
    interval.unref();
    void runAutomationTick();
  }

  function scheduleAutoResolve(roundId: string) {
    if (autoResolveTimer) {
      clearTimeout(autoResolveTimer);
      autoResolveTimer = null;
    }

    if (!options.autoResolveAfterMs || options.autoResolveAfterMs <= 0) {
      return;
    }

    autoResolveTimer = setTimeout(() => {
      void resolveActiveRound(roundId);
    }, options.autoResolveAfterMs);
    autoResolveTimer.unref();
  }

  app.get('/api/state', async (_req, res) => {
    await syncBackendVotes();
    res.json(state());
  });

  app.get('/album-art/:songId', (req, res) => {
    const song = options.songs.find((catalogSong) => catalogSong.id === req.params.songId);
    if (!song?.albumArtPath || !existsSync(song.albumArtPath)) {
      res.status(404).json({ error: 'album_art_not_found' });
      return;
    }

    res.sendFile(song.albumArtPath);
  });

  app.post('/api/rounds/start', async (req, res) => {
    candidateCount = normalizeCandidateCount(req.body?.candidateCount ?? candidateCount);
    const currentEndsAt = options.playbackController?.status().currentEndsAt;
    const currentEndsAtMs = currentEndsAt ? Date.parse(currentEndsAt) : Number.NaN;
    await startRound(
      observedPlaybackKey,
      observedSongId,
      Number.isFinite(currentEndsAtMs) ? currentEndsAtMs : undefined,
    );

    res.status(currentRound ? 201 : 409).json(state());
  });

  app.post('/api/rounds/:roundId/votes', (req, res) => {
    if (!isActiveRound(currentRound, req.params.roundId)) {
      res.status(404).json({ error: 'round_not_found' });
      return;
    }

    const result = submitVote(currentRound, {
      userId: String(req.body?.userId ?? ''),
      candidateId: String(req.body?.candidateId ?? ''),
    });
    currentRound = result.round;

    res.status(result.accepted ? 200 : 409).json({ ...state(), rewardKey: result.rewardKey, reason: result.reason });
  });

  app.post('/api/rounds/:roundId/lock', async (req, res) => {
    if (!isActiveRound(currentRound, req.params.roundId)) {
      res.status(404).json({ error: 'round_not_found' });
      return;
    }

    currentRound = lockRound(currentRound);
    await publishRound();
    res.json(state());
  });

  app.post('/api/rounds/:roundId/resolve', async (req, res) => {
    if (!isActiveRound(currentRound, req.params.roundId)) {
      res.status(404).json({ error: 'round_not_found' });
      return;
    }

    await resolveActiveRound(req.params.roundId);

    res.json(state());
  });

  return app;
}
