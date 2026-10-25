/* UnQuesti — Op.Stap bridge (runs in the PAGE's world, see manifest "world": "MAIN").
 * Questi uses Katholiek Onderwijs Vlaanderen's <op-stap-selector> web component for Op.Stap
 * leerplandoelen, but only loads its script once Questi's own fiche editor opens. This bridge:
 *  - marks <html data-uq-opstap="1"> once the component is defined, so the extension knows;
 *  - on the extension's "uq-opstap-load" event, loads that same script (the URL Questi uses)
 *    when it is not there yet — classic first, as a module if that defines nothing;
 *  - copies each "OpStapSelectionChanged" detail onto UnQuesti's own selectors (marked data-uq)
 *    as JSON in `data-uq-sel`, because an event's detail object does not reach the extension's
 *    isolated world.
 * It touches nothing else and sends nothing anywhere. */
(function () {
  if (window.__UQ_OPSTAP_BRIDGE) return;
  window.__UQ_OPSTAP_BRIDGE = true;
  var SRC = "https://opstap.katholiekonderwijs.vlaanderen/webcomponent/op-stap-selector.latest.js";
  function defined() { return !!(window.customElements && window.customElements.get("op-stap-selector")); }
  function mark() { document.documentElement.setAttribute("data-uq-opstap", "1"); }
  if (window.customElements) window.customElements.whenDefined("op-stap-selector").then(mark);
  function add(asModule) {
    var s = document.createElement("script");
    s.src = SRC; s.async = true; if (asModule) s.type = "module";
    s.setAttribute("data-uq-loaded", asModule ? "module" : "classic");
    (document.head || document.documentElement).appendChild(s);
  }
  document.addEventListener("uq-opstap-load", function () {
    if (defined()) { mark(); return; }
    if (document.querySelector('script[src*="op-stap-selector"]')) return;   // Questi or we are loading it
    add(false);
    setTimeout(function () { if (!defined() && !document.querySelector('script[data-uq-loaded="module"]')) add(true); }, 4000);
  });
  // Capture phase: also sees the event when it does not bubble.
  document.addEventListener("OpStapSelectionChanged", function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute("data-uq")) return;
    try { t.setAttribute("data-uq-sel", JSON.stringify(e.detail || null)); } catch (x) {}
  }, true);
})();
