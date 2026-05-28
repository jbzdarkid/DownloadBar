// DownloadBar -- renderer orchestrator.
// Handles initial UI injection (mount) and regular updates (render).

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.ui) return;
  const { el } = NS.dom;
  const { progressRingSvg, closeIconSvg, caretIconSvg } = NS.svg;
  const { statusText, progressState, progressPct } = NS.format;
  const { closeAnyMenu, buildMenu } = NS.menu;

  let _chipList = null;
  let _sendAction = null;
  const _flashStartedAt = new Map();

  // Split a filename so the extension stays visible while CSS ellipsizes only the basename.
  function splitExt(name) {
    if (!name) return ['', ''];
    const ext = extFromFilename(name);
    if (!ext) return [name, ''];
    const cut = name.length - ext.length - 1; // include the leading dot
    return [name.slice(0, cut), name.slice(cut)];
  }

  function mount(root, actions) {
    // Inline <style> rather than a separate .css file. See styles.js for more details.
    root.appendChild(el('style', null, NS.STYLES));

    _chipList = el('div', { class: 'db-items' });
    root.appendChild(el('div',
      {
        class: 'db-bar',
        onclick: () => closeAnyMenu(root), // Close any open menu when clicking elsewhere in the bar.
        oncontextmenu: (e) => e.preventDefault() // Suppress the existing context menu
      },
      _chipList,
      el('div', { class: 'db-tail' },
        el('button', {
          class: 'db-show-all',
          title: NS.caps.showAllTooltip,
          onclick: () => actions(NS.caps.showAllAction)
        }, 'Show all'),
        el('button', {
          class: 'db-close', title: 'Close',
          // stopPropagation prevents the container click handler from firing and closing any open chip menus.
          onclick: (e) => {
            e.stopPropagation();
            e.preventDefault();
            actions('dismissAll');
          }
        },
          closeIconSvg()
        )
      )
    ));

    // Add a handler to close any pop-up menu when we click outside the host.
    // Events that originate inside the closed shadow get retargeted to the host as they bubble out,
    // so we can detect "outside" by checking whether the composed target equals our host.
    // Caret/menu-button clicks call stopPropagation, so they never reach this listener.
    // contextmenu is wired up the same way so right-clicking outside the bar also dismisses.
    const hostEl = root.host;
    if (hostEl && hostEl.ownerDocument) {
      const dismissOnOutsideClick = (e) => {
        if (e.target !== hostEl) closeAnyMenu(root);
      };
      hostEl.ownerDocument.addEventListener('click', dismissOnOutsideClick, true);
      hostEl.ownerDocument.addEventListener('contextmenu', dismissOnOutsideClick, true);
    }

    _sendAction = actions;
  }

  function render(root, state) {
    if (!_chipList) return;

    closeAnyMenu(root);
    _chipList.replaceChildren();

    // Mirror Chrome 113's kMaxDownloadViews = 15 (download_shelf_view.cc)
    const visibleItems = state.items.slice(0, 15);

    if (!state.items.length) {
      _flashStartedAt.clear();
      return;
    }

    const liveIds = new Set();

    for (const item of visibleItems) {
      liveIds.add(item.id);
      _chipList.append(renderChip(item, root, state.flashedIds, state.enteredIds));
    }

    // Prune flash-start timestamps for chips that are no longer present.
    for (const id of [..._flashStartedAt.keys()]) if (!liveIds.has(id)) _flashStartedAt.delete(id);
  }

  function renderChip(item, root, flashedIds, enteredIds) {
    const isComplete = item.state === 'complete' && item.exists !== false;

    // Completion flash, deduped across two layers:
    //   1. _flashStartedAt -- in-memory, this mount only. Stores the start timestamp so a re-render
    //      mid-pulse can resume the CSS animation via a negative animation-delay instead of restarting it.
    //   2. flashedIds -- SW-tracked, persisted in session storage, so the flash doesn't re-fire in
    //      another tab or after an SW restart. We ack each new flash via _sendAction('markFlashed', id).
    const currState = progressState(item);
    const isNewChip = !enteredIds.includes(item.id);
    if (isNewChip) _sendAction('markEntered', item.id);
    const swFlashed = flashedIds && flashedIds.includes(item.id);
    if (isComplete && !_flashStartedAt.has(item.id) && !swFlashed) {
      _flashStartedAt.set(item.id, Date.now());
      _sendAction('markFlashed', item.id);
    }
    // A flash is "active" for 2500 ms after it starts.
    const startedAt = _flashStartedAt.get(item.id);
    const flashElapsed = startedAt != null ? Date.now() - startedAt : Infinity;
    const shouldFlash = flashElapsed < 2500;

    // Progress ring overlay: drawn while the download is active, and pulse as a full ring during the full flash.
    // Mirrors Chrome 113's PaintDownloadProgress.
    let ringPct;
    if (shouldFlash) ringPct = 100;
    else if (currState === 'in_progress' || currState === 'paused') ringPct = progressPct(item);
    else if (currState === 'indeterminate') ringPct = null;

    const iconWrap = el('div', {
      class: 'db-icon-wrap' + (shouldFlash ? ' db-icon-wrap--flash' : '')
    },
      ringPct !== undefined ? progressRingSvg(ringPct) : null,
      item.iconUrl ? el('img', { class: 'db-os-icon', src: item.iconUrl, alt: '' }) : null
    );
    if (shouldFlash) {
      iconWrap.style.setProperty('--db-flash-delay', `-${flashElapsed | 0}ms`);
    }

    const [baseName, extName] = splitExt(item.basename || item.url || '(unknown)');
    // Completed chips drop the status row entirely (a single centered filename).
    const status = statusText(item);
    const text = el('div', { class: 'db-text' },
      el('div', { class: 'db-name' },
        el('span', { class: 'db-name__base' }, baseName),
        extName ? el('span', { class: 'db-name__ext' }, extName) : null
      ),
      status ? el('div', { class: 'db-status' }, status) : null
    );

    let card; // forward-declared so caret handler can find its menu host.

    function toggleCaretMenu(e) {
      e.stopPropagation();
      e.preventDefault();
      const existing = card.querySelector('.db-menu');
      closeAnyMenu(root);
      if (!existing) {
        card.append(buildMenu(item, _sendAction, root));
        caret.classList.add('db-caret--open');
      }
    }
    const caret = el('button', {
      class: 'db-caret', title: 'More actions',
      onclick: toggleCaretMenu,
      oncontextmenu: toggleCaretMenu
    },
      caretIconSvg()
    );

    // In-progress chips are also clickable: a body-click toggles "Notify when done" for that download,
    // mirroring Chrome 113's "open when done" behavior.
    const isInProgress = item.state === 'in_progress';

    let onChipClick;
    if (isComplete) {
      onChipClick = () => {
        if (card.querySelector('.db-menu')) return;
        _sendAction(NS.caps.defaultClickAction, item.id);
      };
    } else if (isInProgress) {
      onChipClick = () => {
        if (card.querySelector('.db-menu')) return;
        _sendAction('setNotifyWhenDone', item.id, { enabled: !item.notifyWhenDone });
      };
    }

    card = el('div', {
      class: 'db-item' + (isNewChip ? ' db-item--enter' : ''),
      dataset: {
        clickable: onChipClick ? '1' : '0'
      },
      title: item.filename || item.basename,
      onclick: onChipClick,
      // If you right click anywhere else on the card, it should pop a menu at the cursor (instead of the caret).
      oncontextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAnyMenu(root);
        const menu = buildMenu(item, _sendAction, root);
        menu.style.position = 'fixed';
        menu.style.right = 'auto';
        menu.style.top = 'auto';
        menu.style.left = `${e.clientX}px`;
        menu.style.bottom = `${window.innerHeight - e.clientY}px`;
        root.appendChild(menu); // Append to the shadow root so we don't clip at the chip boundary.
      }
    });

    card.append(iconWrap, text, caret);
    return card;
  }

  window.DownloadBar = NS.ui = { mount, render };
})();
