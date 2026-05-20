// DownloadBar -- chip dropdown menu builder.
// Menu shape adapted from the Chrome 113 reference capture (see docs/SHELF_BEHAVIOR.md).

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.menu) return;

  function closeAnyMenu(root) {
    root.querySelectorAll('.db-menu').forEach(m => m.remove());
    // Reset every open caret so dismissing the menu via *any* path (outside click, item activation, re-render)
    // leaves the chip visually consistent. CSS rotates the chevron based on db-caret--open,
    // so removing the class is sufficient to flip it back to pointing up.
    root.querySelectorAll('.db-caret--open').forEach(c => {
      c.classList.remove('db-caret--open');
    });
  }

  function buildMenu(item, actions, root) {
    const { el } = NS.dom;
    const { menuCheckSvg } = NS.svg;

    const menu = el('div', { class: 'db-menu', onclick: (e) => e.stopPropagation() });

    const add = (label, fn, opts = {}) => {
      const btn = el('button', {
        class: 'db-menu-item' + (opts.checked ? ' db-menu-item--checked' : ''),
        disabled: !!opts.disabled || undefined,
        onclick: opts.disabled ? undefined : () => {
          closeAnyMenu(root);
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
    // These two need payload fields beyond {action, id}, so they bypass the strict actions() helper.
    const toggleNotify = () => chrome.runtime.sendMessage({ action: 'setNotifyWhenDone', id: item.id, enabled: !item.notifyWhenDone });
    const toggleAlways = () => chrome.runtime.sendMessage({ action: 'setAlwaysNotifyExt', ext: item.ext, enabled: !item.alwaysNotifyExt });

    if (item.state === 'in_progress') {
      add('Notify when done', toggleNotify, { checked: item.notifyWhenDone || item.alwaysNotifyExt });
      if (item.ext) {
        add('Always notify for files of this type', toggleAlways, { checked: item.alwaysNotifyExt });
      }
      sep();
      if (item.paused) {
        add('Resume', () => actions('resume', item.id), { disabled: !item.canResume });
      } else {
        add('Pause', () => actions('pause', item.id));
      }
      add('Show in folder', () => actions('show', item.id));
      sep();
      add('Cancel', () => actions('cancel', item.id));

    } else if (item.state === 'complete') {
      if (item.exists !== false) {
        if (NS.caps.canOpenFiles) {
          add('Open', () => actions('open', item.id));
        }
        if (item.ext) {
          add('Always notify for files of this type', toggleAlways, { checked: item.alwaysNotifyExt });
        }
        add('Show in folder', () => actions('show', item.id));
        sep();
      }
      add('Remove from list', () => actions('dismiss', item.id));

    } else if (item.state === 'interrupted') {
      // Resume preserves partial bytes; Retry re-requests from byte 0 via downloads.download.
      if (item.canResume) {
        add('Resume', () => actions('resume', item.id));
      } else {
        add('Retry', () => actions('retry', item.id));
      }
      sep();
      add('Remove from list', () => actions('dismiss', item.id));
    }

    return menu;
  }

  NS.menu = { closeAnyMenu, buildMenu };
})();
