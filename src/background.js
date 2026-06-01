// DownloadBar -- service worker (MV3).
// Tracks which download IDs are visible in the bar, persists the set in session storage,
// and pushes state to connected tabs via long-lived ports.

// Firefox loads this implicitly from background.scripts, and will error here if we try again.
if (typeof importScripts === 'function') importScripts('./settings.js');

const VISIBLE_KEY = 'visibleIds';
const FLASHED_KEY = 'flashedIds';
const ENTERED_KEY = 'enteredIds';
// Session-scoped: ids the user toggled "Notify when done" on, awaiting completion.
const NOTIFY_ON_DONE_KEY = 'notifyOnDoneIds';
// Persistent: lowercased file extensions opted into "Always notify for files of this type".
const ALWAYS_NOTIFY_EXTS_KEY = 'alwaysNotifyExts';

const TICK_MS = 500;
const ICON_SIZE = 32; // chrome.downloads.getFileIcon supports 16 or 32.

// Authoritative in-memory copies of the persisted Sets. Storage is RAM-backed for session keys
// (chrome.storage.session is cleared when the browser closes), persistent for chrome.storage.local.
// We hydrate once on first access and treat memory as the source of truth thereafter;
// setX still writes through so other SW invocations after a restart can rehydrate.
function persistedSet(key, persist = false) {
  if (!SW_CACHED_STORAGE_KEYS.has(key)) {
    throw new Error(`[DownloadBar] ${key} was not declared in SW_CACHED_STORAGE_KEYS in settings.js.`);
  }
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
const [getEntered, setEntered] = persistedSet(ENTERED_KEY);
const [getNotifyOnDone, setNotifyOnDone] = persistedSet(NOTIFY_ON_DONE_KEY);
const [getAlwaysNotifyExts, setAlwaysNotifyExts] = persistedSet(ALWAYS_NOTIFY_EXTS_KEY, /*persist=*/true);

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

// Project a chrome.downloads DownloadItem (looked up by id) into the wire shape the renderer
// consumes. Returns null if the download no longer exists. Attaches a cached icon if we have
// one, otherwise kicks off a fetch and dispatches a follow-up 'changed' when it lands.
async function serialize(id) {
  const [download] = await chrome.downloads.search({ id });
  if (!download) return null;
  const notifyOnDoneIds = await getNotifyOnDone();
  const basename = (download.filename || '').split(/[\\/]/).pop();
  const ext = extFromFilename(basename);
  const item = {
    id: download.id,
    filename: download.filename || '',
    basename,
    ext,
    url: download.url,
    state: download.state,
    paused: !!download.paused,
    canResume: !!download.canResume,
    error: download.error,
    bytesReceived: download.bytesReceived,
    totalBytes: download.totalBytes,
    estimatedEndTime: download.estimatedEndTime,
    exists: download.exists !== false,
    notifyWhenDone: notifyOnDoneIds.has(download.id),
  };
  // Firefox reports a paused download as state=interrupted + error=USER_CANCELED + canResume.
  // Normalize to Chrome's shape so consumers see the same `{state: 'in_progress', paused: true}`
  // regardless of browser.
  if (item.state === 'interrupted' && item.error === 'USER_CANCELED' && item.canResume) {
    item.state = 'in_progress';
    item.paused = true;
    item.error = undefined;
  }
  const cached = _iconCache.get(item.id);
  if (cached) item.iconUrl = cached;
  else fetchIcon(item.id).then(url => { if (url) dispatchChanged(item.id); });
  return item;
}

async function getSnapshot() {
  const visible = await getVisible();
  const items = (await Promise.all([...visible].map(serialize))).filter(Boolean);

  // Drop any visible ids whose download no longer exists.
  const found = new Set(items.map(i => i.id));
  const before = visible.size;
  for (const id of [...visible]) if (!found.has(id)) visible.delete(id);
  if (visible.size < before) await setVisible(visible);

  // Sort downloaded items by time (implicit by download ID).
  // Note that download IDs are persistent and stable per-profile, too.
  items.sort((a, b) => b.id - a.id);

  return {
    type: 'snapshot',
    items,
    flashedIds: [...await getFlashed()],
    enteredIds: [...await getEntered()],
  };
}

// Decorate every per-event message with the cross-cutting flash/enter sets the renderer needs.
async function dispatch(msg) {
  msg.flashedIds = [...await getFlashed()];
  msg.enteredIds = [...await getEntered()];
  for (const port of _ports) {
    try { port.postMessage(msg); } catch { /* port closed */ }
  }
  await reconcileTicker();
}

async function dispatchChanged(id) {
  const item = await serialize(id);
  if (item) await dispatch({ type: 'changed', item });
}

// The ticker fires per-chip 'changed' messages for in-progress chips so their progress rings
// and byte counters update. Stops when no chip is actively transferring.
async function reconcileTicker() {
  const visible = await getVisible();
  let wantTicker = false;
  for (const id of visible) {
    const [download] = await chrome.downloads.search({ id });
    if (download && download.state === 'in_progress' && !download.paused) {
      wantTicker = true;
      break;
    }
  }
  const haveTicker = _tickTimer != null;
  if (wantTicker && !haveTicker) {
    _tickTimer = setInterval(tick, TICK_MS);
  } else if (!wantTicker && haveTicker) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}

async function tick() {
  const visible = await getVisible();
  for (const id of visible) {
    const [download] = await chrome.downloads.search({ id });
    if (download && download.state === 'in_progress') {
      await dispatchChanged(id);
    }
  }
}

// chrome.storage.session is not always cleared by the browser on shutdown, so we reset on first load.
chrome.runtime.onStartup.addListener(async () => {
  await setVisible(new Set());
  await setFlashed(new Set());
  await setEntered(new Set());
  await setNotifyOnDone(new Set());
  // Any connected tabs will be sent a fresh snapshot on next port event; no need to push here.
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'downloadbar') return;
  _ports.add(port);
  port.onDisconnect.addListener(() => _ports.delete(port));
  getSnapshot().then(async (msg) => {
    try { port.postMessage(msg); } catch { /* closed */ }
    await reconcileTicker();
  });
});

chrome.downloads.onCreated.addListener(async (item) => {
  const visible = await getVisible();
  visible.add(item.id);
  await setVisible(visible);
  const serialized = await serialize(item.id);
  if (serialized) await dispatch({ type: 'created', item: serialized });
});

// Called from onChanged on the in_progress->complete transition, so no per-id dedupe is needed.
async function maybeDrawAttention(id) {
  const notifyOnDoneIds = await getNotifyOnDone();
  let trigger = notifyOnDoneIds.has(id);
  if (!trigger) {
    const [download] = await chrome.downloads.search({ id });
    if (download) {
      const basename = (download.filename || '').split(/[\\/]/).pop();
      const ext = extFromFilename(basename);
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

chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state) {
    if (delta.state.current === 'complete') {
      await maybeDrawAttention(delta.id);
    } else if (delta.state.current === 'interrupted') {
      // The download won't complete, so any pending "Notify when done" flag is dead -- drop it.
      const notifyOnDoneIds = await getNotifyOnDone();
      if (notifyOnDoneIds.delete(delta.id)) await setNotifyOnDone(notifyOnDoneIds);
    }
  }
  await dispatchChanged(delta.id);
});

chrome.downloads.onErased.addListener(async (id) => {
  _iconCache.delete(id);
  const visible = await getVisible();
  if (visible.delete(id)) await setVisible(visible);
  const flashed = await getFlashed();
  if (flashed.delete(id)) await setFlashed(flashed);
  const entered = await getEntered();
  if (entered.delete(id)) await setEntered(entered);
  const notifyOnDoneIds = await getNotifyOnDone();
  if (notifyOnDoneIds.delete(id)) await setNotifyOnDone(notifyOnDoneIds);
  await dispatch({ type: 'erased', id });
});

const handlers = {
  getState: () => getSnapshot(),

  dismiss: async ({ id }) => {
    const visible = await getVisible();
    if (visible.delete(id)) {
      await setVisible(visible);
      await dispatch({ type: 'erased', id });
    }
  },

  dismissAll: async () => {
    const visible = await getVisible();
    const ids = [...visible];
    await setVisible(new Set());
    for (const id of ids) await dispatch({ type: 'erased', id });
  },

  // Open the file. If the dismissOnOpen setting is on (the default), also drop the chip from the
  // visibility set so the bar matches the user's mental model of "I'm done with this one." When
  // off, the chip stays put, matching classic Chrome behavior.
  open: async ({ id }) => {
    await chrome.downloads.open(id);
    const { dismissOnOpen } = await getSettings();
    if (dismissOnOpen) {
      const visible = await getVisible();
      if (visible.delete(id)) {
        await setVisible(visible);
        await dispatch({ type: 'erased', id });
      }
    }
  },
  show:       ({ id }) => chrome.downloads.show(id),
  pause:      ({ id }) => chrome.downloads.pause(id),
  resume:     ({ id }) => chrome.downloads.resume(id),
  cancel:     ({ id }) => chrome.downloads.cancel(id),

  retry: async ({ id }) => {
    const [original] = await chrome.downloads.search({ id });
    if (original && original.url) await chrome.downloads.download({ url: original.url });
  },

  openDownloadsPage:   () => chrome.tabs.create({ url: 'chrome://downloads' }),
  openDownloadsFolder: () => chrome.downloads.showDefaultFolder(),

  markFlashed: async ({ id }) => {
    const flashed = await getFlashed();
    if (flashed.has(id)) return;
    flashed.add(id);
    await setFlashed(flashed);
  },

  markEntered: async ({ id }) => {
    const entered = await getEntered();
    if (entered.has(id)) return;
    entered.add(id);
    await setEntered(entered);
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
    await dispatchChanged(id);
  },

  // Per-extension "Always notify for files of this type" toggle. Persistent across browser
  // restarts (chrome.storage.local). Applies to any future download of that extension, and to
  // the currently-in-progress chip if the toggle was flipped while it's still transferring --
  // maybeDrawAttention() consults the live set at completion time. The menu's checkmark also
  // pulls live via isAlwaysNotifyExt (below), so we don't have to push a per-chip refresh.
  setAlwaysNotifyExt: async ({ ext, enabled }) => {
    ext = extFromInput(ext);
    if (!ext) return;
    const alwaysNotifyExts = await getAlwaysNotifyExts();
    const isOn = alwaysNotifyExts.has(ext);
    if (enabled === isOn) return;
    if (enabled) alwaysNotifyExts.add(ext);
    else alwaysNotifyExts.delete(ext);
    await setAlwaysNotifyExts(alwaysNotifyExts);
  },

  // Live query for the menu's "Always notify..." checkmark. Cheaper than baking the bool into
  // every serialized item and refreshing all chips whenever the set changes.
  isAlwaysNotifyExt: async ({ ext }) => (await getAlwaysNotifyExts()).has(ext),

  // Read-only view of the always-notify set, for the options page.
  // Marshalled into an array to cross the SW boundary.
  getAlwaysNotifyExts: async () => [...await getAlwaysNotifyExts()],
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
