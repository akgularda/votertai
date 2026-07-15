import { describe, expect, it } from 'vitest';
import {
  buildAuthenticatedIcecastOutputUrl,
  reconnectDelayMs,
  sanitizeIcecastStatusUrl,
  toIcecastErrorCode,
  usesLegacyIcecastSource,
} from './icecastStreamer';
import type { IcecastSourceConfig } from './types';

const sourceConfig: IcecastSourceConfig = {
  enabled: true,
  url: 'https://stream.example.test/ai',
  username: 'source',
  password: 'p@ss word',
  bitrateKbps: 192,
  name: 'RadioTEDU Voting',
  genre: 'RadioTEDU',
  description: 'Voting stream',
};

describe('icecast streamer secret redaction', () => {
  it('exposes only fixed error codes for raw and encoded credential diagnostics', () => {
    const raw = new Error('icecast://source:p@ssword@stream.example.test/ai?token=secret');
    const encoded = new Error('icecast://source:p%40ssword@stream.example.test/ai?signature=secret');

    expect(toIcecastErrorCode(raw)).toBe('icecast_stream_failed');
    expect(toIcecastErrorCode(encoded)).toBe('icecast_stream_failed');
    expect(toIcecastErrorCode(new Error('icecast_ffmpeg_failed'))).toBe('icecast_ffmpeg_failed');
  });

  it('removes userinfo, query values, and fragments from outward stream status', () => {
    expect(
      sanitizeIcecastStatusUrl('icecasts://source:p%40ssword@stream.example.test/ai?token=secret#private'),
    ).toBe('icecasts://stream.example.test/ai');
    expect(sanitizeIcecastStatusUrl('not a url')).toBe('icecast_stream');
  });

  it('retries forever with a bounded exponential delay', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map((attempt) => reconnectDelayMs(attempt))).toEqual([
      2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
  });

  it('uses the working HTTPS source method on port 443 instead of legacy icecast mode', () => {
    expect(buildAuthenticatedIcecastOutputUrl(sourceConfig)).toBe(
      'https://source:p%40ss%20word@stream.example.test/ai',
    );
    expect(buildAuthenticatedIcecastOutputUrl({ ...sourceConfig, url: 'http://stream.example.test:11154/ai' }))
      .toBe('icecast://source:p%40ss%20word@stream.example.test:11154/ai');
    expect(usesLegacyIcecastSource(sourceConfig)).toBe(false);
    expect(usesLegacyIcecastSource({ ...sourceConfig, url: 'http://stream.example.test:11154/ai' })).toBe(true);
  });
});
