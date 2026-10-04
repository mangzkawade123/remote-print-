"""Remote Print - private print page. Upload a PDF from your phone or laptop, choose Direct Print or
print options, confirm, and it prints on this PC's printer. Only the person uploading sees the file.

Run:  python print_server.py      (starts hidden with Windows via the Startup shortcut)
Open: http://<this-PC-address>:8080   e.g. http://192.168.1.37:8080 on the office Wi-Fi
Test without printing:  set REMOTE_PRINT_DRY_RUN=1 before starting.
"""
import html
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(HERE, "print_server.log")
# When started hidden (pythonw, e.g. at Windows startup) there is no console, so log to a file instead
if sys.stdout is None or sys.stderr is None:
    sys.stdout = sys.stderr = open(LOG_FILE, "a", buffering=1, encoding="utf-8")
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

# ---- Settings ----
PORT = int(os.environ.get("REMOTE_PRINT_PORT", "8080"))
# The PIN is kept in pin.txt next to this file (anyone who knows it can print). Change it by editing pin.txt
# and restarting the page.
PIN_FILE = os.path.join(HERE, "pin.txt")
if not os.path.exists(PIN_FILE):
    with open(PIN_FILE, "w") as fh:
        fh.write("".join(secrets.choice("0123456789") for _ in range(8)))
with open(PIN_FILE) as fh:
    PIN = fh.read().strip()
# Wrong-PIN protection (the page is reachable from the internet through the tunnel)
MAX_FAILS_PER_VISITOR = 5      # wrong PINs before that visitor is locked out
VISITOR_LOCK_MINUTES = 15
MAX_FAILS_ALL = 30             # wrong PINs from everyone together per hour before uploads pause
ALL_LOCK_MINUTES = 15
PRINTER = "Brother DCP-T830DW Printer (Copy 1)"
PAPER = "A4"  # paper size is fixed
MAX_MB = 25
MAX_COPIES = 50
JOB_EXPIRY_MINUTES = 60  # unused uploads are deleted after this long
DRY_RUN = os.environ.get("REMOTE_PRINT_DRY_RUN") == "1"  # log the print command instead of printing
# ------------------

SUMATRA = os.path.join(HERE, "SumatraPDF.exe")
UPLOAD_DIR = os.path.join(HERE, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
IMAGE_EXT = {".jpg", ".jpeg", ".png"}
ALLOWED_EXT = IMAGE_EXT | {".pdf"}

jobs = {}  # token -> job dict; the token in the link is the only way to reach a job
jobs_lock = threading.Lock()
print_lock = threading.Lock()  # one print at a time


def log(text):
    print(f"[{time.strftime('%d/%m/%Y %H:%M:%S')}] {text}", flush=True)


# ---------- Wrong-PIN lockout ----------
fails = {}          # visitor -> [times of wrong PINs]
all_fails = []      # times of all wrong PINs
locked_all_until = 0.0
fail_lock = threading.Lock()


def locked_message(visitor):
    now = time.time()
    with fail_lock:
        if now < locked_all_until:
            return f"Too many wrong PINs. Uploads are paused for {int((locked_all_until - now) // 60) + 1} minutes."
        recent = [t for t in fails.get(visitor, []) if now - t < VISITOR_LOCK_MINUTES * 60]
        fails[visitor] = recent
        if len(recent) >= MAX_FAILS_PER_VISITOR:
            wait = int((recent[0] + VISITOR_LOCK_MINUTES * 60 - now) // 60) + 1
            return f"Too many wrong PINs. Try again in {wait} minutes."
    return ""


def record_fail(visitor):
    global locked_all_until, all_fails
    now = time.time()
    with fail_lock:
        fails.setdefault(visitor, []).append(now)
        all_fails = [t for t in all_fails if now - t < 3600] + [now]
        if len(all_fails) >= MAX_FAILS_ALL:
            locked_all_until = now + ALL_LOCK_MINUTES * 60
            all_fails = []
            log(f"{MAX_FAILS_ALL} wrong PINs within an hour - uploads paused for {ALL_LOCK_MINUTES} minutes")


# ---------- PDF page count and orientation (same approach as the WhatsApp bot) ----------
def pdf_info(data):
    texts = [data.decode("latin-1")]
    raw = texts[0]
    for m in re.finditer(r"stream\r?\n", raw):
        start = m.end()
        end = raw.find("endstream", start)
        if end < 0:
            break
        d = raw[raw.rfind("<<", 0, m.start()):m.start()]
        if "FlateDecode" in d and not re.search(r"/Subtype\s*/Image|/Length1|/FontFile", d) and end - start < 5_000_000:
            try:
                out = zlib.decompressobj().decompress(data[start:end]).decode("latin-1")
                if re.search(r"/Type\s*/Page", out):
                    texts.append(out)
            except zlib.error:
                pass

    def dict_around(s, i):
        a = s.rfind("<<", 0, i)
        b = s.find(">>", i)
        return s[max(a, 0):(b + 1 if b >= 0 else len(s))]

    box_re = re.compile(r"/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)")
    tree, leaves, inherited = 0, 0, None
    orient = {"portrait": 0, "landscape": 0}
    for s in texts:
        for m in re.finditer(r"/Type\s*/Pages\b", s):
            d = dict_around(s, m.start())
            c = re.search(r"/Count\s+(\d+)", d)
            if c:
                tree = max(tree, int(c.group(1)))
            b = box_re.search(d)
            if b and not inherited:
                inherited = b
    for s in texts:
        for m in re.finditer(r"/Type\s*/Page(?![s\w])", s):
            leaves += 1
            d = dict_around(s, m.start())
            b = box_re.search(d) or inherited
            if not b:
                continue
            w = abs(float(b.group(3)) - float(b.group(1)))
            h = abs(float(b.group(4)) - float(b.group(2)))
            r = re.search(r"/Rotate\s+(-?\d+)", d)
            if r and abs(int(r.group(1))) % 180 == 90:
                w, h = h, w
            orient["landscape" if w > h else "portrait"] += 1
    pages = tree or leaves
    detected = orient["portrait"] + orient["landscape"]
    return pages, (orient if detected and detected <= pages else None)


def parse_pages(text, total):
    """'1-3,7,10-12' -> (normalised text, None) or (None, error)."""
    t = re.sub(r"\s+", "", text or "").replace("–", "-").replace("—", "-")
    if not re.fullmatch(r"\d+(-\d+)?(,\d+(-\d+)?)*", t):
        return None, "Type pages like 1-5 or 1,3,5 or 1-3,7,10-12."
    pages = set()
    for part in t.split(","):
        a, _, b = part.partition("-")
        a, end = int(a), int(b or a)
        if a < 1:
            return None, "Page numbers start at 1."
        if end < a:
            return None, f'"{part}" goes backwards - write it as {end}-{a}.'
        if total and end > total:
            return None, f"This PDF has only {total} page{'s' if total != 1 else ''} - page {end} doesn't exist."
        pages.update(range(a, end + 1))
    ranges = []
    for p in sorted(pages):
        if ranges and p == ranges[-1][1] + 1:
            ranges[-1][1] = p
        else:
            ranges.append([p, p])
    return ",".join(str(a) if a == b else f"{a}-{b}" for a, b in ranges), None


# ---------- Printing ----------
DIRECT = {"copies": 1, "color": "color", "sides": "single", "pages": "all", "orientation": "auto"}
LABELS = {
    "color": {"mono": "🖤 Black & White", "color": "🎨 Color"},
    "sides": {"single": "📄 Single Side", "duplex": "🔄 Both Side"},
    "orientation": {"portrait": "📄 Portrait", "landscape": "🖼️ Landscape", "auto": "🔄 Auto (as per PDF)"},
}


def sumatra_settings(o, is_image):
    parts = []
    if o["pages"] != "all" and not is_image:
        parts.append(o["pages"])
    if o["copies"] > 1:
        parts.append(f"{o['copies']}x")
    parts.append("monochrome" if o["color"] == "mono" else "color")
    if o["sides"] == "duplex":
        parts.append("duplexshort" if o["orientation"] == "landscape" else "duplexlong")
    else:
        parts.append("simplex")
    parts.append(f"paper={PAPER}")
    if o["orientation"] in ("portrait", "landscape"):
        parts.append(o["orientation"])
    if is_image:
        parts.append("fit")
    return ",".join(parts)


def powershell(cmd):
    r = subprocess.run(["powershell.exe", "-NoProfile", "-Command", cmd], capture_output=True, text=True,
                       timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return r.stdout.strip()


def printer_problem():
    """'' when the printer looks ready, otherwise a short description."""
    name = PRINTER.replace("'", "''")
    try:
        out = powershell(f"$p = Get-Printer -Name '{name}' -ErrorAction Stop; "
                         f"$w = (Get-CimInstance Win32_Printer | Where-Object Name -eq '{name}').WorkOffline; "
                         '"$($p.PrinterStatus)|$w"')
    except Exception as e:  # noqa: BLE001
        return f"could not check the printer ({e})"
    if "|" not in out:
        return f'the printer "{PRINTER}" was not found'
    status, offline = out.split("|", 1)
    if offline == "True":
        return 'the printer is set to "Use printer offline" in Windows'
    if not re.fullmatch(r"(?i)normal|printing|idle|processing|warmup", status):
        return f'the printer reports "{status}"'
    return ""


def do_print(job):
    o = job["options"]
    settings = sumatra_settings(o, job["is_image"])
    cmd = [SUMATRA, "-print-to", PRINTER, "-print-settings", settings, "-silent", job["path"]]
    with print_lock:
        log(f'Print started: "{job["filename"]}" (settings: {settings})')
        if DRY_RUN:
            log(f"DRY RUN - not printing: {cmd}")
            return
        subprocess.run(cmd, timeout=600, check=True)


def remove_file(job):
    try:
        os.remove(job["path"])
    except OSError:
        pass


def cleanup():
    """Delete uploads nobody printed within JOB_EXPIRY_MINUTES."""
    while True:
        time.sleep(60)
        now = time.time()
        with jobs_lock:
            for token, job in list(jobs.items()):
                if now - job["created"] > JOB_EXPIRY_MINUTES * 60:
                    if job["status"] in ("new", "confirm"):
                        log(f'Upload expired without printing: "{job["filename"]}"')
                    remove_file(job)
                    del jobs[token]


# ---------- Pages ----------
CSS = """
:root{--bg:#f4f5f7;--card:#fff;--text:#1f2328;--muted:#5f6670;--line:#d8dce1;--accent:#1a73e8;--accent-text:#fff;
--ok:#e6f4ea;--ok-line:#9ccfa8;--err:#fce8e6;--err-line:#eba59d;--soft:#eef3fd}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--card:#1f2226;--text:#e8eaed;--muted:#a3a9b1;--line:#363b42;
--accent:#6ea8fe;--accent-text:#0b1220;--ok:#1d3326;--ok-line:#3f7a52;--err:#3a1f1d;--err-line:#8a4038;--soft:#1c2533}}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:16px;
background:var(--bg);color:var(--text);line-height:1.4}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
h1{font-size:21px;margin:0 0 4px} h2{font-size:17px;margin:0 0 10px}
small,.muted{color:var(--muted)}
label.f{display:block;margin:14px 0 6px;font-weight:600}
input[type=file],input[type=password],input[type=number],input[type=text]{width:100%;padding:11px;font-size:16px;
border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text)}
.opts{display:flex;flex-wrap:wrap;gap:8px}
.opts label{flex:1 1 130px;display:flex;gap:8px;align-items:center;padding:10px 12px;border:1px solid var(--line);
border-radius:8px;cursor:pointer;min-height:44px}
.opts input{accent-color:var(--accent)}
.btn{display:block;width:100%;margin-top:14px;padding:14px;font-size:17px;border:0;border-radius:8px;
background:var(--accent);color:var(--accent-text);cursor:pointer;text-align:center;text-decoration:none}
.btn.secondary{background:var(--soft);color:var(--text);border:1px solid var(--line)}
.row{display:flex;gap:10px} .row>*{flex:1}
.msg{padding:12px;border-radius:8px;margin-bottom:12px;border:1px solid}
.ok{background:var(--ok);border-color:var(--ok-line)} .err{background:var(--err);border-color:var(--err-line)}
table{width:100%;border-collapse:collapse} td{padding:7px 4px;border-top:1px solid var(--line);vertical-align:top}
td:first-child{color:var(--muted);width:42%}
"""


def page(body, title="Remote Print"):
    return (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" '
            f'content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title>'
            f"<style>{CSS}</style></head><body>{body}</body></html>")


def msg_box(text, ok=True):
    return f'<div class="msg {"ok" if ok else "err"}">{html.escape(text)}</div>' if text else ""


def upload_page(message="", ok=True):
    return page(f"""
<div class="card"><h1>🖨️ Remote Print</h1><small>Private: only you see your file. Paper: {PAPER}.</small></div>
<div class="card">{msg_box(message, ok)}
<form method="post" action="/upload" enctype="multipart/form-data">
<label class="f">PDF or photo (JPG/PNG)</label><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" required>
<label class="f">PIN</label><input type="password" name="pin" inputmode="numeric" autocomplete="off" required>
<button class="btn" type="submit">Upload</button></form></div>""")


def file_line(job):
    pages = "1 photo" if job["is_image"] else (
        f'{job["pages"]} page{"s" if job["pages"] != 1 else ""}' if job["pages"] else "pages unknown")
    return f'📄 <b>{html.escape(job["filename"])}</b> <span class="muted">({pages})</span>'


def radio(name, value, label, current):
    checked = " checked" if current == value else ""
    return f'<label><input type="radio" name="{name}" value="{value}"{checked}> {label}</label>'


def choose_page(token, job, message=""):
    o = job.get("options") or {}
    pages_custom = o.get("pages") if o.get("pages") not in (None, "all") else ""
    copies = o.get("copies", 1)
    return page(f"""
<div class="card">{file_line(job)}</div>
<div class="card"><h2>How do you want to print?</h2>
<form method="post" action="/job/{token}/direct"><button class="btn" type="submit">⚡ Direct Print</button>
<small>1 copy · Color · Single Side · All pages · {PAPER}</small></form></div>
<div class="card"><h2>⚙️ Or choose options</h2>{msg_box(message, False)}
<form method="post" action="/job/{token}/options">
<label class="f">🖨️ Copies</label>
<div class="opts">{radio("copies_pick", "1", "1", str(copies))}{radio("copies_pick", "2", "2", str(copies))}{radio("copies_pick", "3", "3", str(copies))}
{radio("copies_pick", "custom", "Custom", "custom" if copies > 3 else "")}</div>
<input type="number" name="copies_custom" min="1" max="{MAX_COPIES}" placeholder="Custom number of copies"
 value="{copies if copies > 3 else ''}" style="margin-top:8px">
<label class="f">🎨 Color</label>
<div class="opts">{radio("color", "mono", html.escape(LABELS["color"]["mono"]), o.get("color", "color"))}{radio("color", "color", LABELS["color"]["color"], o.get("color", "color"))}</div>
<label class="f">🔄 Sides</label>
<div class="opts">{radio("sides", "single", LABELS["sides"]["single"], o.get("sides", "single"))}{radio("sides", "duplex", LABELS["sides"]["duplex"], o.get("sides", "single"))}</div>
<label class="f">📑 Pages</label>
<div class="opts">{radio("pages_pick", "all", "📄 All Pages", "custom" if pages_custom else "all")}{radio("pages_pick", "custom", "🔢 Specific / Range", "custom" if pages_custom else "all")}</div>
<input type="text" name="pages_custom" placeholder="e.g. 1-5 or 1,3,5 or 1-3,7,10-12" value="{html.escape(pages_custom)}"
 style="margin-top:8px"{' disabled' if job["is_image"] else ''}>
<label class="f">↕️ Orientation</label>
<div class="opts">{radio("orientation", "portrait", LABELS["orientation"]["portrait"], o.get("orientation", "auto"))}{radio("orientation", "landscape", LABELS["orientation"]["landscape"], o.get("orientation", "auto"))}{radio("orientation", "auto", LABELS["orientation"]["auto"], o.get("orientation", "auto"))}</div>
<button class="btn" type="submit">Continue</button></form>
<form method="post" action="/job/{token}/cancel"><button class="btn secondary" type="submit">❌ Cancel</button></form></div>""")


def confirm_page(token, job, message=""):
    o = job["options"]
    orient = LABELS["orientation"][o["orientation"]]
    if o["orientation"] == "auto" and job.get("orient"):
        d = job["orient"]
        orient += f' <span class="muted">({d["portrait"]} portrait, {d["landscape"]} landscape)</span>'
    pages = "All" + (f' (1-{job["pages"]})' if job["pages"] else "") if o["pages"] == "all" else html.escape(o["pages"])
    return page(f"""
<div class="card"><h2>🖨️ Print confirmation</h2>{msg_box(message, False)}
<table>
<tr><td>📄 File</td><td>{html.escape(job["filename"])}</td></tr>
<tr><td>📑 Total pages</td><td>{job["pages"] or ("1" if job["is_image"] else "unknown")}</td></tr>
<tr><td>🖨️ Copies</td><td>{o["copies"]}</td></tr>
<tr><td>🎨 Color</td><td>{html.escape(LABELS["color"][o["color"]])}</td></tr>
<tr><td>🔄 Sides</td><td>{html.escape(LABELS["sides"][o["sides"]])}</td></tr>
<tr><td>📑 Pages</td><td>{pages}</td></tr>
<tr><td>📐 Paper size</td><td>{PAPER}</td></tr>
<tr><td>↕️ Orientation</td><td>{orient}</td></tr>
</table>
<form method="post" action="/job/{token}/print"><button class="btn" type="submit">✅ PRINT</button></form>
<div class="row">
<a class="btn secondary" href="/job/{token}?change=1">🔄 Change options</a>
<form method="post" action="/job/{token}/cancel"><button class="btn secondary" type="submit">❌ Cancel</button></form>
</div></div>""")


def done_page(text, ok=True):
    return page(f'<div class="card">{msg_box(text, ok)}<a class="btn" href="/">Print another file</a></div>')


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep the log for print events only
        pass

    def send_page(self, body, code=200):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, where):
        self.send_response(303)
        self.send_header("Location", where)
        self.end_headers()

    def job_from_path(self):
        m = re.fullmatch(r"/job/([A-Za-z0-9_\-]{20,})(/\w+)?", self.path.split("?")[0])
        if not m:
            return None, None, None
        with jobs_lock:
            job = jobs.get(m.group(1))
        return m.group(1), job, (m.group(2) or "").lstrip("/")

    def do_GET(self):
        if self.path.split("?")[0] == "/":
            return self.send_page(upload_page())
        token, job, _ = self.job_from_path()
        if not job:
            return self.send_page(done_page("This print link has expired or does not exist.", ok=False), 404)
        if job["status"] == "confirm" and "change=1" not in self.path:
            return self.send_page(confirm_page(token, job))
        if job["status"] in ("new", "confirm"):
            return self.send_page(choose_page(token, job))
        return self.send_page(done_page(job.get("result", "This request is finished."), job["status"] == "printed"))

    def read_form(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_MB * 1024 * 1024 + 100_000:
            return None
        return self.rfile.read(length)

    def do_POST(self):
        if self.path == "/upload":
            return self.upload()
        token, job, action = self.job_from_path()
        raw = self.read_form() or b""
        if not job:
            return self.send_page(done_page("This print link has expired or does not exist.", ok=False), 404)
        form = {k: v[0] for k, v in parse_qs(raw.decode("utf-8", "replace")).items()}
        with jobs_lock:
            if job["status"] not in ("new", "confirm"):
                # Already printed / cancelled: never print twice (e.g. double tap or browser refresh)
                return self.redirect(f"/job/{token}")
            if action == "cancel":
                job["status"] = "cancelled"
                job["result"] = "❌ Print cancelled. Nothing was printed."
                remove_file(job)
                log(f'Print cancelled: "{job["filename"]}"')
                return self.redirect(f"/job/{token}")
            if action == "options":
                err = self.apply_options(job, form)
                if err:
                    return self.send_page(choose_page(token, job, err), 400)
                job["status"] = "confirm"
                o = job["options"]
                log(f'Options for "{job["filename"]}": copies {o["copies"]}, {o["color"]}, {o["sides"]}, '
                    f'pages {o["pages"]}, paper {PAPER}, orientation {o["orientation"]}')
                return self.redirect(f"/job/{token}")
            if action == "direct":
                job["options"] = dict(DIRECT)
                log(f'Direct Print chosen for "{job["filename"]}"')
            elif action == "print":
                if job["status"] != "confirm":
                    return self.redirect(f"/job/{token}")
            else:
                return self.redirect(f"/job/{token}")
            job["status"] = "printing"  # claim it so a second tap can't start another print

        problem = printer_problem()
        if problem:
            log(f'Print not started for "{job["filename"]}": {problem}')
            with jobs_lock:
                job["status"] = "confirm"
            return self.send_page(confirm_page(token, job, f"Can't print right now: {problem}. Check the printer "
                                                           "and press PRINT again - your file is kept."), 503)
        try:
            do_print(job)
        except Exception as e:  # noqa: BLE001
            log(f'Print failed: "{job["filename"]}": {e}')
            with jobs_lock:
                job["status"] = "confirm"
            return self.send_page(confirm_page(token, job, f"Print failed: {e}. Press PRINT to try again."), 500)
        o = job["options"]
        with jobs_lock:
            job["status"] = "printed"
            job["result"] = (f'✅ Sent to the printer: {job["filename"]} — {o["copies"]} '
                             f'cop{"y" if o["copies"] == 1 else "ies"}, {LABELS["color"][o["color"]][2:]}, '
                             f'{LABELS["sides"][o["sides"]][2:]}, pages {o["pages"]}, {PAPER}.')
            remove_file(job)  # privacy: the file is not kept after printing
        log(f'Print completed: "{job["filename"]}"')
        return self.redirect(f"/job/{token}")

    def apply_options(self, job, f):
        o = {}
        if f.get("copies_pick") == "custom":
            c = f.get("copies_custom", "").strip()
        else:
            c = f.get("copies_pick", "1")
        if not c.isdigit() or not 1 <= int(c) <= MAX_COPIES:
            return f"Copies must be a whole number from 1 to {MAX_COPIES}."
        o["copies"] = int(c)
        o["color"] = f.get("color") if f.get("color") in ("mono", "color") else None
        o["sides"] = f.get("sides") if f.get("sides") in ("single", "duplex") else None
        o["orientation"] = f.get("orientation") if f.get("orientation") in ("portrait", "landscape", "auto") else None
        if None in (o["color"], o["sides"], o["orientation"]):
            return "Please choose color, sides and orientation."
        if f.get("pages_pick") == "custom" and not job["is_image"]:
            pages, err = parse_pages(f.get("pages_custom", ""), job["pages"])
            if err:
                return err
            o["pages"] = pages
        else:
            o["pages"] = "all"
        job["options"] = o
        return None

    def visitor(self):
        # Behind the Cloudflare tunnel every request comes from this PC; Cloudflare passes the real address
        ip = self.client_address[0]
        if ip in ("127.0.0.1", "::1") and self.headers.get("CF-Connecting-IP"):
            return self.headers["CF-Connecting-IP"].strip()
        return ip

    def upload(self):
        who = self.visitor()
        locked = locked_message(who)
        if locked:
            self.read_form()
            log(f"Upload refused (locked out): {who}")
            return self.send_page(upload_page(locked, ok=False), 429)
        raw = self.read_form()
        if raw is None:
            return self.send_page(upload_page(f"File too big (max {MAX_MB} MB).", ok=False), 413)
        parsed = BytesParser(policy=email_policy).parsebytes(
            f"Content-Type: {self.headers.get('Content-Type', '')}\r\n\r\n".encode() + raw)
        fields, upload = {}, None
        for part in parsed.iter_parts():
            if part.get_filename():
                upload = (os.path.basename(part.get_filename()), part.get_payload(decode=True))
            elif part.get_param("name", header="content-disposition"):
                fields[part.get_param("name", header="content-disposition")] = \
                    part.get_payload(decode=True).decode(errors="ignore").strip()
        if not secrets.compare_digest(fields.get("pin", ""), PIN):
            time.sleep(1)  # slow down PIN guessing
            record_fail(who)
            log(f"Upload refused: wrong PIN from {who}")
            return self.send_page(upload_page("Wrong PIN.", ok=False), 403)
        if not upload or not upload[1]:
            return self.send_page(upload_page("Please choose a file.", ok=False), 400)
        filename, data = upload
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_EXT:
            return self.send_page(upload_page("Only PDF, JPG and PNG files can be printed.", ok=False), 400)
        token = secrets.token_urlsafe(24)
        path = os.path.join(UPLOAD_DIR, f"{token}{ext}")
        with open(path, "wb") as fh:
            fh.write(data)
        pages, orient = (1, None) if ext in IMAGE_EXT else (0, None)
        if ext == ".pdf":
            try:
                pages, orient = pdf_info(data)
            except Exception as e:  # noqa: BLE001
                log(f'Could not read page count of "{filename}": {e}')
        with jobs_lock:
            jobs[token] = {"filename": filename, "path": path, "pages": pages, "orient": orient,
                           "is_image": ext in IMAGE_EXT, "status": "new", "options": None, "created": time.time()}
        log(f'Uploaded: "{filename}" ({pages or "?"} pages) from {who}')
        return self.redirect(f"/job/{token}")


if __name__ == "__main__":
    # Files left from a previous run are deleted (their links no longer work)
    for f in os.listdir(UPLOAD_DIR):
        try:
            os.remove(os.path.join(UPLOAD_DIR, f))
        except OSError:
            pass
    threading.Thread(target=cleanup, daemon=True).start()
    log(f"Remote Print running on port {PORT}{' (DRY RUN - nothing will print)' if DRY_RUN else ''}. "
        f"Printer: {PRINTER}, paper {PAPER}.")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
