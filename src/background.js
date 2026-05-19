// DownloadBar -- service worker (MV3).
// Tracks which download IDs are visible in the bar, persists the set in session storage,
// and pushes state to connected tabs via long-lived ports.

const VISIBLE_KEY = 'visibleIds';
const FLASHED_KEY = 'flashedIds';
// Session-scoped: ids the user toggled "Notify when done" on, awaiting completion.
const NOTIFY_ON_DONE_KEY = 'notifyOnDoneIds';
// Persistent: lowercased file extensions opted into "Always notify for files of this type".
const ALWAYS_NOTIFY_EXTS_KEY = 'alwaysNotifyExts';

const TICK_MS = 500;
const ICON_SIZE = 32; // chrome.downloads.getFileIcon supports 16 or 32.

// Authoritative in-memory copies of the persisted Sets. Storage is RAM-backed for session keys
// (chrome.storage.session is cleared when the browser closes), persistent for chrome.storage.local.
// We hydrate once on first access and treat memory as the source of truth thereafter; setX still writes
// through so other SW invocations after a restart can rehydrate.
function persistedSet(key, persist = false) {
  const storage = persist ? chrome.storage.local : chrome.storage.session;
  let cache = null;
  return [
    async () => {
      if (cache === null) cache = new Set((await storage.get(key))[key] || []);
      return cache;
    },
    async (value) => {
      cache = value;
      await storage.set({ [key]: [...value] });
    },
  ];
}

const [getVisible, setVisible] = persistedSet(VISIBLE_KEY);
const [getFlashed, setFlashed] = persistedSet(FLASHED_KEY);
const [getNotifyOnDone, setNotifyOnDone] = persistedSet(NOTIFY_ON_DONE_KEY);
const [getAlwaysNotifyExts, setAlwaysNotifyExts] = persistedSet(ALWAYS_NOTIFY_EXTS_KEY, /*persist=*/true);

// Lowercased extension without leading dot, or '' if the basename has none.
// Mirrors how Chrome 113 keys the native "Always open files of this type" preference.
function getExt(basename) {
  if (!basename) return '';
  const i = basename.lastIndexOf('.');
  if (i <= 0 || i === basename.length - 1) return '';
  return basename.slice(i + 1).toLowerCase();
}

const _ports = new Set();

// OS-supplied icons keyed by download id.
// Icons are stable once the file exists, so cache forever and evict only on erase.
const _iconCache = new Map();
// Dedupe concurrent getFileIcon calls for the same id.
const _iconPending = new Map();

// chrome.downloads.onChanged fires only on sparse checkpoints, so bytes/ETA appear to freeze.
// While anything is transferring, poll every 500ms.
let _tickTimer = null;

async function fetchIcon(id) {
  if (_iconCache.has(id)) return _iconCache.get(id);
  if (_iconPending.has(id)) return _iconPending.get(id);

  const pending = new Promise((resolve) => {
    chrome.downloads.getFileIcon(id, { size: ICON_SIZE }, (iconUrl) => {
      void chrome.runtime.lastError; // ignore "no file yet" errors
      resolve(iconUrl);
    });
  });
  _iconPending.set(id, pending);
  try {
    const iconUrl = await pending;
    if (iconUrl) _iconCache.set(id, iconUrl);
    return iconUrl;
  } finally {
    _iconPending.delete(id);
  }
}

// Project Chrome's DownloadItem into the trimmed, normalized shape the renderer consumes.
// notifyOnDoneIds and alwaysNotifyExts are passed in so the menu can render checkmark state without
// each chip making its own async lookup; getState() hydrates them once and threads them through.
function serialize(download, notifyOnDoneIds, alwaysNotifyExts) {
  const basename = (download.filename || '').split(/[\\/]/).pop();
  const ext = getExt(basename);
  return {
    id: download.id,
    filename: download.filename || '',
    basename,
    ext,
    url: download.url,
    finalUrl: download.finalUrl,
    mime: download.mime,
    state: download.state,
    paused: !!download.paused,
    canResume: !!download.canResume,
    error: download.error,
    bytesReceived: download.bytesReceived,
    totalBytes: download.totalBytes,
    estimatedEndTime: download.estimatedEndTime,
    exists: download.exists !== false,
    notifyWhenDone: notifyOnDoneIds.has(download.id),
    alwaysNotifyExt: ext ? alwaysNotifyExts.has(ext) : false
  };
}

async function getState() {
  const visible = await getVisible();
  const notifyOnDoneIds = await getNotifyOnDone();
  const alwaysNotifyExts = await getAlwaysNotifyExts();

  // Resolve each visible id to a download record in parallel; drop ids whose download no longer exists.
  const lookup = async (id) => {
    const [download] = await chrome.downloads.search({ id });
    if (download) return serialize(download, notifyOnDoneIds, alwaysNotifyExts);
    visible.delete(id);
    return null;
  };
  const before = visible.size;
  const items = (await Promise.all(Array.from(visible, lookup))).filter(Boolean);
  if (visible.size < before) await setVisible(visible);

  // Sort downloaded items by time (implicit by download ID).
  // Note that download IDs are persistent and stable per-profile, too.
  items.sort((a, b) => b.id - a.id);

  // Attach cached icons; kick off fetches for misses and rebroadcast once any resolve.
  const pending = [];
  for (const item of items) {
    const cached = _iconCache.get(item.id);
    if (cached) item.iconUrl = cached;
    else pending.push(fetchIcon(item.id));
  }
  if (pending.length) {
    Promise.all(pending).then((urls) => { if (urls.some(Boolean)) broadcast(); });
  }

  const flashedIds = [...await getFlashed()];
  return { items, flashedIds };
}

async function broadcast() {
  const state = await getState();
  for (const port of _ports) {
    try { port.postMessage(state); } catch { /* port closed */ }
  }
  const wantTicker = state.items.some(item => item.state === 'in_progress' && !item.paused);
  const haveTicker = _tickTimer != null;
  if (wantTicker && !haveTicker) {
    _tickTimer = setInterval(broadcast, TICK_MS);
  } else if (!wantTicker && haveTicker) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  } else {
    // Do nothing -- what we want is what we have.
  }
  return state;
}

chrome.downloads.onCreated.addListener(async (item) => {
  const visible = await getVisible();
  visible.add(item.id);
  await setVisible(visible);
  broadcast();
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state) {
    if (delta.state.current === 'complete') {
      await maybeDrawAttention(delta.id);
    } else if (delta.state.current === 'interrupted') {
      // A canceled / failed download never triggers a notify; clear any pending one-shot flag
      // so a future ID collision after SW restart can't fire a stale flash.
      const notifyOnDoneIds = await getNotifyOnDone();
      if (notifyOnDoneIds.delete(delta.id)) await setNotifyOnDone(notifyOnDoneIds);
    }
  }
  broadcast();
});

chrome.downloads.onErased.addListener(async (id) => {
  _iconCache.delete(id);
  const visible = await getVisible();
  if (visible.delete(id)) await setVisible(visible);
  const flashed = await getFlashed();
  if (flashed.delete(id)) await setFlashed(flashed);
  const notifyOnDoneIds = await getNotifyOnDone();
  if (notifyOnDoneIds.delete(id)) await setNotifyOnDone(notifyOnDoneIds);
  broadcast();
});

// Draw attention on the Chrome taskbar button for the user's last-focused window when a download
// completes, if the user opted in via either the per-download "Notify when done" toggle or the
// per-extension "Always notify for files of this type" rule. This is our adaptation of Chromium's
// legacy auto-open behavior -- the MV3 user-gesture gate makes a true auto-open impossible from a SW
// callback, so we settle for an attention signal instead. chrome.windows.update({drawAttention:true})
// maps to Win32 FlashWindowEx; it's a no-op when the window is already focused.
// Called from onChanged on the in_progress->complete transition, which Chrome fires exactly once,
// so no per-id dedup set is needed.
async function maybeDrawAttention(id) {
  const notifyOnDoneIds = await getNotifyOnDone();
  let trigger = notifyOnDoneIds.has(id);
  if (!trigger) {
    const [download] = await chrome.downloads.search({ id });
    if (download) {
      const basename = (download.filename || '').split(/[\\/]/).pop();
      const ext = getExt(basename);
      const alwaysNotifyExts = await getAlwaysNotifyExts();
      if (ext && alwaysNotifyExts.has(ext)) trigger = true;
    }
  }
  if (!trigger) return;

  if (notifyOnDoneIds.delete(id)) await setNotifyOnDone(notifyOnDoneIds);

  try {
    const win = await chrome.windows.getLastFocused();
    if (win) await chrome.windows.update(win.id, { drawAttention: true });
  } catch { /* no window available, or it closed between the two calls */ }
}

broadcast();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'downloadbar') return;
  _ports.add(port);
  port.onDisconnect.addListener(() => _ports.delete(port));
  getState().then(state => {
    try { port.postMessage(state); } catch { /* closed */ }
  });
});

const handlers = {
  getState: () => getState(),

  dismiss: async ({ id }) => {
    const visible = await getVisible();
    if (visible.delete(id)) await setVisible(visible);
    broadcast();
  },

  dismissAll: async () => {
    await setVisible(new Set());
    broadcast();
  },

  open:       ({ id }) => chrome.downloads.open(id),
  show:       ({ id }) => chrome.downloads.show(id),
  pause:      ({ id }) => chrome.downloads.pause(id),
  resume:     ({ id }) => chrome.downloads.resume(id),
  cancel:     ({ id }) => chrome.downloads.cancel(id),

  retry: async ({ id }) => {
    const [original] = await chrome.downloads.search({ id });
    if (original && original.url) await chrome.downloads.download({ url: original.url });
  },

  openDownloadsPage: () => chrome.tabs.create({ url: 'chrome://downloads' }),

  markFlashed: async ({ id }) => {
    const flashed = await getFlashed();
    if (flashed.has(id)) return;
    flashed.add(id);
    await setFlashed(flashed);
  },

  // Per-download "Notify when done" toggle. One-shot: cleared automatically when the download
  // completes (or fails). The current download still gets the flash if its extension is also in
  // alwaysNotifyExts, since maybeDrawAttention() OR's the two triggers.
  setNotifyWhenDone: async ({ id, enabled }) => {
    const notifyOnDoneIds = await getNotifyOnDone();
    const isOn = notifyOnDoneIds.has(id);
    if (enabled === isOn) return;
    if (enabled) notifyOnDoneIds.add(id);
    else notifyOnDoneIds.delete(id);
    await setNotifyOnDone(notifyOnDoneIds);
    broadcast();
  },

  // Per-extension "Always notify for files of this type" toggle. Persistent across browser
  // restarts (chrome.storage.local). Applies to any future download of that extension, and to
  // the currently-in-progress chip if the toggle was flipped while it's still transferring --
  // maybeDrawAttention() consults the live set at completion time.
  setAlwaysNotifyExt: async ({ ext, enabled }) => {
    if (!ext) return;
    const alwaysNotifyExts = await getAlwaysNotifyExts();
    const isOn = alwaysNotifyExts.has(ext);
    if (enabled === isOn) return;
    if (enabled) alwaysNotifyExts.add(ext);
    else alwaysNotifyExts.delete(ext);
    await setAlwaysNotifyExts(alwaysNotifyExts);
    broadcast();
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && handlers[msg.action];
  if (!handler) {
    sendResponse({ ok: false, error: 'unknown action' });
    return;
  }
  Promise.resolve(handler(msg))
    .then((result) => sendResponse(result !== undefined ? result : { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async response
});
