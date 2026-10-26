/* PatchGoblin — Op.Stap bridge (runs in the PAGE's world, see manifest "world": "MAIN").
 * Questi uses Katholiek Onderwijs Vlaanderen's <op-stap-selector> web component for Op.Stap
 * leerplandoelen, but only loads its script once Questi's own fiche editor opens. This bridge:
 *  - marks <html data-pg-opstap="1"> once the component is defined, so the extension knows;
 *  - on the extension's "pg-opstap-load" event, loads that same script (the URL Questi uses)
 *    when it is not there yet — classic first, as a module if that defines nothing;
 *  - copies each "OpStapSelectionChanged" detail onto PatchGoblin's own selectors (marked data-pg)
 *    as JSON in `data-pg-sel`, because an event's detail object does not reach the extension's
 *    isolated world.
 * It touches nothing else and sends nothing anywhere. */
(function () {
  if (window.__PG_OPSTAP_BRIDGE) return;
  window.__PG_OPSTAP_BRIDGE = true;
  var SRC = "https://opstap.katholiekonderwijs.vlaanderen/webcomponent/op-stap-selector.latest.js";
  function defined() { return !!(window.customElements && window.customElements.get("op-stap-selector")); }
  function mark() { document.documentElement.setAttribute("data-pg-opstap", "1"); }
  if (window.customElements) window.customElements.whenDefined("op-stap-selector").then(mark);
  function add(asModule) {
    var s = document.createElement("script");
    s.src = SRC; s.async = true; if (asModule) s.type = "module";
    s.setAttribute("data-pg-loaded", asModule ? "module" : "classic");
    (document.head || document.documentElement).appendChild(s);
  }
  document.addEventListener("pg-opstap-load", function () {
    if (defined()) { mark(); return; }
    if (document.querySelector('script[src*="op-stap-selector"]')) return;   // Questi or we are loading it
    add(false);
    setTimeout(function () { if (!defined() && !document.querySelector('script[data-pg-loaded="module"]')) add(true); }, 4000);
  });
  // Capture phase: also sees the event when it does not bubble.
  document.addEventListener("OpStapSelectionChanged", function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute("data-pg")) return;
    try { t.setAttribute("data-pg-sel", JSON.stringify(e.detail || null)); } catch (x) {}
  }, true);
})();
