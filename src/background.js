// DownloadBar -- service worker (MV3).
// Tracks which download IDs are visible in the bar, persists the set in session storage,
// and pushes state to connected tabs via long-lived ports.

const VISIBLE_KEY = 'visibleIds';
const FLASHED_KEY = 'flashedIds';

const TICK_MS = 500;
const ICON_SIZE = 32; // chrome.downloads.getFileIcon supports 16 or 32.

// Authoritative in-memory copies of the two persisted Sets. Storage is RAM-backed (chrome.storage.session
// is cleared when the browser closes), so we hydrate once on first access and treat memory as the source of
// truth thereafter; setX still writes through so other SW invocations after a restart can rehydrate.
let _visible = null;
let _flashed = null;

async function getVisible() {
  if (_visible === null) {
    const stored = await chrome.storage.session.get(VISIBLE_KEY);
    _visible = new Set(stored[VISIBLE_KEY] || []);
  }
  return _visible;
}

async function setVisible(set) {
  _visible = set;
  await chrome.storage.session.set({ [VISIBLE_KEY]: [...set] });
}

async function getFlashed() {
  if (_flashed === null) {
    const stored = await chrome.storage.session.get(FLASHED_KEY);
    _flashed = new Set(stored[FLASHED_KEY] || []);
  }
  return _flashed;
}

async function setFlashed(set) {
  _flashed = set;
  await chrome.storage.session.set({ [FLASHED_KEY]: [...set] });
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
function serialize(download) {
  return {
    id: download.id,
    filename: download.filename || '',
    basename: (download.filename || '').split(/[\\/]/).pop(),
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
    exists: download.exists !== false
  };
}

async function getState() {
  const visible = await getVisible();

  // Resolve each visible id to a download record in parallel; drop ids whose download no longer exists.
  const lookup = async (id) => {
    const [download] = await chrome.downloads.search({ id });
    if (download) return serialize(download);
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

chrome.downloads.onChanged.addListener(() => broadcast());

chrome.downloads.onErased.addListener(async (id) => {
  _iconCache.delete(id);
  const visible = await getVisible();
  if (visible.delete(id)) await setVisible(visible);
  const flashed = await getFlashed();
  if (flashed.delete(id)) await setFlashed(flashed);
  broadcast();
});

// Restart the ticker on SW boot if a download is already in progress.
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
