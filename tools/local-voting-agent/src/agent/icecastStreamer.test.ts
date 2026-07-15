import { describe, expect, it } from 'vitest';
import { reconnectDelayMs, sanitizeIcecastStatusUrl, toIcecastErrorCode } from './icecastStreamer';

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
});
