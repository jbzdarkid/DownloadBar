// DownloadBar -- renderer orchestrator.
// Consumes helpers from window.__DB (styles, dom, svg, format, menu) and exposes
// the public window.DownloadBar surface used by content.js:
//   mount(root, actions)   -- install stylesheet + chrome skeleton into a
//                            shadow root, prime per-mount state.
//   render(root, state)    -- re-render the chip list from a state snapshot.

(function () {
  if (window.DownloadBar) return;
  const NS = window.__DB || {};
  const { el } = NS.dom;
  const { strokeIconSvg, progressRingSvg } = NS.svg;
  const { statusText, progressState, progressPct } = NS.format;
  const { closeAnyMenu, buildMenu } = NS.menu;

  let _chipList = null;
  let _sendAction = null;
  const _seenDownloadIds = new Set();
  const _flashed = new Set();
  const _flashStartedAt = new Map();

  // Split a filename so the extension stays visible while CSS ellipsizes only the basename.
  // "Firefox News - Foo.html" -> ["Firefox News - Foo", ".html"]
  function splitExt(name) {
    if (!name) return ['', ''];
    const i = name.lastIndexOf('.');
    if (i <= 0 || i === name.length - 1) return [name, ''];
    return [name.slice(0, i), name.slice(i)];
  }

  function mount(root, actions) {
    // Inline <style> rather than a separate .css file. See styles.js for more details.
    root.appendChild(el('style', null, NS.STYLES));

    _chipList = el('div', { class: 'db-items' });
    root.appendChild(el('div',
      {
        class: 'db-bar',
        onclick: () => closeAnyMenu(root) // Close any open menu when clicking elsewhere in the bar.
      },
      _chipList,
      el('div', { class: 'db-tail' },
        el('button', {
          class: 'db-show-all', title: 'Show all downloads',
          onclick: () => actions('openDownloadsPage')
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
    const hostEl = root.host;
    if (hostEl && hostEl.ownerDocument) {
      hostEl.ownerDocument.addEventListener('click', (e) => {
        if (e.target !== hostEl) closeAnyMenu(root);
      }, true);
    }

    _sendAction = actions;
  }

  function render(root, state) {
    if (!_chipList) return;

    closeAnyMenu(root);
    _chipList.replaceChildren();

    // Mirror Chrome 113's kMaxDownloadViews = 15 (download_shelf_view.cc): keep at most 15 chips in the
    // DOM and rely on flex/clip-path to hide any whose right edge overlaps the trailing cluster.
    const visibleItems = state.items.slice(0, 15);

    if (!state.items.length) {
      // Reset transition tracking when the bar empties, so a later
      // download that reuses an old ID doesn't suppress its flash.
      _seenDownloadIds.clear();
      _flashed.clear();
      _flashStartedAt.clear();
      return;
    }

    const nextSeen = new Set();
    const liveIds = new Set();

    for (const item of visibleItems) {
      const isComplete = item.state === 'complete' && item.exists !== false;

      // Completion flash. Coordinated via two layers:
      //   1. flashed: in-memory dedup for this mount lifetime.
      //   2. state.flashedIds: SW-tracked set persisted in session storage, so the flash doesn't re-fire
      //      in another tab or after SW restart. The renderer acks every new flash via
      //      dispatch('markFlashed', id).
      const currState = progressState(item);
      const isNewChip = !_seenDownloadIds.has(item.id);
      const swFlashed = state.flashedIds && state.flashedIds.includes(item.id);
      if (isComplete && !_flashed.has(item.id) && !swFlashed) {
        _flashed.add(item.id);
        _flashStartedAt.set(item.id, Date.now());
        _sendAction('markFlashed', item.id);
      }
      // A flash is "active" if it started within the 2500 ms window. Re-renders during that window
      // re-apply the class with a negative animation-delay so the animation appears continuous.
      const startedAt = _flashStartedAt.get(item.id);
      const flashElapsed = startedAt != null ? Date.now() - startedAt : Infinity;
      const shouldFlash = flashElapsed < 2500;
      nextSeen.add(item.id);
      liveIds.add(item.id);

      const iconWrap = el('div', {
        class: 'db-icon-wrap' + (shouldFlash ? ' db-icon-wrap--flash' : '')
      });
      if (shouldFlash) {
        // Negative delay fast-forwards the CSS animation to the elapsed position, so a re-render mid-flash
        // doesn't restart at frame 0.
        iconWrap.style.setProperty('--db-flash-delay', `-${flashElapsed | 0}ms`);
      }
      // Progress ring overlay: drawn while the download is active, and again (as a full-circle,
      // opacity-pulsed full ring) during the 2500ms completion flash. Matches legacy Chrome 113's
      // PaintDownloadProgress.
      if (shouldFlash) {
        iconWrap.append(progressRingSvg(100));
      } else if (currState === 'in_progress' || currState === 'paused') {
        iconWrap.append(progressRingSvg(progressPct(item)));
      } else if (currState === 'indeterminate') {
        iconWrap.append(progressRingSvg(null));
      }
      // Primary icon: the OS-supplied file icon (chrome.downloads.getFileIcon in the service worker,
      // propagated via state.iconUrl). This is what the legacy Chrome 113 shelf shows -- the same icon
      // Windows Explorer would draw for the file. While the SW is still fetching it, the icon slot stays
      // blank (matching the legacy DownloadItemView, which draws nothing until the IconManager cache
      // lookup returns).
      if (item.iconUrl) {
        iconWrap.append(el('img', { class: 'db-os-icon', src: item.iconUrl, alt: '' }));
      }

      const [baseName, extName] = splitExt(item.basename || item.url || '(unknown)');
      // Completed chips drop the status row entirely (a single centered filename). The
      // interrupted-but-not-canceled case gets the red tint; canceled stays neutral grey, matching the
      // reference recording.
      const status = statusText(item);
      const textChildren = [
        el('div', { class: 'db-name' },
          el('span', { class: 'db-name__base' }, baseName),
          extName && el('span', { class: 'db-name__ext' }, extName)
        )
      ];
      if (status) {
        textChildren.push(el('div', {
          class: 'db-status' +
            (currState === 'interrupted' ? ' db-status--error' : '')
        }, status));
      }
      const text = el('div', { class: 'db-text' }, ...textChildren);

      let card; // forward-declared so caret handler can find its menu host.

      const caret = el('button', {
        class: 'db-caret', title: 'More actions',
        onclick: (e) => {
          e.stopPropagation();
          e.preventDefault();
          const existing = card.querySelector('.db-menu');
          closeAnyMenu(root);
          if (!existing) {
            card.append(buildMenu(item, _sendAction, root));
            caret.classList.add('db-caret--open');
          }
        }
      });
      caret.append(caretIconSvg());

      // In-progress chips are also clickable: a body-click toggles "Notify when done" for that
      // download, mirroring Chrome 113's behavior where clicking an in-progress chip set
      // open_when_complete on the underlying DownloadItem. The menu's "Notify when done" row is the
      // secondary affordance with the explicit checkmark. Body-click is a no-op visual while the
      // per-extension always-rule is on (the flash would happen anyway).
      const isInProgress = item.state === 'in_progress';
      card = el('div', {
        class: 'db-item' + (isNewChip ? ' db-item--enter' : ''),
        draggable: isComplete,
        dataset: {
          state: progressState(item),
          clickable: (isComplete || isInProgress) ? '1' : '0'
        },
        title: item.filename || item.basename,
        onclick: isComplete
          ? () => { if (!card.querySelector('.db-menu')) _sendAction('open', item.id); }
          : isInProgress
            ? () => {
                if (card.querySelector('.db-menu')) return;
                _sendAction('setNotifyWhenDone', item.id, { enabled: !item.notifyWhenDone });
              }
            : undefined,
        ondragstart: isComplete ? (e) => onDragStart(e, item) : undefined
      });

      card.append(iconWrap, text, caret);
      _chipList.append(card);
    }

    // Commit next state and prune flashed IDs that are no longer present.
    _seenDownloadIds.clear();
    for (const id of nextSeen) _seenDownloadIds.add(id);
    for (const id of [..._flashed]) if (!liveIds.has(id)) _flashed.delete(id);
    for (const id of [..._flashStartedAt.keys()]) if (!liveIds.has(id)) _flashStartedAt.delete(id);
  }

  function onDragStart(e, item) {
    const name = item.basename || 'download';
    const url = item.finalUrl || item.url || '';
    const mime = item.mime || 'application/octet-stream';
    try {
      e.dataTransfer.setData('DownloadURL', `${mime}:${name}:${url}`);
      e.dataTransfer.setData('text/uri-list', url);
      e.dataTransfer.setData('text/plain', url);
      e.dataTransfer.effectAllowed = 'copy';
    } catch { /* ignore */ }
  }

  window.DownloadBar = { mount, render };
})();
