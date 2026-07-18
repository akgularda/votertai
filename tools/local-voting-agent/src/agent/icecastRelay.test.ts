import { describe, expect, it } from 'vitest';
import { buildIcecastPcmSinkArgs } from './icecastRelay';
import type { IcecastSourceConfig } from './types';

const config: IcecastSourceConfig = {
  enabled: true,
  url: 'http://icecast.example.test:11154/ai',
  username: 'source',
  password: 'p@ss word',
  bitrateKbps: 192,
  name: 'RadioTEDU Voting',
  genre: 'RadioTEDU',
  description: 'Voting radio',
};

describe('BroadcastAI-compatible Icecast PCM sink', () => {
  it('keeps one PCM-fed AAC-LC ADTS source process on the /ai mount', () => {
    const args = buildIcecastPcmSinkArgs(config);

    expect(args.slice(3, 13)).toEqual(['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-vn', '-c:a']);
    expect(args).toContain('aac');
    expect(args).toContain('192k');
    expect(args).toContain('aac_low');
    expect(args).toContain('audio/aac');
    expect(args).toContain('adts');
    expect(args).toContain('-legacy_icecast');
    expect(args.at(-1)).toBe('icecast://source:p%40ss%20word@icecast.example.test:11154/ai');
  });

  it('supports the proven /ai MP3 source contract without legacy SOURCE mode', () => {
    const args = buildIcecastPcmSinkArgs({
      ...config,
      codec: 'mp3',
      legacySource: false,
      sourceTransport: 'http',
    });

    expect(args).toContain('libmp3lame');
    expect(args).toContain('audio/mpeg');
    expect(args).toContain('mp3');
    expect(args).not.toContain('-legacy_icecast');
    expect(args.at(-1)).toBe('http://source:p%40ss%20word@icecast.example.test:11154/ai');
  });
});
