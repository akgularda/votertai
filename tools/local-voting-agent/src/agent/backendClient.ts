import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { AgentBackendConfig, VotingRound } from './types';

const AGENT_PROTOCOL = 'radiotedu-radio-agent/v1';
const MAX_ART_BYTES = 1_500_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 75_000;
const MAX_RECONNECT_MS = 60_000;

export interface BackendRoundCandidatePayload {
  id: string;
  songId: string;
  title: string;
  artist: string;
  albumArtUrl: string | null;
  votes: number;
  albumArtAsset: { contentType: string; dataBase64: string } | null;
}

export interface BackendRoundPayload {
  id: string;
  status: VotingRound['status'];
  openedAt: string;
  lockAt: string | null;
  resolveAt: string | null;
  lockedAt: string | null;
  resolvedAt: string | null;
  candidates: BackendRoundCandidatePayload[];
  winnerCandidateId: string | null;
  resolutionMode: VotingRound['resolutionMode'];
}

export interface BackendVotingClient {
  publishRound(round: VotingRound): Promise<void>;
  fetchActiveRound(): Promise<VotingRound | null>;
  resolveRound?(roundId: string): Promise<VotingRound | null>;
  connectionState?(): 'disabled' | 'connecting' | 'connected';
}

function contentTypeFor(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return null;
}

function loadAlbumArtAsset(filePath: string | null | undefined) {
  if (!filePath) return null;
  try {
    const contentType = contentTypeFor(filePath);
    const size = statSync(filePath).size;
    if (!contentType || size <= 0 || size > MAX_ART_BYTES) return null;
    return { contentType, dataBase64: readFileSync(filePath).toString('base64') };
  } catch {
    return null;
  }
}

export function buildAgentHeaders(config: AgentBackendConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.agentToken}`,
    'Content-Type': 'application/json',
    'X-RT-Device-Id': config.deviceId,
  };
}

function sanitizeAlbumArtUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export function buildBackendRoundPayload(round: VotingRound): BackendRoundPayload {
  return {
    id: round.id,
    status: round.status,
    openedAt: round.openedAt,
    lockAt: round.lockAt ?? round.lockedAt,
    resolveAt: round.resolveAt ?? round.resolvedAt,
    lockedAt: round.lockedAt,
    resolvedAt: round.resolvedAt,
    candidates: round.candidates.map((candidate) => ({
      id: candidate.id,
      songId: candidate.songId,
      title: candidate.title,
      artist: candidate.artist,
      albumArtUrl: sanitizeAlbumArtUrl(candidate.albumArtUrl),
      albumArtAsset: loadAlbumArtAsset(candidate.albumArtPath),
      votes: candidate.votes,
    })),
    winnerCandidateId: round.winnerCandidateId,
    resolutionMode: round.resolutionMode,
  };
}

export function signRadioAgentHandshake(agentId: string, timestamp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${agentId}:${timestamp}`).digest('base64url');
}

export function backendReconnectDelayMs(attempt: number, baseMs: number, maximumMs = MAX_RECONNECT_MS): number {
  return Math.min(maximumMs, Math.max(1, baseMs) * 2 ** Math.max(0, attempt - 1));
}

function createWebSocketVotingClient(config: AgentBackendConfig): BackendVotingClient {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;
  let lastActivityAt = 0;
  let connectionState: 'connecting' | 'connected' = 'connecting';
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  function rejectPending(reason: string) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    pending.clear();
  }

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectAttempt += 1;
    const retryMs = backendReconnectDelayMs(reconnectAttempt, config.reconnectMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, retryMs);
    reconnectTimer.unref();
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
    connectionState = 'connecting';
    const timestamp = Math.floor(Date.now() / 1000);
    let connectingSocket: WebSocket;
    try {
      connectingSocket = new WebSocket(config.connectUrl, {
        headers: {
          'x-radio-agent-id': config.agentId,
          'x-radio-agent-timestamp': String(timestamp),
          'x-radio-agent-signature': signRadioAgentHandshake(config.agentId, timestamp, config.requestSecret),
        },
      });
      socket = connectingSocket;
    } catch {
      socket = null;
      scheduleReconnect();
      return;
    }
    connectingSocket.on('open', () => {
      reconnectAttempt = 0;
      lastActivityAt = Date.now();
      connectionState = 'connected';
      connectingSocket.send(
        JSON.stringify({
          protocol: AGENT_PROTOCOL,
          type: 'agent_connect',
          agent_id: config.agentId,
          capabilities: ['radio.playout', 'radio.voting', 'radio.cover-art', 'radio.heartbeat'],
        }),
      );
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (connectingSocket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastActivityAt >= HEARTBEAT_TIMEOUT_MS) {
          connectingSocket.terminate();
          return;
        }
        connectingSocket.ping();
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref();
    });
    connectingSocket.on('pong', () => {
      lastActivityAt = Date.now();
    });
    connectingSocket.on('message', (raw) => {
      lastActivityAt = Date.now();
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === 'ping') {
        connectingSocket.send(JSON.stringify({ protocol: AGENT_PROTOCOL, type: 'pong', sent_at: new Date().toISOString() }));
        return;
      }
      if (message.type !== 'response' || typeof message.request_id !== 'string') return;
      const request = pending.get(message.request_id);
      if (!request) return;
      pending.delete(message.request_id);
      clearTimeout(request.timer);
      if (message.ok === false) {
        request.reject(new Error(typeof message.error === 'string' ? message.error : 'radio_agent_request_failed'));
      } else {
        request.resolve(message.payload);
      }
    });
    connectingSocket.on('error', () => undefined);
    connectingSocket.on('close', () => {
      clearHeartbeat();
      if (socket === connectingSocket) socket = null;
      connectionState = 'connecting';
      rejectPending('radio_agent_websocket_disconnected');
      scheduleReconnect();
    });
  }

  function request(method: string, payload: unknown): Promise<unknown> {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('radio_agent_websocket_not_connected'));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`radio_agent_request_timeout:${method}`));
      }, 10_000);
      timer.unref();
      pending.set(requestId, { resolve, reject, timer });
      socket?.send(
        JSON.stringify({
          protocol: AGENT_PROTOCOL,
          type: 'request',
          request_id: requestId,
          method,
          payload,
        }),
      );
    });
  }

  connect();
  return {
    async publishRound(round) {
      await request('round.publish', buildBackendRoundPayload(round));
    },
    async fetchActiveRound() {
      const payload = (await request('round.active', {})) as { round?: VotingRound | null } | null;
      return payload?.round ?? null;
    },
    async resolveRound(roundId) {
      const payload = (await request('round.resolve', { roundId })) as { round?: VotingRound | null } | null;
      return payload?.round ?? null;
    },
    connectionState: () => connectionState,
  };
}

export function createBackendVotingClient(
  config: AgentBackendConfig,
  fetchImpl: typeof fetch = fetch,
): BackendVotingClient | null {
  if (!config.enabled) {
    return null;
  }

  if (config.transport === 'websocket') {
    return createWebSocketVotingClient(config);
  }

  return {
    async publishRound(round: VotingRound) {
      const response = await fetchImpl(`${config.apiBaseUrl.replace(/\/$/, '')}/api/v1/next-song-voting/agent/rounds`, {
        method: 'POST',
        headers: buildAgentHeaders(config),
        body: JSON.stringify(buildBackendRoundPayload(round)),
      });

      if (!response.ok) {
        throw new Error(`backend_round_publish_failed:${response.status}`);
      }
    },
    async fetchActiveRound() {
      const response = await fetchImpl(`${config.apiBaseUrl.replace(/\/$/, '')}/api/v1/next-song-voting/rounds/active`);
      if (!response.ok) {
        throw new Error(`backend_active_round_fetch_failed:${response.status}`);
      }

      const payload = (await response.json()) as { data?: { round?: VotingRound | null }; round?: VotingRound | null };
      return payload.data?.round ?? payload.round ?? null;
    },
    async resolveRound(roundId) {
      const response = await fetchImpl(
        `${config.apiBaseUrl.replace(/\/$/, '')}/api/v1/next-song-voting/agent/rounds/${encodeURIComponent(roundId)}/resolve`,
        { method: 'POST', headers: buildAgentHeaders(config) },
      );
      if (!response.ok) {
        throw new Error(`backend_round_resolve_failed:${response.status}`);
      }
      const payload = (await response.json()) as { data?: { round?: VotingRound | null }; round?: VotingRound | null };
      return payload.data?.round ?? payload.round ?? null;
    },
    connectionState: () => 'connected',
  };
}
