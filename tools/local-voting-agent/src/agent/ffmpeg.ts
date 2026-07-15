export interface ParsedFfprobeMetadata {
  title?: string;
  artist?: string;
  durationSeconds?: number;
  hasArtwork?: boolean;
}

interface FfprobeFormat {
  duration?: unknown;
  tags?: Record<string, unknown>;
}

interface FfprobePayload {
  format?: FfprobeFormat;
  streams?: Array<{ codec_type?: unknown; disposition?: { attached_pic?: unknown } }>;
}

export function buildFfprobeMetadataArgs(filePath: string): string[] {
  return ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];
}

export function parseFfprobeMetadata(stdout: string): ParsedFfprobeMetadata {
  try {
    const payload = JSON.parse(stdout) as FfprobePayload;
    const tags = payload.format?.tags ?? {};
    const duration = Number(payload.format?.duration);
    const hasArtwork = Boolean(
      payload.streams?.some(
        (stream) => stream.codec_type === 'video' || Number(stream.disposition?.attached_pic ?? 0) === 1,
      ),
    );

    return {
      ...(typeof tags.title === 'string' ? { title: tags.title } : {}),
      ...(typeof tags.artist === 'string' ? { artist: tags.artist } : {}),
      ...(Number.isFinite(duration) ? { durationSeconds: Math.floor(duration) } : {}),
      ...(hasArtwork ? { hasArtwork: true } : {}),
    };
  } catch {
    return {};
  }
}

export function buildAlbumArtExtractionArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-q:v',
    '2',
    outputPath,
  ];
}

export function buildPlaybackArgs(filePath: string): string[] {
  return ['-hide_banner', '-nostdin', '-re', '-i', filePath, '-f', 'null', '-'];
}
