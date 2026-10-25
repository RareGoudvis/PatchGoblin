/* Questi Week Planner — content.js
 * Thin boot/relay layer. planner.js (loaded first, same isolated world) defines
 * window.__QWP_TOGGLE. This script:
 *   - guards against double injection (window.__QWP_BOOTED),
 *   - relays QWP_TOGGLE messages from background (toolbar action / Alt+P command),
 *   - provides an in-page Alt+P keydown fallback (works even if the command key
 *     is unregistered or intercepted by the SPA).
 * It injects nothing itself; the fullscreen page is built lazily by __QWP_TOGGLE. */
(function () {
  "use strict";
  if (window.__QWP_BOOTED) return;
  window.__QWP_BOOTED = true;

  // ----- Beta channel -----
  // A BETA copy (manifest name contains "BETA") is sideloaded next to the stable addon. Both inject
  // the same overlay ids and class names into the same page, so they must never be live together:
  //   - the beta's CSS is NOT in its manifest; the worker inserts it only once the beta is the active
  //     copy (QWP_INSERT_CSS), so beta styles never bleed into the stable overlay;
  //   - before that, stable is detected by probing for its CSS (manifest CSS is injected before the
  //     DOM, so it is already there at document_idle); if found, the beta stays dormant and says so;
  //   - beta chips carry their own data attributes, so neither copy mistakes the other's chips for its own.
  var IS_BETA = (function () { try { return /BETA/.test(chrome.runtime.getManifest().name || ""); } catch (e) { return false; } })();
  var stableActive = IS_BETA && (function () {
    try {
      var probe = document.createElement("div");
      probe.className = "qwp-banner"; probe.style.position = "absolute"; probe.style.visibility = "hidden";
      (document.body || document.documentElement).appendChild(probe);
      var on = getComputedStyle(probe).display === "flex";   // planner.css: .qwp-banner { display:flex }
      probe.remove();
      return on;
    } catch (e) { return false; }
  })();
  var _cssReady = null;
  function ensureCss() {
    if (!IS_BETA) return Promise.resolve();
    if (!_cssReady) _cssReady = new Promise(function (resolve) {
      try { chrome.runtime.sendMessage({ type: "QWP_INSERT_CSS" }, function () { void chrome.runtime.lastError; resolve(); }); }
      catch (e) { resolve(); }
    });
    return _cssReady;
  }
  var _noticeShown = false;
  function showDormantNotice() {
    if (_noticeShown || !document.body) return; _noticeShown = true;
    var n = document.createElement("div");
    n.setAttribute("data-qwpb-notice", "1");
    n.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483600;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:#fff7d6;color:#304651;border:1px solid #e4c84a;box-shadow:0 2px 10px rgba(0,0,0,.18);font:600 13px/1.35 urw-din,helvetica,'Segoe UI',Arial,sans-serif;max-width:92vw;";
    n.innerHTML = "<span>UnQuesti <b>BETA</b> staat uit: de stabiele versie is ook actief. Schakel één van beide uit op chrome://extensions en herlaad de pagina.</span>";
    var x = document.createElement("button");
    x.type = "button"; x.textContent = "×"; x.title = "Verbergen";
    x.style.cssText = "border:none;background:transparent;color:#304651;font-size:18px;line-height:1;cursor:pointer;padding:0 2px;";
    x.addEventListener("click", function () { n.remove(); });
    n.appendChild(x);
    document.body.appendChild(n);
  }
  // Every entry point (chip, toolbar action, shortcut) goes through here.
  function activate(fn) {
    if (stableActive) { _noticeShown = false; showDormantNotice(); return; }
    ensureCss().then(function () { try { fn(); } catch (e) { /* no-op */ } });
  }

  function toggle() {
    activate(function () { if (typeof window.__QWP_TOGGLE === "function") window.__QWP_TOGGLE(); });
  }

  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === "QWP_TOGGLE") toggle();
    });
  } catch (e) { /* not in extension context */ }

  document.addEventListener(
    "keydown",
    function (e) {
      // Stable: Alt+P. Beta: Alt+Shift+P, so the two never fight over one shortcut.
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "p" || e.key === "P") && (!IS_BETA || e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    },
    true
  );

  // ----- Launcher button inside the Questi UI -----
  // Adds a "Weekplanner" button to Questi's top toolbar (next to the zoom/Week/print
  // icons). Falls back to a floating top-right button when the toolbar isn't found.
  // Runtime-discovered anchor + MutationObserver so it survives the SPA re-rendering.
  // Anchor = the calendar toolbar's print button (`.print-trigger` in `.calendar-header`),
  // so the launcher sits right after it — NOT in the top dark nav bar.
  function findToolbarAnchor() {
    var el = document.querySelector(".calendar-header .print-trigger") || document.querySelector("button.print-trigger");
    if (el && el.offsetParent !== null) return el;
    // Fallback: any visible control labelled print/afdrukken.
    var cands = document.querySelectorAll('button, a[role="button"], [role="button"]');
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i]; if (!c || c.offsetParent === null) continue;
      var label = ((c.getAttribute("aria-label") || "") + " " + (c.getAttribute("title") || "") + " " + (c.textContent || "")).toLowerCase();
      if (/\bprint\b|afdruk/.test(label)) return c;
    }
    return null;
  }
  // Styled to match Questi's light-gray toolbar chips (like the "Week" / "125%" chips):
  // rounded pill, dark text, a small icon. Self-contained inline SVG + styles.
  var CAL_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';
  var DOC_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line></svg>';
  var PRINT_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>';
  function makeChip(opts, floating) {
    var b = document.createElement("button");
    b.setAttribute(opts.attr, "1");
    b.type = "button";
    b.title = opts.title;
    b.innerHTML = opts.icon + "<span>" + opts.label + "</span>"
      + (IS_BETA ? '<span style="padding:2px 6px;border-radius:8px;background:#e4e642;color:#304651;font-size:10px;letter-spacing:.04em;">BETA</span>' : "");
    // Match Questi's own toolbar chips: urw-din font, slate ink (#304651), light-grey pill.
    b.style.cssText = "display:inline-flex;align-items:center;gap:7px;cursor:pointer;height:32px;padding:0 14px;margin:0 4px;border:none;border-radius:16px;background:#eceef0;color:#304651;font:600 13px/1 urw-din,q-urw-din,helvetica,'Segoe UI',Arial,sans-serif;vertical-align:middle;white-space:nowrap;";
    if (floating) b.style.cssText += "position:fixed;top:56px;right:" + (opts.floatRight || 16) + "px;z-index:2147482000;box-shadow:0 1px 4px rgba(0,0,0,.2);";
    b.addEventListener("mouseenter", function () { b.style.background = "#dfe2e5"; });
    b.addEventListener("mouseleave", function () { b.style.background = "#eceef0"; });
    b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); opts.onClick(); });
    return b;
  }
  var CHIP_ATTR = IS_BETA
    ? { planner: "data-qwpb-launcher", lessons: "data-qwpb-lessons", print: "data-qwpb-print" }
    : { planner: "data-qwp-launcher", lessons: "data-qwl-launcher", print: "data-qwp-print" };
  var PLANNER_CHIP = { attr: CHIP_ATTR.planner, title: "Questi Weekplanner (" + (IS_BETA ? "Alt+Shift+P" : "Alt+P") + ")", label: "Weekplanner", icon: CAL_ICON, floatRight: 16, onClick: toggle };
  var LESSONS_CHIP = { attr: CHIP_ATTR.lessons, title: "Lesfiches beheren", label: "Lesfiches", icon: DOC_ICON, floatRight: IS_BETA ? 200 : 158, onClick: function () { activate(function () { if (typeof window.__QWP_OPEN_LESSONS === "function") window.__QWP_OPEN_LESSONS(); }); } };
  var PRINT_CHIP = { attr: CHIP_ATTR.print, title: "Weekplanning afdrukken", label: "Afdrukken", icon: PRINT_ICON, floatRight: IS_BETA ? 380 : 300, onClick: function () { activate(function () { if (typeof window.__QWP_PRINT === "function") window.__QWP_PRINT(); }); } };
  // The launcher belongs only on the calendar view. Questi is an SPA, so the URL can
  // change without a reload — gate on the current path and remove the button elsewhere.
  function onCalendar() { return /\/(calendar|kalender|agenda)/i.test(location.pathname || ""); }
  function haveChips() { return document.querySelector("[" + CHIP_ATTR.planner + "]") && document.querySelector("[" + CHIP_ATTR.lessons + "]") && document.querySelector("[" + CHIP_ATTR.print + "]"); }
  function removeLauncher() {
    var a = document.querySelector("[" + CHIP_ATTR.planner + "]"); if (a) a.remove();
    var b = document.querySelector("[" + CHIP_ATTR.lessons + "]"); if (b) b.remove();
    var c = document.querySelector("[" + CHIP_ATTR.print + "]"); if (c) c.remove();
  }
  function ensureLauncher() {
    if (!onCalendar()) { removeLauncher(); return; }   // off the calendar → no buttons
    if (stableActive) { removeLauncher(); showDormantNotice(); return; } // beta stays out of the way
    if (haveChips()) return;                            // idempotent (both present)
    removeLauncher();                                   // clear a partial insert, re-add as a pair
    var anchor = findToolbarAnchor();
    if (anchor && anchor.parentNode) {
      // Insert Weekplanner right after the anchor, then Lesfiches, then Afdrukken.
      var planner = makeChip(PLANNER_CHIP, false);
      anchor.parentNode.insertBefore(planner, anchor.nextSibling);
      var lessons = makeChip(LESSONS_CHIP, false);
      anchor.parentNode.insertBefore(lessons, planner.nextSibling);
      anchor.parentNode.insertBefore(makeChip(PRINT_CHIP, false), lessons.nextSibling);
      return;
    }
    if (document.body) { document.body.appendChild(makeChip(PLANNER_CHIP, true)); document.body.appendChild(makeChip(LESSONS_CHIP, true)); document.body.appendChild(makeChip(PRINT_CHIP, true)); } // fallback
  }
  var _luPending = false;
  function scheduleLauncher() {
    if (_luPending) return; _luPending = true;
    setTimeout(function () { _luPending = false; try { ensureLauncher(); } catch (e) {} }, 300);
  }
  try {
    scheduleLauncher();
    // Re-evaluate on any DOM change: adds the chips when the calendar renders, removes
    // them after an SPA navigation to a non-calendar page.
    var mo = new MutationObserver(function () {
      if (!onCalendar()) { removeLauncher(); return; }
      if (!haveChips()) scheduleLauncher();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // Backstop: if the toolbar anchor is never found (SPA/DOM change), guarantee an entry
    // point by dropping the floating chips ~2.5s in. Common case: chips are already inline by
    // then, so haveChips() short-circuits this. Floating chips carry the same data-attrs, so no
    // duplicate insert. (Alt+P already rescues the planner; this is the only rescue for Lesfiches.)
    setTimeout(function () {
      try {
        if (onCalendar() && !stableActive && !haveChips() && document.body) {
          document.body.appendChild(makeChip(PLANNER_CHIP, true));
          document.body.appendChild(makeChip(LESSONS_CHIP, true));
          document.body.appendChild(makeChip(PRINT_CHIP, true));
        }
      } catch (e) { /* no-op */ }
    }, 2500);
  } catch (e) { /* no-op */ }
})();
