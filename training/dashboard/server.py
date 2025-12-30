import argparse
import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import threading
import time
from collections import deque
from urllib.parse import unquote, urlparse


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Serve training dashboard + run logs.")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--runsDir", default="training/runs")
    p.add_argument("--uiDir", default="training/dashboard/ui")
    return p.parse_args()


def safe_join(base: Path, rel: str) -> Path | None:
    """
    Join base + rel, preventing path traversal.
    Returns None if rel escapes base.
    """
    rel = rel.lstrip("/")
    target = (base / rel).resolve()
    try:
        base_resolved = base.resolve()
        target.relative_to(base_resolved)
    except Exception:
        return None
    return target


class Handler(BaseHTTPRequestHandler):
    runs_dir: Path
    ui_dir: Path
    root_dir: Path

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/presets":
            self.send_json(200, load_presets())
            return

        if path == "/api/status":
            self.send_json(200, job_status())
            return

        if path.startswith("/api/log"):
            q = parsed.query or ""
            since = 0
            for part in q.split("&"):
                if part.startswith("since="):
                    try:
                        since = int(part.split("=", 1)[1])
                    except ValueError:
                        since = 0
            self.send_json(200, job_log(since))
            return

        if path.startswith("/runs/"):
            rel = path[len("/runs/") :]
            file_path = safe_join(self.runs_dir, rel)
            if file_path is None:
                self.send_error(400, "Bad path")
                return
            self.serve_file(file_path)
            return

        # UI files
        if path == "/" or path == "":
            self.serve_file(self.ui_dir / "index.html")
            return

        rel = path.lstrip("/")
        file_path = safe_join(self.ui_dir, rel)
        if file_path is None:
            self.send_error(400, "Bad path")
            return
        self.serve_file(file_path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/start":
            payload = self.read_json_body()
            preset = str(payload.get("preset", "balanced"))
            cycles = int(payload.get("cycles", 1))
            seed = payload.get("seed")
            seed_int = int(seed) if seed is not None else None
            ok, out = start_job(self.root_dir, preset, cycles, seed_int)
            self.send_json(200 if ok else 409, out)
            return

        if path == "/api/stop":
            ok, out = stop_job()
            self.send_json(200 if ok else 409, out)
            return

        self.send_error(404, "Not found")

    def serve_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404, "Not found")
            return

        ctype, _ = mimetypes.guess_type(str(path))
        if ctype is None:
            ctype = "application/octet-stream"

        try:
            data = path.read_bytes()
        except OSError:
            self.send_error(500, "Could not read file")
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # Dev-friendly: disable caching so changes show up immediately.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, code: int, obj: object) -> None:
        data = json.dumps(obj, indent=2, sort_keys=True).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            obj = json.loads(raw.decode("utf-8"))
        except Exception:
            return {}
        return obj if isinstance(obj, dict) else {}

    def log_message(self, fmt: str, *args) -> None:
        # Keep logs concise.
        msg = fmt % args
        print(f"[dashboard] {self.address_string()} {self.command} {self.path} -> {msg}")


def load_presets() -> dict:
    # SSoT: same file used by training/cycle.py
    path = Path("training/presets.json")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


# ---- Job management (single job at a time) ----
_job_lock = threading.Lock()
_job_proc: subprocess.Popen | None = None
_job_started_at: float | None = None
_job_ended_at: float | None = None
_job_exit_code: int | None = None
_job_cmd: list[str] | None = None
_job_preset: str | None = None
_job_cycles: int | None = None
_log_seq = 0
_log: deque[tuple[int, str]] = deque(maxlen=2000)
_max_line_chars = 2000


def _append_log(line: str) -> None:
    global _log_seq
    _log_seq += 1
    if len(line) > _max_line_chars:
        line = line[:_max_line_chars] + " …(truncated)"
    _log.append((_log_seq, line))


def _reader_thread(proc: subprocess.Popen) -> None:
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip("\n")
        with _job_lock:
            _append_log(line)
    with _job_lock:
        global _job_exit_code, _job_ended_at
        _job_exit_code = proc.poll()
        _job_ended_at = time.time()


def job_status() -> dict:
    with _job_lock:
        running = _job_proc is not None and _job_proc.poll() is None
        return {
            "running": running,
            "pid": _job_proc.pid if _job_proc else None,
            "preset": _job_preset,
            "cycles": _job_cycles,
            "startedAt": _job_started_at,
            "endedAt": _job_ended_at,
            "exitCode": _job_exit_code,
            "cmd": _job_cmd,
            "logNext": _log_seq,
        }


def job_log(since: int) -> dict:
    with _job_lock:
        lines = [{"seq": s, "line": l} for (s, l) in _log if s > since]
        running = _job_proc is not None and _job_proc.poll() is None
        return {"lines": lines, "next": _log_seq, "running": running, "exitCode": _job_exit_code}


def start_job(root_dir: Path, preset: str, cycles: int, seed: int | None) -> tuple[bool, dict]:
    presets = load_presets()
    if preset not in presets:
        return False, {"ok": False, "error": f"Unknown preset: {preset}"}
    if cycles <= 0:
        return False, {"ok": False, "error": "cycles must be > 0"}

    with _job_lock:
        global _job_proc, _job_started_at, _job_ended_at, _job_exit_code, _job_cmd, _job_preset, _job_cycles, _log_seq
        if _job_proc is not None and _job_proc.poll() is None:
            return False, {"ok": False, "error": "A job is already running"}

        _log.clear()
        _log_seq = 0
        _job_started_at = time.time()
        _job_ended_at = None
        _job_exit_code = None
        _job_preset = preset
        _job_cycles = cycles

        cmd = [sys.executable, "-u", "training/cycle.py", "--preset", preset, "--cycles", str(cycles)]
        if seed is not None:
            cmd += ["--seed", str(seed)]
        _job_cmd = cmd

        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        proc = subprocess.Popen(
            cmd,
            cwd=str(root_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )
        _job_proc = proc
        _append_log(f"[dashboard] started: {' '.join(cmd)}")

        t = threading.Thread(target=_reader_thread, args=(proc,), daemon=True)
        t.start()

        return True, {"ok": True, "pid": proc.pid}


def stop_job() -> tuple[bool, dict]:
    with _job_lock:
        global _job_proc
        if _job_proc is None or _job_proc.poll() is not None:
            return False, {"ok": False, "error": "No running job"}
        _append_log("[dashboard] stopping job...")
        _job_proc.terminate()
        return True, {"ok": True}


def main() -> None:
    args = parse_args()
    runs_dir = Path(args.runsDir)
    ui_dir = Path(args.uiDir)
    root_dir = Path(__file__).resolve().parents[2]

    Handler.runs_dir = runs_dir
    Handler.ui_dir = ui_dir
    Handler.root_dir = root_dir

    server = ThreadingHTTPServer((args.host, int(args.port)), Handler)
    print("[dashboard] serving", {"host": args.host, "port": args.port, "runsDir": str(runs_dir), "uiDir": str(ui_dir)})
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    # Ensure mimetypes knows about common extensions.
    mimetypes.init()
    main()

