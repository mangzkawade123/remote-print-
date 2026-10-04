"""End-to-end test of the print page in DRY RUN mode (nothing is printed).
Starts its own copy on port 8091, uploads PDFs and walks through every path:  python test_print_server.py
"""
import glob
import http.cookiejar
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "http://127.0.0.1:8091"
PIN = None  # read from pin.txt once the server has started (it creates the file on first run)
LOG = os.path.join(HERE, "print_server.log")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def req(method, path, data=None, headers=None):
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {})
    try:
        resp = opener.open(r, timeout=30)
        return resp.status, resp.headers, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")


def upload(path, pin=None):
    pin = pin or PIN
    b ="----test" + str(time.time()).replace(".", "")
    with open(path, "rb") as fh:
        content = fh.read()
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"pin\"\r\n\r\n{pin}\r\n"
            f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{os.path.basename(path)}\"\r\n"
            f"Content-Type: application/pdf\r\n\r\n").encode() + content + f"\r\n--{b}--\r\n".encode()
    return req("POST", "/upload", body, {"Content-Type": f"multipart/form-data; boundary={b}"})


def form(path, fields):
    data = "&".join(f"{k}={urllib.request.quote(str(v))}" for k, v in fields.items()).encode()
    return req("POST", path, data, {"Content-Type": "application/x-www-form-urlencoded"})


passed = failed = 0


def check(name, cond, info=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {info}")


log_start = os.path.getsize(LOG) if os.path.exists(LOG) else 0
env = dict(os.environ, REMOTE_PRINT_DRY_RUN="1", REMOTE_PRINT_PORT="8091")
server = subprocess.Popen([sys.executable, os.path.join(HERE, "print_server.py")], env=env,
                          stdout=open(LOG, "a"), stderr=subprocess.STDOUT)
try:
    for _ in range(50):
        try:
            req("GET", "/")
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.2)
    with open(os.path.join(HERE, "pin.txt")) as _fh:
        PIN = _fh.read().strip()

    pdfs = {os.path.basename(p).split("_", 1)[1]: p for p in glob.glob(os.path.join(HERE, "whatsapp", "jobs", "*.pdf"))}
    five = pdfs["20-minute Artificial Intelligence speaking script.pdf"]  # 5 pages

    print("\nUpload")
    s, _, body = req("GET", "/")
    check("upload page loads", s == 200 and "Remote Print" in body)
    check("no list of other people's jobs on the page", "Recent jobs" not in body)
    s, _, body = upload(five, pin="0000")
    check("wrong PIN refused", s == 403 and "Wrong PIN" in body)
    s, h, _ = upload(five)
    link = h.get("Location", "")
    check("PDF upload -> private link", s == 303 and re.fullmatch(r"/job/[\w\-]{20,}", link), link)
    s, _, body = req("GET", link)
    check("page count detected (5 pages)", "5 pages" in body)
    check("Direct Print and options offered", "Direct Print" in body and "Choose options" in body.replace("⚙️ Or choose options", "Choose options"))
    s, _, body = req("GET", "/job/" + "x" * 32)
    check("unknown link refused", s == 404)

    print("\nDirect Print")
    s, h, _ = form(link + "/direct", {})
    s, _, body = req("GET", link)
    check("direct print done", "Sent to the printer" in body, body[-300:])
    s, h, _ = form(link + "/direct", {})
    s2, _, body = req("GET", link)
    check("second tap does not print again", body.count("Sent to the printer") == 1)

    print("\nOptions -> confirm -> print (copies, B&W, duplex, pages, landscape)")
    _, h, _ = upload(five)
    link = h["Location"]
    s, _, body = form(link + "/options", {"copies_pick": "2", "color": "mono", "sides": "duplex",
                                          "pages_pick": "custom", "pages_custom": "1,3-4", "orientation": "landscape"})
    check("options accepted", s == 303)
    s, _, body = req("GET", link)
    for part in ["Print confirmation", "<td>2</td>", "Black &amp; White", "Both Side", "1,3-4", "A4", "Landscape"]:
        check(f"summary shows {part}", part in body)
    s, _, body = req("GET", link + "?change=1")
    check("change options shows the form prefilled", 'value="1,3-4"' in body)
    form(link + "/print", {})
    _, _, body = req("GET", link)
    check("printed after PRINT", "Sent to the printer" in body)

    print("\nValidation")
    _, h, _ = upload(five)
    link = h["Location"]
    base = {"copies_pick": "1", "color": "color", "sides": "single", "orientation": "auto", "pages_pick": "custom"}
    s, _, body = form(link + "/options", dict(base, pages_custom="1-9"))
    check("page beyond PDF refused", s == 400 and "only 5 pages" in body)
    s, _, body = form(link + "/options", dict(base, pages_custom="abc"))
    check("invalid pages refused", s == 400)
    s, _, body = form(link + "/options", dict(base, pages_pick="all", copies_pick="custom", copies_custom="0"))
    check("0 copies refused", s == 400)
    s, _, body = form(link + "/options", dict(base, pages_pick="all", copies_pick="custom", copies_custom="7"))
    check("custom 7 copies accepted", s == 303)
    form(link + "/print", {})

    print("\nCancel")
    _, h, _ = upload(five)
    link = h["Location"]
    form(link + "/cancel", {})
    _, _, body = req("GET", link)
    check("cancelled, nothing printed", "cancelled" in body.lower())
    form(link + "/direct", {})
    _, _, body = req("GET", link)
    check("cancelled request can't be printed afterwards", "Sent to the printer" not in body)

    print("\nWrong-PIN lockout (behind the tunnel: real visitor address from CF-Connecting-IP)")

    def upload_as(ip, pin):
        b = "----lock"
        body = (f"--{b}\r\nContent-Disposition: form-data; name=\"pin\"\r\n\r\n{pin}\r\n"
                f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.pdf\"\r\n"
                f"Content-Type: application/pdf\r\n\r\n%PDF-1.4\r\n--{b}--\r\n").encode()
        return req("POST", "/upload", body, {"Content-Type": f"multipart/form-data; boundary={b}",
                                             "CF-Connecting-IP": ip})
    codes = [upload_as("203.0.113.9", "11111111")[0] for _ in range(5)]
    check("5 wrong PINs refused", codes == [403] * 5, codes)
    check("6th attempt locked out even with the right PIN", upload_as("203.0.113.9", PIN)[0] == 429)
    s, h, _ = upload_as("198.51.100.7", PIN)
    check("a different visitor is not affected", s == 303)
    form(h["Location"] + "/cancel", {})

    print("\nPrivacy")
    # every upload above was printed or cancelled, so no file may be left on the PC
    check("uploaded files are deleted after print/cancel", len(os.listdir(os.path.join(HERE, "uploads"))) == 0,
          os.listdir(os.path.join(HERE, "uploads")))
finally:
    server.terminate()
    server.wait()

with open(LOG, encoding="utf-8", errors="replace") as fh:
    fh.seek(log_start)
    new_log = fh.read()
print("\nPrint commands that would have run (dry run):")
for line in new_log.splitlines():
    if "Print started" in line or "Direct Print chosen" in line:
        print("  " + line.split("] ", 1)[-1])
dry = new_log.count("DRY RUN - not printing")
check("exactly 3 prints would have run (direct, options, 7 copies)", dry == 3, f"got {dry}")
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
