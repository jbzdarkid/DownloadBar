// DownloadBar — service worker (MV3).
// Tracks which download IDs are visible in the bar, persists the set in
// session storage, and pushes state to connected tabs/popups via long-lived
// ports.

const VISIBLE_KEY = 'visibleIds';
const FLASHED_KEY = 'flashedIds';
// User's "always open files of this type" extensions (lowercased, no dot).
// Only honored at the moment of toggle, when chrome.downloads.open() still
// has user activation from the menu click. See DESIGN.md.
const ALWAYS_OPEN_KEY = 'alwaysOpenExts';

const TICK_MS = 500;
const ICON_SIZE = 32; // chrome.downloads.getFileIcon supports 16 or 32.

async function getSet(area, key) {
  const obj = await chrome.storage[area].get(key);
  return new Set(obj[key] || []);
}

function putSet(area, key, set) {
  return chrome.storage[area].set({ [key]: [...set] });
}

const getVisible    = () => getSet('session', VISIBLE_KEY);
const setVisible    = (s) => putSet('session', VISIBLE_KEY, s);
const getFlashed    = () => getSet('session', FLASHED_KEY);
const setFlashed    = (s) => putSet('session', FLASHED_KEY, s);
const getAlwaysOpen = () => getSet('local',   ALWAYS_OPEN_KEY);
const setAlwaysOpen = (s) => putSet('local',   ALWAYS_OPEN_KEY, s);

function extOf(filename) {
  if (!filename) return '';
  const base = String(filename).split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** @type {Set<chrome.runtime.Port>} */
const ports = new Set();

// OS-supplied icons keyed by download id. Icons are stable once the file
// exists, so cache forever and evict only on erase.
/** @type {Map<number, string>} */
const iconCache = new Map();
/** @type {Map<number, Promise<string|undefined>>} */
const iconPending = new Map();

function fetchIcon(id) {
  if (iconCache.has(id)) return Promise.resolve(iconCache.get(id));
  if (iconPending.has(id)) return iconPending.get(id);
  const p = new Promise((resolve) => {
    chrome.downloads.getFileIcon(id, { size: ICON_SIZE }, (url) => {
      void chrome.runtime.lastError; // ignore "no file yet" errors
      if (url) iconCache.set(id, url);
      resolve(url);
    });
  }).finally(() => iconPending.delete(id));
  iconPending.set(id, p);
  return p;
}

function serialize(d) {
  return {
    id: d.id,
    filename: d.filename || '',
    basename: (d.filename || '').split(/[\\/]/).pop(),
    url: d.url,
    finalUrl: d.finalUrl,
    referrer: d.referrer || '',
    mime: d.mime,
    state: d.state,
    paused: !!d.paused,
    canResume: !!d.canResume,
    error: d.error,
    bytesReceived: d.bytesReceived,
    totalBytes: d.totalBytes,
    fileSize: d.fileSize,
    startTime: d.startTime,
    endTime: d.endTime,
    estimatedEndTime: d.estimatedEndTime,
    exists: d.exists !== false
  };
}

async function getState() {
  const visible = await getVisible();
  const alwaysOpenExts = [...(await getAlwaysOpen())];
  const flashedIds = [...(await getFlashed())];
  if (visible.size === 0) return { items: [], alwaysOpenExts, flashedIds };

  const all = await chrome.downloads.search({});
  const byId = new Map(all.map(d => [d.id, d]));

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
  for (const it of items) {
    const cached = iconCache.get(it.id);
    if (cached) it.iconUrl = cached;
    else fetchIcon(it.id).then((url) => { if (url) broadcast(); });
  }

  return { items, alwaysOpenExts, flashedIds };
}

async function broadcast() {
  const state = await getState();
  for (const port of ports) {
    try { port.postMessage({ type: 'state', state }); } catch { /* port closed */ }
  }
  syncTicker(state);
  return state;
}

// chrome.downloads.onChanged fires only on sparse checkpoints, so bytes/ETA
// appear to freeze. While anything is transferring, poll every 500ms.
let tickTimer = null;
function syncTicker(state) {
  const active = state.items.some(i => i.state === 'in_progress' && !i.paused);
  if (active && tickTimer == null) tickTimer = setInterval(broadcast, TICK_MS);
  else if (!active && tickTimer != null) { clearInterval(tickTimer); tickTimer = null; }
}

chrome.downloads.onCreated.addListener(async (item) => {
  const s = await getVisible();
  s.add(item.id);
  await setVisible(s);
  broadcast();
});

chrome.downloads.onChanged.addListener(() => broadcast());

chrome.downloads.onErased.addListener(async (id) => {
  iconCache.delete(id);
  iconPending.delete(id);
  const v = await getVisible();
  if (v.delete(id)) await setVisible(v);
  const f = await getFlashed();
  if (f.delete(id)) await setFlashed(f);
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
    const s = await getVisible();
    if (s.delete(id)) await setVisible(s);
    broadcast();
  },

  dismissAll: async () => {
    await setVisible(new Set());
    broadcast();
  },

  open:       ({ id }) => chrome.downloads.open(id),
  show:       ({ id }) => chrome.downloads.show(id),
  showFolder: () => chrome.downloads.showDefaultFolder(),
  pause:      ({ id }) => chrome.downloads.pause(id),
  resume:     ({ id }) => chrome.downloads.resume(id),
  cancel:     ({ id }) => chrome.downloads.cancel(id),

  retry: async ({ id }) => {
    const [orig] = await chrome.downloads.search({ id });
    if (orig && orig.url) await chrome.downloads.download({ url: orig.url });
  },

  openDownloadsPage: () => chrome.tabs.create({ url: 'chrome://downloads' }),

  toggleAlwaysOpen: async ({ ext, id }) => {
    ext = String(ext || '').toLowerCase();
    if (!ext) throw new Error('no ext');
    const s = await getAlwaysOpen();
    const turnedOn = !s.has(ext);
    if (turnedOn) s.add(ext); else s.delete(ext);
    await setAlwaysOpen(s);
    // Open the toggled file now, while we still have user activation from
    // the menu click. Future downloads can't be auto-opened from the SW.
    if (turnedOn && Number.isFinite(Number(id))) {
      const [d] = await chrome.downloads.search({ id: Number(id) });
      if (d && d.state === 'complete' && extOf(d.filename) === ext) {
        try { await chrome.downloads.open(d.id); } catch { /* ignore */ }
      }
    }
    broadcast();
  },

  markFlashed: async ({ id }) => {
    id = Number(id);
    if (!Number.isFinite(id)) return;
    const f = await getFlashed();
    if (!f.has(id)) { f.add(id); await setFlashed(f); }
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = msg && handlers[msg.action];
  if (!fn) { sendResponse({ ok: false, error: 'unknown action' }); return; }
  Promise.resolve(fn(msg))
    .then((result) => sendResponse(result !== undefined ? result : { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // async response
});
