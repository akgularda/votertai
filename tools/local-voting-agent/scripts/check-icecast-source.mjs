import { spawn } from 'node:child_process';
import { once } from 'node:events';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Pass one local audio file path.');

const publicUrl = new URL(process.env.ICECAST_SOURCE_URL);
publicUrl.username = process.env.ICECAST_SOURCE_USERNAME || 'source';
publicUrl.password = process.env.ICECAST_SOURCE_PASSWORD || '';
const outputUrl = `icecast://${publicUrl.username}:${publicUrl.password}@${publicUrl.host}${publicUrl.pathname}${publicUrl.search}`;
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const args = [
  '-hide_banner', '-loglevel', 'warning', '-nostdin', '-re', '-i', inputPath,
  '-t', '15', '-vn', '-codec:a', 'libmp3lame', '-b:a', '192k',
  '-content_type', 'audio/mpeg', '-f', 'mp3', outputUrl,
];
const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
const [code] = await once(child, 'close');
const password = process.env.ICECAST_SOURCE_PASSWORD || '';
const safeError = stderr
  .split(password).join('<redacted>')
  .split(encodeURIComponent(password)).join('<redacted>')
  .replace(/Authorization:\s*Basic\s+\S+/gi, 'Authorization: Basic <redacted>');
console.log(JSON.stringify({ ok: code === 0, exitCode: code, error: safeError.slice(-1200) }));
process.exitCode = code === 0 ? 0 : 1;
