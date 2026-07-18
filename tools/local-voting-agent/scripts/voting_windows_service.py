from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import ctypes
from ctypes import wintypes
from pathlib import Path
from urllib.request import Request, urlopen


SERVICE_NAME = "RadioTEDUVotingRadio"
SERVICE_DISPLAY_NAME = "RadioTEDU Voting Radio"
SERVICE_DESCRIPTION = (
    "Starts and supervises the RadioTEDU Voting player, backend WebSocket agent, "
    "and continuous /ai source."
)

CONFIG_DIR = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "RadioTEDU Voting"
CONFIG_PATH = CONFIG_DIR / "service.json"


def _load_service_config() -> dict[str, str]:
    try:
        # Windows PowerShell 5.1 writes a UTF-8 BOM by default. utf-8-sig
        # accepts both BOM and BOM-less config files.
        parsed = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
        return parsed if isinstance(parsed, dict) else {}
    except (OSError, ValueError):
        return {}


SERVICE_CONFIG = _load_service_config()


def _candidate_pywin32_sites() -> list[Path]:
    version = f"Python{sys.version_info.major}{sys.version_info.minor}"
    candidates: list[Path] = []
    configured = str(SERVICE_CONFIG.get("pywin32SitePackages", "")).strip()
    if configured:
        candidates.append(Path(configured))

    candidates.append(Path(sys.executable).parent / "Lib" / "site-packages")
    users_root = Path(os.environ.get("SystemDrive", "C:") + r"\Users")
    try:
        candidates.extend(
            user_dir / "AppData" / "Roaming" / "Python" / version / "site-packages"
            for user_dir in users_root.iterdir()
            if user_dir.is_dir()
        )
    except OSError:
        pass
    return candidates


def _prepare_pywin32_imports() -> None:
    for site_packages in _candidate_pywin32_sites():
        if not (site_packages / "win32" / "lib" / "win32serviceutil.py").exists():
            continue
        paths = (
            site_packages,
            site_packages / "win32",
            site_packages / "win32" / "lib",
            site_packages / "pythonwin",
            site_packages / "pywin32_system32",
        )
        for path in paths:
            text = str(path)
            if path.exists() and text not in sys.path:
                sys.path.insert(0, text)
            if path.exists() and hasattr(os, "add_dll_directory"):
                try:
                    os.add_dll_directory(text)
                except OSError:
                    pass
        return


_prepare_pywin32_imports()

import servicemanager  # noqa: E402
import win32event  # noqa: E402
import win32service  # noqa: E402
import win32serviceutil  # noqa: E402


def _path_from_config(key: str, fallback: Path) -> Path:
    value = str(SERVICE_CONFIG.get(key, "")).strip()
    return Path(value) if value else fallback


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_AGENT_ROOT = SCRIPT_DIR.parent
AGENT_ROOT = _path_from_config("agentRoot", DEFAULT_AGENT_ROOT)
NODE_EXE = _path_from_config("nodeExe", Path(r"C:\Program Files\nodejs\node.exe"))
ENV_FILE = _path_from_config("envFile", AGENT_ROOT / ".env")
SUPERVISOR_SCRIPT = _path_from_config(
    "supervisorScript", AGENT_ROOT / "scripts" / "voting-supervisor.mjs"
)
SUPERVISOR_PID_FILE = AGENT_ROOT / "var" / "voting-supervisor.pid"
LOG_DIR = AGENT_ROOT / "runtime-logs"
SERVICE_LOG = LOG_DIR / "voting-windows-service.log"
SUPERVISOR_OUT = LOG_DIR / "voting-service-supervisor.out.log"
SUPERVISOR_ERR = LOG_DIR / "voting-service-supervisor.err.log"
HEALTH_URL = "http://127.0.0.1:4317/api/health"
LOCAL_STREAM_URL = "http://127.0.0.1:4320/ai"
CHECK_INTERVAL_MS = 5_000
FAILURES_BEFORE_LAUNCH = 1


def log(message: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    try:
        with SERVICE_LOG.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def health_snapshot(timeout: float = 5.0) -> dict:
    request = Request(HEALTH_URL, headers={"Accept": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        if int(response.status) != 200:
            raise RuntimeError(f"health HTTP {response.status}")
        parsed = json.loads(response.read().decode("utf-8"))
        return parsed if isinstance(parsed, dict) else {}


def audio_bytes_healthy(timeout: float = 6.0, minimum_bytes: int = 4096) -> bool:
    request = Request(LOCAL_STREAM_URL, headers={"Accept": "audio/aac,audio/mpeg,*/*"})
    try:
        with urlopen(request, timeout=timeout) as response:
            if int(response.status) != 200:
                return False
            return len(response.read(minimum_bytes)) >= minimum_bytes
    except Exception:
        return False


def agent_healthy() -> bool:
    try:
        snapshot = health_snapshot()
        return (
            snapshot.get("ok") is True
            and snapshot.get("playbackState") == "playing"
            and audio_bytes_healthy()
        )
    except Exception:
        return False


def process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        process_query_limited_information = 0x1000
        still_active = 259
        handle = ctypes.windll.kernel32.OpenProcess(
            process_query_limited_information, False, pid
        )
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            exit_code = wintypes.DWORD()
            if not ctypes.windll.kernel32.GetExitCodeProcess(
                handle, ctypes.byref(exit_code)
            ):
                return False
            return exit_code.value == still_active
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def supervisor_present() -> bool:
    try:
        pid = int(SUPERVISOR_PID_FILE.read_text(encoding="utf-8").strip())
        return process_is_alive(pid)
    except (OSError, ValueError):
        return False


def service_env() -> dict[str, str]:
    env = dict(os.environ)
    path_parts = [
        str(NODE_EXE.parent),
        str(AGENT_ROOT / "node_modules" / ".bin"),
        env.get("PATH", ""),
    ]
    env["PATH"] = ";".join(part for part in path_parts if part)
    env["VOTING_WINDOWS_SERVICE"] = "1"
    return env


def validate_runtime() -> None:
    required = {
        "Node executable": NODE_EXE,
        "Voting environment file": ENV_FILE,
        "Voting supervisor": SUPERVISOR_SCRIPT,
    }
    missing = [f"{label}: {path}" for label, path in required.items() if not path.exists()]
    if missing:
        raise FileNotFoundError("; ".join(missing))


def launch_supervisor() -> subprocess.Popen:
    validate_runtime()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log(f"Launching Voting supervisor from {AGENT_ROOT}.")
    return subprocess.Popen(
        [
            str(NODE_EXE),
            f"--env-file={ENV_FILE}",
            str(SUPERVISOR_SCRIPT),
        ],
        cwd=str(AGENT_ROOT),
        env=service_env(),
        stdout=SUPERVISOR_OUT.open("ab"),
        stderr=SUPERVISOR_ERR.open("ab"),
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def stop_owned_process(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=15)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


class RadioTEDUVotingService(win32serviceutil.ServiceFramework):
    _svc_name_ = SERVICE_NAME
    _svc_display_name_ = SERVICE_DISPLAY_NAME
    _svc_description_ = SERVICE_DESCRIPTION

    def __init__(self, args):
        super().__init__(args)
        self.stop_event = win32event.CreateEvent(None, 0, 0, None)
        self.supervisor_process: subprocess.Popen | None = None

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        win32event.SetEvent(self.stop_event)

    def SvcDoRun(self):
        servicemanager.LogInfoMsg(f"{SERVICE_DISPLAY_NAME} starting")
        log("Windows service starting.")
        self.ReportServiceStatus(win32service.SERVICE_RUNNING)
        try:
            self.main()
        except Exception as exc:
            log(f"Service loop failed: {type(exc).__name__}: {exc}")
            raise
        finally:
            stop_owned_process(self.supervisor_process)
            log("Windows service stopped.")
            servicemanager.LogInfoMsg(f"{SERVICE_DISPLAY_NAME} stopped")

    def main(self):
        unhealthy_count = 0
        if agent_healthy():
            log("Voting agent is already healthy; monitoring the existing process.")
        else:
            self.supervisor_process = launch_supervisor()

        while True:
            result = win32event.WaitForSingleObject(self.stop_event, CHECK_INTERVAL_MS)
            if result == win32event.WAIT_OBJECT_0:
                return

            if agent_healthy():
                if unhealthy_count:
                    log("Voting agent recovered.")
                unhealthy_count = 0
                if not supervisor_present():
                    log("Voting audio is healthy but its supervisor is missing; restoring it.")
                    self.supervisor_process = launch_supervisor()
                continue

            unhealthy_count += 1
            if unhealthy_count == 1:
                log("Voting health check failed; checking supervisor ownership.")
            if unhealthy_count < FAILURES_BEFORE_LAUNCH:
                continue

            unhealthy_count = 0
            if (
                self.supervisor_process is not None
                and self.supervisor_process.poll() is None
            ):
                log("Owned supervisor is alive; its internal watchdog is still recovering.")
                continue

            # If a user-session supervisor owns the PID lock, this launch exits
            # harmlessly. The service keeps retrying and takes ownership as soon
            # as that external process disappears.
            self.supervisor_process = launch_supervisor()


if __name__ == "__main__":
    win32serviceutil.HandleCommandLine(RadioTEDUVotingService)
