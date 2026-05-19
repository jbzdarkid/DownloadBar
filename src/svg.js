// DownloadBar -- inline SVG primitives.
// Centralizes the small handful of SVG builders the chip + menu paint.
// All icons are based on Chromium 113 source -- originals are in reference/chromium-113-vector-icons/

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.svg) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Chromium 113 vector_icons::kCloseRoundedIcon.
  function closeIconSvg() {
    return strokeIconSvg('M4 4 L12 12 M4 12 L12 4', 1.85);
  }

  // Chromium 113 vector_icons::kCaretUpIcon.
  // The chip's dropdown swaps to kCaretDownIcon, we rotate 180 degrees instead.
  function caretIconSvg() {
    return strokeIconSvg('M4 10 L8 6 L12 10', 1.765);
  }

  // Chromium 113 DownloadItemView::PaintDownloadProgress.
  // Draws an arc around the file icon while downloading; flashes when complete.
  // Pass percent=null for indeterminate, which draws a fixed 50-degree arc that CSS spins.
  function progressRingSvg(percent) {
    const indeterminate = percent == null;
    const r = 10.15;
    const c = 2 * Math.PI * r;
    const fgLen = indeterminate ? (c * 50 / 360) : (c * Math.max(0, Math.min(100, percent)) / 100);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'db-progress-ring' + (indeterminate ? ' db-progress-ring--indeterminate' : ''));
    svg.setAttribute('viewBox', '0 0 24 24');
    if (!indeterminate) {
      const bg = document.createElementNS(SVG_NS, 'circle');
      bg.setAttribute('class', 'db-progress-ring__bg');
      bg.setAttribute('cx', '12');
      bg.setAttribute('cy', '12');
      bg.setAttribute('r', String(r));
      bg.setAttribute('stroke-width', '1.7');
      svg.appendChild(bg);
    }
    const fg = document.createElementNS(SVG_NS, 'circle');
    fg.setAttribute('class', 'db-progress-ring__fg');
    fg.setAttribute('cx', '12');
    fg.setAttribute('cy', '12');
    fg.setAttribute('r', String(r));
    fg.setAttribute('stroke-width', '1.7');
    fg.setAttribute('stroke-linecap', 'butt');
    fg.setAttribute('stroke-dasharray', `${fgLen.toFixed(3)} ${c.toFixed(3)}`);
    // Rotate -90deg around the circle center so the dash starts at 12 o'clock.
    fg.setAttribute('transform', 'rotate(-90 12 12)');
    svg.appendChild(fg);
    return svg;
  }

  // Chromium 113 vector_icons::kMenuCheckIcon.
  function menuCheckSvg() {
    return strokeIconSvg('M2.68 8.53 L5.76 11.71 L13.64 3.62', 1.94, 'butt', 'miter');
  }

  // Shared helper for the stroked icons above.
  function strokeIconSvg(d, strokeWidth, linecap = 'round', linejoin = 'round') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', String(strokeWidth));
    path.setAttribute('stroke-linecap', linecap);
    path.setAttribute('stroke-linejoin', linejoin);
    svg.appendChild(path);
    return svg;
  }

  NS.svg = { closeIconSvg, caretIconSvg, progressRingSvg, menuCheckSvg };
})();
