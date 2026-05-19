// DownloadBar -- formatting and status classification.
// Pure functions: no DOM, no Chrome API. Verified frame-by-frame against a
// Chrome 113 reference recording (see docs/SHELF_BEHAVIOR.md):
//
//   in progress : `0.5/10.0 MB, 5 mins left`      (single unit, no spaces around `/`)
//   no ETA      : `0.5/10.0 MB`                   (in_progress, estimatedEndTime missing/past)
//   starting    : `Starting...`                   (in_progress, no bytes yet)
//   paused      : `0.7/100 MB, Paused`            (ETA replaced by literal `Paused`)
//   canceled    : `Canceled`                      (interrupted + error=USER_CANCELED)
//   failed      : `Failed - Network disconnected` (interrupted + mapped error)
//   failed bare : `Failed`                        (interrupted with no error field)
//   removed     : `Removed`                       (complete but file no longer on disk)
//   complete    : (empty -- renderer drops the status row entirely)
//
// progressState() additionally classifies `indeterminate` (in_progress, totalBytes unknown).

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.format) return;

  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

  function fmtOne(scaled) {
    if (scaled >= 100) return String(Math.round(scaled));
    return (Math.round(scaled * 10) / 10).toFixed(1);
  }

  // Render received/total with a single shared unit suffix chosen by the larger of the two:
  // `0.5/10.0 MB`, never `512 KB / 10.0 MB`.
  function fmtBytePair(received, total) {
    const ref = Math.max(received || 0, total || 0);
    let unitIndex = 0, scale = 1;
    while (ref / scale >= 1024 && unitIndex < UNITS.length - 1) {
      scale *= 1024;
      unitIndex++;
    }
    const scaledReceived = (received || 0) / scale;
    if (total > 0) {
      const scaledTotal = total / scale;
      return `${fmtOne(scaledReceived)}/${fmtOne(scaledTotal)} ${UNITS[unitIndex]}`;
    }
    return `${fmtOne(scaledReceived)} ${UNITS[unitIndex]}`;
  }

  function fmtEta(iso) {
    if (!iso) return '';
    const remainingMs = new Date(iso).getTime() - Date.now();
    if (!isFinite(remainingMs) || remainingMs <= 0) return '';
    const seconds = Math.round(remainingMs / 1000);
    if (seconds < 60) return seconds + ' secs left';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' mins left';
    return Math.round(minutes / 60) + ' hrs left';
  }

  // chrome.downloads.InterruptReason -> human text.
  // Strings match Chrome 113 IDS_DOWNLOAD_INTERRUPTED_STATUS_* (chrome/app/generated_resources.grd).
  // FailState -> IDS mapping resolved via OfflineItemUtils::GetFailStateMessage (offline_item_utils.cc).
  // Reasons that fall back to the generic IDS_DOWNLOAD_INTERRUPTED_STATUS in Chrome are intentionally omitted
  // so the title-cased enum fallback below handles them.
  const ERROR_MESSAGES = {
    NETWORK_FAILED: 'Network error',
    NETWORK_TIMEOUT: 'Network timeout',
    NETWORK_DISCONNECTED: 'Network disconnected',
    NETWORK_SERVER_DOWN: 'Server unavailable',
    NETWORK_INVALID_REQUEST: 'Network error',
    SERVER_FAILED: 'Server problem',
    SERVER_BAD_CONTENT: 'No file',
    SERVER_UNAUTHORIZED: 'Needs authorization',
    SERVER_CERT_PROBLEM: 'Bad certificate',
    SERVER_FORBIDDEN: 'Forbidden',
    SERVER_UNREACHABLE: 'Server unreachable',
    SERVER_CONTENT_LENGTH_MISMATCH: 'File incomplete',
    FILE_ACCESS_DENIED: 'Insufficient permissions',
    FILE_NO_SPACE: 'Disk full',
    FILE_NAME_TOO_LONG: 'Path too long',
    FILE_TOO_LARGE: 'File too large',
    FILE_VIRUS_INFECTED: 'Virus detected',
    FILE_TRANSIENT_ERROR: 'System busy',
    FILE_BLOCKED: 'Blocked',
    FILE_SECURITY_CHECK_FAILED: 'Virus scan failed',
    FILE_TOO_SHORT: 'File truncated',
    FILE_SAME_AS_SOURCE: 'Already downloaded',
    USER_SHUTDOWN: 'Shutdown',
    CRASH: 'Crash',
  };

  // The downloads API reports user-cancellation as state=interrupted with error=USER_CANCELED.
  // Treat that as its own visual state -- not a failure.
  function isCanceled(item) {
    return item.state === 'interrupted' && item.error === 'USER_CANCELED';
  }

  function statusText(item) {
    // Completed chips drop the status row; "Removed" is the one exception.
    if (item.state === 'complete') return item.exists === false ? 'Removed' : '';
    if (item.state === 'interrupted') {
      if (isCanceled(item)) return 'Canceled';
      if (!item.error) return 'Failed';
      const reason = ERROR_MESSAGES[item.error] ||
        item.error.replace(/_/g, ' ').toLowerCase().replace(/^./, ch => ch.toUpperCase());
      return 'Failed - ' + reason;
    }
    if (item.paused) return fmtBytePair(item.bytesReceived, item.totalBytes) + ', Paused';
    // in_progress
    if (!item.bytesReceived) return 'Starting...';
    const bytes = fmtBytePair(item.bytesReceived, item.totalBytes);
    const eta = fmtEta(item.estimatedEndTime);
    return eta ? `${bytes}, ${eta}` : bytes;
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
