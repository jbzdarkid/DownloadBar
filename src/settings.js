// DownloadBar -- shared settings module.
// Loaded by the service worker via importScripts() and by options.html via a <script> tag,
// so every realm sees the same constants without a message round-trip.

// Keys which are owned by the service worker (SW).
// These must always be written via persistedSet() to avoid cache inconsistencies.
const SW_CACHED_STORAGE_KEYS = new Set(['visibleIds', 'flashedIds', 'notifyOnDoneIds', 'alwaysNotifyExts']);

async function writeStorage(area, key, value) {
  if (SW_CACHED_STORAGE_KEYS.has(key)) {
    throw new Error(`[DownloadBar] "${key}" is cached in the service worker and should not be written directly.`);
  }
  await chrome.storage[area].set({ [key]: value });
}

const SETTINGS_KEY = 'settings';

const SETTINGS_DEFAULTS = Object.freeze({
  dismissOnOpen: true,
});

async function getSettings() {
  const stored = (await chrome.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  return { ...SETTINGS_DEFAULTS, ...stored };
}

async function setSettings(partial) {
  const stored = (await chrome.storage.sync.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  for (const key of Object.keys(partial)) stored[key] = partial[key];
  await writeStorage('sync', SETTINGS_KEY, stored);
  return { ...SETTINGS_DEFAULTS, ...stored };
}

// Compound extensions treated as a single type when keying "always notify" preferences.
// This is a curated list, not a syntactic rule, since these are generally hybrid types.
const COMPOUND_EXTS = Object.freeze(new Set([
  'tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst', 'tar.lz', 'tar.lzma',
  'user.js', 'user.css',
  'min.js', 'min.css',
  'd.ts',
]));

// Two paths to the same token shape:
// - extFromFilename extracts the ext from a downloaded file's basename
// - extFromInput validates user-typed input from the options page.
// Both return a lowercase compound (tar.gz), a single segment (pdf), or '' if no usable ext is present.
// They intentionally diverge on multi-dot inputs, which are only valid for filenames.
// extFromFilename('something.foo.bar') == 'bar', extFromInput('something.foo.bar') == ''
function extFromFilename(filename) {
  const lower = (filename || '').toLowerCase();
  for (const compound of COMPOUND_EXTS) {
    if (lower.endsWith('.' + compound)) return compound;
  }
  const m = lower.match(/\.([a-z0-9_+-]+)$/);
  return m ? m[1] : '';
}

function extFromInput(input) {
  // Allows a leading dot since '.pdf' is a natural thing to type.
  const m = (input || '').trim().toLowerCase().match(/^\.?([.a-z0-9_+-]+)$/);
  if (!m) return '';
  const cleaned = m[1];
  return cleaned.includes('.') && !COMPOUND_EXTS.has(cleaned) ? '' : cleaned;
}


