import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {normalizeCoverMatchTitle, synchronizeYoutubeCoverArt} from './youtubeCoverSync';

describe('YouTube cover synchronization', () => {
  it('matches Unicode punctuation and writes a sidecar cover for a downloaded song', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'radiotedu-youtube-cover-'));
    const album = path.join(root, 'Classical');
    const cache = path.join(root, 'cache');
    await mkdir(album);
    const songPath = path.join(album, 'Vivaldi： Four Seasons (Winter).mp3');
    await writeFile(songPath, 'audio');
    await writeFile(path.join(root, 'downloaded.txt'), 'youtube nGdFHJXciAQ\n');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/oembed?')) {
        return Response.json({
          title: 'Vivaldi: Four Seasons (Winter)',
          thumbnail_url: 'https://i.ytimg.com/vi/nGdFHJXciAQ/hqdefault.jpg',
        });
      }
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: {'content-type': 'image/jpeg'},
      });
    }) as typeof fetch;

    const result = await synchronizeYoutubeCoverArt({
      songs: [{id: 'song-1', title: 'Four Seasons (Winter)', artist: 'Vivaldi', filePath: songPath}],
      musicRoots: [root],
      artCacheDir: cache,
      fetchImpl,
    });

    expect(result).toMatchObject({archiveIds: 1, downloaded: 1, failed: 0, unmatched: 0});
    expect(await readFile(path.join(album, 'Vivaldi： Four Seasons (Winter).jpg'))).toEqual(
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    );
  });

  it('normalizes combining marks and presentation punctuation', () => {
    expect(normalizeCoverMatchTitle('Tomás Marco｜Concerto')).toBe(
      normalizeCoverMatchTitle('Tomas Marco | Concerto'),
    );
  });
});
