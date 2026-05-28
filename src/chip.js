// DownloadBar -- the DOM and event wiring for a single download item ("chip").

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.Chip) return;
  const { el } = NS.dom;
  const { progressRingSvg, caretIconSvg } = NS.svg;
  const { statusText, progressState, progressPct } = NS.format;
  const { buildMenu } = NS.menu;

  // Split a filename so the extension stays visible while CSS ellipsizes only the basename.
  function splitExt(name) {
    if (!name) return ['', ''];
    const ext = extFromFilename(name);
    if (!ext) return [name, ''];
    const cut = name.length - ext.length - 1; // include the leading dot
    return [name.slice(0, cut), name.slice(cut)];
  }

  // Build, position, and attach a menu to the shadow root. Living on the root (rather than
  // inside .db-items) escapes that container's horizontal clip-path, which would otherwise snip
  // the menu's drop shadow near the right edge of the bar.
  // Each positional anchor (left / right / top / bottom) is a viewport-space pixel value;
  // omitted edges fall through to `auto`, so callers only specify the edges they actually want.
  async function openMenu({ root, item, closeAllMenus, left, right, top, bottom }) {
    const menu = await buildMenu(item, closeAllMenus);
    const px = (v) => v == null ? 'auto' : `${v}px`;
    menu.style.left = px(left);
    menu.style.right = px(right);
    menu.style.top = px(top);
    menu.style.bottom = px(bottom);
    root.appendChild(menu);
  }

  class Chip {
    constructor({ item, root, closeAllMenus, flashedIds, enteredIds }) {
      this.state = item.state;
      this.cursorMenuOpen = false; // A menu not on the caret itself

      const isComplete = item.state === 'complete' && item.exists !== false;
      const isInProgress = item.state === 'in_progress';

      const shouldSlideIn = !enteredIds.includes(item.id);
      if (shouldSlideIn) chrome.runtime.sendMessage({ action: 'markEntered', id: item.id });
      const shouldFlash = isComplete && !flashedIds.includes(item.id);
      if (shouldFlash) chrome.runtime.sendMessage({ action: 'markFlashed', id: item.id });

      const currState = progressState(item);
      // Progress ring overlay: drawn while active, pulsed as a full ring during the flash.
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

      const toggleCaretMenu = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const wasOpen = this.caretMenuOpen;
        closeAllMenus();
        if (!wasOpen) {
          // Anchor flush with the caret's left edge and bottom (the menu sits directly above the caret).
          // Chrome 113 opens this menu downward; we open upward because our bar is pinned to the viewport bottom.
          const rect = caret.getBoundingClientRect();
          openMenu({
            root, item, closeAllMenus,
            left: rect.left,
            bottom: window.innerHeight - rect.top,
          });
          this.setCaretMenuOpen(true);
        }
      };
      const caret = el('button', {
        class: 'db-caret', title: 'More actions',
        onclick: toggleCaretMenu,
        oncontextmenu: toggleCaretMenu
      },
        caretIconSvg()
      );
      this._caret = caret;

      // In-progress chips are also clickable: a body-click toggles "Notify when done",
      // mirroring Chrome 113's "open when done" behavior.
      let onChipClick;
      if (isComplete) {
        onChipClick = () => {
          if (root.querySelector('.db-menu')) return;
          chrome.runtime.sendMessage({ action: NS.caps.defaultClickAction, id: item.id });
        };
      } else if (isInProgress) {
        onChipClick = () => {
          if (root.querySelector('.db-menu')) return;
          chrome.runtime.sendMessage({ action: 'setNotifyWhenDone', id: item.id, enabled: !item.notifyWhenDone });
        };
      }

      this.el = el('div', {
        class: 'db-item' + (shouldSlideIn ? ' db-item--enter' : ''),
        dataset: {
          clickable: onChipClick ? '1' : '0'
        },
        title: item.filename || item.basename,
        onclick: onChipClick,
        // Right-click anywhere on the chip body opens the caret menu anchored at the cursor.
        // The caret button stops propagation, so caret right-clicks don't reach here.
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeAllMenus();
          openMenu({
            root, item, closeAllMenus,
            left: e.clientX,
            bottom: window.innerHeight - e.clientY,
          });
          this.cursorMenuOpen = true;
        }
      }, iconWrap, text, caret);
    }

    get caretMenuOpen() {
      return this._caret.classList.contains('db-caret--open');
    }

    setCaretMenuOpen(open) {
      this._caret.classList.toggle('db-caret--open', open);
    }

    dispose() {
      this.el.remove();
    }
  }

  NS.Chip = Chip;
})();
