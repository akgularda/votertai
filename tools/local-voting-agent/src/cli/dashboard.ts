import readline from 'node:readline';

const AGENT_URL = process.env.LOCAL_AGENT_URL ?? 'http://127.0.0.1:4317';
const STREAM_URL = process.env.LOCAL_HTTP_STREAM_URL ?? 'http://127.0.0.1:4320/stream.mp3';
const REFRESH_MS = Number(process.env.DASHBOARD_REFRESH_MS || 1500);

interface Candidate {
  id: string;
  title: string;
  artist: string;
  votes: number;
}

interface ApiState {
  candidateCount: number;
  round: null | {
    id: string;
    status: string;
    openedAt: string;
    resolvedAt: string | null;
    winnerCandidateId: string | null;
    resolutionMode: string | null;
    candidates: Candidate[];
  };
  attribution: string | null;
  backendSyncError: string | null;
  playbackStatus: {
    state: string;
    codec?: string;
    streamUrl?: string;
    currentKind?: string;
    currentTitle?: string;
    queuedEntries: number;
    lastWinnerTitle?: string;
    lastError: string | null;
  };
  playbackPlanPreview: null | {
    entries: Array<{ kind: string; title: string; filePath: string }>;
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function probeStream(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(STREAM_URL, { signal: controller.signal });
    return response.ok ? `${response.status} ${response.headers.get('content-type') ?? 'audio'}` : `${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : 'offline';
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function bar(votes: number, maxVotes: number): string {
  const width = 24;
  const filled = maxVotes <= 0 ? 0 : Math.round((votes / maxVotes) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function clear(): void {
  process.stdout.write('\x1b[2J\x1b[H');
}

function render(state: ApiState | null, streamStatus: string, error: string | null): void {
  clear();
  console.log('RadioTEDU Local Voting Dashboard');
  console.log('='.repeat(36));
  console.log(`Agent : ${AGENT_URL}`);
  console.log(`Stream: ${STREAM_URL} (${streamStatus})`);
  console.log(`Time  : ${new Date().toLocaleTimeString()}`);
  console.log('');

  if (error) {
    console.log(`ERROR: ${error}`);
    console.log('');
  }

  if (!state?.round) {
    console.log('No active local round.');
    console.log('');
  } else {
    const round = state.round;
    const maxVotes = Math.max(1, ...round.candidates.map((candidate) => candidate.votes));
    const winner = round.candidates.find((candidate) => candidate.id === round.winnerCandidateId);

    console.log(`Round : ${round.id}`);
    console.log(`Status: ${round.status}${round.resolutionMode ? ` (${round.resolutionMode})` : ''}`);
    if (state.backendSyncError) {
      console.log(`Backend sync: ${state.backendSyncError}`);
    }
    console.log('');
    console.log('Candidates');
    console.log('-'.repeat(36));
    for (const [index, candidate] of round.candidates.entries()) {
      const marker = candidate.id === round.winnerCandidateId ? '🏆' : `${index + 1}.`;
      console.log(`${marker} ${candidate.title}`);
      console.log(`   ${bar(candidate.votes, maxVotes)} ${candidate.votes} vote(s)`);
    }
    console.log('');
    console.log(`Winner: ${winner ? winner.title : '-'}`);
    console.log(`Attribution: ${state.attribution ?? '-'}`);
    const nextPlayback = state.playbackPlanPreview?.entries.map((entry) => `${entry.kind}: ${entry.title}`).join(' -> ');
    console.log(`Playback: ${nextPlayback || '-'}`);
    console.log(
      `Now    : ${state.playbackStatus.state}` +
        `${state.playbackStatus.currentTitle ? ` / ${state.playbackStatus.currentTitle}` : ''}` +
        `${state.playbackStatus.codec ? ` / ${state.playbackStatus.codec}` : ''}`,
    );
    console.log(`Queue  : ${state.playbackStatus.queuedEntries}`);
    console.log(`Stream : ${state.playbackStatus.streamUrl ?? STREAM_URL}`);
    if (state.playbackStatus.lastError) {
      console.log(`Playback error: ${state.playbackStatus.lastError}`);
    }
    console.log('');
  }

  console.log('Keys: [n] new round  [1-3] test vote  [r] resolve  [q] quit');
}

async function startRound(): Promise<void> {
  await api('/api/rounds/start', {
    method: 'POST',
    body: JSON.stringify({ candidateCount: 3 }),
  });
}

async function vote(state: ApiState | null, index: number): Promise<void> {
  const round = state?.round;
  const candidate = round?.candidates[index];
  if (!round || !candidate || round.status !== 'open') {
    return;
  }
  await api(`/api/rounds/${round.id}/votes`, {
    method: 'POST',
    body: JSON.stringify({
      userId: `dashboard-test-${index + 1}`,
      candidateId: candidate.id,
    }),
  });
}

async function resolveRound(state: ApiState | null): Promise<void> {
  const round = state?.round;
  if (!round || round.status === 'resolved') {
    return;
  }
  await api(`/api/rounds/${round.id}/resolve`, {
    method: 'POST',
    body: '{}',
  });
}

let latestState: ApiState | null = null;
let latestError: string | null = null;
let running = true;

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdin.on('keypress', async (_str, key) => {
  try {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      running = false;
      clear();
      process.exit(0);
    }
    if (key.name === 'n') {
      await startRound();
    }
    if (key.name === 'r') {
      await resolveRound(latestState);
    }
    if (['1', '2', '3'].includes(key.name ?? '')) {
      await vote(latestState, Number(key.name) - 1);
    }
  } catch (error) {
    latestError = error instanceof Error ? error.message : String(error);
  }
});

while (running) {
  try {
    latestState = await api<ApiState>('/api/state');
    latestError = null;
  } catch (error) {
    latestState = null;
    latestError = error instanceof Error ? error.message : String(error);
  }
  const streamStatus = await probeStream();
  render(latestState, streamStatus, latestError);
  await new Promise((resolve) => setTimeout(resolve, REFRESH_MS));
}
