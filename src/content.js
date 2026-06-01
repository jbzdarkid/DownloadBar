// DownloadBar -- content script.
// Injects a fixed-position bar into the page using a closed Shadow DOM so page CSS cannot affect it (and vice versa).
// Subscribes to the SW via a long-lived port; renders state, never polls.

(function () {
  if (window.__downloadbar_installed) return;
  window.__downloadbar_installed = true;
  if (window.top !== window.self) return; // top frame only

  let _host = null;
  let _shadow = null;
  let _port;

  function ensureHost() {
    if (_host) return;
    _host = document.createElement('div');
    _host.id = '__downloadbar_host__';
    _host.style.cssText =
      'all: initial !important;' +
      // `all: initial !important` overrides the :host font-family rule, so restore it inline.
      'font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif !important;' +
      'position: fixed !important;' +
      'left: 0 !important; right: 0 !important; bottom: 0 !important;' +
      'z-index: 2147483647 !important;' +
      'pointer-events: auto !important;';
    _shadow = _host.attachShadow({ mode: 'closed' });
    DownloadBar.mount(_shadow);
    (document.body || document.documentElement).appendChild(_host);
  }

  function setVisible(v) {
    if (!_host) return;
    // The host's cssText uses `all: initial !important`, so a plain style.display = 'none' is silently
    // overridden. Use setProperty with 'important' to actually hide.
    if (v) _host.style.removeProperty('display');
    else _host.style.setProperty('display', 'none', 'important');
  }

  // Long-lived port: SW pushes state on connect and on every change.
  function connect() {
    try {
      _port = chrome.runtime.connect({ name: 'downloadbar' });
    } catch {
      // The extension was reloaded, shut down until the next page navigation.
      _port = null;
      setVisible(false);
      return;
    }
    // Local count of visible chips so we can hide the host when it's empty without asking the SW.
    // snapshot resets it; created/erased adjust by one.
    let visibleCount = 0;
    _port.onMessage.addListener((msg) => {
      // Update visibility counter, then dispatch to the matching renderer handler. Even when
      // visibleCount drops to zero we still apply the message so the renderer's _chips map
      // stays in sync for any later messages.
      switch (msg.type) {
        case 'snapshot':
          visibleCount = msg.items.length;
          if (_shadow) DownloadBar.snapshot(_shadow, msg);
          break;
        case 'created':
          visibleCount++;
          if (_shadow) DownloadBar.created(_shadow, msg);
          break;
        case 'changed':
          if (_shadow) DownloadBar.changed(_shadow, msg);
          break;
        case 'erased':
          if (visibleCount > 0) visibleCount--;
          if (_shadow) DownloadBar.erased(_shadow, msg);
          break;
      }
      if (visibleCount > 0) {
        ensureHost();
        setVisible(true);
      } else {
        setVisible(false);
      }
    });
    _port.onDisconnect.addListener(() => {
      // SW recycled or extension reloaded -- reconnect on next interaction.
      void chrome.runtime.lastError;
      _port = null;
      const reconnect = () => {
        window.removeEventListener('focus', reconnect);
        document.removeEventListener('visibilitychange', reconnect);
        connect();
      };
      window.addEventListener('focus', reconnect, { once: true });
      document.addEventListener('visibilitychange', reconnect, { once: true });
    });
  }

  connect();
})();
