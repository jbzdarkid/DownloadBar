// DownloadBar -- formatting and status classification.
// Pure functions: no DOM, no Chrome API. Verified frame-by-frame against a
// Chrome 113 reference recording (see docs/SHELF_BEHAVIOR.md):
//
//   in progress : `0.5/10.0 MB, 5 mins left`     (single unit, no spaces around `/`)
//   paused      : `0.7/100 MB, Paused`           (ETA replaced by literal `Paused`)
//   starting    : `Starting...`
//   canceled    : `Canceled`
//   failed      : `Failed - Network disconnected`
//   complete    : (empty -- renderer drops the status row entirely)

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.format) return;

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

  // chrome.downloads.InterruptReason -> human text. Unmapped values fall
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

  // The downloads API reports user-cancellation as state=interrupted with
  // error=USER_CANCELED. Treat that as its own visual state -- not a failure.
  function isCanceled(item) {
    return item.state === 'interrupted' && item.error === 'USER_CANCELED';
  }

  function statusText(item) {
    if (item.state === 'complete') {
      // Completed chips drop the status row; "Removed" is the one exception.
      return item.exists === false ? 'Removed' : '';
    }
    if (item.state === 'interrupted') {
      if (isCanceled(item)) return 'Canceled';
      if (!item.error) return 'Failed';
      const reason = ERROR_MESSAGES[item.error] ||
        item.error.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
      return 'Failed - ' + reason;
    }
    if (item.paused) {
      return fmtBytePair(item.bytesReceived, item.totalBytes) + ', Paused';
    }
    // in_progress
    if (!item.bytesReceived) return 'Starting...';
    const sz = fmtBytePair(item.bytesReceived, item.totalBytes);
    const eta = fmtEta(item.estimatedEndTime);
    return eta ? `${sz}, ${eta}` : sz;
  }

  function progressState(item) {
    if (item.state === 'complete') return 'complete';
    if (item.state === 'interrupted') return isCanceled(item) ? 'canceled' : 'interrupted';
    if (item.paused) return 'paused';
    if (item.totalBytes > 0) return 'in_progress';
    return 'indeterminate';
  }

  function progressPct(item) {
    if (item.state === 'complete') return 100;
    if (item.totalBytes > 0) return Math.max(0, Math.min(100, (item.bytesReceived / item.totalBytes) * 100));
    return 0;
  }

  NS.format = { statusText, progressState, progressPct };
})();
