// DownloadBar — toolbar popup.
// Uses the same renderer as the content script, in vertical "list" layout.
// Acts as a fallback on pages where content scripts can't run (chrome://,
// new tab, web store, PDF viewer, etc.).

(function () {
  const root = document.getElementById('root');
  const actions = DownloadBar.makeActions({
    openDownloadsPage() { window.close(); },
  });

  DownloadBar.mount(root, actions, { layout: 'list' });

  const port = chrome.runtime.connect({ name: 'downloadbar' });
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'state') DownloadBar.render(root, msg.state);
  });
})();
