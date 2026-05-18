// DownloadBar -- renderer orchestrator.
// Consumes helpers from window.__DB (styles, dom, format, menu) and exposes
// the public window.DownloadBar surface used by content.js:
//   mount(root, actions)   -- install stylesheet + chrome skeleton into a
//                            shadow root, prime per-mount state.
//   render(root, state)    -- re-render the chip list from a state snapshot.

(function () {
  if (window.DownloadBar) return;
  const NS = window.__DB || {};
  const { el } = NS.dom;
  const { statusText, progressState, progressPct } = NS.format;
  const { closeAnyMenu, buildMenu } = NS.menu;

  // Split a filename so the extension stays visible while CSS ellipsizes
  // only the basename. "Firefox News - Foo.html" -> ["Firefox News - Foo", ".html"]
  function splitExt(name) {
    if (!name) return ['', ''];
    const i = name.lastIndexOf('.');
    if (i <= 0 || i === name.length - 1) return [name, ''];
    return [name.slice(0, i), name.slice(i)];
  }

  // SVG progress ring drawn around the file-type icon while a download is
  // active, and again (as a full-circle pulse) during the completion flash.
  // Matches the geometry of Chrome 113's PaintDownloadProgress: 1.7 px
  // stroke, start at 12 o'clock, sweep clockwise. Indeterminate mode draws
  // a fixed 50-degree arc; CSS rotates the whole SVG to animate it.
  function progressRingSvg(percent, indeterminate) {
    const svgNs = 'http://www.w3.org/2000/svg';
    const r = 10.15;                 // circumference ~63.77 inside a 24x24 box
    const c = 2 * Math.PI * r;
    const fgLen = indeterminate ? (c * 50 / 360) : (c * Math.max(0, Math.min(100, percent)) / 100);
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('class', 'db-progress-ring' + (indeterminate ? ' db-progress-ring--indeterminate' : ''));
    svg.setAttribute('viewBox', '0 0 24 24');
    if (!indeterminate) {
      const bg = document.createElementNS(svgNs, 'circle');
      bg.setAttribute('class', 'db-progress-ring-bg');
      bg.setAttribute('cx', '12'); bg.setAttribute('cy', '12');
      bg.setAttribute('r', String(r));
      bg.setAttribute('stroke-width', '1.7');
      svg.appendChild(bg);
    }
    const fg = document.createElementNS(svgNs, 'circle');
    fg.setAttribute('class', 'db-progress-ring-fg');
    fg.setAttribute('cx', '12'); fg.setAttribute('cy', '12');
    fg.setAttribute('r', String(r));
    fg.setAttribute('stroke-width', '1.7');
    fg.setAttribute('stroke-linecap', 'butt');
    fg.setAttribute('stroke-dasharray', `${fgLen.toFixed(3)} ${c.toFixed(3)}`);
    // Rotate -90deg around the circle center so the dash starts at 12 o'clock.
    fg.setAttribute('transform', 'rotate(-90 12 12)');
    svg.appendChild(fg);
    return svg;
  }

  // Chrome 113 keeps up to kMaxDownloadViews = 15 download_item_views in
  // memory (download_shelf_view.cc). The shelf then hides any chip whose
  // right edge would overlap the trailing cluster. We mirror that: render
  // up to 15 chips, and rely on flex/clip-path to clip overflow.
  const BAR_CHIP_LIMIT = 15;
  const FLASH_MS = 2500;

  function mount(root, actions) {
    const styleEl = document.createElement('style');
    styleEl.textContent = NS.STYLES;
    root.appendChild(styleEl);

    const container = el('div', { class: 'db-bar' });
    const items = el('div', { class: 'db-items' });

    const showAllBtn = el('button', {
      class: 'db-show-all', title: 'Show all downloads',
      onclick: () => actions('openDownloadsPage')
    }, 'Show all');

    const tail = el('div', { class: 'db-tail' },
      showAllBtn,
      el('button', {
        class: 'db-close', title: 'Close',
        // stopPropagation prevents the container click handler from firing
        // and closing any open chip menus.
        onclick: (e) => { e.stopPropagation(); e.preventDefault(); actions('dismissAll'); }
      }, '\u2715')
    );

    container.append(items, tail);
    root.appendChild(container);

    // Close any open menu when clicking elsewhere in the bar.
    container.addEventListener('click', () => closeAnyMenu(root));

    // Close on outside click. Events that originate inside the closed shadow
    // get retargeted to the host as they bubble out, so we can detect
    // "outside" by checking whether the composed target equals our host.
    // Caret/menu-button clicks call stopPropagation, so they never reach
    // this listener and the menu they just opened stays put.
    const hostEl = root.host;
    if (hostEl && hostEl.ownerDocument) {
      hostEl.ownerDocument.addEventListener('click', (e) => {
        if (e.target !== hostEl) closeAnyMenu(root);
      }, true);
    }

    root.__db = {
      container, items, tail, showAllBtn, actions,
      // Tracks the rendered state of each download ID across renders so we
      // can detect transitions (notably in_progress -> complete) and fire
      // one-shot UI affordances like the completion flash.
      lastState: new Map(),
      // IDs that have already flashed on completion in this mount lifetime,
      // so a later re-render of the same completed chip doesn't restart
      // the animation.
      flashed: new Set(),
      // id -> wallclock ms when the flash animation started. Renders that
      // happen during the 2500 ms flash window (e.g. an iconUrl arriving
      // 200 ms in) re-apply the class with a negative animation-delay so
      // the animation appears to continue rather than restart from frame 0.
      flashStart: new Map()
    };
  }

  function render(root, state) {
    const ctx = root.__db;
    if (!ctx) return;
    const { items: list, actions } = ctx;

    closeAnyMenu(root);
    list.replaceChildren();

    const visibleItems = state.items.slice(0, BAR_CHIP_LIMIT);

    if (!state.items.length) {
      // Reset transition tracking when the bar empties, so a later
      // download that reuses an old ID doesn't suppress its flash.
      ctx.lastState.clear();
      ctx.flashed.clear();
      ctx.flashStart.clear();
      return;
    }

    const nextLast = new Map();
    const liveIds = new Set();

    for (const item of visibleItems) {
      const isComplete = item.state === 'complete' && item.exists !== false;

      // Completion flash. Coordinated via two layers:
      //   1. ctx.flashed: in-memory dedup for this mount lifetime.
      //   2. state.flashedIds: SW-tracked set persisted in session storage,
      //      so the flash doesn't re-fire in another tab or after SW restart.
      //      The renderer acks every new flash via actions('markFlashed', id).
      const currState = progressState(item);
      const isNewChip = !ctx.lastState.has(item.id);
      const swFlashed = state.flashedIds && state.flashedIds.includes(item.id);
      if (isComplete && !ctx.flashed.has(item.id) && !swFlashed) {
        ctx.flashed.add(item.id);
        ctx.flashStart.set(item.id, Date.now());
        actions('markFlashed', item.id);
      }
      // A flash is "active" if it started within the 2500 ms window. Re-renders
      // during that window re-apply the class with a negative animation-delay
      // so the animation appears continuous.
      const flashStartAt = ctx.flashStart.get(item.id);
      const flashElapsed = flashStartAt != null ? Date.now() - flashStartAt : Infinity;
      const shouldFlash = flashElapsed < FLASH_MS;
      nextLast.set(item.id, currState);
      liveIds.add(item.id);

      const iconWrap = el('div', {
        class: 'db-icon-wrap' + (shouldFlash ? ' db-icon-wrap--flash' : '')
      });
      if (shouldFlash) {
        // Negative delay fast-forwards the CSS animation to the elapsed
        // position, so a re-render mid-flash doesn't restart at frame 0.
        iconWrap.style.setProperty('--db-flash-delay', `-${flashElapsed | 0}ms`);
      }
      // Progress ring overlay: drawn while the download is active, and again
      // (as a full-circle, opacity-pulsed full ring) during the 2500ms
      // completion flash. Matches legacy Chrome 113's PaintDownloadProgress.
      if (shouldFlash) {
        iconWrap.append(progressRingSvg(100, false));
      } else if (currState === 'in_progress' || currState === 'paused') {
        iconWrap.append(progressRingSvg(progressPct(item), false));
      } else if (currState === 'indeterminate') {
        iconWrap.append(progressRingSvg(0, true));
      }
      // Primary icon: the OS-supplied file icon (chrome.downloads.getFileIcon
      // in the service worker, propagated via state.iconUrl). This is what
      // the legacy Chrome 113 shelf shows -- the same icon Windows Explorer
      // would draw for the file. While the SW is still fetching it, the
      // icon slot stays blank (matching the legacy DownloadItemView, which
      // draws nothing until the IconManager cache lookup returns).
      if (item.iconUrl) {
        const osIcon = document.createElement('img');
        osIcon.src = item.iconUrl;
        osIcon.alt = '';
        osIcon.className = 'db-os-icon';
        iconWrap.append(osIcon);
      }

      const [baseName, extName] = splitExt(item.basename || item.url || '(unknown)');
      // Completed chips drop the status row entirely (a single centered
      // filename). The interrupted-but-not-canceled case gets the red tint;
      // canceled stays neutral grey, matching the reference recording.
      const status = statusText(item);
      const textChildren = [
        el('div', { class: 'db-name' },
          el('span', { class: 'db-name-base' }, baseName),
          extName && el('span', { class: 'db-name-ext' }, extName)
        )
      ];
      if (status) {
        textChildren.push(el('div', {
          class: 'db-status' +
            (currState === 'interrupted' ? ' db-error' : '')
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
            card.append(buildMenu(item, actions, root));
            caret.classList.add('db-caret--open');
          }
        }
      });
      // Chevron is always drawn pointing up; CSS rotates it 180deg when the
      // caret carries db-caret--open, so menu open/close == chevron down/up.
      const caretSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      caretSvg.setAttribute('viewBox', '0 0 10 10');
      const chev = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      chev.setAttribute('d', 'M1 7 L5 3 L9 7');
      chev.setAttribute('fill', 'none');
      chev.setAttribute('stroke', 'currentColor');
      chev.setAttribute('stroke-width', '1.5');
      chev.setAttribute('stroke-linecap', 'round');
      chev.setAttribute('stroke-linejoin', 'round');
      caretSvg.appendChild(chev);
      caret.append(caretSvg);

      card = el('div', {
        class: 'db-item' + (isNewChip ? ' db-item--enter' : ''),
        draggable: isComplete,
        dataset: { state: progressState(item), clickable: isComplete ? '1' : '0' },
        title: item.filename || item.basename,
        onclick: isComplete
          ? () => { if (!card.querySelector('.db-menu')) actions('open', item.id); }
          : undefined,
        ondragstart: isComplete ? (e) => onDragStart(e, item) : undefined
      });

      card.append(iconWrap, text, caret);
      list.append(card);
    }

    // Commit next state and prune flashed IDs that are no longer present.
    ctx.lastState = nextLast;
    for (const id of [...ctx.flashed]) if (!liveIds.has(id)) ctx.flashed.delete(id);
    for (const id of [...ctx.flashStart.keys()]) if (!liveIds.has(id)) ctx.flashStart.delete(id);
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
