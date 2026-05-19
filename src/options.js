// DownloadBar -- options page glue.
// One row per boolean setting; writes back on change. The checkbox state is its own feedback,
// so there's no "saved" indicator -- chrome.storage.sync resolves immediately and the service
// worker reads settings on demand.

(async function () {
  const { el } = window.__DB.dom;
  const settings = await getSettings();
  const root = document.getElementById('root');

  // ---- boolean settings --------------------------------------------------------------------

  // A single row: checkbox + title + description. Clicking the label toggles the checkbox via
  // for=/id= pairing, which is also what gives us keyboard activation for free.
  function setting(key, title, desc) {
    const id = `opt-${key}`;
    const box = el('input', {
      type: 'checkbox',
      id,
      checked: !!settings[key],
      onchange: () => setSettings({ [key]: box.checked }),
    });
    return el('div', { class: 'setting' },
      box,
      el('label', { for: id },
        el('span', { class: 'title' }, title),
        el('span', { class: 'desc' }, desc),
      ),
    );
  }

  root.append(
    setting(
      'dismissOnOpen',
      'Remove chip from the bar after opening',
      'When you click a completed download, open the file and also clear it from the bar. ' +
      'Turn this off to match classic Chrome, which left the chip in place after opening.',
    ),
  );

  // ---- always-notify extensions ------------------------------------------------------------

  // alwaysNotifyExts is SW-cached (see SW_CACHED_STORAGE_KEYS in settings.js), so reads and
  // writes both go through the SW. normalizeExt() is the same one the SW validates with, so
  // page-side rejection here matches what the SW would have rejected anyway.
  const sendMsg = (action, payload) => chrome.runtime.sendMessage({ action, ...payload });

  const list = el('div', { class: 'ext-list' });
  const input = el('input', {
    type: 'text',
    class: 'ext-input',
    placeholder: 'e.g. pdf',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
  });
  const addBtn = el('button', { class: 'ext-add', type: 'button', onclick: onAdd }, 'Add');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onAdd(); }
  });

  async function refresh() {
    const exts = await sendMsg('getAlwaysNotifyExts');
    exts.sort();
    if (!exts.length) {
      list.replaceChildren(el('span', { class: 'ext-empty' }, 'No file types yet.'));
      return;
    }
    const chips = [];
    for (const ext of exts) {
      chips.push(el('button', {
        class: 'ext-chip',
        type: 'button',
        title: `Remove .${ext}`,
        'aria-label': `Remove .${ext}`,
        onclick: () => onRemove(ext),
      }, '.' + ext));
    }
    list.replaceChildren(...chips);
  }

  function onAdd() {
    const ext = normalizeExt(input.value);
    if (!ext) {
        // Highlight and re-select the input text if it was invalid
        input.focus();
        input.select();
        return;
    }
    input.value = '';
    sendMsg('setAlwaysNotifyExt', { ext, enabled: true });
  }

  function onRemove(ext) {
    sendMsg('setAlwaysNotifyExt', { ext, enabled: false });
  }

  // The set lives in chrome.storage.local; anything that mutates it (this page, a chip menu in
  // the bar, the SW responding to a download) fires onChanged in every extension context. Listen
  // so the list stays in sync without polling.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.alwaysNotifyExts) refresh();
  });

  root.append(
    el('section', null,
      el('h2', null, 'Always notify for these file types'),
      el('p', null,
        'When a download with one of these extensions finishes, the Chrome taskbar button ' +
        'flashes to draw your attention. You can also toggle this per-extension from any ' +
        'chip\u2019s menu.',
      ),
      list,
      el('div', { class: 'ext-add-row' }, input, addBtn),
    ),
  );

  refresh();
})();



