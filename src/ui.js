// DownloadBar -- bar lifecycle. Owns the shadow-root injection (mount) and the per-event
// renderer entry points (snapshot / created / changed / erased) that content.js dispatches to
// as SW messages arrive. Each entry point maps to one surgical DOM op, so untouched chips keep
// their CSS animations and DOM identity.

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.ui) return;
  const { el } = NS.dom;
  const { closeIconSvg } = NS.svg;
  const Chip = NS.Chip;

  let _chipList = null;
  let _root = null;
  // Live download chips keyed by download id, mirroring the DOM under _chipList.
  // Keeping per-chip identity across messages lets us swap one chip's subtree without
  // disturbing other chips' CSS animations.
  const _chips = new Map();

  // Root function which closes every open menu. This is passed around as a callback.
  function closeAllMenus() {
    _root.querySelectorAll('.db-menu').forEach(m => m.remove());
    _root.querySelectorAll('.db-caret--open').forEach(c => c.classList.remove('db-caret--open'));
    for (const chip of _chips.values()) chip.cursorMenuOpen = false;
  }

  function mount(root) {
    _root = root;

    // Inline <style> rather than a separate .css file. See styles.js for more details.
    root.appendChild(el('style', null, NS.STYLES));

    _chipList = el('div', { class: 'db-items' });
    root.appendChild(el('div',
      {
        class: 'db-bar',
        onclick: () => closeAllMenus(), // Click on bar background dismisses any open chip menu.
        // Right-click on bar background suppresses the page's context menu and also dismisses.
        // Right-clicks on a chip or caret stop propagation, so they don't reach this handler.
        oncontextmenu: (e) => { e.preventDefault(); closeAllMenus(); }
      },
      _chipList,
      el('div', { class: 'db-tail' },
        el('button', {
          class: 'db-show-all',
          title: NS.caps.showAllTooltip,
          onclick: () => chrome.runtime.sendMessage({ action: NS.caps.showAllAction })
        }, 'Show all'),
        el('button', {
          class: 'db-close', title: 'Close',
          // stopPropagation prevents the container click handler from firing and closing any open chip menus.
          onclick: (e) => {
            e.stopPropagation();
            e.preventDefault();
            chrome.runtime.sendMessage({ action: 'dismissAll' });
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
        if (e.target !== hostEl) closeAllMenus();
      };
      hostEl.ownerDocument.addEventListener('click', dismissOnOutsideClick, true);
      hostEl.ownerDocument.addEventListener('contextmenu', dismissOnOutsideClick, true);
    }
  }

  function snapshot(root, { items, flashedIds, enteredIds }) {
    if (!_chipList) return;
    // Cold-start path: wipe and rebuild. No CSS animations to preserve, since this is the
    // first state this tab is seeing.
    for (const chip of _chips.values()) chip.dispose();
    _chips.clear();
    _chipList.replaceChildren();
    // Insert in reverse so insertBefore(firstChild) inside created() yields the newest-first
    // DOM order the snapshot already arrives in.
    for (const item of items.slice(0, 15).reverse()) {
      created(root, { item, flashedIds, enteredIds });
    }
  }

  function created(root, { item, flashedIds, enteredIds }) {
    if (!_chipList) return;
    if (_chips.has(item.id)) {
      // Snapshot may have already created this chip; treat duplicate as a no-op.
      return;
    }
    const chip = new Chip({ item, root, closeAllMenus, flashedIds, enteredIds });
    _chips.set(item.id, chip);
    _chipList.insertBefore(chip.el, _chipList.firstChild);
  }

  function changed(root, { item, flashedIds, enteredIds }) {
    if (!_chipList) return;
    const prev = _chips.get(item.id);
    if (!prev) {
      // Missed the 'created' event (e.g., this tab connected mid-download). Treat as creation.
      return created(root, { item, flashedIds, enteredIds });
    }
    // Stable chip; nothing visible has changed and no progress to refresh.
    if (prev.state === item.state && item.state !== 'in_progress') return;

    const chip = new Chip({ item, root, closeAllMenus, flashedIds, enteredIds });
    if (prev.state === item.state) {
      // In-progress tick: transfer menu ownership so an open menu doesn't visually orphan.
      if (prev.caretMenuOpen) chip.setCaretMenuOpen(true);
      if (prev.cursorMenuOpen) chip.cursorMenuOpen = true;
    } else if (prev.caretMenuOpen || prev.cursorMenuOpen) {
      // State change invalidates the menu's action set -- drop it.
      closeAllMenus();
    }
    _chipList.replaceChild(chip.el, prev.el);
    _chips.set(item.id, chip);
  }

  function erased(root, { id }) {
    if (!_chipList) return;
    const chip = _chips.get(id);
    if (!chip) return;
    if (chip.caretMenuOpen || chip.cursorMenuOpen) closeAllMenus();
    chip.dispose();
    _chips.delete(id);
  }

  window.DownloadBar = NS.ui = { mount, snapshot, created, changed, erased };
})();
