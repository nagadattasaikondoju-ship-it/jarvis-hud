#!/usr/bin/env python3
"""
Jarvis Companion - a small local helper for the OpenJarvis HUD.

  * Web search with YOUR OWN search API key (Tavily or Brave). The key stays on this PC.
  * Scheduled tasks that run in the background with your local Ollama model,
    even when the browser is closed. Results wait in the HUD's inbox, and a
    desktop notification tells you when one is ready.
  * Live system vitals for the HUD (CPU, memory, battery, NVIDIA GPU).

Standard library only (no pip installs). Listens on 127.0.0.1:8765 only, and
only answers the HUD's own web address (CORS) plus requests carrying X-Jarvis.
"""
import base64
import json
import os
import platform
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta
from xml.sax.saxutils import escape as xml_escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.1.0"
FEATURES = ["search", "tasks", "system", "notify"]
HOST = "127.0.0.1"
PORT = int(os.environ.get("JARVIS_COMPANION_PORT", "8765"))
ALLOWED_ORIGINS = {
    o.strip()
    for o in os.environ.get(
        "JARVIS_ALLOWED_ORIGINS",
        "https://openjarvis-hud.vercel.app,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173",
    ).split(",")
    if o.strip()
}
HOME = os.environ.get("JARVIS_COMPANION_HOME") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share"), "JarvisCompanion"
)
os.makedirs(HOME, exist_ok=True)
CFG_PATH = os.path.join(HOME, "config.json")
DB_PATH = os.path.join(HOME, "jarvis.db")
LOG_PATH = os.path.join(HOME, "companion.log")

DEFAULT_CFG = {
    "search_provider": "tavily",
    "search_key": "",
    "ollama_url": "http://127.0.0.1:11434",
    "model": "qwen3.5:2b",
    "system_prompt": "You are JARVIS, a calm, precise and slightly witty personal AI running on the user's own computer. Be concise.",
    "memory": [],
    "notify": True,
    "site_url": "https://openjarvis-hud.vercel.app",
}
IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"
NO_WINDOW = 0x08000000 if IS_WIN else 0  # CREATE_NO_WINDOW: no console flash under pythonw
_lock = threading.RLock()


# ---------------------------------------------------------------- utilities
def log(*parts):
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 1_000_000:
            os.replace(LOG_PATH, LOG_PATH + ".old")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(datetime.now().strftime("%Y-%m-%d %H:%M:%S ") + " ".join(str(p) for p in parts) + "\n")
    except Exception:
        pass


def load_cfg():
    with _lock:
        try:
            with open(CFG_PATH, encoding="utf-8") as f:
                return {**DEFAULT_CFG, **json.load(f)}
        except Exception:
            return dict(DEFAULT_CFG)


def save_cfg(cfg):
    with _lock:
        tmp = CFG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp, CFG_PATH)


def http_json(url, body=None, headers=None, method=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("User-Agent", "JarvisCompanion/" + VERSION)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode("utf-8") or "{}"
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Tolerate a streamed (newline-delimited JSON) reply: merge the message chunks.
            parts = [json.loads(line) for line in text.splitlines() if line.strip()]
            merged = dict(parts[-1]) if parts else {}
            merged["message"] = {"role": "assistant", "content": "".join((p.get("message") or {}).get("content", "") for p in parts)}
            return merged
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"HTTP {e.code} from {urllib.parse.urlparse(url).netloc}: {detail}")


def db():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    with db() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS tasks (
              id TEXT PRIMARY KEY, name TEXT, prompt TEXT, schedule TEXT,
              research INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
              next_run REAL, last_run REAL, created REAL);
            CREATE TABLE IF NOT EXISTS runs (
              id TEXT PRIMARY KEY, task_id TEXT, task_name TEXT, started REAL, finished REAL,
              status TEXT, output TEXT, sources TEXT, read INTEGER DEFAULT 0);
            CREATE INDEX IF NOT EXISTS runs_started ON runs(started);
            """
        )


# ------------------------------------------------------------ system vitals
def run_quiet(cmd, timeout=5):
    """Run a helper program without flashing a console window; return stdout or ''."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=NO_WINDOW)
        return r.stdout if r.returncode == 0 else ""
    except Exception:
        return ""


if IS_WIN:
    import ctypes
    from ctypes import wintypes

    class _FT(ctypes.Structure):
        _fields_ = [("lo", wintypes.DWORD), ("hi", wintypes.DWORD)]

    class _MEM(ctypes.Structure):
        _fields_ = [("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

    class _PWR(ctypes.Structure):
        _fields_ = [("ACLineStatus", ctypes.c_ubyte), ("BatteryFlag", ctypes.c_ubyte),
                    ("BatteryLifePercent", ctypes.c_ubyte), ("SystemStatusFlag", ctypes.c_ubyte),
                    ("BatteryLifeTime", wintypes.DWORD), ("BatteryFullLifeTime", wintypes.DWORD)]


def _cpu_times():
    """Return (idle, total) CPU time counters, or None."""
    try:
        if IS_WIN:
            idle, kern, user = _FT(), _FT(), _FT()
            if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kern), ctypes.byref(user)):
                return None
            v = lambda f: (f.hi << 32) | f.lo  # noqa: E731
            return v(idle), v(kern) + v(user)  # kernel time already includes idle time
        if os.path.exists("/proc/stat"):
            with open("/proc/stat") as f:
                nums = [int(x) for x in f.readline().split()[1:]]
            return nums[3] + (nums[4] if len(nums) > 4 else 0), sum(nums[:8])
    except Exception:
        pass
    return None


def _memory():
    try:
        if IS_WIN:
            m = _MEM()
            m.dwLength = ctypes.sizeof(_MEM)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return m.ullTotalPhys, m.ullTotalPhys - m.ullAvailPhys
        if os.path.exists("/proc/meminfo"):
            info = {}
            with open("/proc/meminfo") as f:
                for line in f:
                    k, v = line.split(":", 1)
                    info[k] = int(v.split()[0]) * 1024
            return info["MemTotal"], info["MemTotal"] - info.get("MemAvailable", info.get("MemFree", 0))
        if IS_MAC:
            total = int(run_quiet(["sysctl", "-n", "hw.memsize"]).strip() or 0)
            page = 4096
            free = 0
            for line in run_quiet(["vm_stat"]).splitlines():
                if "page size of" in line:
                    page = int("".join(ch for ch in line.split("page size of")[1] if ch.isdigit()) or 4096)
                if line.startswith(("Pages free", "Pages inactive", "Pages speculative")):
                    free += int(line.split(":")[1].strip().rstrip("."))
            return total, total - free * page
    except Exception:
        pass
    return None, None


def _battery():
    try:
        if IS_WIN:
            p = _PWR()
            if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(p)):
                return None
            if p.BatteryFlag == 128 or p.BatteryLifePercent == 255:  # no battery / unknown
                return None
            return {"percent": int(p.BatteryLifePercent), "plugged": p.ACLineStatus == 1}
        base = "/sys/class/power_supply"
        if os.path.isdir(base):
            for name in sorted(os.listdir(base)):
                if name.startswith("BAT"):
                    with open(os.path.join(base, name, "capacity")) as f:
                        pct = int(f.read().strip())
                    with open(os.path.join(base, name, "status")) as f:
                        status = f.read().strip()
                    return {"percent": pct, "plugged": status != "Discharging"}
        if IS_MAC:
            out = run_quiet(["pmset", "-g", "batt"])
            if "%" in out:
                pct = int(out.split("%")[0].split()[-1])
                return {"percent": pct, "plugged": "AC Power" in out}
    except Exception:
        pass
    return None


def _cpu_name():
    try:
        if IS_WIN:
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                return winreg.QueryValueEx(k, "ProcessorNameString")[0].strip()
        if os.path.exists("/proc/cpuinfo"):
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if line.startswith("model name"):
                        return line.split(":", 1)[1].strip()
        if IS_MAC:
            return run_quiet(["sysctl", "-n", "machdep.cpu.brand_string"]).strip() or platform.processor()
    except Exception:
        pass
    return platform.processor() or platform.machine()


def _cpu_temp():
    """CPU temperature where it can be read without admin rights (Linux). Windows needs admin, so None."""
    try:
        base = "/sys/class/thermal"
        if os.path.isdir(base):
            best = None
            for z in sorted(os.listdir(base)):
                tp = os.path.join(base, z, "type")
                if not os.path.exists(tp):
                    continue
                with open(tp) as f:
                    kind = f.read().strip()
                with open(os.path.join(base, z, "temp")) as f:
                    c = int(f.read().strip()) / 1000
                if kind in ("x86_pkg_temp", "cpu-thermal", "k10temp", "coretemp"):
                    return round(c)
                best = best if best is not None else round(c)
            return best
    except Exception:
        pass
    return None


def _nvidia_smi():
    exe = shutil.which("nvidia-smi")
    if not exe and IS_WIN:
        for c in (os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe"),
                  os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe")):
            if os.path.exists(c):
                return c
    return exe


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _gpus():
    exe = _nvidia_smi()
    if not exe:
        return []
    out = run_quiet([exe, "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                     "--format=csv,noheader,nounits"], timeout=6)
    gpus = []
    for line in out.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 5:
            continue
        gpus.append({
            "name": f[0], "util": _num(f[1]), "mem_used_mb": _num(f[2]), "mem_total_mb": _num(f[3]),
            "temp_c": _num(f[4]), "power_w": _num(f[5]) if len(f) > 5 else None,
        })
    return gpus


class Vitals:
    """Samples vitals on demand (never more than about once a second) and caches the slow GPU query."""

    def __init__(self):
        self.lock = threading.Lock()
        self.prev = _cpu_times()
        self.prev_at = time.time()
        self.cpu_pct = None
        self.gpu = []
        self.gpu_at = 0.0
        self.gpu_missing_at = 0.0
        self.cpu_name = None
        self.cache = None
        self.cache_at = 0.0

    def snapshot(self):
        with self.lock:
            now = time.time()
            if self.cache and now - self.cache_at < 0.9:
                return self.cache
            cur = _cpu_times()
            if cur and self.prev:
                d_idle, d_total = cur[0] - self.prev[0], cur[1] - self.prev[1]
                if d_total > 0:
                    self.cpu_pct = max(0.0, min(100.0, 100.0 * (1 - d_idle / d_total)))
            elif cur and not self.prev:
                time.sleep(0.25)
                nxt = _cpu_times()
                if nxt and nxt[1] - cur[1] > 0:
                    self.cpu_pct = max(0.0, min(100.0, 100.0 * (1 - (nxt[0] - cur[0]) / (nxt[1] - cur[1]))))
                cur = nxt
            self.prev = cur
            # GPU: refresh every ~2 s; if there is no NVIDIA GPU, only look again once a minute.
            if now - self.gpu_at > 1.8 and (self.gpu or now - self.gpu_missing_at > 60):
                self.gpu = _gpus()
                self.gpu_at = now
                if not self.gpu:
                    self.gpu_missing_at = now
            if self.cpu_name is None:
                self.cpu_name = _cpu_name()
            total, used = _memory()
            self.cache = {
                "ok": True, "time": now, "platform": platform.system(), "host": platform.node(),
                "cpu": {"percent": None if self.cpu_pct is None else round(self.cpu_pct, 1),
                        "cores": os.cpu_count(), "name": self.cpu_name, "temp_c": _cpu_temp()},
                "ram": {"total": total, "used": used,
                        "percent": round(100.0 * used / total, 1) if total else None},
                "battery": _battery(),
                "gpus": self.gpu,
            }
            self.cache_at = now
            return self.cache


VITALS = Vitals()


# ----------------------------------------------------------- notifications
def _plain(text, limit):
    t = " ".join((text or "").replace("#", " ").replace("*", "").replace("`", "").split())
    return t if len(t) <= limit else t[: limit - 1] + "…"


def notify(title, body, url=None):
    """Show a desktop notification. Returns True when it was handed to the OS."""
    title, body = _plain(title, 64), _plain(body, 180)
    try:
        if IS_WIN:
            launch = ' activationType="protocol" launch="' + xml_escape(url, {'"': "&quot;"}) + '"' if url else ""
            xml = (f'<toast{launch}><visual><binding template="ToastGeneric">'
                   f"<text>{xml_escape(title)}</text><text>{xml_escape(body)}</text>"
                   f"</binding></visual></toast>")
            ps = (
                "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;"
                "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null;"
                "$x = New-Object Windows.Data.Xml.Dom.XmlDocument;"
                "$x.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"
                + base64.b64encode(xml.encode("utf-8")).decode() + "')));"
                "$t = New-Object Windows.UI.Notifications.ToastNotification $x;"
                "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("
                "'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($t)"
            )
            enc = base64.b64encode(ps.encode("utf-16-le")).decode()
            r = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", enc],
                               capture_output=True, timeout=20, creationflags=NO_WINDOW)
            if r.returncode != 0:
                log("notify failed", r.stderr.decode("utf-8", "replace")[:400])
            return r.returncode == 0
        if IS_MAC:
            q = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731
            return subprocess.run(["osascript", "-e", f'display notification "{q(body)}" with title "{q(title)}"'],
                                  capture_output=True, timeout=10).returncode == 0
        exe = shutil.which("notify-send")
        if exe:
            return subprocess.run([exe, "-a", "Jarvis", title, body], capture_output=True, timeout=10).returncode == 0
    except Exception:
        log("notify error", traceback.format_exc())
    return False


# ------------------------------------------------------------------ search
def web_search(query, max_results=6):
    cfg = load_cfg()
    key = (cfg.get("search_key") or "").strip()
    if not key:
        raise RuntimeError("No search key saved yet. In the HUD open SETUP > COMPANION and paste your search API key.")
    n = max(1, min(int(max_results or 6), 10))
    if cfg.get("search_provider") == "brave":
        q = urllib.parse.urlencode({"q": query, "count": n})
        j = http_json(
            "https://api.search.brave.com/res/v1/web/search?" + q,
            headers={"X-Subscription-Token": key, "Accept": "application/json"},
            timeout=25,
        )
        out = []
        for r in (j.get("web") or {}).get("results", [])[:n]:
            snippet = " ".join([r.get("description") or ""] + (r.get("extra_snippets") or []))
            out.append({"title": r.get("title", ""), "url": r.get("url", ""), "content": strip_tags(snippet)})
        return out
    j = http_json(
        "https://api.tavily.com/search",
        body={"api_key": key, "query": query, "max_results": n, "search_depth": "basic", "include_answer": False},
        headers={"Authorization": "Bearer " + key},
        timeout=30,
    )
    return [{"title": r.get("title", ""), "url": r.get("url", ""), "content": r.get("content", "")} for r in j.get("results", [])[:n]]


def strip_tags(s):
    out, inside = [], False
    for ch in s or "":
        if ch == "<":
            inside = True
        elif ch == ">":
            inside = False
        elif not inside:
            out.append(ch)
    return "".join(out).strip()


# ------------------------------------------------------------------- model
def ask_model(messages, num_ctx=8192):
    cfg = load_cfg()
    j = http_json(
        cfg["ollama_url"].rstrip("/") + "/api/chat",
        body={"model": cfg["model"], "messages": messages, "stream": False, "think": False, "options": {"num_ctx": num_ctx}},
        timeout=900,
    )
    if j.get("error"):
        raise RuntimeError(j["error"])
    return (j.get("message") or {}).get("content", "").strip()


def system_text(extra=""):
    cfg = load_cfg()
    parts = [cfg.get("system_prompt") or DEFAULT_CFG["system_prompt"]]
    mem = [m for m in cfg.get("memory") or [] if m]
    if mem:
        parts.append("Things you know about the user:\n" + "\n".join("- " + m for m in mem))
    parts.append("Current date and time: " + datetime.now().strftime("%A %d %B %Y, %H:%M"))
    if extra:
        parts.append(extra)
    return "\n\n".join(parts)


# --------------------------------------------------------------- scheduling
def next_run(schedule, after=None):
    now = after or datetime.now()
    t = schedule.get("type", "daily")
    if t == "interval":
        return now + timedelta(minutes=max(5, int(schedule.get("minutes") or 60)))
    if t == "hourly":
        return (now + timedelta(hours=1)).replace(second=0, microsecond=0)
    hh, mm = (schedule.get("time") or "08:00").split(":")[:2]
    days = schedule.get("days") or [0, 1, 2, 3, 4, 5, 6]
    for add in range(0, 8):
        d = (now + timedelta(days=add)).replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
        js_dow = (d.weekday() + 1) % 7  # browser: Sunday = 0
        if d > now and (t == "daily" or js_dow in days):
            return d
    return now + timedelta(days=1)


def row_task(r):
    return {
        "id": r["id"], "name": r["name"], "prompt": r["prompt"], "schedule": json.loads(r["schedule"] or "{}"),
        "research": bool(r["research"]), "enabled": bool(r["enabled"]),
        "next_run": r["next_run"], "last_run": r["last_run"],
    }


def run_task(task):
    rid = uuid.uuid4().hex[:12]
    with db() as con:
        con.execute(
            "INSERT INTO runs(id,task_id,task_name,started,status,read) VALUES(?,?,?,?,?,0)",
            (rid, task["id"], task["name"], time.time(), "running"),
        )
    status, output, sources = "done", "", []
    try:
        extra = "This is a scheduled task the user set up earlier. Do it now and reply with the result only."
        user = task["prompt"]
        if task.get("research"):
            sources = web_search(task["prompt"], 6)
            block = "\n\n".join(f"[{i + 1}] {s['title']}\nURL: {s['url']}\n{(s['content'] or '')[:1800]}" for i, s in enumerate(sources))
            extra += " Use ONLY these numbered web sources and cite them inline like [1]."
            user = f"{task['prompt']}\n\nWeb sources:\n{block}"
        output = ask_model([{"role": "system", "content": system_text(extra)}, {"role": "user", "content": user}])
    except Exception as e:  # noqa: BLE001
        status, output = "error", f"{type(e).__name__}: {e}"
        log("task failed", task["name"], traceback.format_exc())
    with db() as con:
        con.execute(
            "UPDATE runs SET finished=?, status=?, output=?, sources=? WHERE id=?",
            (time.time(), status, output, json.dumps(sources), rid),
        )
        con.execute("UPDATE tasks SET last_run=? WHERE id=?", (time.time(), task["id"]))
        con.execute("DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY started DESC LIMIT 200)")
    log("task", task["name"], status)
    cfg = load_cfg()
    if cfg.get("notify", True):
        site = (cfg.get("site_url") or DEFAULT_CFG["site_url"]).rstrip("/")
        notify(("Jarvis · " if status == "done" else "Jarvis · failed: ") + task["name"],
               output or "No output.", f"{site}/?run={rid}")


def scheduler_loop():
    while True:
        try:
            now = datetime.now()
            with db() as con:
                due = [row_task(r) for r in con.execute("SELECT * FROM tasks WHERE enabled=1 AND next_run IS NOT NULL AND next_run<=?", (now.timestamp(),))]
                for t in due:  # schedule the next run first, so a missed backlog runs only once
                    con.execute("UPDATE tasks SET next_run=? WHERE id=?", (next_run(t["schedule"], now).timestamp(), t["id"]))
            for t in due:
                threading.Thread(target=run_task, args=(t,), daemon=True).start()
        except Exception:
            log("scheduler error", traceback.format_exc())
        time.sleep(20)


# --------------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = "JarvisCompanion/" + VERSION

    def log_message(self, fmt, *args):  # quiet
        pass

    def _origin_ok(self):
        o = self.headers.get("Origin")
        return o is None or o in ALLOWED_ORIGINS

    def _cors(self):
        o = self.headers.get("Origin")
        if o in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Jarvis")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            raise ValueError("Request too large")
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw or b"{}")

    def do_OPTIONS(self):
        if self.headers.get("Origin") not in ALLOWED_ORIGINS:
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _guard(self, path):
        if not self._origin_ok():
            self._send(403, {"error": "This website is not allowed to use Jarvis Companion."})
            return False
        if path != "/health" and self.headers.get("X-Jarvis") != "1":
            self._send(403, {"error": "Missing X-Jarvis header."})
            return False
        return True

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._guard(path):
            return
        try:
            if path == "/health":
                cfg = load_cfg()
                return self._send(200, {
                    "ok": True, "version": VERSION, "search_configured": bool(cfg.get("search_key")),
                    "search_provider": cfg.get("search_provider"), "model": cfg.get("model"), "home": HOME,
                    "features": FEATURES, "notify": bool(cfg.get("notify", True)), "platform": platform.system(),
                })
            if path == "/system":
                return self._send(200, VITALS.snapshot())
            if path == "/tasks":
                with db() as con:
                    rows = [row_task(r) for r in con.execute("SELECT * FROM tasks ORDER BY created")]
                return self._send(200, {"tasks": rows})
            if path == "/runs":
                with db() as con:
                    rows = [
                        {**dict(r), "sources": json.loads(r["sources"] or "[]"), "read": bool(r["read"])}
                        for r in con.execute("SELECT * FROM runs ORDER BY started DESC LIMIT 50")
                    ]
                return self._send(200, {"runs": rows})
            parts = path.strip("/").split("/")
            if len(parts) == 2 and parts[0] == "runs":
                with db() as con:
                    r = con.execute("SELECT * FROM runs WHERE id=?", (parts[1],)).fetchone()
                if not r:
                    return self._send(404, {"error": "No such result"})
                return self._send(200, {"run": {**dict(r), "sources": json.loads(r["sources"] or "[]"), "read": bool(r["read"])}})
            self._send(404, {"error": "Not found"})
        except Exception as e:  # noqa: BLE001
            log("GET error", path, traceback.format_exc())
            self._send(500, {"error": str(e)})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._guard(path):
            return
        try:
            body = self._body()
            if path == "/config":
                cfg = load_cfg()
                if "searchKey" in body:
                    cfg["search_key"] = str(body["searchKey"]).strip()
                if body.get("searchProvider") in ("tavily", "brave"):
                    cfg["search_provider"] = body["searchProvider"]
                if body.get("model"):
                    cfg["model"] = str(body["model"])
                if body.get("ollamaUrl"):
                    cfg["ollama_url"] = str(body["ollamaUrl"])
                if "systemPrompt" in body:
                    cfg["system_prompt"] = str(body["systemPrompt"] or "")
                if isinstance(body.get("notify"), bool):
                    cfg["notify"] = body["notify"]
                origin = self.headers.get("Origin")
                if origin in ALLOWED_ORIGINS:
                    cfg["site_url"] = origin
                if isinstance(body.get("memory"), list):
                    cfg["memory"] = [str(m)[:500] for m in body["memory"][:100]]
                save_cfg(cfg)
                return self._send(200, {"ok": True, "search_configured": bool(cfg.get("search_key"))})
            if path == "/notify/test":
                site = (load_cfg().get("site_url") or DEFAULT_CFG["site_url"]).rstrip("/")
                ok = notify("Jarvis", "Notifications are working. Scheduled task results will appear like this.", site)
                return self._send(200 if ok else 500, {"ok": ok} if ok else {"error": "Your system did not accept the notification. On Windows, check Settings > System > Notifications."})
            if path == "/search":
                q = str(body.get("query") or "").strip()
                if not q:
                    return self._send(400, {"error": "Empty query"})
                return self._send(200, {"results": web_search(q, body.get("max") or 6)})
            if path == "/tasks":
                tid = body.get("id") or uuid.uuid4().hex[:10]
                sched = body.get("schedule") or {"type": "daily", "time": "08:00"}
                nr = next_run(sched).timestamp()
                with db() as con:
                    con.execute(
                        """INSERT INTO tasks(id,name,prompt,schedule,research,enabled,next_run,created)
                           VALUES(?,?,?,?,?,?,?,?)
                           ON CONFLICT(id) DO UPDATE SET name=excluded.name, prompt=excluded.prompt,
                             schedule=excluded.schedule, research=excluded.research, enabled=excluded.enabled,
                             next_run=excluded.next_run""",
                        (tid, str(body.get("name") or "Task")[:120], str(body.get("prompt") or "")[:4000], json.dumps(sched),
                         1 if body.get("research") else 0, 0 if body.get("enabled") is False else 1, nr, time.time()),
                    )
                    row = con.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
                return self._send(200, {"task": row_task(row)})
            parts = path.strip("/").split("/")
            if len(parts) == 3 and parts[0] == "tasks" and parts[2] == "run":
                with db() as con:
                    row = con.execute("SELECT * FROM tasks WHERE id=?", (parts[1],)).fetchone()
                if not row:
                    return self._send(404, {"error": "No such task"})
                threading.Thread(target=run_task, args=(row_task(row),), daemon=True).start()
                return self._send(200, {"ok": True})
            if len(parts) == 3 and parts[0] == "runs" and parts[2] == "read":
                with db() as con:
                    con.execute("UPDATE runs SET read=1 WHERE id=?", (parts[1],))
                return self._send(200, {"ok": True})
            self._send(404, {"error": "Not found"})
        except Exception as e:  # noqa: BLE001
            log("POST error", path, traceback.format_exc())
            self._send(500, {"error": str(e)})

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._guard(path):
            return
        parts = path.strip("/").split("/")
        if len(parts) == 2 and parts[0] == "tasks":
            with db() as con:
                con.execute("DELETE FROM tasks WHERE id=?", (parts[1],))
            return self._send(200, {"ok": True})
        self._send(404, {"error": "Not found"})


def main():
    init_db()
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        log("port in use; another Companion is probably running")
        sys.exit(0)
    threading.Thread(target=scheduler_loop, daemon=True).start()
    log(f"Jarvis Companion {VERSION} listening on http://{HOST}:{PORT} (data: {HOME})")
    print(f"Jarvis Companion {VERSION} running on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
