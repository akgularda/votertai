import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(workDir, 'runtime-logs');
const varDir = path.join(workDir, 'var');
const supervisorLog = path.join(logDir, 'voting-supervisor.log');
const supervisorLockPath = path.join(varDir, 'voting-supervisor.pid');
const agentLockPath = path.join(varDir, 'voting-agent.lock');
const serverPath = path.join(workDir, 'dist-server', 'index.mjs');
const healthUrl = `http://127.0.0.1:${process.env.PORT || '4317'}/api/health`;
const localStreamUrl = `http://127.0.0.1:${process.env.LOCAL_HTTP_STREAM_PORT || '4320'}${process.env.LOCAL_HTTP_STREAM_PATH || '/ai'}`;
const publicStreamUrl = process.env.ICECAST_PUBLIC_STREAM_URL || 'https://stream.radiotedu.com/ai';

mkdirSync(logDir, { recursive: true });
mkdirSync(varDir, { recursive: true });

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquirePidLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(lockPath, 'wx');
      writeFileSync(handle, `${process.pid}\n`, 'utf8');
      closeSync(handle);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = 0;
      try {
        owner = Number(readFileSync(lockPath, 'utf8').trim());
      } catch {}
      if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner)) return false;
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') return false;
      }
    }
  }
  return false;
}

function releasePidLock(lockPath) {
  try {
    if (Number(readFileSync(lockPath, 'utf8').trim()) === process.pid) unlinkSync(lockPath);
  } catch {}
}

function log(message) {
  appendFileSync(supervisorLog, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function rotateAgentLogs() {
  const files = readdirSync(logDir)
    .filter((name) => /^voting-agent-\d{8}-\d{6}\.(out|err)\.log$/.test(name))
    .map((name) => ({ name, modified: statSync(path.join(logDir, name)).mtimeMs }))
    .sort((left, right) => right.modified - left.modified);
  for (const file of files.slice(20)) {
    try {
      unlinkSync(path.join(logDir, file.name));
    } catch {}
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: 'no-store', redirect: 'manual', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getHealth() {
  try {
    const response = await fetchWithTimeout(healthUrl, 4_000);
    if (!response.ok) return null;
    const health = await response.json();
    return health?.ok === true &&
      health?.service === 'radiotedu-local-voting-agent' &&
      !['disabled', 'error'].includes(health?.playbackState)
      ? health
      : null;
  } catch {
    return null;
  }
}

async function hasAudio(url, timeoutMs) {
  let reader;
  try {
    const response = await fetchWithTimeout(url, timeoutMs);
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('audio/')) return false;
    reader = response.body?.getReader();
    if (!reader) return false;
    const chunk = await reader.read();
    return !chunk.done && Boolean(chunk.value?.byteLength);
  } catch {
    return false;
  } finally {
    try {
      await reader?.cancel();
    } catch {}
  }
}

function stopAgentFromLock() {
  let pid = 0;
  try {
    pid = Number(readFileSync(agentLockPath, 'utf8').trim());
  } catch {}
  if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
    try {
      process.kill(pid);
    } catch {}
  }
  try {
    unlinkSync(agentLockPath);
  } catch {}
}

let child = null;
let childStartedAt = 0;
let stopping = false;
let restartTimer = null;

function startAgent() {
  if (stopping || (child && child.exitCode === null)) return;
  rotateAgentLogs();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const stdout = openSync(path.join(logDir, `voting-agent-${stamp}.out.log`), 'a');
  const stderr = openSync(path.join(logDir, `voting-agent-${stamp}.err.log`), 'a');
  child = spawn(process.execPath, [serverPath], {
    cwd: workDir,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
  });
  childStartedAt = Date.now();
  closeSync(stdout);
  closeSync(stderr);
  log(`started voting agent pid=${child.pid}`);
  child.once('close', (code) => {
    child = null;
    childStartedAt = 0;
    if (stopping) return;
    log(`voting agent exited code=${code ?? 'signal'}; checking recovery`);
    scheduleRecovery(2_000);
  });
  child.once('error', () => {
    log('voting agent process failed to start; retrying');
  });
}

function scheduleRecovery(delayMs) {
  if (stopping || restartTimer) return;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    const healthy = await getHealth();
    if (!healthy || !(await hasAudio(localStreamUrl, 5_000))) startAgent();
  }, delayMs);
}

function stopManagedAgent() {
  if (child?.pid) {
    try {
      child.kill();
    } catch {}
  } else {
    stopAgentFromLock();
  }
}

if (!acquirePidLock(supervisorLockPath)) process.exit(0);

let localFailures = 0;
let lastLocalHealthy = null;
let lastPublicHealthy = null;
let nextPublicCheckAt = 0;
let checkRunning = false;

async function monitor() {
  if (checkRunning || stopping) return;
  checkRunning = true;
  try {
    const health = await getHealth();
    const localHealthy = Boolean(health) && await hasAudio(localStreamUrl, 5_000);
    const withinStartupGrace = Boolean(child && child.exitCode === null && Date.now() - childStartedAt < 90_000);
    if (localHealthy) {
      localFailures = 0;
      if (lastLocalHealthy !== true) log('local agent and audio stream healthy');
    } else if (withinStartupGrace) {
      localFailures = 0;
      if (lastLocalHealthy !== false) log('agent startup in progress; health grace active');
    } else {
      localFailures += 1;
      if (lastLocalHealthy !== false) log('local health degraded; confirming before restart');
      if (localFailures >= 3) {
        log('local health failed three times; replacing managed agent');
        stopManagedAgent();
        scheduleRecovery(1_000);
        localFailures = 0;
      }
    }
    lastLocalHealthy = localHealthy;

    if (Date.now() >= nextPublicCheckAt) {
      const publicHealthy = await hasAudio(publicStreamUrl, 8_000);
      if (publicHealthy && lastPublicHealthy !== true) log('public /ai stream healthy');
      if (!publicHealthy && lastPublicHealthy !== false) log('public /ai unavailable; source reconnect remains active');
      lastPublicHealthy = publicHealthy;
      nextPublicCheckAt = Date.now() + 30_000;
    }
  } finally {
    checkRunning = false;
  }
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  stopManagedAgent();
  releasePidLock(supervisorLockPath);
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('exit', () => releasePidLock(supervisorLockPath));
process.once('uncaughtException', () => {
  log('supervisor fatal exception; Task Scheduler will restart it');
  process.exit(1);
});
process.once('unhandledRejection', () => {
  log('supervisor fatal rejection; Task Scheduler will restart it');
  process.exit(1);
});

log('hardened Node voting supervisor starting');
startAgent();
setTimeout(() => void monitor(), 2_000);
setInterval(() => void monitor(), 5_000);
