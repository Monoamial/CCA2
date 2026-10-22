// Embedded mode (?embed): tell the parent page how tall the document is so an
// enclosing iframe can fit it without an inner scrollbar.

if ('embed' in document.documentElement.dataset && window.parent !== window) {
  const report = () => {
    window.parent.postMessage({ type: 'cca:height', height: document.documentElement.scrollHeight }, window.location.origin);
  };
  new ResizeObserver(report).observe(document.body);
  window.addEventListener('load', report);
}
