# Classic-shelf capture runner

> **Note.** Most of the code in this folder is throwaway, AI-generated
> exploration scaffolding -- one-off probes, measurement loops, and a
> capture harness built to answer specific questions about the classic
> Chrome shelf. It is not representative of the extension code in
> [`src/`](../src), is not held to the same quality bar, and should not
> be read as an example of how to write Selenium tests, image
> processing, or anything else. Kept around as a lab notebook, not a
> reference implementation.

Drives Chrome for Testing 113.0.5672.63 through a fixed sequence of
download scenarios while you screen-record. Each scenario prints a
timestamped `[label]` to stdout so you can slice the recording
afterward.

M113 is the last Chrome that still ships the classic download shelf
(reachable via `--disable-features=DownloadBubble`). Newer versions
removed the code path entirely.

## Setup (one time)

```powershell
cd <repo-root>
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r tests\requirements.txt
```

Place Chrome for Testing 113.0.5672.63 at
`reference\chrome-win64\chrome.exe`, and the matching `chromedriver.exe`
next to it. The runner pins to the in-tree driver because Selenium
Manager fetches the *latest*, which won't attach to M113.

## Run

```powershell
.\.venv\Scripts\Activate.ps1
python tests\run_shelf_tests.py
```

The script:

1. Launches Chrome with a clean temp profile and `DownloadBubble`
   disabled.
2. Waits for you to start recording, then press ENTER.
3. Walks through scenarios, printing `[label]` timestamps you can find
   in the clip.
4. Pauses for any step requiring native-UI interaction (shelf clicks,
   drag-out, *Always open* toggle) and waits for ENTER.
5. Cleans up the temp profile on exit. **Downloaded files are kept**
   in `%USERPROFILE%\Downloads\` so click-to-open, drag-out, and *Show
   in folder* work against real files. Pass `--clean-downloads` to
   wipe prior fixtures (`small.txt`, `medium.bin`, `large.bin`,
   `dummy.pdf` and `(1)`/`(2)` siblings) before the run.

## Run a subset

```powershell
python tests\run_shelf_tests.py B1 B3 A5
```

## Scenarios

Run in this order. B2-B4 last on purpose -- see below.

| Label | Behavior under test |
| --- | --- |
| A1 | Quick complete (small file, near-instant). Icon flash. |
| A2 | Visible progress at 256 kbps; `Starting...` / `X of Y, N secs left` wording. |
| A3 | Pause / resume from the caret menu (manual). |
| A4 | User-cancel from the caret menu (manual). |
| A5 | Network failure mid-download (CDP offline). |
| A6 | Retry from the failed chip (manual). |
| B1 | Plain click-to-open on a completed chip. |
| C1 | Four medium downloads in flight at once. Layout, ordering. |
| C3 | Overflow: 10 downloads. `Show all` / scroll affordance. |
| D1 | Bar close button: hide vs. clear behavior. |
| D2 | `Show all downloads` link, if present. |
| D4 | Drag a completed chip to the desktop (manual). |
| E1 | Dangerous-extension chip: `.exe` Keep/Discard inline buttons (manual). |
| E2 | Long filename truncation + hover tooltip (manual). |
| E3 | Narrow window (600 px) with 3 mediums: overflow / scroll. |
| E4 | Hover states on body / caret / Show all / close X (manual). |
| E5 | Right-click context menu (manual). |
| E6 | Caret menu full item list on completed chip (manual). |
| E7 | Light-theme capture (manual). |
| B2 | Toggle *Always open files of this type* on `.txt` (manual). |
| B3 | Subsequent fast `.txt` with Always-open on. |
| B4 | Slow (256 kbps) `.txt` with Always-open on -- confirms an in-progress chip does appear and is removed at completion. |

B2 sets a per-extension auto-open rule on `.txt` that persists for the
profile session. Every subsequent `.txt` then auto-launches Notepad,
which steals focus and dismisses the chip. D1 and D4 both use
`small.txt`, so B2-B4 run *after* them to avoid contamination.

## OS prerequisites

Click-to-open invokes Windows `ShellExecuteEx`, which needs a default
app registered for the file extension. If `.txt` has no default on this
account, B1 will trigger the Windows "Open with" picker instead. The
runner prints a preflight warning; fix with:

```powershell
Start-Process "ms-settings:defaultapps"
```

Search `.txt`, pick Notepad. (Windows hash-protects the per-user FTA
registry key, so the runner can't set this for you.)

## Implementation notes

- **Selenium can't see or click anything on the native shelf.**
  ChromeDriver injects automation switches that make the shelf inert
  to JS-driven clicks even after stripping `enable-automation`. All
  shelf interactions are manual. To automate them you would have to
  attach Selenium to an already-running Chrome via `debuggerAddress`
  instead of letting chromedriver launch it -- not wired up.
- **Pause is via CDP `Network.emulateNetworkConditions`,** not by
  clicking Pause. A3 still requires a manual click -- it specifically
  tests the shelf's Pause/Resume menu items.
- **Fixtures are served by a local HTTP server on `127.0.0.1`** with
  `Content-Disposition: attachment` on every response. No internet
  required.
- **Hostname alias `files.test -> 127.0.0.1`** via
  `--host-resolver-rules`. Chromium's *Always open files of this type*
  path bails on loopback origins for Safe Browsing reasons; the
  `.test` TLD looks non-local enough to satisfy the `.txt` code path
  (B3/B4). PDFs are gated by a stricter check that this alias does not
  satisfy -- B2-B4 use `.txt`.
- **Trigger anchor must use `target='_blank'`.** Driving downloads via
  `driver.get(<url>)` blocks the page-load handler. Each trigger
  injects an `<a target='_blank' href>` and `.click()`s it via
  `execute_script`. C3 (rapid-fire 10 downloads) also needs a 0.5s
  sleep between triggers so the shelf can slot each chip.
