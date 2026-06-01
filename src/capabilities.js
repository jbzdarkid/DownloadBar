// DownloadBar -- browser capability flags for the content script.
// Handles pivot points between chrome and firefox.

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.caps) return;

  // Firefox serves extension resources from moz-extension://, Chrome from chrome-extension://.
  const isFirefox = chrome.runtime.getURL('').startsWith('moz-extension://');

  if (isFirefox) {
    NS.caps = {
      canOpenFiles:       false,
      defaultClickAction: 'show',
      showAllAction:      'openDownloadsFolder',
      showAllTooltip:     'Open downloads folder',
    };
  } else {
    NS.caps = {
      canOpenFiles:       true,
      defaultClickAction: 'open',
      showAllAction:      'openDownloadsPage',
      showAllTooltip:     'Show all downloads',
    };
  }
})();
