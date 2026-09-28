/**
 * Native hover tooltips may outlive a hidden Electron window on macOS and
 * appear in screen capture. Keep their text available to assistive technology
 * without creating a separate native tooltip surface.
 */
export function disableNativeTooltips(root: Element): () => void {
  const strip = (element: Element) => {
    const hint = element.getAttribute('title');
    if (hint == null) return;
    if (hint && !element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')) {
      element.setAttribute('aria-label', hint);
    }
    element.removeAttribute('title');
  };
  const stripTree = (element: Element) => {
    strip(element);
    element.querySelectorAll('[title]').forEach(strip);
  };
  stripTree(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') strip(record.target as Element);
      else for (const node of record.addedNodes) {
        if (node instanceof Element) stripTree(node);
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['title'],
  });
  return () => observer.disconnect();
}
