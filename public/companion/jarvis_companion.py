#!/usr/bin/env python3
"""
Jarvis Companion - a small local helper for the OpenJarvis HUD.

  * Web search with YOUR OWN search API key (Tavily or Brave). The key stays on this PC.
  * Scheduled tasks that run in the background with your local Ollama model,
    even when the browser is closed. Results wait in the HUD's inbox, and a
    desktop notification tells you when one is ready.
  * Live system vitals for the HUD (CPU, memory, battery, NVIDIA GPU).
  * Optional add-ons, installed only when you click SET UP in the HUD:
      - Folder search: indexes folders you choose, with a small local embedding model.
      - Offline voice: Whisper speech recognition and Piper voices, all on this PC.
      - "Hey Jarvis": an always-on wake phrase that opens Jarvis even with no window open.
  * A fixed list of safe PC actions (open an app or website, media keys, reminders, disk report).

Standard library only (no pip installs). Listens on 127.0.0.1:8765 only, and
only answers the HUD's own web address (CORS) plus requests carrying X-Jarvis.
"""
import base64
import collections
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

VERSION = "1.3.0"
FEATURES = ["search", "tasks", "system", "notify", "folders", "actions", "voice", "hotword"]
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
    "folders": [],
    "stt_model": "small",
    "stt_language": "",
    "tts_voice": "en_GB-alan-medium",
    "hotword_enabled": False,
    "hotword_sensitivity": "normal",
    "hotword_paused_until": 0,
    "hotword_browser": "auto",
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
            CREATE TABLE IF NOT EXISTS docs (
              id INTEGER PRIMARY KEY, folder TEXT, path TEXT UNIQUE, mtime REAL, size INTEGER,
              chunks INTEGER, status TEXT, error TEXT);
            CREATE TABLE IF NOT EXISTS chunks (
              id INTEGER PRIMARY KEY, doc_id INTEGER, idx INTEGER, label TEXT, text TEXT, vec BLOB);
            CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
            CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, at REAL, text TEXT, done INTEGER, created REAL);
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
            due_reminders()
        except Exception:
            log("scheduler error", traceback.format_exc())
        time.sleep(20)


# ------------------------------------------------------------ optional add-ons
# Folder search and offline voice need a few extra Python packages and models.
# They are installed only when the user clicks SET UP in the HUD, from this fixed list.
EXTRAS = {
    "folders": ["pypdf>=4,<8", "numpy>=1.24"],
    "voice": ["faster-whisper>=1.1,<2", "piper-tts>=1.3,<2", "numpy>=1.24"],
    "wake": ["onnxruntime>=1.16,<2", "numpy>=1.24", "sounddevice>=0.4.6,<1"],
}
EMBED_MODEL = "nomic-embed-text"
WHISPER_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]
WHISPER_SIZES = {"base": 145, "small": 480}  # MB, multilingual models
VOICE_CATALOG = [
    ("en_GB-alan-medium", "English (UK) · Alan, calm male"),
    ("en_GB-northern_english_male-medium", "English (UK) · Northern male"),
    ("en_GB-cori-medium", "English (UK) · Cori, female"),
    ("en_US-ryan-medium", "English (US) · Ryan, male"),
    ("en_US-lessac-medium", "English (US) · Lessac, female"),
    ("te_IN-padmavathi-medium", "Telugu · Padmavathi, female"),
    ("te_IN-maya-medium", "Telugu · Maya, female"),
    ("hi_IN-pratham-medium", "Hindi · Pratham, male"),
    ("hi_IN-priyamvada-medium", "Hindi · Priyamvada, female"),
    ("ml_IN-arjun-medium", "Malayalam · Arjun, male"),
]
VOICE_IDS = {v for v, _ in VOICE_CATALOG}
MODELS_DIR = os.path.join(HOME, "models")
VOICES_DIR = os.path.join(HOME, "voices")
JOBS = {}
_jobs_lock = threading.Lock()


def job_update(name, **kw):
    with _jobs_lock:
        JOBS.setdefault(name, {"state": "idle"}).update(kw)


def python_cli():
    """python.exe next to pythonw.exe (pip needs a console interpreter on Windows)."""
    exe = sys.executable
    if IS_WIN and exe.lower().endswith("pythonw.exe"):
        cand = exe[:-len("pythonw.exe")] + "python.exe"
        if os.path.exists(cand):
            return cand
    return exe


def pip_install(pkgs):
    cmd = [python_cli(), "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "--upgrade"]
    if sys.prefix == getattr(sys, "base_prefix", sys.prefix):  # not inside a virtualenv
        cmd.append("--user")
    r = subprocess.run(cmd + list(pkgs), capture_output=True, text=True, timeout=1800, creationflags=NO_WINDOW)
    if r.returncode != 0:
        log("pip failed", r.stdout[-2000:], r.stderr[-2000:])
        tail = (r.stderr or r.stdout).strip().splitlines()[-1:] or ["unknown error"]
        raise RuntimeError("Installing packages failed: " + tail[0][:300])
    # A user site-packages folder created just now is not on sys.path yet.
    import importlib
    import site
    try:
        site.addsitedir(site.getusersitepackages())
    except Exception:
        pass
    importlib.invalidate_caches()


def have(module):
    import importlib.util
    try:
        return importlib.util.find_spec(module) is not None
    except Exception:
        return False


def download(url, dest, job=None, label=""):
    """Download to dest (via a .part file), reporting progress to a job."""
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "JarvisCompanion/" + VERSION})
    with urllib.request.urlopen(req, timeout=60) as r:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        with open(dest + ".part", "wb") as f:
            while True:
                b = r.read(1 << 16)
                if not b:
                    break
                f.write(b)
                got += len(b)
                if job:
                    job_update(job, detail=f"{label} · {got // 1_000_000} / {total // 1_000_000 or '?'} MB",
                               progress=(got / total) if total else None)
    os.replace(dest + ".part", dest)


def ollama_pull(model, job):
    cfg = load_cfg()
    req = urllib.request.Request(cfg["ollama_url"].rstrip("/") + "/api/pull", data=json.dumps({"model": model, "stream": True}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=3600) as r:
        for line in r:
            if not line.strip():
                continue
            j = json.loads(line)
            if j.get("error"):
                raise RuntimeError(j["error"])
            if j.get("total"):
                job_update(job, detail=f"AI search model · {j.get('completed', 0) // 1_000_000} / {j['total'] // 1_000_000} MB",
                           progress=j.get("completed", 0) / j["total"])


def ollama_has(model):
    try:
        tags = http_json(load_cfg()["ollama_url"].rstrip("/") + "/api/tags", timeout=5)
        return any(m.get("name", "").split(":")[0] == model.split(":")[0] for m in tags.get("models", []))
    except Exception:
        return False


def whisper_dir(size):
    return os.path.join(MODELS_DIR, f"whisper-{size}")


def whisper_ready(size):
    return all(os.path.exists(os.path.join(whisper_dir(size), f)) for f in WHISPER_FILES)


def voice_path(vid):
    return os.path.join(VOICES_DIR, vid + ".onnx")


def voice_ready(vid):
    return os.path.exists(voice_path(vid)) and os.path.exists(voice_path(vid) + ".json")


def fetch_voice(vid, job=None):
    if vid not in VOICE_IDS:
        raise ValueError("Unknown voice")
    lang, name, quality = vid.split("-", 2)
    base = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{lang.split('_')[0]}/{lang}/{name}/{quality}/{vid}"
    download(base + ".onnx.json", voice_path(vid) + ".json")
    download(base + ".onnx", voice_path(vid), job, "Voice " + vid)


def run_extra(name, opts):
    try:
        job_update(name, state="running", step="Installing Python packages (a few minutes)…", detail="", progress=None, error="")
        module_of = {"pypdf": "pypdf", "numpy": "numpy", "faster-whisper": "faster_whisper", "piper-tts": "piper",
                     "onnxruntime": "onnxruntime", "sounddevice": "sounddevice"}
        missing = [p for p in EXTRAS[name] if not have(module_of[p.split(">")[0].split("<")[0].split("=")[0]])]
        if missing:
            pip_install(missing)
        if name == "folders":
            if not ollama_has(EMBED_MODEL):
                job_update(name, step="Downloading the AI search model (about 275 MB)…", progress=0)
                ollama_pull(EMBED_MODEL, name)
            FOLDERS.wake()
        elif name == "wake":
            for i, (f, url) in enumerate(HOTWORD_FILES.items()):
                job_update(name, step=f"Downloading the “Hey Jarvis” model ({i + 1}/3)…", progress=i / 3)
                download(url, os.path.join(HOTWORD_DIR, f), name, f)
            cfg = load_cfg()
            cfg["hotword_enabled"] = True
            save_cfg(cfg)
            HOTWORD.ensure()
        else:
            size = opts.get("stt_model") if opts.get("stt_model") in WHISPER_SIZES else load_cfg().get("stt_model", "small")
            if not whisper_ready(size):
                job_update(name, step=f"Downloading speech recognition ({WHISPER_SIZES[size]} MB)…", progress=0)
                for f in WHISPER_FILES:
                    download(f"https://huggingface.co/Systran/faster-whisper-{size}/resolve/main/{f}",
                             os.path.join(whisper_dir(size), f), name, f"Whisper {size} · {f}")
            for vid in opts.get("voices") or [load_cfg().get("tts_voice", "en_GB-alan-medium")]:
                if not voice_ready(vid):
                    job_update(name, step=f"Downloading voice {vid} (about 60 MB)…", progress=0)
                    fetch_voice(vid, name)
            cfg = load_cfg()
            cfg["stt_model"] = size
            save_cfg(cfg)
        job_update(name, state="done", step="Ready", detail="", progress=1)
    except Exception as e:  # noqa: BLE001
        log("extra failed", name, traceback.format_exc())
        job_update(name, state="error", error=f"{type(e).__name__}: {e}")


def start_extra(name, opts=None):
    with _jobs_lock:
        if JOBS.get(name, {}).get("state") == "running":
            return
        JOBS[name] = {"state": "running", "step": "Starting…"}
    threading.Thread(target=run_extra, args=(name, opts or {}), daemon=True).start()


# ------------------------------------------------------------ offline voice
class Voice:
    def __init__(self):
        self.lock = threading.Lock()
        self.stt = None
        self.stt_size = None
        self.voices = {}

    def status(self):
        cfg = load_cfg()
        size = cfg.get("stt_model", "small")
        return {
            "packages": have("faster_whisper") and have("piper"),
            "stt_model": size, "stt_ready": whisper_ready(size), "stt_language": cfg.get("stt_language", ""),
            "tts_voice": cfg.get("tts_voice", "en_GB-alan-medium"),
            "voices": [{"id": v, "label": label, "installed": voice_ready(v)} for v, label in VOICE_CATALOG],
            "job": JOBS.get("voice", {"state": "idle"}),
        }

    def transcribe(self, wav_bytes, language=None, quick=False):
        import io
        import wave
        import numpy as np
        size = load_cfg().get("stt_model", "small")
        if not whisper_ready(size):
            raise RuntimeError("Offline speech recognition is not set up yet.")
        with wave.open(io.BytesIO(wav_bytes), "rb") as w:
            if w.getsampwidth() != 2:
                raise ValueError("Expected 16-bit WAV audio")
            sr, ch = w.getframerate(), w.getnchannels()
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        if ch > 1:
            pcm = pcm.reshape(-1, ch).mean(axis=1)
        if sr != 16000:
            pcm = np.interp(np.arange(0, len(pcm), sr / 16000.0), np.arange(len(pcm)), pcm).astype(np.float32)
        with self.lock:
            if self.stt is None or self.stt_size != size:
                from faster_whisper import WhisperModel
                self.stt = WhisperModel(whisper_dir(size), device="cpu", compute_type="int8",
                                        cpu_threads=max(1, (os.cpu_count() or 4) - 1))
                self.stt_size = size
            t = time.time()
            segs, info = self.stt.transcribe(pcm, language=language or None, beam_size=1 if quick else 3,
                                             vad_filter=not quick, condition_on_previous_text=False)
            text = " ".join(s.text.strip() for s in segs).strip()
        return {"text": text, "language": info.language, "seconds": round(time.time() - t, 2), "audio_seconds": round(len(pcm) / 16000, 1)}

    def pick_voice(self, text, wanted):
        # Telugu, Hindi or Malayalam script: use an installed voice for that language when there is one.
        scripts = [("te_IN", 0x0C00, 0x0C7F), ("hi_IN", 0x0900, 0x097F), ("ml_IN", 0x0D00, 0x0D7F)]
        for prefix, lo, hi in scripts:
            n = sum(1 for ch in text if lo <= ord(ch) <= hi)
            if n > max(3, len(text) * 0.2):
                for v, _ in VOICE_CATALOG:
                    if v.startswith(prefix) and voice_ready(v):
                        return v
        return wanted

    def speak(self, text, voice=None):
        import io
        import wave
        vid = self.pick_voice(text, voice if voice in VOICE_IDS else load_cfg().get("tts_voice", "en_GB-alan-medium"))
        if not voice_ready(vid):
            raise RuntimeError(f"The voice {vid} is not downloaded yet.")
        with self.lock:
            v = self.voices.get(vid)
            if v is None:
                from piper import PiperVoice
                v = self.voices[vid] = PiperVoice.load(voice_path(vid))
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                if hasattr(v, "synthesize_wav"):
                    v.synthesize_wav(text, w)
                else:  # piper-tts < 1.3
                    v.synthesize(text, w)
        return buf.getvalue()


VOICE = Voice()


# ------------------------------------------------------------ folder search
DOC_EXT = {".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".rtf",
           ".html", ".htm", ".xml", ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".c", ".cpp", ".h", ".cs", ".go",
           ".rs", ".php", ".rb", ".kt", ".swift", ".sql", ".sh", ".ps1", ".yaml", ".yml", ".ini", ".tex"}
SKIP_DIRS = {"node_modules", "__pycache__", ".git", "venv", ".venv", "appdata", "$recycle.bin", "system volume information",
             "dist", "build", ".cache", "site-packages", "windows", "program files", "program files (x86)"}
MAX_FILE = 30_000_000
MAX_FILES = 8000


def _xml_text(xml, tag):
    import re
    import html
    return [html.unescape(m) for m in re.findall(rf"<{tag}(?:\s[^>]*)?>([^<]*)</{tag}>", xml)]


def extract_text(path):
    """Return [(label, text)] parts: pages for PDF, slides for PPTX, sheets for XLSX, one part otherwise."""
    import re
    import zipfile
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        if not have("pypdf"):
            raise RuntimeError("PDF support is not installed")
        from pypdf import PdfReader
        r = PdfReader(path)
        return [(f"page {i + 1}", (p.extract_text() or "")) for i, p in enumerate(r.pages[:400])]
    if ext == ".docx":
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf-8", "ignore")
        paras = ["".join(_xml_text(p, "w:t")) for p in re.findall(r"<w:p[ >].*?</w:p>", xml, flags=re.S)]
        return [("", "\n".join(p for p in paras if p.strip()))]
    if ext == ".pptx":
        with zipfile.ZipFile(path) as z:
            names = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=lambda n: int(re.findall(r"\d+", n)[0]))
            return [(f"slide {i + 1}", " ".join(_xml_text(z.read(n).decode("utf-8", "ignore"), "a:t"))) for i, n in enumerate(names)]
    if ext == ".xlsx":
        with zipfile.ZipFile(path) as z:
            shared = []
            if "xl/sharedStrings.xml" in z.namelist():
                sx = z.read("xl/sharedStrings.xml").decode("utf-8", "ignore")
                shared = ["".join(_xml_text(si, "t")) for si in re.findall(r"<si>.*?</si>", sx, flags=re.S)]
            parts = []
            for n in sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))[:20]:
                sx = z.read(n).decode("utf-8", "ignore")
                rows = []
                for row in re.findall(r"<row[ >].*?</row>", sx, flags=re.S)[:3000]:
                    cells = []
                    for attrs, val in re.findall(r"<c([^>]*)>(?:.*?<v>([^<]*)</v>)?.*?</c>", row, flags=re.S):
                        if 't="s"' in attrs and val.isdigit() and int(val) < len(shared):
                            cells.append(shared[int(val)])
                        else:
                            cells.append(val)
                    rows.append(" | ".join(c for c in cells if c))
                parts.append((os.path.basename(n).replace(".xml", ""), "\n".join(r for r in rows if r)))
            return parts
    with open(path, "rb") as f:
        raw = f.read(3_000_000)
    text = raw.decode("utf-8", "ignore")
    if ext in (".html", ".htm", ".xml", ".rtf"):
        text = strip_tags(text)
    return [("", text)]


def chunk_parts(parts, size=1100, overlap=180):
    out = []
    for label, text in parts:
        text = " ".join((text or "").split())
        if not text:
            continue
        i = 0
        while i < len(text):
            piece = text[i:i + size]
            if i + size < len(text):  # end on a sentence or word boundary
                cut = max(piece.rfind(". "), piece.rfind("? "), piece.rfind("! "))
                if cut < size * 0.5:
                    cut = piece.rfind(" ")
                if cut > size * 0.3:
                    piece = piece[:cut + 1]
            out.append((label, piece.strip()))
            if i + len(piece) >= len(text):
                break
            i += max(1, len(piece) - overlap)
    return out


def embed(texts, query=False):
    cfg = load_cfg()
    prefix = "search_query: " if query else "search_document: "
    j = http_json(cfg["ollama_url"].rstrip("/") + "/api/embed",
                  body={"model": EMBED_MODEL, "input": [prefix + t for t in texts], "truncate": True}, timeout=300)
    if j.get("error"):
        raise RuntimeError(j["error"])
    vecs = []
    for v in j.get("embeddings") or []:
        n = sum(x * x for x in v) ** 0.5 or 1.0
        vecs.append([x / n for x in v])
    return vecs


def pack(vec):
    from array import array
    return array("f", vec).tobytes()


def unpack(blob):
    from array import array
    a = array("f")
    a.frombytes(blob)
    return a


def default_folders():
    home = os.path.expanduser("~")
    out = []
    for name in ("Documents", "Downloads", "Desktop", "OneDrive\\Documents" if IS_WIN else "Notes"):
        p = os.path.join(home, name)
        if os.path.isdir(p):
            out.append(p)
    return out


def folder_allowed(path):
    p = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(p):
        return None, "That folder does not exist on this PC."
    drive, rest = os.path.splitdrive(p)
    if rest.strip("\\/") == "":
        return None, "Pick a folder (like Documents), not a whole drive."
    if IS_WIN:
        sysroots = [os.environ.get(k, "") for k in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "APPDATA", "LOCALAPPDATA")]
    else:
        sysroots = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/proc", "/sys", "/dev", "/var", "/boot", "/System", "/Library", "/Applications"]
    norm = os.path.normcase(p)
    for root in sysroots:
        r = os.path.normcase(os.path.abspath(root)) if root else ""
        if r and (norm == r or norm.startswith(r.rstrip("\\/") + os.sep)):
            return None, "System folders can't be indexed. Pick a folder with your own files."
    return p, ""


class Folders:
    """Indexes the user's chosen folders into SQLite with embeddings from Ollama."""

    def __init__(self):
        self.event = threading.Event()
        self.status = {"state": "idle", "folder": "", "file": "", "done": 0, "total": 0, "last_run": None, "error": ""}
        self.cache = None
        self.lock = threading.Lock()

    def wake(self):
        self.event.set()

    def folders(self):
        return [f for f in load_cfg().get("folders") or [] if isinstance(f, str)]

    def ready(self):
        return {"pypdf": have("pypdf"), "numpy": have("numpy"), "embed_model": ollama_has(EMBED_MODEL)}

    def stats(self):
        with db() as con:
            rows = {r["folder"]: dict(r) for r in con.execute(
                "SELECT folder, COUNT(*) AS docs, SUM(chunks) AS chunks, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors FROM docs GROUP BY folder")}
        return [{"path": f, "docs": rows.get(f, {}).get("docs", 0), "chunks": rows.get(f, {}).get("chunks") or 0,
                 "errors": rows.get(f, {}).get("errors", 0)} for f in self.folders()]

    def loop(self):
        while True:
            self.event.wait(timeout=1800)  # re-check every 30 minutes, or when woken
            self.event.clear()
            try:
                if self.folders() and ollama_has(EMBED_MODEL):
                    self.index_all()
            except Exception as e:  # noqa: BLE001
                log("index error", traceback.format_exc())
                self.status.update(state="error", error=str(e))

    def index_all(self):
        folders = self.folders()
        with db() as con:  # forget folders the user removed
            gone = [r["folder"] for r in con.execute("SELECT DISTINCT folder FROM docs") if r["folder"] not in folders]
            for g in gone:
                con.execute("DELETE FROM chunks WHERE doc_id IN (SELECT id FROM docs WHERE folder=?)", (g,))
                con.execute("DELETE FROM docs WHERE folder=?", (g,))
        for folder in folders:
            files = []
            for root, dirs, names in os.walk(folder):
                dirs[:] = [d for d in dirs if not d.startswith(".") and d.lower() not in SKIP_DIRS]
                for n in names:
                    if os.path.splitext(n)[1].lower() in DOC_EXT and not n.startswith("~$"):
                        p = os.path.join(root, n)
                        try:
                            st = os.stat(p)
                        except OSError:
                            continue
                        if st.st_size <= MAX_FILE:
                            files.append((p, st.st_mtime, st.st_size))
                if len(files) >= MAX_FILES:
                    break
            self.status.update(state="indexing", folder=folder, done=0, total=len(files), error="")
            seen = set()
            for i, (p, mtime, size) in enumerate(files):
                seen.add(p)
                self.status.update(file=os.path.basename(p), done=i)
                with db() as con:
                    row = con.execute("SELECT id, mtime, size, status FROM docs WHERE path=?", (p,)).fetchone()
                if row and row["mtime"] == mtime and row["size"] == size and row["status"] in ("ok", "empty"):
                    continue
                self.index_file(folder, p, mtime, size, row["id"] if row else None)
            with db() as con:  # files deleted from disk
                for r in con.execute("SELECT id, path FROM docs WHERE folder=?", (folder,)).fetchall():
                    if r["path"] not in seen:
                        con.execute("DELETE FROM chunks WHERE doc_id=?", (r["id"],))
                        con.execute("DELETE FROM docs WHERE id=?", (r["id"],))
        self.cache = None
        self.status.update(state="idle", folder="", file="", done=self.status.get("total", 0), last_run=time.time())

    def index_file(self, folder, path, mtime, size, doc_id):
        status, err, pieces = "ok", "", []
        try:
            pieces = chunk_parts(extract_text(path))
        except Exception as e:  # noqa: BLE001
            status, err = "error", f"{type(e).__name__}: {e}"[:300]
        vecs = []
        try:
            for b in range(0, len(pieces), 16):
                vecs += embed([f"{os.path.basename(path)} {label}: {t}" for label, t in pieces[b:b + 16]])
        except Exception as e:  # noqa: BLE001
            status, err, pieces, vecs = "error", f"Embedding failed: {e}"[:300], [], []
        if status == "ok" and not pieces:
            status = "empty"
        with db() as con:
            if doc_id:
                con.execute("DELETE FROM chunks WHERE doc_id=?", (doc_id,))
                con.execute("UPDATE docs SET mtime=?, size=?, chunks=?, status=?, error=? WHERE id=?", (mtime, size, len(pieces), status, err, doc_id))
            else:
                doc_id = con.execute("INSERT INTO docs(folder, path, mtime, size, chunks, status, error) VALUES(?,?,?,?,?,?,?)",
                                     (folder, path, mtime, size, len(pieces), status, err)).lastrowid
            con.executemany("INSERT INTO chunks(doc_id, idx, label, text, vec) VALUES(?,?,?,?,?)",
                            [(doc_id, i, label, t, pack(v)) for i, ((label, t), v) in enumerate(zip(pieces, vecs))])
        self.cache = None

    def _matrix(self):
        with self.lock:
            if self.cache is None:
                with db() as con:
                    rows = con.execute("SELECT c.id, c.vec FROM chunks c JOIN docs d ON d.id=c.doc_id WHERE d.status='ok'").fetchall()
                ids = [r["id"] for r in rows]
                if have("numpy"):
                    import numpy as np
                    mat = np.frombuffer(b"".join(r["vec"] for r in rows), dtype=np.float32).reshape(len(rows), -1) if rows else None
                else:
                    mat = [unpack(r["vec"]) for r in rows]
                self.cache = (ids, mat)
            return self.cache

    def search(self, query, k=6):
        ids, mat = self._matrix()
        if not ids:
            return []
        q = embed([query], query=True)[0]
        if have("numpy"):
            import numpy as np
            scores = mat @ np.asarray(q, dtype=np.float32)
            order = np.argsort(-scores)[: k * 3]
            ranked = [(ids[i], float(scores[i])) for i in order]
        else:
            scored = [(ids[i], sum(a * b for a, b in zip(v, q))) for i, v in enumerate(mat)]
            ranked = sorted(scored, key=lambda x: -x[1])[: k * 3]
        words = {w for w in query.lower().split() if len(w) > 3}
        out = []
        with db() as con:
            for cid, score in ranked:
                r = con.execute("SELECT c.text, c.label, d.path, d.folder FROM chunks c JOIN docs d ON d.id=c.doc_id WHERE c.id=?", (cid,)).fetchone()
                if not r:
                    continue
                name = os.path.basename(r["path"])
                bonus = 0.05 * sum(1 for w in words if w in name.lower())  # "the physics pdf" -> files named physics
                out.append({"path": r["path"], "name": name, "label": r["label"], "text": r["text"], "score": round(score + bonus, 3),
                            "folder": r["folder"]})
        out.sort(key=lambda x: -x["score"])
        return out[:k]


FOLDERS = Folders()


def inside_folders(path):
    p = os.path.normcase(os.path.abspath(path))
    for f in FOLDERS.folders():
        base = os.path.normcase(os.path.abspath(f))
        try:
            if os.path.commonpath([p, base]) == base:
                return True
        except ValueError:  # different drives on Windows
            continue
    return False


def open_path(p):
    if IS_WIN:
        os.startfile(p)  # noqa: S606 - opens with the user's default app
    elif IS_MAC:
        subprocess.Popen(["open", p])
    else:
        subprocess.Popen(["xdg-open", p], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ---------------------------------------------------------------- PC actions
# A fixed list of safe actions. Nothing here runs a command the user (or a web page) typed.
APPS_WIN = {
    "notepad": ["notepad.exe"], "calculator": "calculator:", "paint": ["mspaint.exe"], "file explorer": ["explorer.exe"],
    "settings": "ms-settings:", "task manager": ["taskmgr.exe"], "camera": "microsoft.windows.camera:", "photos": "ms-photos:",
    "clock": "ms-clock:", "snipping tool": "ms-screenclip:", "microsoft store": "ms-windows-store:", "spotify": "spotify:",
    "whatsapp": "whatsapp:", "edge": "microsoft-edge:", "chrome": "chrome.exe", "word": "winword.exe", "excel": "excel.exe",
    "powerpoint": "powerpnt.exe", "outlook": "outlook.exe", "vs code": "__vscode__", "terminal": "__terminal__",
    "command prompt": ["cmd.exe"], "powershell": ["powershell.exe"], "control panel": ["control.exe"], "teams": "msteams:",
}
FOLDER_NAMES = {"documents": "Documents", "downloads": "Downloads", "desktop": "Desktop", "pictures": "Pictures",
                "music": "Music", "videos": "Videos", "home": ""}
MEDIA_KEYS = {"play_pause": 0xB3, "next": 0xB0, "previous": 0xB1, "mute": 0xAD, "volume_down": 0xAE, "volume_up": 0xAF}


def _launch_win(target):
    if target == "__vscode__":
        for exe in (os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Microsoft VS Code", "Code.exe"),
                    os.path.join(os.environ.get("ProgramFiles", ""), "Microsoft VS Code", "Code.exe")):
            if os.path.exists(exe):
                subprocess.Popen([exe])
                return
        if shutil.which("code"):  # code.cmd on PATH
            subprocess.Popen(["cmd", "/c", "code"], creationflags=NO_WINDOW)
            return
        raise RuntimeError("VS Code doesn't seem to be installed.")
    if target == "__terminal__":
        target = "wt.exe" if shutil.which("wt") else ["powershell.exe"]
    if isinstance(target, list):
        subprocess.Popen(target, creationflags=subprocess.CREATE_NEW_CONSOLE if target[0] in ("cmd.exe", "powershell.exe") else 0)
    else:
        os.startfile(target)  # noqa: S606 - URI schemes and App Paths (winword.exe, chrome.exe…)


def disk_report():
    drives = []
    if IS_WIN:
        for letter in "CDEFGHIJ":
            root = f"{letter}:\\"
            if os.path.exists(root):
                try:
                    u = shutil.disk_usage(root)
                    drives.append({"drive": root, "total": u.total, "free": u.free})
                except OSError:
                    pass
    else:
        u = shutil.disk_usage("/")
        drives.append({"drive": "/", "total": u.total, "free": u.free})
    home = os.path.expanduser("~")
    deadline = time.time() + 12

    def size_of(path):
        total = 0
        stack = [path]
        while stack and time.time() < deadline:
            try:
                with os.scandir(stack.pop()) as it:
                    for e in it:
                        try:
                            if e.is_symlink():
                                continue
                            if e.is_dir():
                                stack.append(e.path)
                            else:
                                total += e.stat().st_size
                        except OSError:
                            pass
            except OSError:
                pass
        return total

    folders = []
    for name in ("Downloads", "Documents", "Desktop", "Pictures", "Videos", "Music", "OneDrive", os.path.join("AppData", "Local", "Temp")):
        p = os.path.join(home, name)
        if os.path.isdir(p):
            folders.append({"name": name, "path": p, "size": size_of(p)})
    big = []
    for name in ("Downloads", "Desktop", "Videos", "Documents"):
        p = os.path.join(home, name)
        for root, dirs, files in os.walk(p):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                try:
                    big.append({"path": os.path.join(root, f), "size": os.path.getsize(os.path.join(root, f))})
                except OSError:
                    pass
            if time.time() > deadline + 6:
                break
    big.sort(key=lambda x: -x["size"])
    folders.sort(key=lambda x: -x["size"])
    return {"drives": drives, "folders": folders, "largest": big[:10], "partial": time.time() > deadline}


def run_action(action, args):
    args = args or {}
    if action == "open_url":
        url = str(args.get("url") or "")
        if not url.startswith(("https://", "http://")):
            raise ValueError("Only web addresses can be opened.")
        import webbrowser
        webbrowser.open(url)
        return {"message": f"Opened {urllib.parse.urlparse(url).netloc}"}
    if action == "open_app":
        app = str(args.get("app") or "").lower()
        if IS_WIN:
            if app not in APPS_WIN:
                raise ValueError(f"I can't open “{app}” yet.")
            _launch_win(APPS_WIN[app])
        elif IS_MAC:
            mac = {"vs code": "Visual Studio Code", "chrome": "Google Chrome", "calculator": "Calculator", "notepad": "TextEdit",
                   "terminal": "Terminal", "settings": "System Settings", "spotify": "Spotify", "word": "Microsoft Word",
                   "excel": "Microsoft Excel", "powerpoint": "Microsoft PowerPoint", "file explorer": "Finder"}
            if app not in mac:
                raise ValueError(f"I can't open “{app}” on this Mac yet.")
            subprocess.Popen(["open", "-a", mac[app]])
        else:
            lin = {"vs code": "code", "chrome": "google-chrome", "calculator": "gnome-calculator", "terminal": "x-terminal-emulator",
                   "file explorer": "xdg-open", "notepad": "gedit"}
            exe = lin.get(app)
            if not exe or not shutil.which(exe):
                raise ValueError(f"I can't open “{app}” here.")
            subprocess.Popen([exe] + ([os.path.expanduser("~")] if exe == "xdg-open" else []))
        return {"message": f"Opened {app}"}
    if action == "open_folder":
        name = str(args.get("name") or "").lower()
        if name not in FOLDER_NAMES:
            raise ValueError("Unknown folder")
        p = os.path.join(os.path.expanduser("~"), FOLDER_NAMES[name])
        open_path(p)
        return {"message": f"Opened {name}"}
    if action == "open_file":
        p = str(args.get("path") or "")
        if not (os.path.isfile(p) and inside_folders(p)):
            raise ValueError("I can only open files inside the folders you added to Jarvis.")
        open_path(p)
        return {"message": f"Opened {os.path.basename(p)}"}
    if action == "media":
        key = str(args.get("key") or "")
        if key not in MEDIA_KEYS or not IS_WIN:
            raise ValueError("Media keys work on Windows only." if key in MEDIA_KEYS else "Unknown media key")
        import ctypes
        for _ in range(max(1, min(int(args.get("times") or 1), 10))):
            ctypes.windll.user32.keybd_event(MEDIA_KEYS[key], 0, 0, 0)
            ctypes.windll.user32.keybd_event(MEDIA_KEYS[key], 0, 2, 0)
        return {"message": key.replace("_", " ")}
    if action == "lock":
        if not IS_WIN:
            raise ValueError("Locking works on Windows only.")
        import ctypes
        ctypes.windll.user32.LockWorkStation()
        return {"message": "Locked"}
    if action == "remind":
        at = float(args.get("at") or 0)
        text = str(args.get("text") or "Reminder")[:300]
        if at < time.time() - 60 or at > time.time() + 366 * 86400:
            raise ValueError("That reminder time is not valid.")
        rid = uuid.uuid4().hex[:10]
        with db() as con:
            con.execute("INSERT INTO reminders(id, at, text, done, created) VALUES(?,?,?,0,?)", (rid, at, text, time.time()))
        return {"message": "Reminder set", "id": rid, "at": at}
    if action == "disk":
        return {"message": "Disk report", "data": disk_report()}
    raise ValueError("Unknown action")


def due_reminders():
    now = time.time()
    with db() as con:
        rows = con.execute("SELECT * FROM reminders WHERE done=0 AND at<=?", (now,)).fetchall()
        for r in rows:
            con.execute("UPDATE reminders SET done=1 WHERE id=?", (r["id"],))
            rid = uuid.uuid4().hex[:12]
            con.execute("INSERT INTO runs(id,task_id,task_name,started,finished,status,output,sources,read) VALUES(?,?,?,?,?,?,?,?,0)",
                        (rid, "reminder", "⏰ Reminder", now, now, "done", r["text"], "[]"))
            site = (load_cfg().get("site_url") or DEFAULT_CFG["site_url"]).rstrip("/")
            notify("⏰ Reminder", r["text"], f"{site}/?run={rid}")

# ------------------------------------------------------------ "Hey Jarvis"
# Always-on wake phrase, handled here so it works with no browser window open.
# Detection uses openWakeWord's ONNX models (Apache-2.0): a mel spectrogram, a speech
# embedding and the "hey jarvis" classifier. Audio is processed in memory and never stored.
HOTWORD_FILES = {
    "melspectrogram.onnx": "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx",
    "embedding_model.onnx": "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx",
    "hey_jarvis_v0.1.onnx": "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/hey_jarvis_v0.1.onnx",
}
HOTWORD_DIR = os.path.join(MODELS_DIR, "hotword")
SENSITIVITY = {"low": 0.75, "normal": 0.5, "high": 0.3}  # score needed to wake up


def hotword_models_ready():
    return all(os.path.exists(os.path.join(HOTWORD_DIR, f)) for f in HOTWORD_FILES)


class HeyJarvisDetector:
    FRAME = 1280  # 80 ms at 16 kHz

    def __init__(self):
        import numpy as np
        import onnxruntime as ort
        self.np = np
        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 1
        load = lambda f: ort.InferenceSession(os.path.join(HOTWORD_DIR, f), sess_options=so, providers=["CPUExecutionProvider"])  # noqa: E731
        self.mel, self.emb, self.ww = load("melspectrogram.onnx"), load("embedding_model.onnx"), load("hey_jarvis_v0.1.onnx")
        self.mel_in, self.emb_in, self.ww_in = self.mel.get_inputs()[0].name, self.emb.get_inputs()[0].name, self.ww.get_inputs()[0].name
        self.reset()

    def _melspec(self, pcm):
        spec = self.np.squeeze(self.mel.run(None, {self.mel_in: pcm.astype(self.np.float32)[None, :]})[0])
        return spec / 10 + 2

    def _embed(self, mel76):
        return self.emb.run(None, {self.emb_in: mel76.astype(self.np.float32)[None, :, :, None]})[0].reshape(1, -1)

    def reset(self):
        np = self.np
        self.raw = np.zeros(0, dtype=np.int16)
        self.mel_buf = np.ones((76, 32), dtype=np.float32)
        self.pending = np.zeros(0, dtype=np.int16)
        spec = self._melspec(np.random.randint(-1000, 1000, 16000 * 4).astype(np.int16))
        self.feat_buf = np.vstack([self._embed(spec[i:i + 76]) for i in range(0, spec.shape[0] - 75, 8)])
        self.frames = 0

    def process(self, pcm):
        """Feed 16 kHz mono int16 audio; returns the highest wake score (0..1) in it."""
        np = self.np
        x = np.concatenate([self.pending, pcm.astype(np.int16)])
        best = 0.0
        while len(x) >= self.FRAME:
            chunk, x = x[:self.FRAME], x[self.FRAME:]
            self.raw = np.concatenate([self.raw, chunk])[-(self.FRAME + 480):]
            if len(self.raw) < self.FRAME + 480:
                continue
            self.mel_buf = np.vstack([self.mel_buf, self._melspec(self.raw)])[-970:]
            self.feat_buf = np.vstack([self.feat_buf, self._embed(self.mel_buf[-76:])])[-120:]
            self.frames += 1
            score = float(self.ww.run(None, {self.ww_in: self.feat_buf[-16:][None, :, :].astype(np.float32)})[0].reshape(-1)[0])
            if self.frames > 5:
                best = max(best, score)
        self.pending = x
        return best


class MicSource:
    """16 kHz mono int16 frames from the default microphone (or a WAV file for testing)."""

    def __init__(self):
        import queue
        self.q = queue.Queue(maxsize=400)
        self.stream = None
        self.test_wav = os.environ.get("JARVIS_HOTWORD_WAV")

    def __enter__(self):
        if self.test_wav:
            threading.Thread(target=self._feed_file, daemon=True).start()
            return self
        import sounddevice as sd
        self.stream = sd.InputStream(samplerate=16000, channels=1, dtype="int16", blocksize=1280,
                                     callback=lambda data, frames, t, status: self._put(data[:, 0].copy()))
        self.stream.start()
        return self

    def _put(self, frame):
        try:
            self.q.put_nowait(frame)
        except Exception:  # queue full: drop the oldest audio
            try:
                self.q.get_nowait()
                self.q.put_nowait(frame)
            except Exception:
                pass

    def _feed_file(self):
        import wave
        import numpy as np
        with wave.open(self.test_wav, "rb") as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        while not getattr(self, "closed", False):
            for i in range(0, len(pcm) - 1280, 1280):
                if getattr(self, "closed", False):
                    return
                self._put(pcm[i:i + 1280].copy())
                time.sleep(0.08)

    def read(self, timeout=2.0):
        return self.q.get(timeout=timeout)

    def flush(self):
        while not self.q.empty():
            try:
                self.q.get_nowait()
            except Exception:
                break

    def __exit__(self, *exc):
        self.closed = True
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass


def play_wav(data):
    """Play WAV bytes on this PC's speakers and wait until it finishes."""
    try:
        if IS_WIN:
            import winsound
            winsound.PlaySound(data, winsound.SND_MEMORY | winsound.SND_NODEFAULT)
            return True
        player = shutil.which("afplay") if IS_MAC else (shutil.which("paplay") or shutil.which("aplay"))
        if not player:
            return False
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(data)
            name = f.name
        subprocess.run([player, name], capture_output=True, timeout=180)
        os.remove(name)
        return True
    except Exception:
        log("play_wav failed", traceback.format_exc())
        return False


def stop_audio():
    if IS_WIN:
        try:
            import winsound
            winsound.PlaySound(None, winsound.SND_PURGE)
        except Exception:
            pass


def beep():
    if IS_WIN:
        try:
            import winsound
            winsound.Beep(880, 90)
            winsound.Beep(1320, 110)
        except Exception:
            pass


def pcm_to_wav(pcm):
    import io
    import wave
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm.astype("int16").tobytes())
    return b.getvalue()


# --- opening the dashboard window ---------------------------------------------------------
def _find_hud_window():
    if not IS_WIN:
        return None
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                if "OpenJarvis HUD" in buf.value:
                    found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found[0] if found else None


def _focus_window(hwnd):
    import ctypes
    user32 = ctypes.windll.user32
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.keybd_event(0x12, 0, 0, 0)  # a quick ALT tap lets a background program bring a window to the front
    user32.keybd_event(0x12, 0, 2, 0)
    user32.SetForegroundWindow(hwnd)


def _browser_exe(pref="auto"):
    if not IS_WIN:
        return None
    import winreg
    names = {"chrome": ["chrome.exe"], "edge": ["msedge.exe"]}.get(pref, ["chrome.exe", "msedge.exe"])
    for name in names:
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(hive, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{name}") as k:
                    p = (winreg.QueryValue(k, None) or "").strip('"')
                    if p and os.path.exists(p):
                        return p
            except OSError:
                pass
    return None


def show_hud():
    """Bring an open Jarvis window to the front, or open a new app-style window."""
    cfg = load_cfg()
    url = (cfg.get("site_url") or DEFAULT_CFG["site_url"]).rstrip("/") + "/?wake=1"
    try:
        hwnd = _find_hud_window()
        if hwnd:
            _focus_window(hwnd)
            return "focused"
        exe = _browser_exe(cfg.get("hotword_browser", "auto"))
        if exe:
            subprocess.Popen([exe, f"--app={url}"])
            return "opened"
        import webbrowser
        webbrowser.open(url)
        return "opened"
    except Exception:
        log("show_hud failed", traceback.format_exc())
        return "failed"


class Hotword:
    def __init__(self):
        self.state = "off"
        self.error = ""
        self.last_trigger = None
        self.last_score = 0.0
        self.triggers = 0
        self.cmds = collections.deque(maxlen=5)
        self.thread = None
        self.lock = threading.Lock()
        self.ambient = 300.0  # background loudness, measured while nobody is waking Jarvis

    def ready(self):
        return have("onnxruntime") and have("numpy") and (have("sounddevice") or bool(os.environ.get("JARVIS_HOTWORD_WAV"))) and hotword_models_ready()

    def enabled(self):
        cfg = load_cfg()
        return bool(cfg.get("hotword_enabled")) and time.time() >= float(cfg.get("hotword_paused_until") or 0)

    def status(self):
        cfg = load_cfg()
        return {
            "ready": self.ready(), "enabled": bool(cfg.get("hotword_enabled")), "state": self.state, "error": self.error,
            "sensitivity": cfg.get("hotword_sensitivity", "normal"), "paused_until": cfg.get("hotword_paused_until") or 0,
            "last_trigger": self.last_trigger, "triggers": self.triggers, "browser": cfg.get("hotword_browser", "auto"),
            "stt_ready": have("faster_whisper") and whisper_ready(cfg.get("stt_model", "small")),
            "tts_ready": have("piper") and any(voice_ready(v) for v in VOICE_IDS),
            "autostart": autostart_status(), "job": JOBS.get("wake", {"state": "idle"}),
        }

    def ensure(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            if not load_cfg().get("hotword_enabled") or not self.ready():
                self.state = "off" if self.ready() else "not set up"
                return
            self.thread = threading.Thread(target=self.run, daemon=True)
            self.thread.start()

    def run(self):
        import numpy as np
        try:
            det = HeyJarvisDetector()
        except Exception as e:  # noqa: BLE001
            self.state, self.error = "error", f"Could not load the wake model: {e}"
            log("hotword load failed", traceback.format_exc())
            return
        threading.Thread(target=self.warm_up, daemon=True).start()
        while load_cfg().get("hotword_enabled"):
            if not self.enabled():  # paused
                self.state = "paused"
                time.sleep(5)
                continue
            try:
                with MicSource() as mic:
                    self.state, self.error = "listening", ""
                    det.reset()
                    while self.enabled():
                        try:
                            frame = mic.read()
                        except Exception:
                            continue
                        score = det.process(frame)
                        self.last_score = max(score, self.last_score * 0.98)
                        if score < 0.1:
                            rms = float(np.sqrt(np.mean(frame.astype(np.float32) ** 2)))
                            self.ambient = self.ambient * 0.98 + min(rms, 3000.0) * 0.02
                        threshold = SENSITIVITY.get(load_cfg().get("hotword_sensitivity", "normal"), 0.5)
                        if score >= threshold and (not self.last_trigger or time.time() - self.last_trigger > 3):
                            self.on_wake(mic)
                            det.reset()
                            mic.flush()
                            self.state = "listening"
            except Exception as e:  # noqa: BLE001  (no microphone, device unplugged, …)
                self.state, self.error = "error", f"Microphone problem: {e}"
                log("hotword mic error", traceback.format_exc())
                time.sleep(10)
        self.state = "off"
        _ = np

    def on_wake(self, mic):
        self.last_trigger = time.time()
        self.triggers += 1
        self.state = "awake"
        log("hey jarvis heard")
        cfg = load_cfg()
        opened = {"how": ""}
        t = threading.Thread(target=lambda: opened.update(how=show_hud()), daemon=True)
        t.start()
        # "Yes?" — the offline voice if installed, else a short chime
        spoke = False
        if have("piper"):
            try:
                spoke = play_wav(VOICE.speak("Yes?", cfg.get("tts_voice")))
            except Exception:
                spoke = False
        if not spoke:
            beep()
        mic.flush()  # don't transcribe our own "Yes?"
        text = ""
        if have("faster_whisper") and whisper_ready(cfg.get("stt_model", "small")):
            self.state = "recording"
            pcm = self.record_phrase(mic)
            log("hotword phrase", "none" if pcm is None else f"{len(pcm) / 16000:.1f}s")
            if pcm is not None:
                self.state = "transcribing"
                try:
                    text = VOICE.transcribe(pcm_to_wav(pcm)).get("text", "").strip()
                except Exception:
                    log("hotword stt failed", traceback.format_exc())
        t.join(timeout=5)
        self.cmds.append({"id": uuid.uuid4().hex[:10], "text": text, "ts": time.time(), "window": opened["how"],
                          "needs_mic": not text and not (have("faster_whisper") and whisper_ready(cfg.get("stt_model", "small")))})

    def warm_up(self):
        """Load the voice and speech models now, so "Yes?" and the transcription are quick later."""
        cfg = load_cfg()
        try:
            if have("piper"):
                VOICE.speak("Yes?", cfg.get("tts_voice"))
            if have("faster_whisper") and whisper_ready(cfg.get("stt_model", "small")):
                import numpy as np
                VOICE.transcribe(pcm_to_wav(np.zeros(16000, dtype=np.int16)), quick=True)
        except Exception:
            log("hotword warm-up", traceback.format_exc())

    def record_phrase(self, mic, wait_s=6.0, silence_s=1.0, max_s=15.0):
        import numpy as np
        chunks, pre = [], []
        noise = min(max(self.ambient, 120.0), 1500.0)  # measured before the wake word, while it was quiet
        started, loud_run, quiet = False, 0, 0
        t0 = time.time()
        while time.time() - t0 < wait_s + max_s:
            try:
                f = mic.read(timeout=1.0)
            except Exception:
                continue
            rms = float(np.sqrt(np.mean(f.astype(np.float32) ** 2)))
            thr = max(450.0, noise * 3)
            if not started:
                pre = (pre + [f])[-4:]
                loud_run = loud_run + 1 if rms > thr else 0
                if loud_run >= 2:
                    started, chunks = True, list(pre)
                elif time.time() - t0 > wait_s:
                    return None
                continue
            chunks.append(f)
            quiet = 0 if rms > thr * 0.8 else quiet + 1
            if quiet * 0.08 >= silence_s or len(chunks) * 0.08 >= max_s:
                break
        return np.concatenate(chunks) if chunks else None

    def next_command(self):
        while self.cmds:
            c = self.cmds.popleft()
            if time.time() - c["ts"] < 90:
                return c
        return None


HOTWORD = Hotword()
SPEAK_LOCK = threading.Lock()


# --- start with Windows -------------------------------------------------------------------
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def _pythonw():
    exe = sys.executable
    if IS_WIN and exe.lower().endswith("python.exe"):
        cand = exe[:-len("python.exe")] + "pythonw.exe"
        if os.path.exists(cand):
            return cand
    return exe


def _startup_vbs():
    return os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Jarvis Companion.vbs")


def autostart_status():
    if not IS_WIN:
        return "unsupported"
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.QueryValueEx(k, "JarvisCompanion")
            return "on"
    except OSError:
        pass
    startup = os.path.join(os.path.dirname(_startup_vbs()), "Jarvis Companion.lnk")
    return "on" if os.path.exists(_startup_vbs()) or os.path.exists(startup) else "off"


def set_autostart():
    """Start the Companion when you sign in to Windows. Tries the per-user Run key, then the Startup folder."""
    if not IS_WIN:
        raise ValueError("Automatic start is set up by the installer only on Windows.")
    script = os.path.abspath(__file__)
    cmd = f'"{_pythonw()}" "{script}"'
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.SetValueEx(k, "JarvisCompanion", 0, winreg.REG_SZ, cmd)
        return "Jarvis Companion will start every time you sign in (Run key)."
    except OSError as e:
        log("run key blocked", e)
    try:
        vbs = 'CreateObject("WScript.Shell").Run """' + _pythonw() + '"" ""' + script + '""", 0, False\r\n'
        with open(_startup_vbs(), "w", encoding="utf-8") as f:
            f.write(vbs)
        return "Jarvis Companion will start every time you sign in (Startup folder)."
    except OSError as e:
        log("startup folder blocked", e)
    raise RuntimeError("Windows security blocked automatic start. Use the manual steps shown below the button.")

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

    def _raw(self, limit=8_000_000):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError("Request too large")
        return self.rfile.read(n) if n else b""

    def _send_bytes(self, code, data, ctype):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

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
            if path == "/jobs":
                return self._send(200, {"jobs": JOBS})
            if path == "/voice":
                return self._send(200, VOICE.status())
            if path == "/folders":
                return self._send(200, {"folders": FOLDERS.stats(), "index": FOLDERS.status, "ready": FOLDERS.ready(),
                                        "suggestions": default_folders(), "job": JOBS.get("folders", {"state": "idle"})})
            if path == "/hotword":
                return self._send(200, HOTWORD.status())
            if path == "/wake/next":
                return self._send(200, {"command": HOTWORD.next_command()})
            if path == "/reminders":
                with db() as con:
                    rows = [dict(r) for r in con.execute("SELECT * FROM reminders WHERE done=0 ORDER BY at")]
                return self._send(200, {"reminders": rows})
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
            if path == "/stt":
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                return self._send(200, VOICE.transcribe(self._raw(), language=(q.get("lang") or [""])[0] or load_cfg().get("stt_language") or None,
                                                         quick=(q.get("quick") or ["0"])[0] == "1"))
            body = self._body()
            if path == "/tts":
                text = str(body.get("text") or "").strip()[:2500]
                if not text:
                    return self._send(400, {"error": "Nothing to say"})
                return self._send_bytes(200, VOICE.speak(text, body.get("voice")), "audio/wav")
            if path == "/extras/install":
                name = body.get("name")
                if name not in EXTRAS:
                    return self._send(400, {"error": "Unknown add-on"})
                opts = {"stt_model": body.get("stt_model")}
                if isinstance(body.get("voices"), list):
                    opts["voices"] = [v for v in body["voices"] if v in VOICE_IDS][:4]
                start_extra(name, opts)
                return self._send(200, {"ok": True})
            if path == "/hotword/config":
                cfg = load_cfg()
                if isinstance(body.get("enabled"), bool):
                    cfg["hotword_enabled"] = body["enabled"]
                    cfg["hotword_paused_until"] = 0
                if body.get("sensitivity") in SENSITIVITY:
                    cfg["hotword_sensitivity"] = body["sensitivity"]
                if body.get("browser") in ("auto", "chrome", "edge", "default"):
                    cfg["hotword_browser"] = body["browser"]
                if "pause_minutes" in body:
                    m = max(0, min(int(body.get("pause_minutes") or 0), 24 * 60))
                    cfg["hotword_paused_until"] = time.time() + m * 60 if m else 0
                save_cfg(cfg)
                HOTWORD.ensure()
                return self._send(200, HOTWORD.status())
            if path == "/speak":
                text = str(body.get("text") or "").strip()[:2500]
                if not text:
                    return self._send(400, {"error": "Nothing to say"})
                wav = VOICE.speak(text, body.get("voice"))
                with SPEAK_LOCK:
                    ok = play_wav(wav)
                return self._send(200 if ok else 500, {"ok": ok} if ok else {"error": "This PC could not play the audio."})
            if path == "/speak/stop":
                stop_audio()
                return self._send(200, {"ok": True})
            if path == "/autostart":
                return self._send(200, {"ok": True, "message": set_autostart(), "autostart": autostart_status()})
            if path == "/voice/config":
                cfg = load_cfg()
                if body.get("tts_voice") in VOICE_IDS:
                    cfg["tts_voice"] = body["tts_voice"]
                if body.get("stt_model") in WHISPER_SIZES:
                    cfg["stt_model"] = body["stt_model"]
                if "stt_language" in body:
                    cfg["stt_language"] = str(body.get("stt_language") or "")[:5]
                save_cfg(cfg)
                return self._send(200, VOICE.status())
            if path == "/folders":
                p, why = folder_allowed(str(body.get("path") or ""))
                if not p:
                    return self._send(400, {"error": why})
                cfg = load_cfg()
                if p not in cfg["folders"]:
                    cfg["folders"] = (cfg.get("folders") or []) + [p]
                    save_cfg(cfg)
                FOLDERS.wake()
                return self._send(200, {"ok": True, "path": p})
            if path == "/folders/remove":
                cfg = load_cfg()
                cfg["folders"] = [f for f in cfg.get("folders") or [] if f != body.get("path")]
                save_cfg(cfg)
                FOLDERS.wake()
                return self._send(200, {"ok": True})
            if path == "/folders/reindex":
                FOLDERS.wake()
                return self._send(200, {"ok": True})
            if path == "/folders/search":
                q = str(body.get("query") or "").strip()
                if not q:
                    return self._send(400, {"error": "Empty query"})
                if not ollama_has(EMBED_MODEL):
                    return self._send(400, {"error": "Folder search is not set up yet. Open WORKSPACE → MY FOLDERS and press SET UP."})
                return self._send(200, {"results": FOLDERS.search(q, int(body.get("k") or 6))})
            if path == "/actions/run":
                return self._send(200, {"ok": True, **run_action(str(body.get("action") or ""), body.get("args"))})
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
        except (ValueError, RuntimeError) as e:  # a clear message for the HUD
            log("POST refused", path, str(e))
            self._send(400, {"error": str(e)})
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
        if len(parts) == 2 and parts[0] == "reminders":
            with db() as con:
                con.execute("DELETE FROM reminders WHERE id=?", (parts[1],))
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
    threading.Thread(target=FOLDERS.loop, daemon=True).start()
    FOLDERS.wake()
    HOTWORD.ensure()
    log(f"Jarvis Companion {VERSION} listening on http://{HOST}:{PORT} (data: {HOME})")
    print(f"Jarvis Companion {VERSION} running on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
