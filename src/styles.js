// DownloadBar -- shadow-root stylesheet.
// Kept as a JS template literal because content scripts can't synchronously load CSS into a closed shadow root.
// All visual constants here have been verified pixel-perfect against the Chrome 113 (see docs/SHELF_BEHAVIOR.md).

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.STYLES) return;

  // CSS source with developer comments. Stripped once below so the shipped stylesheet (injected into every
  // shadow root) carries no comment bytes.
  const SOURCE = `
    /* Shadow root host: resets inherited page styles and pins the color scheme. */
    :host {
      all: initial;
      font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
      /* color-scheme inherits, so every descendant resolves light-dark() against this value. Set once here;
         never overridden. */
      color-scheme: light dark;
    }

    /* The bar itself: fixed-position horizontal strip pinned to the bottom of the viewport. */
    .db-bar {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      background: light-dark(#f1f3f4, #33363b);
      color: light-dark(#202124, #e8eaed);
      border-top: 1px solid light-dark(#d2d4d7, #5e5e60);
      font-size: 13px;
      line-height: 1.3;
      flex-direction: row;
      /* Chrome 113 shelf height = 57 CSS px = 56 chip + 1 px top separator.
         kStartPadding=4 left, kEndPadding=6 right. */
      height: 57px;
      padding: 0 6px 0 4px;
      /* Don't clip vertically -- the chip caret menu escapes upward; see .db-items below for the full mechanism. */
      overflow: visible;
    }

    /* Chip strip: horizontal flex container holding every download chip, left of the tail cluster. */
    .db-items {
      display: flex;
      flex: 0 1 auto;
      min-width: 0;
      flex-direction: row;
      gap: 0;
      /* Use clip-path instead of overflow:hidden so the chip caret menu can escape UPWARD (it's positioned
         above the chip with bottom: 100%) while excess chips still get clipped on the right edge. The negative
         top inset reserves 400 px of vertical headroom above the bar, more than enough for the tallest menu
         we render. */
      overflow: visible;
      clip-path: inset(-400px 0 0 0);
      height: 100%;
      align-items: center;
    }

    /* Chrome 113 chip: width 233 CSS px (fixed; never resizes -- the rightmost chip is hidden when the window
       narrows; see docs/SHELF_BEHAVIOR.md). Height 56 CSS px, filling the 57 px shelf below its 1 px top
       separator. */
    .db-item {
      position: relative;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 8px;
      height: 56px;
      padding: 0 6px 0 12px;
      flex: 0 0 auto;
      width: 233px;
      cursor: default;
      user-select: none;
    }
    /* 1 px right separator on every chip, matching the per-chip SeparatorView painted by Chrome 113's
       DownloadShelfView. */
    .db-item::after {
      content: "";
      position: absolute;
      top: 50%;
      right: 0;
      width: 1px;
      height: 36px;
      transform: translateY(-50%);
      background-color: light-dark(rgba(0,0,0,0.28), rgba(255,255,255,0.32));
      pointer-events: none;
    }
    .db-item[data-clickable="1"] { cursor: pointer; }
    .db-item:hover { background-color: light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.05)); }

    /* Icon slot: 22 px box centering the OS-supplied file icon, with the progress ring (if any) overlaid on
       top via absolute positioning. */
    .db-icon-wrap {
      width: 22px; height: 22px;
      flex: 0 0 auto;
      display: flex; align-items: center; justify-content: center;
      position: relative;
    }
    /* OS-supplied file icon (chrome.downloads.getFileIcon, 32 device px). Rendered at 16 CSS px so it stays
       crisp on HiDPI displays without hardcoding a per-DPR size in the service worker. */
    .db-icon-wrap .db-os-icon {
      width: 16px;
      height: 16px;
      display: block;
      image-rendering: -webkit-optimize-contrast;
    }

    /* Progress ring: SVG circle overlaying the icon while a download is active (in_progress / paused /
       indeterminate); also reused for the completion flash. */
    .db-progress-ring {
      position: absolute;
      top: -5px; left: -5px;
      width: 32px; height: 32px;
      pointer-events: none;
      overflow: visible;
    }
    .db-progress-ring__bg { stroke: light-dark(rgba(60,64,67,0.25), rgba(232,234,237,0.20)); fill: none; }
    .db-progress-ring__fg { stroke: light-dark(#1a73e8, #8ab4f8); fill: none; }
      /* Indeterminate: spin the whole SVG; the arc itself is a fixed 50deg drawn by progressRingSvg(null).
         Chrome 113's PaintDownloadProgress sweeps at 80 deg/sec (download_item_view.cc), so a full revolution
         takes 360/80 = 4.5s = 4500ms. */
    .db-progress-ring--indeterminate { 
      animation: db-progress-spin 4500ms linear infinite;
    }
    @keyframes db-progress-spin {
      to { transform: rotate(360deg); }
    }

    /* Completion flash: renderer adds .db-icon-wrap--flash + a full-circle ring; 2.5 ease-in-out cycles at 1000ms
       each give 3 opacity peaks over 2500ms, approximating Chrome 113's sine-sampled complete_animation_. */
    .db-icon-wrap--flash .db-progress-ring {
      animation: db-icon-flash 1000ms ease-in-out 2.5 forwards;
      animation-delay: var(--db-flash-delay, 0ms);
    }
    @keyframes db-icon-flash {
      0%   { opacity: 1; }
      50%  { opacity: 0; }
      100% { opacity: 1; }
    }

    /* New-item slide-in: when a chip ID appears for the first time, the renderer tags it with .db-item--enter,
       which animates max-width and opacity over 800ms (matching DownloadShelfView::new_item_animation_'s
       SetSlideDuration of 800ms). */
    .db-item--enter {
      animation: db-item-enter 800ms ease-out 1;
      overflow: hidden;
    }
    @keyframes db-item-enter {
      from { max-width: 0; opacity: 0; }
      to   { max-width: 233px; opacity: 1; }
    }

    /* Filename block: two-line column (name + status) that fills the middle of a chip. */
    .db-text {
      flex: 1 1 auto;
      min-width: 0;
      display: flex; flex-direction: column; justify-content: center;
    }
    .db-name {
      display: flex;
      min-width: 0;
      font-weight: 400;
      font-size: 13px;
    }
    .db-name__base {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .db-name__ext {
      flex: 0 0 auto;
      white-space: nowrap;
    }

    /* Status line under the filename: "123 MB / 456 MB, 30 secs left", "Failed - ...", "Canceled", etc. */
    .db-status {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-size: 12px;
      color: light-dark(#5f6368, #9aa0a6);
      margin-top: 1px;
    }

    /* Caret button: the small down-chevron on the right edge of a chip that opens the pop-up menu. */
    .db-caret {
      all: unset;
      cursor: pointer;
      width: 22px; height: 28px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 4px;
      color: light-dark(#5f6368, #c4c7c5);
      flex: 0 0 auto;
    }
    .db-caret:hover, .db-caret.db-caret--open {
      background: light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.10));
      color: inherit;
    }
    .db-caret svg { width: 10px; height: 10px; }
    .db-caret.db-caret--open svg { transform: rotate(180deg); }

    /* Caret pop-up: the per-chip context menu (Open / Show in folder / Pause / Cancel / Remove ...)
       that anchors above the caret button and floats over the bar. */
    .db-menu {
      position: absolute;
      bottom: calc(100% + 4px);
      right: 0;
      min-width: 180px;
      background: light-dark(#ffffff, #2d2e30);
      color: light-dark(#202124, #e8eaed);
      border-radius: 6px;
      box-shadow: 0 2px 10px light-dark(rgba(0,0,0,0.2), rgba(0,0,0,0.5));
      padding: 4px 0;
      z-index: 1;
      font-size: 13px;
    }
    .db-menu .db-menu-item {
      all: unset;
      display: flex;
      align-items: center;
      width: 100%;
      box-sizing: border-box;
      padding: 6px 14px 6px 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    .db-menu .db-menu-item[disabled] { cursor: default; opacity: 0.5; }
    .db-menu .db-menu-check {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      margin-right: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .db-menu .db-menu-check svg { width: 12px; height: 12px; display: block; }
    .db-menu .db-menu-label { flex: 1 1 auto; }
    .db-menu .db-menu-item:hover { background: light-dark(rgba(0,0,0,0.07), rgba(255,255,255,0.08)); }
    .db-menu hr {
      border: none;
      border-top: 1px solid light-dark(rgba(0,0,0,0.1), rgba(255,255,255,0.12));
      margin: 4px 0;
    }

    /* Tail cluster: right-side group holding the "Show all" button and close X, always reserved. */
    .db-tail {
      display: flex; align-items: center; gap: 6px;
      flex: 0 0 auto;
      margin-left: auto;
      /* Right-side reserve = 121 CSS px. This is the width that must always remain free of chips: the
         Show-all button, gap, close X, and container right padding together fill that reserve. The shelf
         hides the rightmost chip whenever:
            shelf_inner_width < N x 233 + 121
         See docs/SHELF_BEHAVIOR.md "Shelf width and chip-hiding thresholds". */
    }

    /* "Show all" in Chrome 113 CfT renders as a MdTextButton with a dark rounded-rect background,
       not a plain text link. */
    .db-show-all {
      all: unset;
      cursor: pointer;
      color: light-dark(#202124, #e8eaed);
      font-size: 12px;
      font-weight: 500;
      padding: 6px 12px;
      line-height: 1;
      border-radius: 14px;
      background: light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.06));
    }
    .db-show-all:hover { background: light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.12)); }

    /* Close X: dismisses the whole bar for the current session (re-shown when a new download starts).
       The X glyph itself is an inline SVG built in ui.js, mirroring Chromium 113's kCloseRoundedIcon. */
    .db-close {
      all: unset;
      cursor: pointer;
      width: 24px; height: 24px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 4px;
      color: light-dark(#5f6368, #9aa0a6);
    }
    .db-close svg { width: 12px; height: 12px; }
    .db-close:hover {
      background: light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.10));
      color: inherit;
    }
  `;

  // Strip /* ... */ blocks and collapse the runs of blank lines they leave behind.
  // Runs once per content-script load.
  NS.STYLES = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n/g, '\n');
})();
