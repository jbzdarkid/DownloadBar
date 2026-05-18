// DownloadBar -- service worker (MV3).
// Tracks which download IDs are visible in the bar, persists the set in
// session storage, and pushes state to connected tabs via long-lived
// ports.

const VISIBLE_KEY = 'visibleIds';
const FLASHED_KEY = 'flashedIds';

const TICK_MS = 500;
const ICON_SIZE = 32; // chrome.downloads.getFileIcon supports 16 or 32.

async function loadSet(area, key) {
  const stored = await chrome.storage[area].get(key);
  return new Set(stored[key] || []);
}

function saveSet(area, key, set) {
  return chrome.storage[area].set({ [key]: [...set] });
}

const getVisible    = ()    => loadSet('session', VISIBLE_KEY);
const setVisible    = (set) => saveSet('session', VISIBLE_KEY, set);
const getFlashed    = ()    => loadSet('session', FLASHED_KEY);
const setFlashed    = (set) => saveSet('session', FLASHED_KEY, set);

/** @type {Set<chrome.runtime.Port>} */
const ports = new Set();

// OS-supplied icons keyed by download id. Icons are stable once the file
// exists, so cache forever and evict only on erase.
/** @type {Map<number, string>} */
const iconCache = new Map();

async function fetchIcon(id) {
  if (iconCache.has(id)) return iconCache.get(id);
  const url = await new Promise((resolve) => {
    chrome.downloads.getFileIcon(id, { size: ICON_SIZE }, (u) => {
      void chrome.runtime.lastError; // ignore "no file yet" errors
      resolve(u);
    });
  });
  if (url) iconCache.set(id, url);
  return url;
}

function serialize(dl) {
  return {
    id: dl.id,
    filename: dl.filename || '',
    basename: (dl.filename || '').split(/[\\/]/).pop(),
    url: dl.url,
    finalUrl: dl.finalUrl,
    mime: dl.mime,
    state: dl.state,
    paused: !!dl.paused,
    canResume: !!dl.canResume,
    error: dl.error,
    bytesReceived: dl.bytesReceived,
    totalBytes: dl.totalBytes,
    fileSize: dl.fileSize,
    startTime: dl.startTime,
    endTime: dl.endTime,
    estimatedEndTime: dl.estimatedEndTime,
    exists: dl.exists !== false
  };
}

async function getState() {
  const visible = await getVisible();
  const flashedIds = [...(await getFlashed())];
  if (visible.size === 0) return { items: [], flashedIds };

  const allDownloads = await chrome.downloads.search({});
  const byId = new Map(allDownloads.map(dl => [dl.id, dl]));

  // Prune visible IDs that no longer exist.
  let pruned = false;
  for (const id of [...visible]) {
    if (!byId.has(id)) { visible.delete(id); pruned = true; }
  }
  if (pruned) await setVisible(visible);

  // Newest first; the renderer slices.
  const items = [...visible]
    .map(id => serialize(byId.get(id)))
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

  // Attach cached icons; fetch missing ones async and rebroadcast on arrival.
  for (const item of items) {
    const cached = iconCache.get(item.id);
    if (cached) item.iconUrl = cached;
    else fetchIcon(item.id).then((url) => { if (url) broadcast(); });
  }

  return { items, flashedIds };
}

// chrome.downloads.onChanged fires only on sparse checkpoints, so bytes/ETA
// appear to freeze. While anything is transferring, poll every 500ms.
let tickTimer = null;
async function broadcast() {
  const state = await getState();
  for (const port of ports) {
    try { port.postMessage({ type: 'state', state }); } catch { /* port closed */ }
  }
  const wantTicker = state.items.some(i => i.state === 'in_progress' && !i.paused);
  const haveTicker = tickTimer != null;
  if (wantTicker && !haveTicker) {
    tickTimer = setInterval(broadcast, TICK_MS);
  } else if (!wantTicker && haveTicker) {
    clearInterval(tickTimer);
    tickTimer = null;
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
  iconCache.delete(id);
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
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  getState().then(state => {
    try { port.postMessage({ type: 'state', state }); } catch { /* closed */ }
  });
});

// ---- one-shot action messages ----

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
    const [orig] = await chrome.downloads.search({ id });
    if (orig && orig.url) await chrome.downloads.download({ url: orig.url });
  },

  openDownloadsPage: () => chrome.tabs.create({ url: 'chrome://downloads' }),

  markFlashed: async ({ id }) => {
    const flashed = await getFlashed();
    if (!flashed.has(id)) { flashed.add(id); await setFlashed(flashed); }
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && handlers[msg.action];
  if (!handler) { sendResponse({ ok: false, error: 'unknown action' }); return; }
  Promise.resolve(handler(msg))
    .then((result) => sendResponse(result !== undefined ? result : { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async response
});
