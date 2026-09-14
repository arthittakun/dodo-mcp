/* DODO Local Config UI — accessible tooltip system (WAI-ARIA tooltip pattern).
 * One shared, non-interactive tooltip element:
 *   - opens on hover AND keyboard focus AND tap;
 *   - closes on Escape, blur, pointer leave, click outside, scroll, resize;
 *   - trigger gets aria-describedby while open + aria-expanded state;
 *   - repositions/flips near viewport edges and never captures pointer events,
 *     so it cannot block the control it describes;
 *   - all tip text is set through textContent (server/path/client/provider
 *     values can never become markup);
 *   - motion is CSS-only and disabled under prefers-reduced-motion.
 * The title attribute is never used as the primary mechanism. */
'use strict';
(() => {
  const DodoUI = (window.DodoUI = window.DodoUI || {});
  const TIP_ID = 'dodo-tooltip';
  const tipText = new WeakMap();

  let bubble = null;
  let openFor = null;

  function ensureBubble() {
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.id = TIP_ID;
    bubble.setAttribute('role', 'tooltip');
    bubble.hidden = true;
    document.body.append(bubble);
    return bubble;
  }

  function place(trigger) {
    const margin = 8;
    const rect = trigger.getBoundingClientRect();
    const tip = ensureBubble();
    // Measure after content is set; fixed positioning, pointer-events: none.
    tip.style.left = '0px';
    tip.style.top = '0px';
    const size = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - size.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - size.width - margin));
    let top = rect.top - size.height - margin; // prefer above
    let position = 'above';
    if (top < margin) { top = rect.bottom + margin; position = 'below'; } // flip near the top edge
    if (top + size.height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - size.height - margin);
    tip.dataset.position = position;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function show(trigger) {
    const text = tipText.get(trigger) ?? trigger.dataset.tip ?? '';
    if (!text) return;
    const tip = ensureBubble();
    if (openFor && openFor !== trigger) hide();
    openFor = trigger;
    tip.textContent = text; // never HTML
    tip.hidden = false;
    trigger.setAttribute('aria-describedby', TIP_ID);
    trigger.setAttribute('aria-expanded', 'true');
    place(trigger);
  }

  function hide() {
    if (!openFor) return;
    openFor.removeAttribute('aria-describedby');
    openFor.setAttribute('aria-expanded', 'false');
    openFor = null;
    if (bubble) bubble.hidden = true;
  }

  function wire(trigger) {
    if (trigger.dataset.tipWired === '1') return;
    trigger.dataset.tipWired = '1';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('pointerenter', () => show(trigger));
    trigger.addEventListener('pointerleave', () => { if (document.activeElement !== trigger) hide(); });
    trigger.addEventListener('focus', () => show(trigger));
    trigger.addEventListener('blur', hide);
    // Tap (and click) always OPENS: with a mouse, hover has usually opened the
    // tip already, so a toggle would close it on the same gesture. Closing is
    // Escape / outside tap / blur / pointer leave.
    trigger.addEventListener('click', (ev) => {
      ev.preventDefault(); // help buttons never submit forms
      show(trigger);
    });
  }

  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hide(); });
  document.addEventListener('pointerdown', (ev) => {
    if (openFor && ev.target !== openFor && !openFor.contains(ev.target)) hide();
  });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);

  DodoUI.tooltips = {
    /** Create a `?` help button whose tooltip text is set via textContent only. */
    helpButton(text, subject) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'help-tip';
      b.textContent = '?';
      b.setAttribute('aria-label', subject ? `คำอธิบาย: ${subject}` : 'คำอธิบายเพิ่มเติม');
      tipText.set(b, String(text));
      wire(b);
      return b;
    },
    /** Wire every element with a static data-tip attribute under root. */
    attach(root = document) {
      for (const node of root.querySelectorAll('[data-tip]')) wire(node);
    },
    hide,
  };

  DodoUI.tooltips.attach();
})();
