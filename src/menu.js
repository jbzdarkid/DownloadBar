// DownloadBar -- chip dropdown menu builder.
// Menu shape adapted from the Chrome 113 reference capture (see docs/SHELF_BEHAVIOR.md).
// "Open when done" and "Always open files of this type" are intentionally omitted: both require the SW to
// auto-invoke chrome.downloads.open() without user activation, which recent Chrome versions reject.

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

    const menu = el('div', { class: 'db-menu', onclick: (e) => e.stopPropagation() });

    const add = (label, fn, opts = {}) => {
      const btn = el('button', {
        class: 'db-menu-item',
        disabled: !!opts.disabled || undefined,
        onclick: opts.disabled ? undefined : () => {
          closeAnyMenu(root);
          fn();
        }
      },
        el('span', { class: 'db-menu-label' }, label)
      );
      menu.append(btn);
    };
    const sep = () => menu.append(document.createElement('hr'));

    if (item.state === 'in_progress') {
      if (item.paused) {
        add('Resume', () => actions('resume', item.id));
      } else {
        add('Pause', () => actions('pause', item.id), { disabled: !item.canResume && item.bytesReceived === 0 });
      }
      add('Show in folder', () => actions('show', item.id), { disabled: !item.filename });
      sep();
      add('Cancel', () => actions('cancel', item.id));

    } else if (item.state === 'complete') {
      if (item.exists !== false) {
        add('Open', () => actions('open', item.id));
        add('Show in folder', () => actions('show', item.id));
        sep();
      }
      add('Remove from list', () => actions('dismiss', item.id));

    } else if (item.state === 'interrupted') {
      add('Retry', () => actions('retry', item.id));
      sep();
      add('Remove from list', () => actions('dismiss', item.id));
    }

    return menu;
  }

  NS.menu = { closeAnyMenu, buildMenu };
})();
