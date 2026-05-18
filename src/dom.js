// DownloadBar -- generic DOM helpers.
// Attached to the internal __DB namespace; consumed by ui.js and menu.js.

(function () {
  const NS = (window.__DB = window.__DB || {});
  if (NS.dom) return;

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) for (const key in attrs) {
      if (key === 'class') node.className = attrs[key];
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), attrs[key]);
      else if (key === 'dataset') for (const dataKey in attrs.dataset) node.dataset[dataKey] = attrs.dataset[dataKey];
      else if (attrs[key] === true) node.setAttribute(key, '');
      else if (attrs[key] != null && attrs[key] !== false) node.setAttribute(key, attrs[key]);
    }
    for (const child of children) {
      if (child == null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  NS.dom = { el };
})();
