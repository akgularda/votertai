export type RoundStatus = 'open' | 'locked' | 'resolved' | 'cancelled';

export interface Candidate {
  id: string;
  songId: string;
  title: string;
  artist: string;
  albumArtUrl: string | null;
  votes: number;
}

export interface VotingRound {
  id: string;
  status: RoundStatus;
  openedAt: string | null;
  lockAt: string | null;
  resolveAt: string | null;
  serverNow: string | null;
  candidates: Candidate[];
  userVoteCandidateId: string | null;
  winnerCandidateId: string | null;
  resolutionMode: string | null;
}

export interface VotingStatus {
  agent: {agentId: string | null; connected: boolean; lastSeen: string | null};
  activeRound: {id: string; status: RoundStatus; openedAt: string; lockAt: string; resolveAt: string} | null;
  streamUrl: string;
  serverNow: string;
}

export interface RuntimeConfig {
  apiBaseUrl: string;
  socketOrigin: string;
  socketPath: string;
  streamUrl: string;
}

declare global {
  interface Window {
    __RADIOTEDU_VOTING_CONFIG__?: Partial<RuntimeConfig>;
    __RADIOTEDU_SET_AUTH__?: (payload: {accessToken?: string | null; user?: unknown}) => void;
    ReactNativeWebView?: {postMessage(message: string): void};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function resolveRuntimeConfig(
  location: Pick<Location, 'origin' | 'hostname' | 'protocol'>,
  isDev = import.meta.env.DEV,
): RuntimeConfig {
  const override = typeof window === 'undefined' ? {} : window.__RADIOTEDU_VOTING_CONFIG__ ?? {};
  const devOrigin = `${location.protocol}//${location.hostname}:3000`;
  const serverOrigin = isDev ? devOrigin : location.origin;
  return {
    apiBaseUrl: override.apiBaseUrl?.replace(/\/$/, '') || `${serverOrigin}${isDev ? '' : '/jukebox'}/api/v1`,
    socketOrigin: override.socketOrigin || serverOrigin,
    socketPath: override.socketPath || (isDev ? '/socket.io' : '/jukebox/socket.io'),
    streamUrl: override.streamUrl || 'https://stream.radiotedu.com/ai',
  };
}

export function normalizeRound(payload: unknown): VotingRound | null {
  let value: unknown = payload;
  if (isRecord(value) && isRecord(value.data) && 'round' in value.data) value = value.data.round;
  else if (isRecord(value) && 'round' in value) value = value.round;
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.candidates)) return null;

  const status = ['open', 'locked', 'resolved', 'cancelled'].includes(text(value.status))
    ? text(value.status) as RoundStatus
    : 'open';
  return {
    id: value.id,
    status,
    openedAt: nullableText(value.openedAt ?? value.opened_at),
    lockAt: nullableText(value.lockAt ?? value.lock_at),
    resolveAt: nullableText(value.resolveAt ?? value.resolve_at),
    serverNow: nullableText(value.serverNow ?? value.server_now),
    userVoteCandidateId: nullableText(value.userVoteCandidateId ?? value.user_vote_candidate_id),
    winnerCandidateId: nullableText(value.winnerCandidateId ?? value.winner_candidate_id),
    resolutionMode: nullableText(value.resolutionMode ?? value.resolution_mode),
    candidates: value.candidates.filter(isRecord).map((candidate) => ({
      id: text(candidate.id ?? candidate.candidate_id),
      songId: text(candidate.songId ?? candidate.song_id),
      title: text(candidate.title),
      artist: text(candidate.artist),
      albumArtUrl: nullableText(candidate.albumArtUrl ?? candidate.album_art_url),
      votes: Math.max(0, Number(candidate.votes ?? 0) || 0),
    })),
  };
}

export function normalizeStatus(payload: unknown, fallbackStreamUrl: string): VotingStatus | null {
  let value: unknown = payload;
  if (isRecord(value) && isRecord(value.data)) value = value.data;
  if (!isRecord(value)) return null;
  const agent = isRecord(value.agent) ? value.agent : {};
  const activeRound = isRecord(value.activeRound) ? value.activeRound : null;
  return {
    agent: {
      agentId: nullableText(agent.agentId),
      connected: agent.connected === true,
      lastSeen: nullableText(agent.lastSeen),
    },
    activeRound: activeRound && typeof activeRound.id === 'string' ? {
      id: activeRound.id,
      status: text(activeRound.status) as RoundStatus,
      openedAt: text(activeRound.openedAt),
      lockAt: text(activeRound.lockAt),
      resolveAt: text(activeRound.resolveAt),
    } : null,
    streamUrl: nullableText(value.streamUrl) || fallbackStreamUrl,
    serverNow: nullableText(value.serverNow) || new Date().toISOString(),
  };
}

export function candidateArtUrl(candidate: Candidate, origin: string): string | null {
  if (!candidate.albumArtUrl) return null;
  if (/^https:\/\//i.test(candidate.albumArtUrl)) return candidate.albumArtUrl;
  if (candidate.albumArtUrl.startsWith('/uploads/') && /^https:\/\/(?:www\.)?radiotedu\.com$/i.test(origin)) {
    return `${origin}/jukebox${candidate.albumArtUrl}`;
  }
  if (candidate.albumArtUrl.startsWith('/')) return `${origin}${candidate.albumArtUrl}`;
  return null;
}

export function secondsRemaining(round: VotingRound | null, now = Date.now()): number | null {
  if (!round) return null;
  const target = round.status === 'open' ? round.lockAt : round.resolveAt;
  if (!target) return null;
  const serverNow = round.serverNow ? Date.parse(round.serverNow) : Number.NaN;
  const offset = Number.isFinite(serverNow) ? serverNow - Date.now() : 0;
  const seconds = Math.ceil((Date.parse(target) - (now + offset)) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}

export function roundCopy(round: VotingRound | null) {
  if (!round) return {eyebrow: 'Sıradaki şarkı', title: 'Yeni tur bekleniyor', detail: 'Voting PC yeni adayları gönderdiğinde oylama burada otomatik açılacak.'};
  if (round.status === 'open') return {eyebrow: 'Oylama açık', title: 'Sıradaki şarkıyı sen seç', detail: 'Bir adaya dokun; turun sonuna kadar seçimini değiştirebilirsin.'};
  if (round.status === 'locked') return {eyebrow: 'Oylar kilitlendi', title: 'Sonuç hazırlanıyor', detail: 'Kazanan birkaç saniye içinde Voting Radio’da sıraya alınacak.'};
  return {eyebrow: 'Tur tamamlandı', title: 'Sıradaki şarkı hazır', detail: 'Yeni tur başladığında adaylar otomatik yenilenecek.'};
}
