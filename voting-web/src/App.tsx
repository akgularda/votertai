import {useCallback, useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {io} from 'socket.io-client';
import {
  AlertTriangle,
  Check,
  Clock3,
  Headphones,
  LogIn,
  LogOut,
  Music2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  UserRound,
  Vote,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  candidateArtUrl,
  normalizeRound,
  normalizeStatus,
  resolveRuntimeConfig,
  roundCopy,
  secondsRemaining,
  type Candidate,
  type VotingRound,
  type VotingStatus,
} from './voting';

interface AuthUser {
  display_name?: string;
  is_guest?: boolean;
}

interface Notice {
  tone: 'error' | 'success' | 'info';
  message: string;
}

const demoRound: VotingRound = {
  id: 'preview-round',
  status: 'open',
  openedAt: new Date().toISOString(),
  lockAt: new Date(Date.now() + 48_000).toISOString(),
  resolveAt: new Date(Date.now() + 58_000).toISOString(),
  serverNow: new Date().toISOString(),
  userVoteCandidateId: null,
  winnerCandidateId: null,
  resolutionMode: null,
  candidates: [
    {id: 'c1', songId: 's1', title: 'Blinding Lights', artist: 'The Weeknd', albumArtUrl: null, votes: 18},
    {id: 'c2', songId: 's2', title: 'Espresso', artist: 'Sabrina Carpenter', albumArtUrl: null, votes: 12},
    {id: 'c3', songId: 's3', title: 'Bir Derdim Var', artist: 'Mor ve Ötesi', albumArtUrl: null, votes: 9},
  ],
};

function parseBridgePayload(value: unknown): {accessToken: string | null; user: AuthUser | null} | null {
  let payload = value;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (record.type && record.type !== 'radiotedu.voting.auth') return null;
  return {
    accessToken: typeof record.accessToken === 'string' && record.accessToken ? record.accessToken : null,
    user: record.user && typeof record.user === 'object' ? record.user as AuthUser : null,
  };
}

function CandidateCard({
  candidate,
  index,
  origin,
  selected,
  winner,
  disabled,
  onVote,
}: {
  candidate: Candidate;
  index: number;
  origin: string;
  selected: boolean;
  winner: boolean;
  disabled: boolean;
  onVote(): void;
}) {
  const artUrl = candidateArtUrl(candidate, origin);
  return (
    <button
      type="button"
      className={`candidate-card${selected ? ' selected' : ''}${winner ? ' winner' : ''}`}
      disabled={disabled}
      onClick={onVote}
      aria-pressed={selected}
      aria-label={`${candidate.title}, ${candidate.artist}; ${candidate.votes} oy`}
    >
      <span className="candidate-index">0{index + 1}</span>
      <span className="candidate-art">
        {artUrl ? <img src={artUrl} alt="" /> : <Music2 aria-hidden="true" />}
      </span>
      <span className="candidate-copy">
        <strong>{candidate.title}</strong>
        <small>{candidate.artist}</small>
      </span>
      <span className="candidate-votes">
        {selected || winner ? <Check size={15} aria-hidden="true" /> : <Vote size={15} aria-hidden="true" />}
        <strong>{candidate.votes}</strong>
        <small>oy</small>
      </span>
    </button>
  );
}

export default function App() {
  const config = useMemo(() => resolveRuntimeConfig(window.location), []);
  const embedded = useMemo(() => new URLSearchParams(window.location.search).get('embed') === '1', []);
  const isDemo = import.meta.env.DEV && new URLSearchParams(window.location.search).get('demo') === '1';
  const [round, setRound] = useState<VotingRound | null>(isDemo ? demoRound : null);
  const [status, setStatus] = useState<VotingStatus | null>(isDemo ? {
    agent: {agentId: 'school-radio-pc', connected: true, lastSeen: new Date().toISOString()},
    activeRound: null,
    streamUrl: config.streamUrl,
    serverNow: new Date().toISOString(),
  } : null);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [apiConnected, setApiConnected] = useState<boolean | null>(isDemo ? true : null);
  const [loading, setLoading] = useState(!isDemo);
  const [votingId, setVotingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [tick, setTick] = useState(Date.now());
  const audioRef = useRef<HTMLAudioElement>(null);

  const headers = useCallback((withJson = false) => ({
    ...(withJson ? {'Content-Type': 'application/json'} : {}),
    ...(token ? {Authorization: `Bearer ${token}`} : {}),
  }), [token]);

  const loadRound = useCallback(async (quiet = false) => {
    if (isDemo) return;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`${config.apiBaseUrl}/next-song-voting/rounds/active`, {headers: headers()});
      if (!response.ok) throw new Error(`active_round_${response.status}`);
      const payload = await response.json();
      setRound(normalizeRound(payload));
      setApiConnected(true);
    } catch {
      setApiConnected(false);
      if (!quiet) setNotice({tone: 'error', message: 'Voting sunucusuna şu anda ulaşılamıyor. Yeniden deniyoruz.'});
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [config.apiBaseUrl, headers, isDemo]);

  const loadStatus = useCallback(async () => {
    if (isDemo) return;
    try {
      const response = await fetch(`${config.apiBaseUrl}/next-song-voting/status`);
      if (!response.ok) return;
      setStatus(normalizeStatus(await response.json(), config.streamUrl));
    } catch {
      // Round polling is authoritative; status is intentionally best-effort.
    }
  }, [config.apiBaseUrl, config.streamUrl, isDemo]);

  useEffect(() => {
    void loadRound();
    void loadStatus();
  }, [loadRound, loadStatus]);

  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (isDemo) return;
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadRound(true);
    }, 4000);
    const statusPoll = window.setInterval(() => void loadStatus(), 15000);
    const onVisible = () => { if (document.visibilityState === 'visible') void loadRound(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(statusPoll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isDemo, loadRound, loadStatus]);

  useEffect(() => {
    if (isDemo) return;
    const socket = io(config.socketOrigin, {
      path: config.socketPath,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      timeout: 12000,
    });
    const update = (payload: unknown) => {
      const incoming = normalizeRound(payload);
      setRound((current) => incoming && current?.id === incoming.id && !incoming.userVoteCandidateId && current.userVoteCandidateId
        ? {...incoming, userVoteCandidateId: current.userVoteCandidateId}
        : incoming);
    };
    socket.on('connect', () => { setSocketConnected(true); void loadRound(true); });
    socket.on('disconnect', () => setSocketConnected(false));
    socket.on('next_vote_round_started', update);
    socket.on('next_vote_round_updated', update);
    socket.on('next_vote_round_locked', update);
    socket.on('next_vote_round_resolved', update);
    socket.on('next_vote_round_cancelled', () => setRound(null));
    return () => {
      socket.disconnect();
    };
  }, [config.socketOrigin, config.socketPath, isDemo, loadRound]);

  useEffect(() => {
    const applyAuth = (payload: {accessToken?: string | null; user?: unknown}) => {
      const parsed = parseBridgePayload({type: 'radiotedu.voting.auth', ...payload});
      if (!parsed) return;
      setToken(parsed.accessToken);
      setUser(parsed.user);
      setShowLogin(false);
    };
    window.__RADIOTEDU_SET_AUTH__ = applyAuth;
    const onMessage = (event: MessageEvent) => {
      const parsed = parseBridgePayload(event.data);
      if (!parsed) return;
      setToken(parsed.accessToken);
      setUser(parsed.user);
      setShowLogin(false);
    };
    window.addEventListener('message', onMessage);
    window.ReactNativeWebView?.postMessage(JSON.stringify({type: 'radiotedu.voting.ready'}));
    return () => {
      window.removeEventListener('message', onMessage);
      delete window.__RADIOTEDU_SET_AUTH__;
    };
  }, []);

  useEffect(() => {
    if (token) void loadRound(true);
  }, [token, loadRound]);

  const submitVote = async (candidateId: string) => {
    if (!round || round.status !== 'open' || votingId) return;
    if (!token) {
      setShowLogin(true);
      setNotice({tone: 'info', message: 'Oy vermek için RadioTEDU hesabınla giriş yap.'});
      return;
    }
    setVotingId(candidateId);
    setNotice(null);
    try {
      const response = await fetch(`${config.apiBaseUrl}/next-song-voting/rounds/${encodeURIComponent(round.id)}/votes`, {
        method: 'POST', headers: headers(true), body: JSON.stringify({candidateId}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) setShowLogin(true);
        if (response.status === 403) throw new Error('Oy vermek için misafir olmayan bir hesap gerekli.');
        if (response.status === 409) throw new Error('Bu turun oyları artık kilitli.');
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Oy gönderilemedi.');
      }
      setRound(normalizeRound(payload));
      setNotice({tone: 'success', message: 'Oyun kaydedildi. Tur kapanana kadar seçimini değiştirebilirsin.'});
      window.ReactNativeWebView?.postMessage(JSON.stringify({type: 'radiotedu.voting.vote-recorded', roundId: round.id, candidateId}));
    } catch (error) {
      setNotice({tone: 'error', message: error instanceof Error ? error.message : 'Oy gönderilemedi.'});
    } finally {
      setVotingId(null);
    }
  };

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoginBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${config.apiBaseUrl}/auth/login`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({email: String(form.get('email') || '').trim(), password: String(form.get('password') || '')}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.data?.access_token) throw new Error('E-posta veya şifre hatalı.');
      setToken(payload.data.access_token);
      setUser(payload.data.user ?? null);
      setShowLogin(false);
      setNotice({tone: 'success', message: 'Giriş yapıldı. Şimdi adayını seçebilirsin.'});
    } catch (error) {
      setNotice({tone: 'error', message: error instanceof Error ? error.message : 'Giriş yapılamadı.'});
    } finally {
      setLoginBusy(false);
    }
  };

  const toggleAudio = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      if (audio.paused) { await audio.play(); setPlaying(true); }
      else { audio.pause(); setPlaying(false); }
    } catch {
      setNotice({tone: 'error', message: 'Canlı yayın başlatılamadı. Bağlantını kontrol edip tekrar dene.'});
    }
  };

  const copy = roundCopy(round);
  const remaining = secondsRemaining(round, tick);
  const streamUrl = status?.streamUrl || config.streamUrl;
  const agentOnline = status?.agent.connected === true;

  return (
    <main className={`app-shell${embedded ? ' embedded' : ''}`}>
      <audio ref={audioRef} src={streamUrl} preload="none" onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />

      <header className="site-header">
        <img src="./radiotedu-logo.png" alt="RadioTEDU" className="brand-logo" />
        <button className="account-button" type="button" onClick={() => token ? (setToken(null), setUser(null)) : setShowLogin(true)}>
          {token ? <LogOut aria-hidden="true" /> : <UserRound aria-hidden="true" />}
          <span>{token ? user?.display_name || 'Çıkış' : 'Giriş'}</span>
        </button>
      </header>

      <section className="stream-card" aria-label="Voting Radio canlı yayın">
        <div className="stream-art"><Radio aria-hidden="true" /></div>
        <div className="stream-copy">
          <div className="stream-badges">
            <span className="live-badge"><i /> LIVE</span>
            <span className={`agent-badge ${agentOnline ? 'online' : ''}`}>{agentOnline ? <Wifi /> : <WifiOff />} {agentOnline ? 'PC bağlı' : 'PC bekleniyor'}</span>
          </div>
          <strong>Voting Radio</strong>
          <small>Sıradaki şarkıyı dinleyiciler seçiyor</small>
        </div>
        <button className="play-button" type="button" onClick={toggleAudio} aria-label={playing ? 'Canlı yayını duraklat' : 'Canlı yayını oynat'}>
          {playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        </button>
      </section>

      <section className="vote-hero">
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-topline">
          <span className={`connection-pill ${apiConnected === false ? 'offline' : ''}`}>
            {apiConnected === false ? <WifiOff /> : <Wifi />} {apiConnected === false ? 'Bağlantı aranıyor' : socketConnected || isDemo ? 'Canlı bağlı' : 'Sunucu bağlı'}
          </span>
          {remaining !== null && <span className="timer"><Clock3 /> {remaining}s</span>}
        </div>
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1>{copy.title}</h1>
        <p className="hero-detail">{copy.detail}</p>
      </section>

      {notice && (
        <div className={`notice ${notice.tone}`} role="status">
          {notice.tone === 'error' ? <AlertTriangle /> : notice.tone === 'success' ? <Check /> : <Headphones />}
          <span>{notice.message}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Bildirimi kapat"><X /></button>
        </div>
      )}

      <section className="candidates-section">
        <div className="section-heading">
          <div><span>Canlı oylama</span><h2>Aday şarkılar</h2></div>
          <button type="button" className="refresh-button" onClick={() => void loadRound()} disabled={loading} aria-label="Oylamayı yenile"><RefreshCw className={loading ? 'spinning' : ''} /></button>
        </div>

        {loading ? (
          <div className="loading-list" aria-label="Oylama yükleniyor">{[0, 1, 2].map((item) => <div key={item} />)}</div>
        ) : round?.candidates.length ? (
          <div className="candidate-list">
            {round.candidates.map((candidate, index) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                index={index}
                origin={window.location.origin}
                selected={round.userVoteCandidateId === candidate.id}
                winner={round.winnerCandidateId === candidate.id}
                disabled={round.status !== 'open' || votingId !== null}
                onVote={() => void submitVote(candidate.id)}
              />
            ))}
          </div>
        ) : (
          <div className="empty-round">
            <span className="signal"><Radio /></span>
            <h2>Yayın devam ediyor</h2>
            <p>Yeni tur, çalan şarkının bitimine yaklaşık 60 saniye kala burada açılır.</p>
            <button type="button" onClick={() => void loadRound()}><RefreshCw /> Şimdi kontrol et</button>
          </div>
        )}
      </section>

      <footer>
        <span><i className={agentOnline ? 'online' : ''} /> Voting PC → RadioTEDU Server → Sen</span>
        <strong>RADIO<span>TEDU</span></strong>
      </footer>

      {showLogin && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowLogin(false); }}>
          <section className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title">
            <button type="button" className="modal-close" onClick={() => setShowLogin(false)} aria-label="Giriş penceresini kapat"><X /></button>
            <span className="modal-icon"><LogIn /></span>
            <p className="eyebrow">RadioTEDU hesabı</p>
            <h2 id="login-title">Oyunu kaydet</h2>
            <p>Mobil uygulamadaysan oturumun otomatik aktarılır. Web’deysen hesabınla giriş yap.</p>
            <form onSubmit={login}>
              <label>E-posta<input name="email" type="email" autoComplete="email" required /></label>
              <label>Şifre<input name="password" type="password" autoComplete="current-password" minLength={6} required /></label>
              <button type="submit" disabled={loginBusy}>{loginBusy ? 'Bağlanıyor…' : 'Giriş yap ve oy ver'}</button>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
