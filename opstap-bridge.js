/* UnQuesti — Op.Stap bridge (runs in the PAGE's world, see manifest "world": "MAIN").
 * Questi loads Katholiek Onderwijs Vlaanderen's <op-stap-selector> web component on every page.
 * It reports a selection with the DOM event "OpStapSelectionChanged" ({ selectedKeys: ["/content/<uuid>", …] }),
 * but an event's `detail` object does not reach the extension's isolated world. For the
 * selectors UnQuesti itself places (marked data-uq), this copies the detail onto the element as
 * JSON in `data-uq-sel`, which the extension reads. It touches nothing else and sends nothing anywhere. */
(function () {
  if (window.__UQ_OPSTAP_BRIDGE) return;
  window.__UQ_OPSTAP_BRIDGE = true;
  // Capture phase: also sees the event when it does not bubble.
  document.addEventListener("OpStapSelectionChanged", function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute("data-uq")) return;
    try { t.setAttribute("data-uq-sel", JSON.stringify(e.detail || null)); } catch (x) {}
  }, true);
})();
