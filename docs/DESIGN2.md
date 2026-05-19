# DownloadBar -- design notes

A small MV3 extension that restores a Chrome-style download shelf across the bottom of every page. No build step, no framework, no dependencies.

## Goals

- Reproduce the classic Chromium download shelf as closely as the extension APIs allow.
    - Smooth over rough edges in the old implementation where needed -- "rose tinted glasses" approach.
- Show the same bar in every tab, updating in real time.
- Cost effectively nothing while idle.

## Non-goals

- Modifying browser chrome (impossible from an extension).
- Replacing the new downloads bubble (we coexist with it).
- Anything out of scope for a modern extension
    - We cannot auto-open files without user input. See "Notify-on-complete" below.
    - We cannot inject HTML on `chrome://` pages or any other internal page.
    - The native chrome chip menu went down (below the window). We are popping up because we can't draw content outside of the DOM.

## Key files

`background.js` is the only piece that talks to the underlying `chrome.downloads` APIs.
`content.js` runs on every tab, and hands state from the background service worker to the front-end `ui.js`. Some user actions also flow backwards to the background SW.
`menu.js` is responsible for the popup menu on each download "chip".
`settings.js` manages the persistent user settings, and is loaded by the service worker and the options UX.
All other files should be self-explanatory.

## Non-obvious code

- We keep a set of "visible chip IDs" to track which downloads are in progress. This survives the service worker's 30s sleep timeout.
- Each download chip should flash on completion, so we keep track of when we first flashed it, to avoid a re-flash and to smoothly resume the animation if needed.
- Icons are fetched asynchronously, but cached. On the hot path, we are in the middle of a download and need to return the icon to render without causing lag. If an icon is missing, we defer (and show nothing). Icons come from `chrome.downloads.getFileIcon`.
- Our download bar is injected as a top-level div ("shadow") on the DOM. We have to do some agressive CSS styling to protect it from other attributes on the host -- this download bar needs to work on any tab. This unfortunately means all of our *actual* CSS styling needs to be `!important`.
- While a download is live, we keep the SW alive with a ping every 500ms. This is needed so we draw download progress correctly, and take download completion actions correctly.

## Notify-on-complete

The classic shelf had two related affordances that auto-opened a finished download with the OS default handler:

- **Open when done** -- per-download toggle on an in-progress chip (could also be triggered by clicking on a chip).
- **Always open files of this type** -- per-extension persistent rule; on completion the chip was silently removed and the file launched in its OS default handler.

Neither is feasible in a modern extension. `chrome.downloads.open()` can only be called when the originating gesture was from the user. Even when the user directly clicks on a file, it still triggers a confirmation dialogue, so a silent download is not possible.

Instead, we built a feature that's basically the same -- notify the user when the download is done. We can easily flash the taskbar on complete (and do nothing when chrome is active).

---

## Future work

- **Drag-to-extract.** Drag a completed chip onto the desktop or another app to copy the file. The new Chrome bubble does this; the classic shelf did too. Likely via `DataTransfer.setData('DownloadURL', ...)` with a synthetic drag from the chip element.
- **Persistence across restarts.** On SW boot, rehydrate chips from `chrome.downloads.search`. Option to restore everything recent vs. only interrupted/paused downloads with `canResume: true`.
- **Grouping.** When several downloads arrive from the same origin within a few seconds (image-savers, "download all"), collapse them into a single expandable chip. Both the classic shelf and the new bubble flood badly in this case.
- **Pinning.** Right-click -> pin a chip; survives auto-dismiss and "clear all". For the "I'll deal with that installer in a minute" case.
- **Notification fallback.** Optional `chrome.notifications.create` on completion when Chrome is unfocused, in addition to (or instead of) the taskbar flash. Useful on platforms where flash semantics are weak.
- **Source-tab jumpback.** Clicking a chip in a tab other than the one that started the download could optionally switch focus back to the originating tab instead of (or before) opening the file.
- **Hash display.** Menu option to compute SHA-256 of a completed file. Requires the user to enable "Allow access to file URLs" on the extension; then `fetch('file:///' + item.filename)` -> `crypto.subtle.digest`. Gate the option on file size to avoid hashing multi-GB ISOs synchronously, or implement a streaming hasher.