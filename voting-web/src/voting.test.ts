import {describe, expect, it} from 'vitest';
import {candidateArtUrl, normalizeRound, normalizeStatus, resolveRuntimeConfig, roundCopy} from './voting';

describe('voting web contract', () => {
  it('uses the production jukebox API and Socket.IO paths', () => {
    const config = resolveRuntimeConfig({origin: 'https://radiotedu.com', hostname: 'radiotedu.com', protocol: 'https:'}, false);
    expect(config.apiBaseUrl).toBe('https://radiotedu.com/jukebox/api/v1');
    expect(config.socketPath).toBe('/jukebox/socket.io');
  });

  it('normalizes the backend round envelope', () => {
    const round = normalizeRound({data: {round: {
      id: 'round-1', status: 'open', lock_at: '2026-07-15T12:00:00.000Z', server_now: '2026-07-15T11:59:30.000Z',
      candidates: [{candidate_id: 'c1', song_id: 's1', title: 'Song', artist: 'Artist', votes: 2}],
      user_vote_candidate_id: 'c1',
    }}});
    expect(round?.candidates[0]).toMatchObject({id: 'c1', songId: 's1', votes: 2});
    expect(round?.userVoteCandidateId).toBe('c1');
  });

  it('normalizes service status and safe artwork URLs', () => {
    const status = normalizeStatus({data: {agent: {agentId: 'school-radio-pc', connected: true}, streamUrl: 'https://stream.radiotedu.com/ai'}}, 'fallback');
    expect(status?.agent.connected).toBe(true);
    expect(candidateArtUrl({id: 'c', songId: 's', title: '', artist: '', albumArtUrl: '/jukebox/uploads/a.webp', votes: 0}, 'https://radiotedu.com')).toBe('https://radiotedu.com/jukebox/uploads/a.webp');
  });

  it('renders round:null as a waiting state', () => {
    expect(roundCopy(null).title).toBe('Yeni tur bekleniyor');
  });
});
