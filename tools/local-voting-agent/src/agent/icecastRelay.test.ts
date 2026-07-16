import { describe, expect, it } from 'vitest';
import { buildIcecastRelayArgs } from './icecastRelay';
import type { IcecastSourceConfig } from './types';

const config: IcecastSourceConfig = {
  enabled: true,
  url: 'http://icecast.example.test:11154/ai',
  username: 'source',
  password: 'p@ss word',
  bitrateKbps: 128,
  name: 'RadioTEDU Voting',
  genre: 'RadioTEDU',
  description: 'Voting radio',
};

describe('Icecast relay command', () => {
  it('relays the persistent MP3 stream without transcoding and uses legacy Icecast source mode', () => {
    const args = buildIcecastRelayArgs('http://127.0.0.1:4320/ai', config);

    expect(args).toContain('http://127.0.0.1:4320/ai');
    expect(args).toContain('copy');
    expect(args).toContain('audio/mpeg');
    expect(args).toContain('-legacy_icecast');
    expect(args.at(-1)).toBe('icecast://source:p%40ss%20word@icecast.example.test:11154/ai');
  });
});
