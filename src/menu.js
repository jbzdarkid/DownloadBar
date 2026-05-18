// DownloadBar -- chip dropdown menu builder.
// Menu shape adapted from the Chrome 113 reference capture (see
// docs/SHELF_BEHAVIOR.md and screenshots 07/08). Chrome's in-progress menu
// also offered "Open when done" and "Always open files of this type";
// both require the SW to auto-invoke chrome.downloads.open() on completion
// without user activation, which recent Chrome versions reject. Both items
// are dropped rather than shipped as disabled stubs.
//   in_progress / paused : 2 items + separator + Cancel
//   complete             : 2 items + separator + Remove from list

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.menu) return;

  function closeAnyMenu(root) {
    root.querySelectorAll('.db-menu').forEach(m => m.remove());
    // Reset every open caret so dismissing the menu via *any* path (outside
    // click, item activation, re-render) leaves the chip visually consistent.
    // CSS rotates the chevron based on db-caret--open, so removing the class
    // is sufficient to flip it back to pointing up.
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
      add(item.paused ? 'Resume' : 'Pause',
          () => actions(item.paused ? 'resume' : 'pause', item.id),
          { disabled: !item.paused && !item.canResume && item.bytesReceived === 0 });
      add('Show in folder', () => actions('show', item.id), { disabled: !item.filename });
      sep();
      add('Cancel', () => actions('cancel', item.id));
    } else if (item.state === 'complete' && item.exists !== false) {
      add('Open', () => actions('open', item.id));
      add('Show in folder', () => actions('show', item.id));
      sep();
      add('Remove from list', () => actions('dismiss', item.id));
    } else if (item.state === 'interrupted') {
      add('Retry', () => actions('retry', item.id));
      sep();
      add('Remove from list', () => actions('dismiss', item.id));
    } else {
      add('Remove from list', () => actions('dismiss', item.id));
    }

    return menu;
  }

  NS.menu = { closeAnyMenu, buildMenu };
})();
