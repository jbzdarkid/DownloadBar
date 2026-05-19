"""
Classic-shelf behavior capture runner.

Drives the bundled Chrome for Testing 113.0.5672.63 build through a
fixed sequence of download scenarios while you screen-record. Prints
labeled timestamps to stdout so you can slice the recording afterward.

CfT (release-channel binary, signed, full shell integration) is the
correct reference for capturing classic-shelf behavior. Bare Chromium
snapshot builds stub out parts of the Win32 download pipeline that the
shelf relies on (Safe Browsing verdicts, 'Always open files of this
type' auto-fire, signed-binary checks), so do not substitute one
without knowing why.

What this script does:
  - launches Chromium with a clean profile and DownloadBubble disabled, so
    the classic shelf is forced on
  - triggers downloads on a clock by navigating to test URLs
  - uses CDP to go offline / throttle / cancel where useful
  - PAUSES at points that require you to manipulate the native shelf
    (clicking the caret, opening a menu, toggling Always-open, etc.)
    because Selenium cannot reach native browser chrome

Run:
  python tests/run_shelf_tests.py

When the script prompts ">>> press ENTER when ready", do the manual step
described, then hit Enter to advance.

Quit early with Ctrl+C; the temp profile and driver clean up on exit.
"""

from __future__ import annotations

import http.server
import json
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service


# ---- config ---------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
CHROME_BIN = REPO_ROOT / "reference" / "chrome-win64" / "chrome.exe"
# Pinned chromedriver matching CHROME_BIN. Required because Selenium
# Manager fetches the *latest* chromedriver by default, which refuses to
# attach to chrome 113 ("only supports Chrome version N"). CfT 113 did
# not publish its own chromedriver, so this binary comes from the legacy
# chromedriver.storage.googleapis.com/113.0.5672.63/ channel.
CHROMEDRIVER_BIN = REPO_ROOT / "reference" / "chrome-win64" / "chromedriver.exe"

# All test fixtures are served from an in-process HTTP server (see
# LocalServer below). Every response sets Content-Disposition: attachment so
# clicking a link always triggers a download instead of navigating, regardless
# of cross-origin rules. URLs are filled in at runtime by main().
URL_SMALL = ""    # tiny text file
URL_MEDIUM = ""   # ~10 MB binary
URL_LARGE = ""    # ~100 MB binary
URL_PDF = ""      # real minimal PDF, served as application/pdf
URL_EXE = ""      # bogus .exe to trigger the dangerous-file Keep/Discard UI
URL_LONGNAME = "" # small body, served with a deliberately huge filename
URL_INDET = ""    # streamed with no Content-Length -> totalBytes<=0 = indeterminate
URL_SLOWTXT = ""  # ~280 KiB .txt fixture for B4 (slow Always-open probe)
URL_BAD = "http://127.0.0.1:1/nope.zip"  # connection refused = clean failure


# ---- timestamped logging --------------------------------------------------

_T0 = time.monotonic()


# ---- local fixture server -------------------------------------------------

def make_minimal_pdf() -> bytes:
    """Generate a tiny valid PDF (~250 bytes) with correct xref offsets.

    Single-page, no fonts, no content streams. Enough for Chrome to recognize
    application/pdf and offer "Always open files of this type".
    """
    header = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    body_parts = [
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n",
    ]
    out = bytearray(header)
    offsets = []
    for part in body_parts:
        offsets.append(len(out))
        out += part
    xref_pos = len(out)
    out += b"xref\n"
    out += f"0 {len(body_parts) + 1}\n".encode()
    # Each xref entry must be exactly 20 bytes including its trailing newline.
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += b"trailer<</Size " + str(len(body_parts) + 1).encode() + b"/Root 1 0 R>>\n"
    out += b"startxref\n"
    out += str(xref_pos).encode() + b"\n"
    out += b"%%EOF\n"
    return bytes(out)


# Pre-generate fixture bodies once so the handler can stream them cheaply.
# Sizes are chosen so that CDP throttling (256 kbps in A2, 1024 kbps in C1/C3)
# can complete each file within the scenario's wait window, avoiding stalled
# in-flight downloads that bleed into later scenarios. medium.bin used to be
# 10 MiB but stalled C1 (4 in flight) + C3 (10 in flight) past unthrottle.
_SMALL_BODY = b"DownloadBar test fixture. Hello!\n" * 4         # ~130 B
_MEDIUM_BODY = b"\x00" * (1 * 1024 * 1024)                      # 1 MiB
_LARGE_BODY = b"\x00" * (20 * 1024 * 1024)                      # 20 MiB
# Plain-text body sized so CDP throttle at 256 kbps yields a multi-second
# download. Used by scenario B4 to probe whether 'Always open files of this
# type' bypasses the shelf even when the download isn't near-instant.
_SLOWTXT_BODY = b"DownloadBar slow .txt fixture line.\n" * 8000  # ~280 KiB
_PDF_BODY = make_minimal_pdf()
# Tiny stub for dangerous-extension UI test. Chromium classifies any .exe
# from a non-allowlisted origin as DANGEROUS_FILE based purely on the
# extension; payload contents don't matter.
_EXE_BODY = b"MZ" + b"\x00" * 510                               # 512 B fake PE
_LONG_FILENAME = (
    "this-is-an-intentionally-very-very-long-filename-for-testing-"
    "download-shelf-chip-truncation-behavior-please-keep-going.txt"
)  # 122 chars


class _Handler(http.server.BaseHTTPRequestHandler):
    """Serves fixed test fixtures with Content-Disposition: attachment.

    Forcing attachment disposition is the key trick: it makes Chrome download
    the response regardless of cross-origin / a-download-attribute rules, so
    a simple `window.location = url` from the parked page reliably starts a
    download instead of navigating away.
    """

    # Quiet the default per-request logging; the runner prints its own marks.
    def log_message(self, fmt, *args):  # noqa: N802 (stdlib signature)
        return

    def do_GET(self):  # noqa: N802 (stdlib signature)
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        # Tiny landing page. The runner parks the tab here (rather than on
        # about:blank) before firing triggers, because Chromium's default
        # 'automatic_downloads' content setting only applies to real http(s)
        # origins -- opaque origins like about:blank are skipped, which
        # makes the "site attempted to download multiple files" prompt fire
        # on A1+A2 / C1 / C3 regardless of the pref. Serving this from
        # http://files.test:<port>/ gives us a stable, real origin.
        if path in ("/", "/index.html"):
            body = b"<!doctype html><meta charset=utf-8><title>fixtures</title>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        # Indeterminate-size fixture: omit Content-Length so Chromium can't
        # compute totalBytes. With our default HTTP/1.0 protocol_version,
        # leaving Content-Length out signals end-of-body via connection
        # close, which Chrome honors. download_item_view.cc then treats
        # percent_done as -1 and PaintDownloadProgress draws the spinning
        # 50-degree arc at 80 deg/sec (4.5 s per revolution). Throttled
        # internally so the stream stays live long enough to observe a
        # few full revolutions on camera; CDP throttling won't help here
        # because we want the *server* to remain the bottleneck.
        if path == "/indeterminate.bin":
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header(
                "Content-Disposition",
                'attachment; filename="indeterminate.bin"',
            )
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            chunk = b"\x00" * 4096
            # ~20 s of stream at this rate: 5 chunks/sec * 4 KiB = 20 KiB/s,
            # 400 KiB total. Plenty for ~4 revolutions of the spinner.
            for _ in range(100):
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                time.sleep(0.2)
            return

        fixtures = {
            "/small.txt": (_SMALL_BODY, "text/plain", "small.txt"),
            "/slow.txt": (_SLOWTXT_BODY, "text/plain", "slow.txt"),
            "/medium.bin": (_MEDIUM_BODY, "application/octet-stream", "medium.bin"),
            "/large.bin": (_LARGE_BODY, "application/octet-stream", "large.bin"),
            "/dummy.pdf": (_PDF_BODY, "application/pdf", "dummy.pdf"),
            "/evil.exe": (_EXE_BODY, "application/octet-stream", "evil.exe"),
            "/long": (_SMALL_BODY, "text/plain", _LONG_FILENAME),
        }
        if path not in fixtures:
            self.send_error(404, "Not Found")
            return

        body, ctype, filename = fixtures[path]
        # Optional ?bps= server-side throttle. CDP throttling already works
        # well; this is a fallback knob if you ever need it.
        bps = int(params.get("bps", [0])[0] or 0)

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        # Defeat caching so re-running scenarios always re-downloads.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        if bps <= 0:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        # Throttled streaming: write 64 KiB at a time, sleep between chunks.
        chunk = 64 * 1024
        sleep_per_chunk = chunk / bps
        for i in range(0, len(body), chunk):
            try:
                self.wfile.write(body[i:i + chunk])
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
            time.sleep(sleep_per_chunk)


class _ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


@contextmanager
def local_server():
    # Bind to port 0 to let the OS pick a free port.
    server = _ThreadedServer(("127.0.0.1", 0), _Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        server.shutdown()
        server.server_close()


# ---- timestamped logging (cont'd) -----------------------------------------


_T0 = time.monotonic()
LOG_FILE = REPO_ROOT / "tests" / "run.log"
_LOG_FH = None  # opened by main()


def _write_log_line(kind: str, label: str, msg: str) -> None:
    """Append one TSV line: iso \\t T_offset \\t kind \\t label \\t msg."""
    if _LOG_FH is None:
        return
    iso = datetime.now().isoformat(timespec="milliseconds")
    elapsed = time.monotonic() - _T0
    _LOG_FH.write(f"{iso}\t{elapsed:.3f}\t{kind}\t{label}\t{msg}\n")
    _LOG_FH.flush()


def log(label: str, msg: str = "") -> None:
    elapsed = time.monotonic() - _T0
    wall = datetime.now().strftime("%H:%M:%S")
    tag = f"[{label}]" if label else ""
    print(f"T+{elapsed:6.1f}  {wall}  {tag:8s} {msg}", flush=True)
    _write_log_line("log", label, msg)


def wait(seconds: float, note: str = "") -> None:
    if note:
        log("", f"...waiting {seconds:.1f}s ({note})")
    else:
        log("", f"...waiting {seconds:.1f}s")
    time.sleep(seconds)


def manual(prompt: str) -> None:
    print()
    print(f"  >>> MANUAL STEP: {prompt}")
    print(f"  >>> press ENTER when done...", end="", flush=True)
    _write_log_line("manual_prompt", "", prompt)
    try:
        input()
    except KeyboardInterrupt:
        raise
    _write_log_line("manual_resume", "", "")
    log("", "...resumed")


def mark(label: str, msg: str = "") -> None:
    """Emit a tagged 'mark' event -- the kind that extract.py can jump to.

    Use this at the precise moment of an observable action (e.g. exactly
    when a download is triggered), so the post-process tooling can find
    the right video frame.
    """
    elapsed = time.monotonic() - _T0
    wall = datetime.now().strftime("%H:%M:%S")
    print(f"T+{elapsed:6.1f}  {wall}  [{label}]  >> MARK: {msg}", flush=True)
    _write_log_line("mark", label, msg)


# ---- driver setup ---------------------------------------------------------

# Chrome args that drive UI / shelf behavior. Kept here (not buried in
# make_driver) so the self-launch and connect paths use the exact same set.
def _chrome_args(profile_dir: Path) -> list[str]:
    return [
        f"--user-data-dir={profile_dir}",
        # Force the classic shelf.
        "--disable-features=DownloadBubble,DownloadBubbleV2",
        # Cosmetic: avoid first-run popups stealing the recording.
        "--no-first-run",
        "--no-default-browser-check",
        # Keep the window predictable for cropping.
        "--window-size=1280,800",
        "--window-position=80,80",
        # Resolve a fake non-loopback hostname to our local fixture server.
        # Chromium's 'Always open files of this type' auto-open path skips
        # the 127.0.0.1/localhost origin (Safe Browsing won't vouch for
        # it), so we serve fixtures over http://files.test instead. The
        # reserved .test TLD will never collide with a real domain.
        "--host-resolver-rules=MAP files.test 127.0.0.1",
        # Start on about:blank; the runner immediately navigates to the
        # fixture server's index (a real http origin) so Chromium's
        # default automatic_downloads content setting actually applies.
        "about:blank",
    ]


def _write_profile_prefs(profile_dir: Path, download_dir: Path) -> None:
    """Pre-seed the profile's Preferences JSON.

    When Selenium spawns chrome via chromedriver, opts.add_experimental_option('prefs',...)
    is materialized into this file. We're launching chrome ourselves (see
    _launch_chrome_silent below), so chromedriver no longer does it -- we
    write the same file directly. Keeps the runtime behavior identical
    to the old code path: silent downloads into our dir, automatic-
    downloads permission auto-granted, Safe Browsing off (see comment
    on the safebrowsing entry below for why off, not on).
    """
    default_dir = profile_dir / "Default"
    default_dir.mkdir(parents=True, exist_ok=True)
    prefs = {
        "download": {
            "default_directory": str(download_dir),
            "prompt_for_download": False,
            "directory_upgrade": True,
        },
        # Counterintuitively, Safe Browsing must be OFF for the E1
        # dangerous-file warning chip to appear. With SB on in a CfT
        # build that has no API key, the download-protection lookup
        # short-circuits to "safe" and .exe files just complete silently
        # with no warning UI. With SB off, Chromium falls back to local
        # extension-based classification, which marks .exe as
        # DANGEROUS_FILE and renders the inline Keep / Discard chip we
        # want to capture. For all other fixtures (.txt/.bin/.pdf) this
        # makes no observable difference.
        "safebrowsing": {"enabled": False},
        "profile": {
            "default_content_setting_values": {
                # 1 = ALLOW, 2 = BLOCK, 3 = ASK. Required so scenarios
                # firing multiple downloads from one tab (A1+A2, C1, C3)
                # are not silently suppressed by the multi-download guard.
                "automatic_downloads": 1,
            },
            # Skip the first-run welcome / sign-in flow.
            "exit_type": "Normal",
            "exited_cleanly": True,
        },
    }
    (default_dir / "Preferences").write_text(json.dumps(prefs), encoding="utf-8")


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_devtools(port: int, timeout: float = 20.0) -> None:
    """Poll the DevTools port until it accepts a TCP connection."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return
        except OSError:
            time.sleep(0.1)
    sys.exit(f"chrome did not open DevTools on port {port} within {timeout:.0f}s")


def _launch_chrome_silent(profile_dir: Path, download_dir: Path) -> tuple[subprocess.Popen, int]:
    """Spawn chrome.exe directly with no inherited console.

    We launch chrome ourselves (rather than letting chromedriver do it) so
    we can pass CREATE_NO_WINDOW | DETACHED_PROCESS and redirect stdio to
    DEVNULL. That suppresses the stray empty-titled chrome.exe console-
    host windows that otherwise pop up alongside the browser on Windows
    because chromedriver -- a console-subsystem binary -- passes its own
    console handles down to its chrome child by default. CfT 113's
    chrome.exe is GUI-subsystem, so once we cut the console linkage it
    has nothing extra to render.

    Returns (process, devtools_port). Selenium attaches to the port via
    Options.debugger_address.
    """
    _write_profile_prefs(profile_dir, download_dir)
    port = _pick_free_port()
    cmd = [str(CHROME_BIN), f"--remote-debugging-port={port}", *_chrome_args(profile_dir)]

    creationflags = 0
    if sys.platform == "win32":
        creationflags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
        close_fds=True,
    )
    _wait_for_devtools(port)
    return proc, port


def make_driver(download_dir: Path, profile_dir: Path) -> tuple[webdriver.Chrome, subprocess.Popen]:
    if not CHROME_BIN.exists():
        sys.exit(f"chrome binary not found at {CHROME_BIN}")
    if not CHROMEDRIVER_BIN.exists():
        sys.exit(f"chromedriver not found at {CHROMEDRIVER_BIN}")

    chrome_proc, port = _launch_chrome_silent(profile_dir, download_dir)

    opts = Options()
    # Attach to the already-running chrome instead of letting chromedriver
    # spawn a new one. Note: binary_location, args, and experimental
    # 'prefs' / 'excludeSwitches' are intentionally NOT set here -- they
    # only apply when chromedriver owns the launch. Equivalent settings
    # are baked into _chrome_args() and _write_profile_prefs() above.
    opts.debugger_address = f"127.0.0.1:{port}"
    # pageLoadStrategy='none' so execute_script returns immediately --
    # see trigger_download() for why this matters with same-tab navigations
    # that get canceled by Content-Disposition: attachment.
    opts.page_load_strategy = "none"

    # chromedriver itself is still console-subsystem; CREATE_NO_WINDOW
    # hides its console. We pin executable_path to the bundled 113.x
    # driver -- Selenium Manager's auto-fetch would pull the latest
    # chromedriver, which refuses to drive chrome 113.
    creation_flags = 0
    if sys.platform == "win32":
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    service = Service(executable_path=str(CHROMEDRIVER_BIN))
    service.creation_flags = creation_flags
    driver = webdriver.Chrome(service=service, options=opts)
    return driver, chrome_proc


# ---- helpers --------------------------------------------------------------

def trigger_download(driver: webdriver.Chrome, url: str) -> None:
    """Start a download from the current page.

    Our local server sets Content-Disposition: attachment on every fixture,
    so navigating to the URL turns into a download instead of an actual
    page load: Chromium cancels the navigation as soon as it sees the
    Content-Disposition header, the current tab stays at about:blank, and
    the shelf chip appears. Crucially we do NOT use target='_blank' --
    that would spawn a new tab per trigger (10 tabs in scenario C3),
    causing tab-strip re-layouts and focus flicker that contaminate the
    recording. pageLoadStrategy='none' (set in make_driver) prevents the
    canceled navigation from blocking subsequent execute_script calls.
    """
    driver.execute_script("window.location.href = arguments[0];", url)


def go_offline(driver: webdriver.Chrome, offline: bool = True) -> None:
    driver.execute_cdp_cmd("Network.enable", {})
    driver.execute_cdp_cmd("Network.emulateNetworkConditions", {
        "offline": offline,
        "latency": 0,
        "downloadThroughput": -1,
        "uploadThroughput": -1,
    })


def throttle(driver: webdriver.Chrome, kbps: float) -> None:
    """Cap download bandwidth so progress text is readable in the recording."""
    bytes_per_sec = int(kbps * 1024 / 8)
    driver.execute_cdp_cmd("Network.enable", {})
    driver.execute_cdp_cmd("Network.emulateNetworkConditions", {
        "offline": False,
        "latency": 20,
        "downloadThroughput": bytes_per_sec,
        "uploadThroughput": bytes_per_sec,
    })


def clear_throttle(driver: webdriver.Chrome) -> None:
    driver.execute_cdp_cmd("Network.emulateNetworkConditions", {
        "offline": False,
        "latency": 0,
        "downloadThroughput": -1,
        "uploadThroughput": -1,
    })


# ---- scenarios ------------------------------------------------------------

def scenario_A1_quick_complete(driver):
    mark("A1", "scenario_start: small download (near-instant complete)")
    mark("A1", "download_trigger")
    trigger_download(driver, URL_SMALL)
    wait(3, "observe complete state + any flash")


def scenario_A2_visible_progress(driver):
    mark("A2", "scenario_start: 10 MB throttled to 256 kbps -- watch 'Starting...' and 'X / Y, N secs left'")
    throttle(driver, 256)
    mark("A2", "download_trigger")
    trigger_download(driver, URL_MEDIUM)
    wait(45, "let it run; status text should update")
    mark("A2", "unthrottle")
    clear_throttle(driver)
    wait(8, "should complete shortly after unthrottling")


def scenario_A3_pause_resume(driver):
    mark("A3", "scenario_start: pause / resume via the shelf menu")
    throttle(driver, 512)
    mark("A3", "download_trigger")
    trigger_download(driver, URL_LARGE)
    wait(5, "transfer should be running")
    manual("click caret on the chip, hit Pause; observe paused chip + text; then Resume")
    wait(5, "let it run a bit longer")
    mark("A3", "unthrottle")
    clear_throttle(driver)
    wait(10, "completing...")


def scenario_A4_user_cancel(driver):
    mark("A4", "scenario_start: start large, then Cancel from caret menu")
    throttle(driver, 512)
    mark("A4", "download_trigger")
    trigger_download(driver, URL_LARGE)
    wait(4, "transfer running")
    manual("caret -> Cancel; observe cancelled chip color / text / menu items")
    clear_throttle(driver)
    wait(4)


def scenario_A5_network_failure(driver):
    mark("A5", "scenario_start: network failure mid-download (offline via CDP)")
    throttle(driver, 256)
    mark("A5", "download_trigger")
    trigger_download(driver, URL_LARGE)
    wait(4, "running")
    mark("A5", "go_offline")
    go_offline(driver, True)
    wait(8, "chip should flip to error state")
    mark("A5", "go_online")
    go_offline(driver, False)
    clear_throttle(driver)
    wait(4)


def scenario_A6_retry(driver):
    mark("A6", "scenario_start: retry from failed chip")
    manual(
        "with the failed/cancelled chip still on the shelf, caret -> Retry; "
        "watch whether the original chip is replaced, removed, or duplicated"
    )
    wait(6, "observe outcome")


def scenario_B1_plain_open(driver):
    mark("B1", "scenario_start: plain click-to-open on a completed chip")
    mark("B1", "download_trigger")
    trigger_download(driver, URL_SMALL)
    wait(2, "complete")
    manual("click the chip body (not the caret); record 5 s after the click")
    wait(6, "watch for 'Opening...', dismiss, dim, or no-op")


def scenario_B2_always_open_toggle(driver):
    # Uses a plain .txt rather than a PDF: PDF auto-open requires a stricter
    # Safe Browsing trust check even with our http://files.test alias, but
    # .txt is on the unconditional auto-openable allow-list.
    mark("B2", "scenario_start: toggle 'Always open files of this type' on a .txt")
    mark("B2", "download_trigger")
    trigger_download(driver, URL_SMALL)
    wait(3, "complete")
    manual(
        "open the chip's caret menu, hold for ~3 s with the menu fully open "
        "(note 'Always open files of this type' position), CHECK that item, "
        "then close the menu"
    )


def scenario_B3_always_open_subsequent(driver):
    mark("B3", "scenario_start: with Always-open enabled, do another .txt download")
    mark("B3", "download_trigger")
    trigger_download(driver, URL_SMALL)
    wait(10, "watch for auto-open + chip behavior (Opening text? auto-dismiss?)")


def scenario_B4_always_open_slow_txt(driver):
    # Probe: does the Always-open bypass also skip the shelf for a SLOW .txt
    # download, or does an in-progress chip appear and then vanish on
    # completion? B3 only verified the near-instant case. Throttle hard so the
    # transfer takes ~8-10 s; if no chip ever appears during that window, the
    # bypass is at onCreated time. If a progress chip appears and is then
    # removed when complete, the bypass is post-completion only.
    mark("B4", "scenario_start: Always-open + throttled .txt -- chip during in-progress?")
    throttle(driver, 256)
    mark("B4", "download_trigger")
    trigger_download(driver, URL_SLOWTXT)
    wait(12, "watch the shelf the whole time: does an in-progress chip appear?")
    mark("B4", "unthrottle")
    clear_throttle(driver)
    wait(4, "settle")


def scenario_C1_many_in_flight(driver):
    mark("C1", "scenario_start: four downloads in flight at once")
    throttle(driver, 1024)
    mark("C1", "download_trigger")
    trigger_download(driver, URL_MEDIUM); time.sleep(0.4)
    trigger_download(driver, URL_MEDIUM); time.sleep(0.4)
    trigger_download(driver, URL_MEDIUM); time.sleep(0.4)
    trigger_download(driver, URL_MEDIUM)
    wait(40, "observe layout, ordering, dividers, any overflow")
    mark("C1", "unthrottle")
    clear_throttle(driver)
    wait(15, "letting them all finish")


def scenario_C3_overflow(driver):
    mark("C3", "scenario_start: start enough downloads to force overflow / Show all")
    throttle(driver, 1024)
    mark("C3", "download_trigger")
    for _ in range(10):
        trigger_download(driver, URL_MEDIUM)
        time.sleep(0.5)
    wait(30, "is there a Show-all / overflow button? hold ~3 s on it")
    mark("C3", "unthrottle")
    clear_throttle(driver)
    wait(15)


def scenario_D1_close_button(driver):
    mark("D1", "scenario_start: click the X on the right edge of the shelf")
    manual("click the bar's X; observe whether it hides the bar or just clears chips")
    wait(3)
    mark("D1", "download_trigger")
    trigger_download(driver, URL_SMALL)
    wait(4, "new download -- does the bar come back?")


def scenario_D2_show_all_link(driver):
    mark("D2", "scenario_start: right end of shelf, any 'Show all' affordance")
    manual("if there is a 'Show all downloads' link/button, click it; let the resulting page sit for ~3 s")


def scenario_D4_drag_out(driver):
    mark("D4", "scenario_start: drag a completed chip to the desktop")
    mark("D4", "download_trigger")
    trigger_download(driver, URL_SMALL)
    wait(2)
    manual("drag the completed chip slowly onto your desktop; pause briefly mid-drag so the cursor + drop visual is captured")


def scenario_E1_dangerous_exe(driver):
    # Chromium classifies any .exe (and a fixed list of other "dangerous"
    # extensions) downloaded from a non-allowlisted origin as
    # DANGEROUS_FILE. The shelf chip then renders in a special layout: a
    # warning icon + "<filename> may be dangerous" + inline "Keep" /
    # "Discard" text buttons in place of the caret. Worth capturing
    # because our extension currently has no equivalent state.
    mark("E1", "scenario_start: dangerous-extension chip (Keep / Discard inline)")
    mark("E1", "download_trigger")
    trigger_download(driver, URL_EXE)
    wait(4, "warning chip should appear with Keep/Discard buttons")
    manual("hold the cursor still on the Keep/Discard chip for ~3 s, then click Discard")
    wait(2)


def scenario_E2_long_filename(driver):
    # Server returns _SMALL_BODY but with a 120-char Content-Disposition
    # filename. Tests truncation, ellipsis position, and the hover-tooltip
    # (if any) on the filename text.
    mark("E2", "scenario_start: very long filename, truncation + tooltip")
    mark("E2", "download_trigger")
    trigger_download(driver, URL_LONGNAME)
    wait(3, "chip should complete with truncated name")
    manual("hover the filename text on the chip and hold for ~3 s so any tooltip appears on the recording")


def scenario_E3_narrow_window(driver):
    # Pre-populate the shelf with several live chips at full width, then
    # step through progressively narrower widths. Each width is held long
    # enough for OBS to capture how the shelf reflows: filename
    # truncation, chip dropping, overflow / Show-all appearing. Heavier
    # throttle (256 kbps on 1 MiB) keeps the chips in-flight through the
    # whole walk so we see active progress in each width.
    mark("E3", "scenario_start: shelf adaptation at multiple widths")
    orig = driver.get_window_size()
    throttle(driver, 256)
    mark("E3", "download_trigger")
    for _ in range(4):
        trigger_download(driver, URL_MEDIUM)
        time.sleep(0.5)
    wait(3, "4 chips populated at full width")
    for w in (1000, 800, 600, 460):
        log("E3", f"resize -> {w}px")
        driver.set_window_size(w, orig["height"])
        wait(4, f"shelf at {w}px width")
    clear_throttle(driver)
    wait(4, "finish remaining downloads at last width")
    driver.set_window_size(orig["width"], orig["height"])
    wait(2, "size restored")


def scenario_E4_hover_states(driver):
    # All chip / shelf hover styling, exercised on whatever's currently
    # on the shelf (we don't trigger a new download here; the prior chips
    # from E1-E3 are enough).
    mark("E4", "scenario_start: hover states (chip body, caret, Show all, close X)")
    manual(
        "hover (don't click) each of: chip body, the caret button, the "
        "'Show all' link, the bar's close X. Pause ~1 s on each so the "
        "recording captures any hover background / tooltip."
    )


def scenario_E5_right_click(driver):
    mark("E5", "scenario_start: right-click on chip body")
    manual("right-click the body of a completed chip; let the context menu sit open for ~3 s, then dismiss")


def scenario_E6_caret_menu_completed(driver):
    # Caret menus on in-progress / paused / cancelled / failed chips were
    # observed during A3/A4/A6. This one specifically captures the menu
    # for a *completed* chip, which has different items (Open, Always
    # open, Show in folder, Remove from list, ...).
    mark("E6", "scenario_start: caret menu on a completed chip")
    mark("E6", "download_trigger")
    trigger_download(driver, URL_SMALL)
    wait(2, "complete")
    manual("open the caret menu on the newest (completed) chip; hold the menu open for ~4 s so every item is on the recording, then dismiss")


def scenario_E7_light_theme(driver):
    # Chromium 113 follows the Windows app-mode setting. Toggle the OS
    # theme to light for one capture, then back to dark when done. We
    # don't try to automate the registry flip -- a per-user setting that
    # would surprise the user is better as a deliberate manual step.
    #
    # Two captures in light mode, hitting every colored UX element:
    #   1. Throttled medium -> in-flight progress (colored progress ring,
    #      filename, byte counter, caret).
    #   2. Quick small -> completion-flash animation (colored on the
    #      moment of transition from in-progress -> done).
    mark("E7", "scenario_start: light theme parity capture")
    manual(
        "switch Windows to LIGHT theme (Settings > Personalization > Colors > "
        "'Choose your mode' = Light), wait for chrome to repaint, ENTER"
    )
    # Throttled medium first: keeps a colored progress ring visible for
    # long enough that OBS captures multiple frames of it.
    throttle(driver, 512)
    mark("E7", "download_trigger:medium (light-mode in-flight)")
    trigger_download(driver, URL_MEDIUM)
    wait(12, "colored progress ring + byte counter in light theme")
    clear_throttle(driver)
    wait(3, "let the medium finish")
    # Quick small: completion flash on a clean chip.
    mark("E7", "download_trigger:small (light-mode completion flash)")
    trigger_download(driver, URL_SMALL)
    wait(4, "completion flash, then resting completed chip in light theme")
    manual("switch Windows back to DARK theme, ENTER to continue")


def scenario_E8_indeterminate_progress(driver):
    # Indeterminate-size download: the server omits Content-Length and
    # streams ~20 s of bytes before closing. Chromium reports
    # totalBytes <= 0 for the lifetime of the transfer, so
    # DownloadItemView paints the spinning 50-degree arc (PaintDownloadProgress,
    # download_item_view.cc -- 80 deg/sec, 4.5 s per revolution) instead of
    # the normal sweep. Reference for the parallel CSS animation in
    # src/styles.js (.db-progress-ring--indeterminate, 4500 ms linear).
    # Captures: status text in indeterminate mode ("Starting..." or a
    # byte counter with no total / no ETA?), ring color, and at least
    # four full revolutions for a frame-by-frame tempo check.
    mark("E8", "scenario_start: indeterminate-size download (spinning ring)")
    mark("E8", "download_trigger")
    trigger_download(driver, URL_INDET)
    wait(22, "observe spinning ring + indeterminate status text (~4 revs)")


# ---- runner ---------------------------------------------------------------

SCENARIOS = [
    scenario_A1_quick_complete,
    scenario_A2_visible_progress,
    scenario_A3_pause_resume,
    scenario_A4_user_cancel,
    scenario_A5_network_failure,
    scenario_A6_retry,
    scenario_B1_plain_open,
    scenario_C1_many_in_flight,
    scenario_C3_overflow,
    scenario_D1_close_button,
    scenario_D2_show_all_link,
    scenario_D4_drag_out,
    # E-series: visual details not covered by state-transition scenarios.
    # E1 must run before B2/B3 so the dangerous-file UI is captured on a
    # clean shelf. E3 resizes the window; E7 toggles the OS theme; these
    # come after the C/D layout scenarios so they don't affect them.
    scenario_E1_dangerous_exe,
    scenario_E2_long_filename,
    scenario_E3_narrow_window,
    scenario_E4_hover_states,
    scenario_E5_right_click,
    scenario_E6_caret_menu_completed,
    scenario_E7_light_theme,
    scenario_E8_indeterminate_progress,
    # B2/B3 last on purpose: toggling "Always open files of this type" on .txt
    # in B2 causes every subsequent .txt download to auto-launch Notepad,
    # which steals focus and auto-dismisses the chip. Putting B2/B3 after
    # the .txt-using D1/D4 keeps those scenarios observable.
    scenario_B2_always_open_toggle,
    scenario_B3_always_open_subsequent,
    scenario_B4_always_open_slow_txt,
]


def _user_downloads_dir() -> Path:
    """Return the user's real Downloads folder.

    We download into the real folder (not a tempdir) so the full classic-
    shelf UX works end-to-end: click-to-open finds the file, drag-out to
    the desktop produces a real file move, 'Show in folder' opens
    Explorer at a real location, and the files persist after the run so
    you can inspect them. Cleaning up is the user's call (see the
    `--clean-downloads` flag in main()).
    """
    if sys.platform == "win32":
        # Resolve via the shell so OneDrive / redirected Downloads work.
        userprofile = os.environ.get("USERPROFILE")
        if userprofile:
            cand = Path(userprofile) / "Downloads"
            if cand.exists():
                return cand
    return Path.home() / "Downloads"


@contextmanager
def temp_dirs(downloads_dir: Path):
    profile = Path(tempfile.mkdtemp(prefix="dlbar-profile-"))
    downloads_dir.mkdir(parents=True, exist_ok=True)
    log("", f"profile dir : {profile} (temp, cleaned on exit)")
    log("", f"download dir: {downloads_dir} (persistent)")
    try:
        yield profile, downloads_dir
    finally:
        try:
            shutil.rmtree(profile, ignore_errors=True)
        except Exception:
            pass


def _default_app_for_ext(ext: str) -> str | None:
    """Return the per-user default ProgId for a file extension, or None.

    Reads HKCU\\...\\FileExts\\<ext>\\UserChoice\\ProgId. If absent, Windows
    will show the 'Open with' picker on click-to-open, which derails the
    classic-shelf recording. We surface that as a preflight warning.
    """
    if sys.platform != "win32":
        return None
    try:
        import winreg  # type: ignore
    except ImportError:
        return None
    key_path = rf"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{ext}\UserChoice"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            progid, _ = winreg.QueryValueEx(key, "ProgId")
            return progid
    except OSError:
        return None


def preflight_warnings() -> None:
    """Surface OS-level gotchas before the user starts recording.

    Right now: warn if .txt has no default app on this account, because
    that produces a Windows 'Open with' picker on B1's click-to-open and
    forces a re-take. The user has to set the default themselves
    (Microsoft hash-protects UserChoice; see tests/README.md), so this is
    advisory only.
    """
    progid = _default_app_for_ext(".txt")
    if not progid:
        print()
        print("  ! preflight: no default app registered for .txt on this account.")
        print("    Click-to-open in scenario B1 will show Windows' 'Open with'")
        print("    picker instead of opening the file. To fix:")
        print("      Start-Process 'ms-settings:defaultapps'")
        print("    then search '.txt' and pick Notepad.")
        print()


def main(argv: list[str]) -> int:
    global URL_SMALL, URL_MEDIUM, URL_LARGE, URL_PDF, URL_EXE, URL_LONGNAME, URL_INDET, URL_SLOWTXT, _LOG_FH
    args = argv[1:]
    clean_downloads = False
    if "--clean-downloads" in args:
        clean_downloads = True
        args = [a for a in args if a != "--clean-downloads"]
    only = set(args)  # optional: filter by scenario label, e.g. A1 B3

    downloads_root = _user_downloads_dir()
    # Land downloads in the user's real Downloads folder (no subdir) so the
    # files show up exactly where the user expects, and so the shelf's
    # click-to-open / drag-out / Show-in-folder paths exercise a normal
    # location. Our fixture filenames are fixed (small.txt, medium.bin,
    # large.bin, dummy.pdf, evil.exe, plus the long-name .txt from E2),
    # which keeps --clean-downloads tightly scoped.
    downloads = downloads_root
    FIXTURE_NAMES = (
        "small.txt", "slow.txt", "medium.bin", "large.bin", "dummy.pdf", "evil.exe",
        _LONG_FILENAME,
    )
    if clean_downloads:
        for name in FIXTURE_NAMES:
            for candidate in downloads.glob(name.rsplit(".", 1)[0] + "*." + name.rsplit(".", 1)[1]):
                # Matches small.txt, small (1).txt, small (2).txt, etc.
                try:
                    candidate.unlink()
                except Exception:
                    pass
            # Also remove any leftover .crdownload partials.
            for partial in downloads.glob(name + ".crdownload"):
                try:
                    partial.unlink()
                except Exception:
                    pass

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "w", encoding="utf-8") as fh:
        _LOG_FH = fh
        fh.write(f"# run started: {datetime.now().isoformat()}\n")
        fh.write(f"# columns: iso\\tT_offset\\tkind\\tlabel\\tmsg\n")
        with local_server() as port, temp_dirs(downloads) as (profile, dl_dir):
            base = f"http://files.test:{port}"
            URL_SMALL = f"{base}/small.txt"
            URL_MEDIUM = f"{base}/medium.bin"
            URL_LARGE = f"{base}/large.bin"
            URL_PDF = f"{base}/dummy.pdf"
            URL_EXE = f"{base}/evil.exe"
            URL_LONGNAME = f"{base}/long"
            URL_INDET = f"{base}/indeterminate.bin"
            URL_SLOWTXT = f"{base}/slow.txt"
            log("", f"fixture server: {base}")

            driver, chrome_proc = make_driver(dl_dir, profile)
            # Park on the fixture server's index page, NOT about:blank.
            # Chromium's default 'automatic_downloads' content setting is
            # only consulted for real http(s) origins; about:blank's
            # opaque origin falls through to the ASK default, which fires
            # the "site attempted to download multiple files" prompt on
            # the second trigger of A1+A2 / C1 / C3. files.test gives us
            # a stable origin where our pref applies.
            driver.get(f"{base}/")
            try:
                preflight_warnings()
                log("", "ready. start your screen recording now.")
                manual("recording rolling? press ENTER to begin scenarios")
                # The next mark is the anchor extract.py uses to line the
                # video clock up with the log clock.
                mark("RECORDING", "scenarios start now")

                for fn in SCENARIOS:
                    label = fn.__name__.split("_")[1]  # e.g. A1
                    if only and label not in only:
                        continue
                    try:
                        fn(driver)
                    except KeyboardInterrupt:
                        log("", "interrupted; stopping cleanly")
                        break
                    except Exception as e:
                        log(label, f"ERROR: {e!r} -- continuing")

                log("", "done. stop the recording.")
                manual("press ENTER to close Chromium and clean up")
            finally:
                # driver.quit() disconnects chromedriver but, since we
                # launched chrome ourselves, does NOT terminate the chrome
                # process. Kill it explicitly so the profile-dir cleanup in
                # temp_dirs() doesn't race with a still-running chrome.
                try:
                    driver.quit()
                except Exception:
                    pass
                try:
                    chrome_proc.terminate()
                    chrome_proc.wait(timeout=5)
                except Exception:
                    try:
                        chrome_proc.kill()
                    except Exception:
                        pass
        _LOG_FH = None
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
