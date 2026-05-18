// DownloadBar -- shadow-root stylesheet.
// Kept as a JS template literal (not a .css file) because content scripts
// can't synchronously load CSS into a closed shadow root: content_scripts.css
// applies to the page document, not our shadow, and fetch() is async.
// All visual constants here have been verified pixel-perfect against the
// Chrome 113 reference build (see docs/SHELF_BEHAVIOR.md).

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.STYLES) return;

  // CSS source with developer comments. Stripped once below so the shipped
  // stylesheet (injected into every shadow root) carries no comment bytes.
  const SOURCE = `
    :host {
      all: initial;
      font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
      color-scheme: light dark;
    }

    .db-bar {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      background: #f1f3f4;
      color: #202124;
      border-top: 1px solid #d2d4d7;
      font-size: 13px;
      line-height: 1.3;
      flex-direction: row;
      height: 57px;
      padding: 0 6px 0 4px;
      /* Don't clip vertically -- the chip caret menu popover extends ABOVE
         the bar and must escape it. Horizontal clipping is delegated to
         .db-items (the chips container) so chips that don't fit get clipped
         while the menu still escapes upward. */
      overflow: visible;
    }
    /* Chrome 113 shelf height = 57 CSS px = 56 chip + 1 px top separator.
       kStartPadding=4 left, kEndPadding=6 right. */
    @media (prefers-color-scheme: dark) {
      .db-bar {
        background: #33363b;
        color: #e8eaed;
        border-top-color: #5e5e60;
      }
    }

    .db-items {
      display: flex;
      flex: 0 1 auto;
      min-width: 0;
      flex-direction: row;
      gap: 0;
      /* Use clip-path instead of overflow:hidden so the chip caret menu can
         escape UPWARD (it's positioned above the chip with bottom: 100%)
         while excess chips still get clipped on the right edge. The negative
         top inset reserves 400 px of vertical headroom above the bar, more
         than enough for the tallest menu we render. */
      overflow: visible;
      clip-path: inset(-400px 0 0 0);
      height: 100%;
      align-items: center;
    }

    /* Chrome 113 chip: width 233 CSS px (fixed; never resizes -- the rightmost
       chip is hidden when the window narrows; see docs/SHELF_BEHAVIOR.md).
       Height 56 CSS px, filling the 57 px shelf below its 1 px top separator. */
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
    /* 1 px right separator on every chip, matching the per-chip SeparatorView
       painted by Chrome 113's DownloadShelfView. */
    .db-item::after {
      content: "";
      position: absolute;
      top: 50%;
      right: 0;
      width: 1px;
      height: 36px;
      transform: translateY(-50%);
      background-color: rgba(0, 0, 0, 0.28);
      pointer-events: none;
    }
    @media (prefers-color-scheme: dark) {
      .db-item::after {
        background-color: rgba(255, 255, 255, 0.32);
      }
    }
    .db-item[data-clickable="1"] { cursor: pointer; }
    .db-item:hover { background-color: rgba(0,0,0,0.04); }
    @media (prefers-color-scheme: dark) {
      .db-item:hover { background-color: rgba(255,255,255,0.05); }
    }

    /* Icon: plain SVG glyph rendered directly on the bar background. */
    .db-icon-wrap {
      width: 22px; height: 22px;
      flex: 0 0 auto;
      display: flex; align-items: center; justify-content: center;
      color: #5f6368;
      position: relative;
    }
    @media (prefers-color-scheme: dark) {
      .db-icon-wrap { color: #e8eaed; }
    }
    /* OS-supplied file icon (chrome.downloads.getFileIcon, 32 device px).
       Rendered at 16 CSS px so it stays crisp on HiDPI displays without
       hardcoding a per-DPR size in the service worker. */
    .db-icon-wrap .db-os-icon {
      width: 16px;
      height: 16px;
      display: block;
      image-rendering: -webkit-optimize-contrast;
    }
    .db-item[data-state="interrupted"] .db-icon-wrap { color: #d93025; }
    @media (prefers-color-scheme: dark) {
      .db-item[data-state="interrupted"] .db-icon-wrap { color: #f28b82; }
    }

    /* Progress ring: SVG circle overlaying the icon while a download is
       active (in_progress / paused / indeterminate); also reused for the
       completion flash. */
    .db-progress-ring {
      position: absolute;
      top: -5px; left: -5px;
      width: 32px; height: 32px;
      pointer-events: none;
      overflow: visible;
    }
    .db-progress-ring-bg { stroke: rgba(60, 64, 67, 0.25); fill: none; }
    .db-progress-ring-fg { stroke: #1a73e8; fill: none; }
    @media (prefers-color-scheme: dark) {
      .db-progress-ring-bg { stroke: rgba(232, 234, 237, 0.20); }
      .db-progress-ring-fg { stroke: #8ab4f8; }
    }
    /* Indeterminate: spin the whole SVG; the arc itself is a fixed 50deg
       drawn by progressRingSvg(0, true). 4500ms per revolution matches
       legacy Chrome's indeterminate_progress_time. */
    .db-progress-ring--indeterminate {
      animation: db-progress-spin 4500ms linear infinite;
    }
    @keyframes db-progress-spin {
      to { transform: rotate(360deg); }
    }

    /* Completion flash: renderer adds .db-icon-wrap--flash + a full-circle
       ring; 2.5 ease-in-out cycles at 1000ms each give 3 opacity peaks over
       2500ms, approximating Chrome 113's sine-sampled complete_animation_. */
    .db-icon-wrap--flash .db-progress-ring {
      animation: db-icon-flash 1000ms ease-in-out 2.5 forwards;
      animation-delay: var(--db-flash-delay, 0ms);
    }
    @keyframes db-icon-flash {
      0%   { opacity: 1; }
      50%  { opacity: 0; }
      100% { opacity: 1; }
    }

    /* New-item slide-in: when a chip ID appears for the first time, the
       renderer tags it with .db-item--enter, which animates max-width and
       opacity over 800ms (matching DownloadShelfView::new_item_animation_'s
       SetSlideDuration of 800ms). */
    .db-item--enter {
      animation: db-item-enter 800ms ease-out 1;
      overflow: hidden;
    }
    @keyframes db-item-enter {
      from { max-width: 0; opacity: 0; }
      to   { max-width: 233px; opacity: 1; }
    }

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
    .db-name-base {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .db-name-ext {
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .db-status {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-size: 12px;
      color: #5f6368;
      margin-top: 1px;
    }
    @media (prefers-color-scheme: dark) {
      .db-status { color: #9aa0a6; }
    }
    .db-status.db-error { color: #d93025; }
    @media (prefers-color-scheme: dark) {
      .db-status.db-error { color: #f28b82; }
    }

    .db-caret {
      all: unset;
      cursor: pointer;
      width: 22px; height: 28px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 4px;
      color: #5f6368;
      flex: 0 0 auto;
    }
    .db-caret:hover, .db-caret.db-caret--open {
      background: rgba(0,0,0,0.06);
      color: inherit;
    }
    @media (prefers-color-scheme: dark) {
      .db-caret { color: #c4c7c5; }
      .db-caret:hover, .db-caret.db-caret--open {
        background: rgba(255,255,255,0.10);
      }
    }
    .db-caret svg { width: 10px; height: 10px; }
    .db-caret.db-caret--open svg { transform: rotate(180deg); }

    .db-menu {
      position: absolute;
      bottom: calc(100% + 4px);
      right: 0;
      min-width: 180px;
      background: #ffffff;
      color: #202124;
      border-radius: 6px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      padding: 4px 0;
      z-index: 1;
      font-size: 13px;
    }
    @media (prefers-color-scheme: dark) {
      .db-menu { background: #2d2e30; color: #e8eaed; box-shadow: 0 2px 10px rgba(0,0,0,0.5); }
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
    .db-menu .db-menu-label { flex: 1 1 auto; }
    .db-menu .db-menu-item:hover { background: rgba(0,0,0,0.07); }
    @media (prefers-color-scheme: dark) {
      .db-menu .db-menu-item:hover { background: rgba(255,255,255,0.08); }
    }
    .db-menu hr {
      border: none;
      border-top: 1px solid rgba(0,0,0,0.1);
      margin: 4px 0;
    }
    @media (prefers-color-scheme: dark) {
      .db-menu hr { border-top-color: rgba(255,255,255,0.12); }
    }

    .db-tail {
      display: flex; align-items: center; gap: 6px;
      flex: 0 0 auto;
      margin-left: auto;
      /* Right-side reserve = 121 CSS px. This is the width that must always
         remain free of chips: the Show-all button, gap, close X, and
         container right padding together fill that reserve. The shelf hides
         the rightmost chip whenever:
            shelf_inner_width < N x 233 + 121
         See docs/SHELF_BEHAVIOR.md "Shelf width and chip-hiding thresholds". */
    }

    /* "Show all" in Chrome 113 CfT renders as a MdTextButton with a dark
       rounded-rect background, not a plain text link. */
    .db-show-all {
      all: unset;
      cursor: pointer;
      color: #e8eaed;
      font-size: 12px;
      font-weight: 500;
      padding: 6px 12px;
      line-height: 1;
      border-radius: 14px;
      background: rgba(255,255,255,0.06);
    }
    .db-show-all:hover { background: rgba(255,255,255,0.12); }
    @media (prefers-color-scheme: light) {
      .db-show-all {
        color: #202124;
        background: rgba(0,0,0,0.04);
      }
      .db-show-all:hover { background: rgba(0,0,0,0.08); }
    }

    .db-close {
      all: unset;
      cursor: pointer;
      width: 24px; height: 24px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 4px;
      color: #5f6368;
      font-size: 14px;
    }
    .db-close:hover { background: rgba(0,0,0,0.08); color: inherit; }
    @media (prefers-color-scheme: dark) {
      .db-close { color: #9aa0a6; }
      .db-close:hover { background: rgba(255,255,255,0.10); }
    }
  `;

  // Strip /* ... */ blocks and collapse the runs of blank lines they leave
  // behind. Runs once per content-script load.
  NS.STYLES = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n/g, '\n');
})();
