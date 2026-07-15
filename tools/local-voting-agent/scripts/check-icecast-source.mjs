import { spawn } from 'node:child_process';
import { once } from 'node:events';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Pass one local audio file path.');

const publicUrl = new URL(process.env.ICECAST_SOURCE_URL);
publicUrl.username = process.env.ICECAST_SOURCE_USERNAME || 'source';
publicUrl.password = process.env.ICECAST_SOURCE_PASSWORD || '';
const port = Number(publicUrl.port || (publicUrl.protocol === 'https:' ? 443 : 80));
const legacySource = port !== 80 && port !== 443;
const protocol = legacySource ? 'icecast' : port === 443 ? 'https' : 'http';
const host = (port === 80 || port === 443) ? publicUrl.hostname : publicUrl.host;
const outputUrl = `${protocol}://${publicUrl.username}:${publicUrl.password}@${host}${publicUrl.pathname}${publicUrl.search}`;
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const args = [
  '-hide_banner', '-loglevel', 'warning', '-nostdin', '-re', '-i', inputPath,
  '-t', '15', '-vn', '-ar', '48000', '-ac', '2',
  '-codec:a', 'aac', '-b:a', '192k', '-profile:a', 'aac_low',
  '-user_agent', 'RadioTEDU Broadcast Wall',
  '-ice_name', 'RadioTEDU Voting', '-ice_description', 'RadioTEDU next-song voting stream',
  '-ice_genre', 'RadioTEDU', '-ice_url', 'https://radiotedu.com', '-ice_public', '1',
  '-content_type', 'audio/aac', '-f', 'adts',
  ...(legacySource ? ['-legacy_icecast', '1'] : []),
  outputUrl,
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
