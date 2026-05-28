// DownloadBar -- chip dropdown menu builder.
// Menu shape adapted from the Chrome 113 reference capture (see docs/SHELF_BEHAVIOR.md).

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.menu) return;

  // Build a click handler that fires `{ action, id: item.id }` to the SW. Actions that need
  // additional payload fields stay inline at their call site.
  function onAction(action, item) {
    return function() {
      chrome.runtime.sendMessage({ action, id: item.id });
    };
  }

  async function buildMenu(item, closeAllMenus) {
    const { el } = NS.dom;
    const { menuCheckSvg } = NS.svg;

    // "Always notify for files of this type" is per-extension and lives on the SW; query its
    // current state instead of relying on a serialized snapshot, so the checkmark is correct
    // even after the user toggled the same ext on a different chip a moment ago.
    const alwaysNotifyExt = item.ext
      ? !!(await chrome.runtime.sendMessage({ action: 'isAlwaysNotifyExt', ext: item.ext }))
      : false;

    const menu = el('div', { class: 'db-menu', onclick: (e) => e.stopPropagation() });

    const add = (label, fn, opts = {}) => {
      const btn = el('button', {
        class: 'db-menu-item' + (opts.checked ? ' db-menu-item--checked' : ''),
        disabled: !!opts.disabled || undefined,
        onclick: opts.disabled ? undefined : () => {
          closeAllMenus();
          fn();
        }
      },
        el('span', { class: 'db-menu-check', 'aria-hidden': 'true' },
          opts.checked ? menuCheckSvg() : null
        ),
        el('span', { class: 'db-menu-label' }, label)
      );
      menu.append(btn);
    };
    const sep = () => menu.append(document.createElement('hr'));

    // "Notify when done" and "Always notify for files of this type" are independent toggles;
    // the row reads as checked whenever either is on, since the per-extension rule subsumes it.
    const toggleNotify = () => chrome.runtime.sendMessage({ action: 'setNotifyWhenDone', id: item.id, enabled: !item.notifyWhenDone });
    const toggleAlways = () => chrome.runtime.sendMessage({ action: 'setAlwaysNotifyExt', ext: item.ext, enabled: !alwaysNotifyExt });

    if (item.state === 'in_progress') {
      add('Notify when done', toggleNotify, { checked: item.notifyWhenDone || alwaysNotifyExt });
      if (item.ext) {
        add('Always notify for files of this type', toggleAlways, { checked: alwaysNotifyExt });
      }
      sep();
      if (item.paused) {
        add('Resume', onAction('resume', item), { disabled: !item.canResume });
      } else {
        add('Pause', onAction('pause', item));
      }
      add('Show in folder', onAction('show', item));
      sep();
      add('Cancel', onAction('cancel', item));

    } else if (item.state === 'complete') {
      if (item.exists !== false) {
        if (NS.caps.canOpenFiles) {
          add('Open', onAction('open', item));
        }
        if (item.ext) {
          add('Always notify for files of this type', toggleAlways, { checked: alwaysNotifyExt });
        }
        add('Show in folder', onAction('show', item));
        sep();
      }
      add('Remove from list', onAction('dismiss', item));

    } else if (item.state === 'interrupted') {
      // Resume preserves partial bytes; Retry re-requests from byte 0 via downloads.download.
      if (item.canResume) {
        add('Resume', onAction('resume', item));
      } else {
        add('Retry', onAction('retry', item));
      }
      sep();
      add('Remove from list', onAction('dismiss', item));
    }

    return menu;
  }

  NS.menu = { buildMenu };
})();


