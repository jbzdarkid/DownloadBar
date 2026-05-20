// DownloadBar -- options page glue.

(async function () {
  const { el } = window.__DB.dom;
  const settings = await getSettings();
  const root = document.getElementById('root');

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

  // alwaysNotifyExts is in SW_CACHED_STORAGE_KEYS, so reads and writes must go through the SW.
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
    const ext = extFromInput(input.value);
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

  // Listen for changes to the underlying storage to trigger a refresh, since we don't own this data.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.alwaysNotifyExts) refresh();
  });

  root.append(
    el('section', null,
      el('h2', null, 'Always notify for these file types'),
      el('p', null,
        'When a download with one of these extensions finishes, ' +
        'the taskbar button flashes to draw your attention. ' +
        'You can also toggle this per-extension from the download popup menu.',
      ),
      list,
      el('div', { class: 'ext-add-row' }, input, addBtn),
    ),
  );

  refresh();
})();



