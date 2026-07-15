import { execFile } from 'node:child_process';
import type { PlaybackController } from './icecastStreamer';
import type { PlaybackPlan, PlaybackStatus } from './types';

const PYTHON_BRIDGE = String.raw`
import json, os, sys
from pathlib import Path
from urllib import request

payload = json.loads(sys.stdin.read() or "{}")
root = Path(payload.get("wallRoot") or r"C:\Users\tedu\AppData\Local\Programs\RadioTEDU Broadcast Wall")
live_root = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "RadioTEDU Broadcast Wall"
os.environ.setdefault("LOCALAPPDATA", str(live_root.parent))
os.environ.setdefault("CLEANROOM_DB_PATH", str(live_root / "cleanroom.db"))
os.environ.setdefault("CLEANROOM_TOOLS_DIR", str(live_root / "tools"))
sys.path.insert(0, str(root / "_internal"))

from app.auth.jwt_handler import create_access_token

headers = {
    "Authorization": "Bearer " + create_access_token(1, "admin"),
    "Content-Type": "application/json",
}
body = json.dumps({
    "input_uri": payload["filePath"],
    "stream_title": payload.get("title") or "",
    "stream_artist": payload.get("artist") or "",
}).encode("utf-8")
req = request.Request(
    "http://127.0.0.1:8100/api/runtime/4/start",
    data=body,
    headers=headers,
    method="POST",
)
with request.urlopen(req, timeout=12) as res:
    data = json.loads(res.read().decode("utf-8") or "{}")
print(json.dumps({
    "running": data.get("running"),
    "backend": data.get("backend"),
    "branch_health": data.get("branch_health"),
}))
`;

export function createWallRuntimePlaybackController(): PlaybackController {
  let status: PlaybackStatus = {
    state: 'idle',
    codec: 'wall-runtime',
    queuedEntries: 0,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };

  return {
    enqueue(plan: PlaybackPlan) {
      const winner = [...plan.entries].reverse().find((entry) => entry.kind === 'winner');
      if (!winner) {
        return status;
      }

      status = {
        ...status,
        state: 'queued',
        queuedEntries: 1,
        lastWinnerTitle: winner.title,
        lastWinnerFilePath: winner.filePath,
        lastError: null,
        updatedAt: new Date().toISOString(),
      };

      const payload = JSON.stringify({
        filePath: winner.filePath,
        title: winner.title,
        wallRoot:
          process.env.RADIOTEDU_WALL_ROOT ??
          'C:\\Users\\tedu\\AppData\\Local\\Programs\\RadioTEDU Broadcast Wall',
      });

      const child = execFile('python', ['-c', PYTHON_BRIDGE], { timeout: 15_000 }, (error, stdout, stderr) => {
        if (error) {
          status = {
            ...status,
            state: 'error',
            queuedEntries: 0,
            lastError: stderr || error.message,
            updatedAt: new Date().toISOString(),
          };
          console.error(`Wall runtime playback failed: ${stderr || error.message}`);
          return;
        }
        status = {
          ...status,
          state: 'playing',
          queuedEntries: 0,
          currentKind: 'winner',
          currentTitle: winner.title,
          currentFilePath: winner.filePath,
          lastError: null,
          updatedAt: new Date().toISOString(),
        };
        console.log(`Wall runtime playback accepted: ${stdout.trim()}`);
      });
      child.stdin?.end(payload);
      return status;
    },
    status() {
      return status;
    },
  };
}
