#!/usr/bin/env python3
"""
Jarvis Companion - a small local helper for the OpenJarvis HUD.

  * Web search with YOUR OWN search API key (Tavily or Brave). The key stays on this PC.
  * Scheduled tasks that run in the background with your local Ollama model,
    even when the browser is closed. Results wait in the HUD's inbox.

Standard library only (no pip installs). Listens on 127.0.0.1:8765 only, and
only answers the HUD's own web address (CORS) plus requests carrying X-Jarvis.
"""
import json
import os
import sqlite3
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0.0"
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
}
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
                })
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
                if isinstance(body.get("memory"), list):
                    cfg["memory"] = [str(m)[:500] for m in body["memory"][:100]]
                save_cfg(cfg)
                return self._send(200, {"ok": True, "search_configured": bool(cfg.get("search_key"))})
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
