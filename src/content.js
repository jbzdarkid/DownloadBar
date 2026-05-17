// DownloadBar — content script.
// Injects a fixed-position bar into the page using a closed Shadow DOM so
// page CSS cannot affect it (and vice versa). Subscribes to the SW via a
// long-lived port; renders state, never polls.

(function () {
  if (window.__downloadbar_installed) return;
  window.__downloadbar_installed = true;
  if (window.top !== window.self) return; // top frame only

  let host = null;
  let shadow = null;

  const actions = DownloadBar.makeActions({
    dismissAll() {
      // Hide immediately so ✕ feels instant; the SW broadcast will follow
      // with items=[] and keep the host hidden. Without this the click can
      // feel broken while the SW wakes up.
      setVisible(false);
    },
  });

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__downloadbar_host__';
    host.style.cssText =
      'all: initial !important;' +
      'position: fixed !important;' +
      'left: 0 !important; right: 0 !important; bottom: 0 !important;' +
      'z-index: 2147483647 !important;' +
      'pointer-events: auto !important;';
    shadow = host.attachShadow({ mode: 'closed' });
    DownloadBar.mount(shadow, actions, { layout: 'bar' });
    (document.body || document.documentElement).appendChild(host);
  }

  function setVisible(v) {
    if (!host) return;
    // The host's cssText uses `all: initial !important`, so a plain
    // style.display = 'none' is silently overridden. Use setProperty with
    // 'important' to actually hide.
    if (v) host.style.removeProperty('display');
    else host.style.setProperty('display', 'none', 'important');
  }

  // Long-lived port: SW pushes state on connect and on every change.
  let port;
  function connect() {
    port = chrome.runtime.connect({ name: 'downloadbar' });
    port.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'state') return;
      if (!msg.state.items.length) { setVisible(false); return; }
      ensureHost();
      setVisible(true);
      DownloadBar.render(shadow, msg.state);
    });
    port.onDisconnect.addListener(() => {
      // SW recycled or extension reloaded — reconnect on next interaction.
      port = null;
      const reconnect = () => {
        window.removeEventListener('focus', reconnect);
        document.removeEventListener('visibilitychange', reconnect);
        try { connect(); } catch { /* ignore */ }
      };
      window.addEventListener('focus', reconnect, { once: true });
      document.addEventListener('visibilitychange', reconnect, { once: true });
    });
  }

  try { connect(); } catch { /* ignore */ }
})();
