export type CandidateCount = 2 | 3;

export type PlaybackMode = 'dry-run' | 'live';

export interface AgentConfig {
  candidateCount: CandidateCount;
  catalogPath: string;
  musicRoots: string[];
  jingleRoots: string[];
  jingleBeforeWinner: boolean;
  artCacheDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  playbackMode: PlaybackMode;
  serverPort: number;
  catalogRefreshMs: number;
  autoResolveAfterMs: number;
  votingOpenBeforeEndMs: number;
  votingLockBeforeEndMs: number;
  automationTickMs: number;
  recentTrackLimit: number;
  backend: AgentBackendConfig;
  icecast: IcecastSourceConfig;
}

export interface AgentBackendConfig {
  transport: 'http' | 'websocket';
  apiBaseUrl: string;
  agentToken: string;
  deviceId: string;
  connectUrl: string;
  agentId: string;
  requestSecret: string;
  reconnectMs: number;
  enabled: boolean;
}

export interface IcecastSourceConfig {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  bitrateKbps: number;
  name: string;
  genre: string;
  description: string;
}

export interface CatalogSong {
  id: string;
  title: string;
  artist: string;
  filePath: string;
  albumArtPath?: string | null;
  enabled?: boolean;
  durationSeconds?: number;
}

export interface JingleTrack {
  id: string;
  title: string;
  filePath: string;
  enabled?: boolean;
}

export interface VotingCandidate {
  id: string;
  songId: string;
  title: string;
  artist: string;
  filePath: string;
  albumArtUrl: string | null;
  albumArtPath?: string | null;
  votes: number;
  durationSeconds?: number;
}

export type RoundStatus = 'open' | 'locked' | 'resolved' | 'cancelled';

export type RoundResolutionMode = 'user-vote' | 'tie-break' | 'no-vote-fallback';

export interface VoteRecord {
  userId: string;
  candidateId: string;
  acceptedAt: string;
  rewardKey: string;
}

export interface VotingRound {
  id: string;
  status: RoundStatus;
  openedAt: string;
  lockAt?: string | null;
  resolveAt?: string | null;
  lockedAt: string | null;
  resolvedAt: string | null;
  candidates: VotingCandidate[];
  votes: VoteRecord[];
  winnerCandidateId: string | null;
  resolutionMode: RoundResolutionMode | null;
}

export type PlaybackPlanEntryKind = 'jingle' | 'winner';

export interface PlaybackPlanEntry {
  kind: PlaybackPlanEntryKind;
  title: string;
  filePath: string;
  ffmpegArgs: string[];
  songId?: string;
  artist?: string;
  durationSeconds?: number;
}

export interface PlaybackPlan {
  mode: PlaybackMode;
  entries: PlaybackPlanEntry[];
}

export type PlaybackStatusState = 'disabled' | 'idle' | 'queued' | 'playing' | 'error';

export interface PlaybackStatus {
  state: PlaybackStatusState;
  codec?: string;
  streamUrl?: string;
  currentKind?: PlaybackPlanEntryKind | 'filler';
  currentTitle?: string;
  currentArtist?: string;
  currentFilePath?: string;
  currentSongId?: string;
  currentDurationSeconds?: number;
  currentStartedAt?: string;
  currentEndsAt?: string;
  queuedEntries: number;
  lastWinnerTitle?: string;
  lastWinnerFilePath?: string;
  lastError: string | null;
  updatedAt: string;
}
