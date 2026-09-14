/* DODO Local Config UI — shared DOM helpers.
 * Everything that renders values from the server goes through textContent /
 * DOM APIs, never HTML strings; these helpers keep that invariant in one place.
 * Loaded before tooltips/alerts/app/workbench. No framework, no CDN. */
'use strict';
(() => {
  const DodoUI = (window.DodoUI = window.DodoUI || {});

  /** Create an element with optional textContent (never HTML) and className. */
  DodoUI.el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  /** True when the viewer asked the OS for less motion; alerts/tooltips honor it. */
  DodoUI.reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
})();
