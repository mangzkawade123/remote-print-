"""Public link for the print page, using a Cloudflare quick tunnel (no account needed).
The link changes every time the tunnel starts; the current one is written to "Print link.txt" on the Desktop.
Starts hidden with Windows via the Startup shortcut. If cloudflared stops, it is started again.
"""
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(HERE, "tunnel.log")
if sys.stdout is None or sys.stderr is None:
    sys.stdout = sys.stderr = open(LOG_FILE, "a", buffering=1, encoding="utf-8")

CLOUDFLARED = os.path.join(HERE, "cloudflared.exe")
LOCAL_URL = "http://localhost:8080"
LINK_FILE = os.path.join(os.path.expanduser("~"), "Desktop", "Print link.txt")
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def log(text):
    print(f"[{time.strftime('%d/%m/%Y %H:%M:%S')}] {text}", flush=True)


def write_link(url):
    with open(LINK_FILE, "w", encoding="utf-8") as fh:
        fh.write(f"Print page link (works on any Wi-Fi or mobile data):\n{url}\n\n"
                 f"PIN: see pin.txt in the Remote Print folder.\n"
                 f"This link changes when the PC restarts - share the new one from this file.\n"
                 f"Updated: {time.strftime('%d/%m/%Y %H:%M')}\n")


while True:
    log("Starting Cloudflare tunnel...")
    proc = subprocess.Popen(
        [CLOUDFLARED, "tunnel", "--no-autoupdate", "--url", LOCAL_URL],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    found = False
    for line in proc.stdout:
        if not found:
            m = URL_RE.search(line)
            if m:
                found = True
                write_link(m.group(0))
                log(f"Public link: {m.group(0)}")
        if re.search(r"\b(ERR|error)\b", line):
            log("cloudflared: " + line.strip()[:300])
    proc.wait()
    log(f"Tunnel stopped (exit code {proc.returncode}) - restarting in 15 seconds")
    time.sleep(15)
