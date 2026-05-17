// DownloadBar — shared UI renderer.
// Classic-Chrome-shelf look: flat chips, file-type icon with extension label,
// circular progress ring around the icon, single dropdown menu per chip,
// "Show all" text link on the right. Exposes a global `DownloadBar` with
// `mount(root, actions, opts)` and `render(root, state)`. Used by both the
// content-script shadow DOM and the toolbar popup.

(function () {
  if (typeof window !== 'undefined' && window.DownloadBar) return;

  const STYLES = `
    :host, .db-root {
      all: initial;
      font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
      color-scheme: light dark;
    }

    .db-bar, .db-list {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      background: #f1f3f4;
      color: #202124;
      border-top: 1px solid #d2d4d7;
      font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.3;
    }
    /* Chrome 113 shelf height = 57 CSS px = 56 chip + 1 px top separator,
       verified by visual side-by-side staircase comparison against a live
       Chrome 113 download shelf (see tests/height_ladder.html). The earlier
       guess of 49 CSS (kDefaultDownloadItemHeight = 48 + 1) understated the
       real height -- the source constant is for an inner content area, not
       the rendered shelf. The 4K capture's "57 device px" was the right
       number but was wrongly divided by 1.5; the screen was 3840×2400 at
       DPR=1.0, not 2560×1600 at DPR=1.5. kStartPadding=4 left, kEndPadding=6
       right. CSS px is DPR-respecting by definition; Chromium scales these
       to device px automatically. */
    .db-bar {
      flex-direction: row;
      height: 57px;
      padding: 0 6px 0 4px;
      /* Don't clip vertically -- the chip caret menu popover extends ABOVE
         the bar and must escape it. Horizontal clipping is delegated to
         .db-items (the chips container) so chips that don't fit get clipped
         while the menu still escapes upward. */
      overflow: visible;
    }
    .db-list {
      flex-direction: column;
      align-items: stretch;
      padding: 4px 0;
      max-height: 480px;
      overflow-y: auto;
    }
    @media (prefers-color-scheme: dark) {
      .db-bar, .db-list {
        background: #33363b;
        color: #e8eaed;
        /* Solid mid-gray top hairline; the legacy shelf draws a visible
           border at this edge in both light and dark mode. */
        border-top-color: #5e5e60;
      }
    }

    .db-items {
      display: flex;
      flex: 0 1 auto;
      min-width: 0;
    }
    .db-bar .db-items {
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
    .db-list .db-items { flex-direction: column; }
    .db-items::-webkit-scrollbar { height: 6px; }
    .db-items::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.2); border-radius: 3px; }

    /* Chrome 113 chip: width 233 CSS px (fixed; never resizes -- the rightmost
       chip is hidden when the window narrows, verified pixel-perfect against
       the reference build at DPR=1.0 and DPR=1.5; see docs/SHELF_BEHAVIOR.md
       and tests/test_resize_breakpoints.py). Height 56 CSS px, filling the
       57 px shelf below its 1 px top separator. */
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
    /* 1 px right separator on every chip in the bar layout, matching the
       per-chip SeparatorView painted by Chrome 113's DownloadShelfView.
       Measured at ~24 CSS px tall (57 device px / DPR=2.37), vertically
       centered, via PIL analysis of the legacy shelf capture
       frames/shelf-crops/t0240-shelf-3x.png. */
    .db-bar .db-item::after {
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
      .db-bar .db-item::after {
        background-color: rgba(255, 255, 255, 0.32);
      }
    }
    .db-bar .db-item:not(:last-child) {
      /* Adjacent chips: the right separator above already draws the
         inter-chip line at every chip boundary; no extra rule needed. */
    }
    .db-list .db-item { width: auto; margin: 0 4px; border-radius: 4px; height: 40px; }
    .db-item[data-clickable="1"] { cursor: pointer; }
    .db-item:hover { background-color: rgba(0,0,0,0.04); }
    @media (prefers-color-scheme: dark) {
      .db-item:hover { background-color: rgba(255,255,255,0.05); }
    }

    /* Icon: plain SVG glyph, no circular badge. Classic shelf placed the
       file-type icon directly against the bar background. We keep favicons
       layered on top via absolute positioning, but the default rendering is
       a single light glyph for maximum visual quiet. */
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
    .db-icon-wrap svg:not(.db-progress-ring) { width: 16px; height: 16px; display: block; }
    .db-icon-wrap img { width: 16px; height: 16px; display: block; }
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
       active (in_progress / paused / indeterminate). The same geometry is
       re-used for the completion flash, where a full-circle ring pulses
       opacity 3 times via a sine sampling in keyframes -- matching legacy
       Chrome 113 (see reference/chromium-113-download-shelf/
       download_item_view.cc:631-644: 2500ms linear, value 0->5, opacity =
       sin((value + 0.5) * pi) / 2 + 0.5 == 3 peaks, 3 troughs). */
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
    /* Indeterminate: spin the whole ring at 80deg/sec (= 360deg per 4500ms)
       to match legacy Chrome's indeterminate_progress_time-driven rotation
       of a fixed 50-degree arc. */
    .db-progress-ring--indeterminate {
      animation: db-progress-spin 4500ms linear infinite;
    }
    @keyframes db-progress-spin {
      to { transform: rotate(360deg); }
    }

    /* Completion flash: the renderer adds .db-icon-wrap--flash when a chip
       transitions from in_progress to complete and injects a full-circle
       progress ring; the CSS animates that ring's opacity through three
       peaks over 2500ms, matching Chrome 113's complete_animation_ exactly
       (linear time, sine-sampled opacity). */
    /* 2.5 iterations of a smooth ease-in-out cycle (1→0→1) at 1000ms each
       gives 3 peaks (at 0, 1000, 2000ms) and 3 troughs (at 500, 1500, 2500ms),
       ending at opacity 0. ease-in-out per cycle is a close cosine
       approximation of legacy Chrome's sin((value+0.5)*pi)/2 + 0.5. */
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
    .db-list .db-menu { bottom: auto; top: calc(100% - 4px); }
    @media (prefers-color-scheme: dark) {
      .db-menu { background: #2d2e30; color: #e8eaed; box-shadow: 0 2px 10px rgba(0,0,0,0.5); }
    }
    .db-menu button {
      all: unset;
      display: flex;
      align-items: center;
      width: 100%;
      box-sizing: border-box;
      padding: 6px 14px 6px 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    .db-menu button[disabled] { cursor: default; opacity: 0.5; }
    .db-menu .db-menu-check {
      display: inline-block;
      width: 16px;
      text-align: center;
      font-size: 12px;
      margin-right: 4px;
      color: inherit;
    }
    .db-menu .db-menu-label { flex: 1 1 auto; }
    .db-menu button:hover { background: rgba(0,0,0,0.07); }
    @media (prefers-color-scheme: dark) {
      .db-menu button:hover { background: rgba(255,255,255,0.08); }
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
      /* Right-side reserve = 121 CSS px (verified pixel-perfect at DPR=1.0
         and DPR=1.5 against Chrome 113). This is the width that must always
         remain free of chips: the divider, Show-all button, gap, close ✕,
         and container right padding together fill that reserve. The shelf
         hides the rightmost chip whenever:
            shelf_inner_width < N × 233 + 121
         See docs/SHELF_BEHAVIOR.md "Shelf width and chip-hiding thresholds". */
    }
    .db-list .db-tail {
      justify-content: flex-end;
      padding: 6px 8px 2px;
      margin-left: 0;
      border-top: 1px solid rgba(0,0,0,0.08);
    }
    @media (prefers-color-scheme: dark) {
      .db-list .db-tail { border-top-color: rgba(255,255,255,0.1); }
    }

    /* "Show all" in Chrome 113 CfT renders as a MdTextButton with a dark
       rounded-rect background, not a plain text link. */
    .db-link {
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
    .db-link:hover { background: rgba(255,255,255,0.12); }
    @media (prefers-color-scheme: light) {
      .db-link {
        color: #202124;
        background: rgba(0,0,0,0.04);
      }
      .db-link:hover { background: rgba(0,0,0,0.08); }
    }

    /* Vertical separator between the chips area and the trailing
       (show-all + close) cluster. In the BAR layout this is suppressed
       because every chip already paints its own 1 px right separator
       (see the .db-bar .db-item rule above), and the rightmost chip's
       separator naturally serves the chips-tail boundary -- matching
       Chrome 113 DownloadShelfView, which does not draw an additional
       separator there. Still drawn in the LIST/popup layout, where chips
       have rounded corners and no per-item separator. */
    .db-divider {
      display: none;
    }
    .db-bar .db-divider {
      display: none;
    }
    .db-list .db-divider {
      display: block;
      width: 1px;
      height: 32px;
      background: rgba(0,0,0,0.15);
      margin: 0 6px;
      flex: 0 0 auto;
    }
    @media (prefers-color-scheme: dark) {
      .db-list .db-divider { background: rgba(255,255,255,0.18); }
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

    .db-empty {
      padding: 24px 12px; text-align: center; opacity: 0.6; font-size: 12px;
    }
  `;

  // ---- formatting ---------------------------------------------------------
  //
  // Status-line formats are documented in docs/SHELF_BEHAVIOR.md and were
  // verified frame-by-frame against a Chrome 113 reference recording:
  //
  //   in progress : `0.5/10.0 MB, 5 mins left`     (single unit, no spaces around `/`)
  //   paused      : `0.7/100 MB, Paused`           (ETA replaced by literal `Paused`)
  //   starting    : `Starting\u2026`
  //   canceled    : `Canceled`
  //   failed      : `Failed - Network disconnected`
  //   complete    : (empty -- renderer drops the status row entirely)

  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

  function fmtOne(scaled) {
    if (scaled >= 100) return String(Math.round(scaled));
    return (Math.round(scaled * 10) / 10).toFixed(1);
  }

  // Render received/total with a single shared unit suffix chosen by the
  // larger of the two: `0.5/10.0 MB`, never `512 KB / 10.0 MB`.
  function fmtBytePair(received, total) {
    const ref = Math.max(received || 0, total || 0);
    let i = 0, scale = 1;
    while (ref / scale >= 1024 && i < UNITS.length - 1) { scale *= 1024; i++; }
    const r = (received || 0) / scale;
    if (total > 0) {
      const t = total / scale;
      return `${fmtOne(r)}/${fmtOne(t)} ${UNITS[i]}`;
    }
    return `${fmtOne(r)} ${UNITS[i]}`;
  }

  function fmtEta(iso) {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (!isFinite(ms) || ms <= 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + ' secs left';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' mins left';
    return Math.round(m / 60) + ' hrs left';
  }

  // chrome.downloads.InterruptReason → human text. Unmapped values fall
  // back to a title-cased rendering of the enum name.
  const ERROR_MESSAGES = {
    NETWORK_FAILED: 'Network error',
    NETWORK_TIMEOUT: 'Network timeout',
    NETWORK_DISCONNECTED: 'Network disconnected',
    NETWORK_SERVER_DOWN: 'Server unavailable',
    NETWORK_INVALID_REQUEST: 'Invalid request',
    SERVER_FAILED: 'Server error',
    SERVER_NO_RANGE: 'Server error',
    SERVER_BAD_CONTENT: 'No file',
    SERVER_UNAUTHORIZED: 'Needs authorization',
    SERVER_CERT_PROBLEM: 'Certificate error',
    SERVER_FORBIDDEN: 'Forbidden',
    SERVER_UNREACHABLE: 'Server unreachable',
    FILE_FAILED: 'File error',
    FILE_ACCESS_DENIED: 'Needs permission',
    FILE_NO_SPACE: 'Out of disk space',
    FILE_NAME_TOO_LONG: 'Name too long',
    FILE_TOO_LARGE: 'File too large',
    FILE_VIRUS_INFECTED: 'Virus detected',
    FILE_TRANSIENT_ERROR: 'System busy',
    FILE_BLOCKED: 'Blocked',
    FILE_SECURITY_CHECK_FAILED: 'Security check failed',
    FILE_TOO_SHORT: 'File incomplete',
    FILE_HASH_MISMATCH: 'File corrupt',
    FILE_SAME_AS_SOURCE: 'Already downloaded',
    USER_SHUTDOWN: 'Shutdown',
    CRASH: 'Crash',
  };

  function failureReason(error) {
    if (!error) return 'Failed';
    return ERROR_MESSAGES[error] ||
      error.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
  }

  function statusText(it) {
    if (it.state === 'complete') {
      // Completed chips drop the status row; "Removed" is the one exception.
      return it.exists === false ? 'Removed' : '';
    }
    if (it.state === 'interrupted') {
      if (isCanceled(it)) return 'Canceled';
      return 'Failed - ' + failureReason(it.error);
    }
    if (it.paused) {
      return fmtBytePair(it.bytesReceived, it.totalBytes) + ', Paused';
    }
    // in_progress
    if (!it.bytesReceived) return 'Starting\u2026';
    const sz = fmtBytePair(it.bytesReceived, it.totalBytes);
    const eta = fmtEta(it.estimatedEndTime);
    return eta ? `${sz}, ${eta}` : sz;
  }

  // The downloads API reports user-cancellation as state=interrupted with
  // error=USER_CANCELED. Treat that as its own visual state — not a failure.
  function isCanceled(it) {
    return it.state === 'interrupted' && it.error === 'USER_CANCELED';
  }

  function progressState(it) {
    if (it.state === 'complete') return 'complete';
    if (it.state === 'interrupted') return isCanceled(it) ? 'canceled' : 'interrupted';
    if (it.paused) return 'paused';
    if (it.totalBytes > 0) return 'in_progress';
    return 'indeterminate';
  }

  function progressPct(it) {
    if (it.state === 'complete') return 100;
    if (it.totalBytes > 0) return Math.max(0, Math.min(100, (it.bytesReceived / it.totalBytes) * 100));
    return 0;
  }

  // Build the SVG progress ring overlay drawn around the file-type icon while
  // a download is active, and again (as a full-circle pulse) during the
  // completion flash. Matches the geometry of Chrome 113's PaintDownloadProgress:
  // 1.7 px stroke, start at 12 o'clock, sweep clockwise. Indeterminate mode
  // draws a fixed 50-degree arc; CSS rotates the whole SVG to animate it.
  function progressRingSvg(percent, indeterminate) {
    const NS = 'http://www.w3.org/2000/svg';
    const r = 10.15;                 // circumference ~63.77 inside a 24x24 box
    const c = 2 * Math.PI * r;
    const fgLen = indeterminate ? (c * 50 / 360) : (c * Math.max(0, Math.min(100, percent)) / 100);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'db-progress-ring' + (indeterminate ? ' db-progress-ring--indeterminate' : ''));
    svg.setAttribute('viewBox', '0 0 24 24');
    if (!indeterminate) {
      const bg = document.createElementNS(NS, 'circle');
      bg.setAttribute('class', 'db-progress-ring-bg');
      bg.setAttribute('cx', '12'); bg.setAttribute('cy', '12');
      bg.setAttribute('r', String(r));
      bg.setAttribute('stroke-width', '1.7');
      svg.appendChild(bg);
    }
    const fg = document.createElementNS(NS, 'circle');
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

  // ---- icon ---------------------------------------------------------------

  // Build an <img> for the favicon of the page that initiated the download.
  // Uses the MV3 favicon API (declared via the "favicon" permission and
  // exposed as a web-accessible resource). Returns null if no referrer is
  // available, so the caller can fall back to a generic glyph.
  function faviconImg(referrer) {
    if (!referrer) return null;
    try {
      const url = chrome.runtime.getURL('_favicon/?pageUrl=' +
        encodeURIComponent(referrer) + '&size=32');
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      // If the favicon API returns the default globe or fails, swap for the
      // glyph so we never render a broken-image marker.
      img.addEventListener('error', () => img.remove());
      return img;
    } catch {
      return null;
    }
  }

  // Material-style glyph set, drawn in the chip's foreground colour via
  // `fill="currentColor"`. Used as a fallback when no favicon is available.
  const GLYPHS = {
    doc: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM16 18H8v-1.5h8V18zm0-3H8v-1.5h8V15zm0-3H8v-1.5h8V12zm-3-3V3.5L18.5 9H13z',
    exe: 'M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h6v2H7v2h10v-2h-3v-2h6c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11zM12 14l4-4h-3V7h-2v3H8l4 4z',
    img: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
    vid: 'M8 5v14l11-7z',
    aud: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
    zip: 'M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z',
  };

  // Lowercased file extension (no leading dot), or '' if none. Used for the
  // generic glyph fallback and for keying "Always open files of this type".
  function extOf(name) {
    if (!name) return '';
    const m = /\.([^.\\/]+)$/.exec(name);
    return m ? m[1].toLowerCase() : '';
  }

  function categoryFor(filename, mime) {
    const ext = extOf(filename);
    if (mime) {
      if (mime.startsWith('image/')) return 'img';
      if (mime.startsWith('video/')) return 'vid';
      if (mime.startsWith('audio/')) return 'aud';
    }
    if (/^(exe|msi|dmg|deb|rpm|pkg|apk|appx)$/.test(ext)) return 'exe';
    if (/^(jpe?g|png|gif|webp|bmp|svg|ico|tiff?)$/.test(ext)) return 'img';
    if (/^(mp4|mov|mkv|webm|avi|wmv|flv|m4v)$/.test(ext)) return 'vid';
    if (/^(mp3|wav|flac|ogg|m4a|aac|opus)$/.test(ext)) return 'aud';
    if (/^(zip|rar|7z|tar|gz|bz2|xz|tgz)$/.test(ext)) return 'zip';
    return 'doc';
  }

  function glyphSvg(filename, mime) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', GLYPHS[categoryFor(filename, mime)] || GLYPHS.doc);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  // Split a filename for middle-ellipsis: keep the final extension visible.
  // "Firefox News - Foo.html" → ["Firefox News - Foo", ".html"]
  function splitExt(name) {
    if (!name) return ['', ''];
    const i = name.lastIndexOf('.');
    if (i <= 0 || i === name.length - 1) return [name, ''];
    return [name.slice(0, i), name.slice(i)];
  }

  // ---- DOM helpers --------------------------------------------------------

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'dataset') for (const d in attrs.dataset) e.dataset[d] = attrs.dataset[d];
      else if (attrs[k] === true) e.setAttribute(k, '');
      else if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  function stop(fn) {
    return (e) => { e.stopPropagation(); e.preventDefault(); fn(e); };
  }

  // Swap the chevron path inside a caret <button> between up and down without
  // re-creating the SVG node.
  function setCaretChevron(caretBtn, dir) {
    const path = caretBtn.querySelector('path');
    if (!path) return;
    path.setAttribute('d', dir === 'down' ? 'M1 3 L5 7 L9 3' : 'M1 7 L5 3 L9 7');
  }

  // ---- menu ---------------------------------------------------------------

  function closeAnyMenu(root) {
    root.querySelectorAll('.db-menu').forEach(m => m.remove());
    // Reset every open caret back to the up-chevron / unstyled state so
    // dismissing the menu via *any* path (outside click, item activation,
    // re-render) leaves the chip visually consistent.
    root.querySelectorAll('.db-caret--open').forEach(c => {
      c.classList.remove('db-caret--open');
      setCaretChevron(c, 'up');
    });
  }

  function buildMenu(it, actions, root) {
    const menu = el('div', { class: 'db-menu', onclick: (e) => e.stopPropagation() });

    // `opts` may carry { disabled, checked, keepOpen } to support toggle
    // items (Always open) and disabled placeholders.
    const add = (label, fn, opts) => {
      const o = opts || {};
      const btn = el('button', {
        class: 'db-menu-item' + (o.checked ? ' db-menu-item--checked' : ''),
        disabled: !!o.disabled || undefined,
        onclick: o.disabled ? undefined : () => {
          if (!o.keepOpen) closeAnyMenu(root);
          fn();
        }
      },
        el('span', { class: 'db-menu-check' }, o.checked ? '\u2713' : ''),
        el('span', { class: 'db-menu-label' }, label)
      );
      menu.append(btn);
    };
    const sep = () => menu.append(document.createElement('hr'));

    const ext = extOf(it.filename);
    const alwaysOpenExts = (root.__db.state && root.__db.state.alwaysOpenExts) || [];
    const alwaysOpen = !!ext && alwaysOpenExts.includes(ext);
    const alwaysOpenItem = (enabled) => add(
      'Always open files of this type',
      () => { if (ext) actions.toggleAlwaysOpen(ext, it.id); },
      { disabled: !enabled || !ext, checked: alwaysOpen, keepOpen: true }
    );

    // Verified menu layout from the Chrome 113 reference capture
    // (see docs/SHELF_BEHAVIOR.md and screenshots 07/08):
    //   in_progress / paused : 4 flat items + separator + Cancel
    //   complete             : 3 flat items + separator + Remove from list
    //                          (Chrome itself shows a disabled "Cancel" here;
    //                          we replace it with a meaningful action.)
    if (it.state === 'in_progress') {
      add('Open when done', () => { /* TODO: track auto-open */ }, { disabled: true });
      alwaysOpenItem(false);
      add(it.paused ? 'Resume' : 'Pause',
          () => it.paused ? actions.resume(it.id) : actions.pause(it.id),
          { disabled: !it.paused && !it.canResume && it.bytesReceived === 0 });
      add('Show in folder', () => actions.show(it.id), { disabled: !it.filename });
      sep();
      add('Cancel', () => actions.cancel(it.id));
    } else if (it.state === 'complete' && it.exists !== false) {
      add('Open', () => actions.open(it.id));
      alwaysOpenItem(true);
      sep();
      add('Show in folder', () => actions.show(it.id));
      sep();
      add('Remove from list', () => actions.dismiss(it.id));
    } else if (it.state === 'interrupted') {
      add('Retry', () => actions.retry(it.id));
      sep();
      add('Remove from list', () => actions.dismiss(it.id));
    } else {
      add('Remove from list', () => actions.dismiss(it.id));
    }

    return menu;
  }

  // ---- main API -----------------------------------------------------------

  // Map action name -> function building the message payload from its args.
  const ACTION_PAYLOADS = {
    dismiss:           (id)      => ({ id }),
    dismissAll:        ()        => ({}),
    open:              (id)      => ({ id }),
    show:              (id)      => ({ id }),
    showFolder:        ()        => ({}),
    pause:             (id)      => ({ id }),
    resume:            (id)      => ({ id }),
    cancel:            (id)      => ({ id }),
    retry:             (id)      => ({ id }),
    openDownloadsPage: ()        => ({}),
    toggleAlwaysOpen:  (ext, id) => ({ ext, id }),
    markFlashed:       (id)      => ({ id }),
  };

  // Build the actions object shared between content-script and popup. Each
  // entry forwards to the SW; callers may pass overrides that run *after*
  // the message has been dispatched (e.g. the bar hides its host
  // optimistically on dismissAll; the popup closes its window after
  // openDownloadsPage).
  function makeActions(overrides) {
    overrides = overrides || {};
    const out = {};
    for (const name of Object.keys(ACTION_PAYLOADS)) {
      out[name] = (...args) => {
        const msg = Object.assign({ action: name }, ACTION_PAYLOADS[name](...args));
        const p = chrome.runtime.sendMessage(msg);
        if (overrides[name]) overrides[name](...args);
        return p;
      };
    }
    return out;
  }

  // Chrome 113 keeps up to kMaxDownloadViews = 15 download_item_views in
  // memory (download_shelf_view.cc). The shelf then hides any chip whose
  // right edge would overlap the trailing cluster. We mirror that: render
  // up to 15 chips, and rely on flex/clip-path to clip overflow. The popup
  // list is uncapped.
  const BAR_CHIP_LIMIT = 15;

  function mount(root, actions, opts) {
    const layout = (opts && opts.layout) || 'bar';

    const styleEl = document.createElement('style');
    styleEl.textContent = STYLES;
    root.appendChild(styleEl);

    const container = el('div', { class: layout === 'list' ? 'db-list' : 'db-bar' });
    const items = el('div', { class: 'db-items' });
    // Separator: sits between chips and the trailing show-all/close cluster.
    // Adjacent to the chips area (left side), not the right edge of the bar.
    const divider = el('div', { class: 'db-divider' });

    const showAllBtn = el('button', {
      class: 'db-link', title: 'Show all downloads',
      onclick: () => actions.openDownloadsPage()
    }, 'Show all');

    const tail = el('div', { class: 'db-tail' },
      showAllBtn,
      el('button', {
        class: 'db-close', title: 'Close',
        // stop() also prevents the container click handler from firing
        // and closing any open chip menus.
        onclick: stop(() => actions.dismissAll())
      }, '\u2715')
    );

    container.append(items, divider, tail);
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
      container, items, tail, showAllBtn, actions, layout,
      // Tracks the rendered state of each download ID across renders so we
      // can detect transitions (notably in_progress → complete) and fire
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
    // Stash state on ctx so buildMenu (which doesn't receive state directly)
    // can read alwaysOpenExts without threading it through every call site.
    ctx.state = state;
    const { items: list, actions, layout, showAllBtn } = ctx;

    closeAnyMenu(root);
    list.replaceChildren();

    // Chrome 113 behavior: cap the model at 15 chips, then let layout hide
    // any that overflow the bar's visible width. "Show all" stays visible
    // at all times in the bar (matches download_shelf_view.cc: the link
    // and close button are always laid out; only download_views may be
    // SetVisible(false) when they don't fit).
    const isBar = layout !== 'list';
    const visibleItems = isBar
      ? state.items.slice(0, BAR_CHIP_LIMIT)
      : state.items;

    if (!state.items.length) {
      // Reset transition tracking when the bar empties, so a later
      // download that reuses an old ID doesn't suppress its flash.
      ctx.lastState.clear();
      ctx.flashed.clear();
      ctx.flashStart.clear();
      if (layout === 'list') {
        list.append(el('div', { class: 'db-empty' }, 'No active downloads.'));
      }
      return;
    }

    const nextLast = new Map();
    const liveIds = new Set();

    for (const it of visibleItems) {
      const isComplete = it.state === 'complete' && it.exists !== false;

      // Completion flash. Coordinated via two layers:
      //   1. ctx.flashed: in-memory dedup for this mount lifetime.
      //   2. state.flashedIds: SW-tracked set persisted in session storage,
      //      so the flash doesn't re-fire in another tab or after SW restart.
      //      The renderer acks every new flash via actions.markFlashed.
      const currState = progressState(it);
      const isNewChip = !ctx.lastState.has(it.id);
      const swFlashed = state.flashedIds && state.flashedIds.includes(it.id);
      if (isComplete && !ctx.flashed.has(it.id) && !swFlashed) {
        ctx.flashed.add(it.id);
        ctx.flashStart.set(it.id, Date.now());
        try { actions.markFlashed(it.id); } catch { /* best-effort */ }
      }
      // A flash is "active" if it started within the 2500 ms window. Re-renders
      // during that window re-apply the class with a negative animation-delay
      // so the animation appears continuous.
      const FLASH_MS = 2500;
      const flashStartAt = ctx.flashStart.get(it.id);
      const flashElapsed = flashStartAt != null ? Date.now() - flashStartAt : Infinity;
      const shouldFlash = flashElapsed < FLASH_MS;
      nextLast.set(it.id, currState);
      liveIds.add(it.id);

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
        iconWrap.append(progressRingSvg(progressPct(it), false));
      } else if (currState === 'indeterminate') {
        iconWrap.append(progressRingSvg(0, true));
      }
      // Primary icon: the OS-supplied file icon (chrome.downloads.getFileIcon
      // in the service worker, propagated via state.iconUrl). This is what
      // the legacy Chrome 113 shelf shows -- the same icon Windows Explorer
      // would draw for the file, including any embedded .exe icon resource.
      // Fall back to the favicon for the originating page, then to the
      // generic doc glyph if neither is available yet.
      if (it.iconUrl) {
        const osIcon = document.createElement('img');
        osIcon.src = it.iconUrl;
        osIcon.alt = '';
        osIcon.className = 'db-os-icon';
        iconWrap.append(osIcon);
      } else {
        iconWrap.append(glyphSvg(it.basename || it.url, it.mime));
        const fav = faviconImg(it.referrer);
        if (fav) {
          // Place the favicon on top of the glyph using absolute positioning so
          // a failed load reveals the glyph rather than collapsing layout.
          fav.style.cssText = 'position:absolute; width:20px; height:20px;';
          iconWrap.style.position = 'relative';
          iconWrap.append(fav);
        }
      }

      const [baseName, extName] = splitExt(it.basename || it.url || '(unknown)');
      // Completed chips drop the status row entirely (a single centered
      // filename). The interrupted-but-not-canceled case gets the red tint;
      // canceled stays neutral grey, matching the reference recording.
      const status = statusText(it);
      const textChildren = [
        el('div', { class: 'db-name' },
          el('span', { class: 'db-name-base' }, baseName),
          extName && el('span', { class: 'db-name-ext' }, extName)
        )
      ];
      if (status) {
        textChildren.push(el('div', {
          class: 'db-status' +
            (it.state === 'interrupted' && !isCanceled(it) ? ' db-error' : '')
        }, status));
      }
      const text = el('div', { class: 'db-text' }, ...textChildren);

      let card; // forward-declared so caret handler can find its menu host.

      const caret = el('button', {
        class: 'db-caret', title: 'More actions',
        onclick: stop(() => {
          const existing = card.querySelector('.db-menu');
          closeAnyMenu(root);
          if (!existing) {
            card.append(buildMenu(it, actions, root));
            caret.classList.add('db-caret--open');
            setCaretChevron(caret, 'down');
          }
        })
      });
      setCaretChevron(caret, 'up');
      const caretSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      caretSvg.setAttribute('viewBox', '0 0 10 10');
      const chev = document.createElementNS('http://www.w3.org/2000/svg', 'path');
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
        dataset: { state: progressState(it), clickable: isComplete ? '1' : '0' },
        title: it.filename || it.basename,
        onclick: isComplete
          ? () => { if (!card.querySelector('.db-menu')) actions.open(it.id); }
          : undefined,
        ondragstart: isComplete ? (e) => onDragStart(e, it) : undefined
      });

      card.append(iconWrap, text, caret);
      list.append(card);
    }

    // Commit next state and prune flashed IDs that are no longer present.
    ctx.lastState = nextLast;
    for (const id of [...ctx.flashed]) if (!liveIds.has(id)) ctx.flashed.delete(id);
    for (const id of [...ctx.flashStart.keys()]) if (!liveIds.has(id)) ctx.flashStart.delete(id);
  }

  function onDragStart(e, it) {
    const name = it.basename || 'download';
    const url = it.finalUrl || it.url || '';
    const mime = it.mime || 'application/octet-stream';
    try {
      e.dataTransfer.setData('DownloadURL', `${mime}:${name}:${url}`);
      e.dataTransfer.setData('text/uri-list', url);
      e.dataTransfer.setData('text/plain', url);
      e.dataTransfer.effectAllowed = 'copy';
    } catch { /* ignore */ }
  }

  const api = { mount, render, makeActions };
  if (typeof window !== 'undefined') window.DownloadBar = api;
  if (typeof self !== 'undefined') self.DownloadBar = api;
})();
