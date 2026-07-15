import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path


LOCALAPPDATA = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
WALL_PROGRAM = Path(
    os.environ.get(
        "RADIOTEDU_WALL_ROOT",
        str(Path.home() / "AppData" / "Local" / "Programs" / "RadioTEDU Broadcast Wall"),
    )
)
WALL_DATA = LOCALAPPDATA / "RadioTEDU Broadcast Wall"
DB_PATH = Path(os.environ.get("CLEANROOM_DB_PATH", str(WALL_DATA / "cleanroom.db")))
TOOLS_DIR = Path(os.environ.get("CLEANROOM_TOOLS_DIR", str(WALL_DATA / "tools")))

SOURCE_URL = os.environ.get("VOTING_RELAY_SOURCE_URL", "http://127.0.0.1:4320/stream.mp3")
HOST = os.environ.get("VOTING_RELAY_ICECAST_HOST", "10.98.98.75")
PORT = os.environ.get("VOTING_RELAY_ICECAST_PORT", "11154")
MOUNT = os.environ.get("VOTING_RELAY_ICECAST_MOUNT", "/spark")
STATION_ID = int(os.environ.get("VOTING_RELAY_STATION_ID", "5"))
FFMPEG = os.environ.get("VOTING_RELAY_FFMPEG", str(TOOLS_DIR / "bin" / "ffmpeg.exe"))


def log(payload: dict) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {json.dumps(payload, ensure_ascii=False)}", flush=True)


def load_credentials() -> tuple[str, str]:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "select icecast_user, icecast_password from station_outputs where station_id=?",
            (STATION_ID,),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"station_output_missing:{STATION_ID}")
        return str(row["icecast_user"] or "source"), str(row["icecast_password"] or "")
    finally:
        conn.close()


def ffmpeg_process() -> subprocess.Popen:
    return subprocess.Popen(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "2",
            "-i",
            SOURCE_URL,
            "-vn",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-f",
            "adts",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def run_once(user: str, password: str) -> int:
    proc = ffmpeg_process()
    if proc.stdout is None:
        raise RuntimeError("ffmpeg_stdout_missing")

    env = os.environ.copy()
    wall_internal = str(WALL_PROGRAM / "_internal")
    env["PYTHONPATH"] = wall_internal + os.pathsep + env.get("PYTHONPATH", "")
    source_args = [
        sys.executable,
        "-m",
        "app.audio.icecast_source_client",
        "--host",
        HOST,
        "--port",
        str(PORT),
        "--mount",
        MOUNT,
        "--user",
        user,
        "--password",
        password,
        "--buffer-seconds",
        "2.0",
        "--reconnect-delay",
        "1.0",
        "--header",
        "Content-Type: audio/aac",
        "--header",
        "ice-samplerate: 48000",
        "--header",
        "ice-bitrate: 192",
        "--header",
        "ice-channels: 2",
        "--header",
        "ice-audio-info: ice-samplerate=48000;ice-bitrate=192;ice-channels=2",
        "--header",
        "ice-public: 1",
        "--header",
        "ice-name: RadioTEDU Jazz",
        "--header",
        "ice-description: RadioTEDU Jazz live stream from RadioTEDU",
        "--header",
        "ice-genre: Jazz",
        "--header",
        "ice-url: https://radiotedu.com",
        "--header",
        "User-Agent: RadioTEDU Broadcast Wall",
    ]
    source_proc = subprocess.Popen(
        source_args,
        cwd=wall_internal,
        env=env,
        stdin=proc.stdout,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    proc.stdout.close()
    try:
        log({"relay": "starting", "mount": MOUNT, "source": SOURCE_URL})
        code = int(source_proc.wait() or 0)
        stderr = (source_proc.stderr.read() if source_proc.stderr else "").strip()
        if stderr:
            log({"relay": "source_client_stderr", "message": stderr[-500:]})
        return code
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        if source_proc.poll() is None:
            try:
                source_proc.terminate()
                source_proc.wait(timeout=2)
            except Exception:
                try:
                    source_proc.kill()
                except Exception:
                    pass


def main() -> int:
    user, password = load_credentials()
    while True:
        try:
            code = run_once(user, password)
            log({"relay": "exited", "code": code})
        except KeyboardInterrupt:
            return 0
        except Exception as exc:
            log({"relay": "error", "error": str(exc)[:500]})
        time.sleep(2)


if __name__ == "__main__":
    raise SystemExit(main())
