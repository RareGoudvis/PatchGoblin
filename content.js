/* PatchGoblin — content.js
 * Thin boot/relay layer. planner.js (loaded first, same isolated world) defines
 * window.__QWP_TOGGLE. This script:
 *   - guards against double injection (window.__QWP_BOOTED),
 *   - relays QWP_TOGGLE messages from background (toolbar action / Alt+P command),
 *   - provides an in-page Alt+P keydown fallback (works even if the command key
 *     is unregistered or intercepted by the SPA),
 *   - injects the single PatchGoblin launcher button (+ quick menu) into Questi's toolbar.
 * The fullscreen page itself is built lazily by __QWP_TOGGLE. */
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
    n.innerHTML = "<span>PatchGoblin <b>BETA</b> staat uit: de stabiele versie is ook actief. Schakel één van beide uit op chrome://extensions en herlaad de pagina.</span>";
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

  // ----- Launcher: one PatchGoblin button inside the Questi toolbar -----
  // A single split button right after the calendar toolbar's print button: the main part opens the
  // planner, the ▾ part opens a quick menu (Plannen, Lesfiches, Afdrukken, Instellingen). It is
  // deliberately styled as a foreign object — dark sticker with a hard yellow shadow — so nobody
  // mistakes it for part of Questi. Falls back to a floating button when the toolbar isn't found.
  // Runtime-discovered anchor + MutationObserver so it survives the SPA re-rendering.
  function findToolbarAnchor() {
    var el = document.querySelector(".calendar-header .print-trigger") || document.querySelector("button.print-trigger");
    if (el && el.offsetParent !== null) return el;
    // Fallback: any visible control labelled print/afdrukken.
    var cands = document.querySelectorAll('button, a[role="button"], [role="button"]');
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i]; if (!c || c.offsetParent === null) continue;
      if (c.hasAttribute(LAUNCHER_ATTR)) continue;
      var label = ((c.getAttribute("aria-label") || "") + " " + (c.getAttribute("title") || "") + " " + (c.textContent || "")).toLowerCase();
      if (/\bprint\b|afdruk/.test(label)) return c;
    }
    return null;
  }
  var LAUNCHER_ATTR = IS_BETA ? "data-qwpb-launcher" : "data-qwp-launcher";
  var SHORTCUT = IS_BETA ? "Alt+Shift+P" : "Alt+P";
  var FONT = "700 13.5px/1 system-ui,'Segoe UI',Helvetica,Arial,sans-serif";
  function openLessons() { activate(function () { if (typeof window.__QWP_OPEN_LESSONS === "function") window.__QWP_OPEN_LESSONS(); }); }
  function openPrint() { activate(function () { if (typeof window.__QWP_PRINT === "function") window.__QWP_PRINT(); }); }
  // Instellingen lives in the settings module when it is present; the planner hosts it otherwise.
  function openSettings() {
    activate(function () {
      if (window.__UQ_SETTINGS && typeof window.__UQ_SETTINGS.open === "function") window.__UQ_SETTINGS.open();
      else if (typeof window.__QWP_TOGGLE === "function") window.__QWP_TOGGLE();
    });
  }
  // Staged-but-unwritten changes, as counted by the planner (0 when it does not say).
  function pendingCount() {
    try { var n = typeof window.__QWP_PENDING_COUNT === "function" ? window.__QWP_PENDING_COUNT() : 0; return n > 0 ? n : 0; } catch (e) { return 0; }
  }
  // PatchGoblin mark: the app icon itself (icons/icon48.png, web-accessible on questi.com).
  function markSvg(size) {
    var src = ""; try { src = chrome.runtime.getURL("icons/icon48.png"); } catch (e) {}
    return '<img alt="" aria-hidden="true" src="' + src + '" width="' + size + '" height="' + size + '" style="display:block;flex:0 0 auto;border-radius:' + Math.round(size * .22) + 'px;">';
  }
  // Menu icons, stroke style as in the app's own menus.
  var ICONS = {
    plan: '<path d="M3 5h18v15H3zM3 9h18M8 3v4M16 3v4"/>',
    fiches: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
    print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'
  };
  function icoSvg(name) {
    return '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + "</svg>";
  }
  // Launcher: same shape language as the app's buttons (8px corners) in the PatchGoblin colours —
  // ink fill, amber mark — so it reads as a foreign but tidy object in Questi. No offset shadow.
  function makeLauncher(floating) {
    var wrap = document.createElement("span");
    wrap.setAttribute(LAUNCHER_ATTR, "1");
    wrap.style.cssText = "display:inline-flex;align-items:stretch;height:32px;margin:0 6px 0 10px;border-radius:8px;background:#1E1F27;color:#fff;" +
      "box-shadow:0 1px 3px rgba(30,42,51,.25);vertical-align:middle;white-space:nowrap;font:" + FONT + ";";
    if (floating) wrap.style.cssText += "position:fixed;top:56px;right:20px;z-index:2147482000;";
    var main = document.createElement("button");
    main.type = "button";
    main.title = "PatchGoblin openen (" + SHORTCUT + ")";
    main.style.cssText = "display:inline-flex;align-items:center;gap:8px;padding:0 12px 0 5px;border:none;border-radius:8px 0 0 8px;background:transparent;color:#fff;cursor:pointer;font:" + FONT + ";letter-spacing:-.01em;";
    main.innerHTML = markSvg(22) + "<span>PatchGoblin</span>" +
      (IS_BETA ? '<span style="padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.12);color:#7ED957;font-size:9.5px;letter-spacing:.06em;">BETA</span>' : "") +
      '<span data-uq-badge="1" style="display:none;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#7ED957;color:#1E1F27;font-size:11px;align-items:center;justify-content:center;"></span>';
    main.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); closeMenu(); toggle(); });
    var caret = document.createElement("button");
    caret.type = "button";
    caret.setAttribute("aria-label", "PatchGoblin snelmenu");
    caret.setAttribute("aria-haspopup", "menu");
    caret.setAttribute("aria-expanded", "false");
    caret.style.cssText = "width:30px;display:inline-flex;align-items:center;justify-content:center;border:none;border-left:1px solid rgba(255,255,255,.16);border-radius:0 8px 8px 0;background:transparent;color:#7ED957;cursor:pointer;";
    caret.innerHTML = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    caret.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); if (_menu) closeMenu(); else openMenu(wrap, caret); });
    [main, caret].forEach(function (b) {
      b.addEventListener("mouseenter", function () { b.style.background = "rgba(255,255,255,.08)"; });
      b.addEventListener("mouseleave", function () { b.style.background = "transparent"; });
    });
    wrap.appendChild(main);
    wrap.appendChild(caret);
    refreshBadge(wrap);
    return wrap;
  }
  function refreshBadge(root) {
    var b = (root || document).querySelector("[" + LAUNCHER_ATTR + "] [data-uq-badge]"); if (!b) return;
    var n = pendingCount();
    b.textContent = n ? String(n) : "";
    b.style.display = n ? "inline-flex" : "none";
    b.title = n ? n + " wijziging(en) klaar om te controleren" : "";
  }
  // ----- Quick menu: same look as the app's Alles menu (light border, amber top strip, soft shadow, icon tiles) -----
  var _menu = null;
  var MENU_FONT = "system-ui,'Segoe UI',Helvetica,Arial,sans-serif";
  function menuItem(icon, title, sub, hint, onClick, tone) {
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.style.cssText = "display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:none;background:transparent;border-radius:9px;padding:7px 8px;cursor:pointer;color:#fff;font-family:" + MENU_FONT + ";";
    var tile = document.createElement("span");
    tile.style.cssText = "flex:0 0 auto;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;" +
      (tone === "amber" ? "background:#7ED957;color:#1E1F27;" : "background:rgba(255,255,255,.09);color:#7ED957;");
    tile.innerHTML = icoSvg(icon);
    var txt = document.createElement("span");
    txt.style.cssText = "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;";
    var t = document.createElement("span"); t.style.cssText = "font-size:14px;font-weight:700;line-height:1.25;"; t.textContent = title;
    txt.appendChild(t);
    if (sub) { var d = document.createElement("span"); d.style.cssText = "font-size:12px;color:#a9b7bf;line-height:1.3;"; d.textContent = sub; txt.appendChild(d); }
    b.appendChild(tile); b.appendChild(txt);
    if (hint) { var k = document.createElement("span"); k.style.cssText = "flex:0 0 auto;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700;color:#d7e0e5;background:rgba(255,255,255,.1);"; k.textContent = hint; b.appendChild(k); }
    b.addEventListener("mouseenter", function () { b.style.background = "rgba(255,255,255,.08)"; });
    b.addEventListener("mouseleave", function () { b.style.background = "transparent"; });
    b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); closeMenu(); onClick(); });
    return b;
  }
  function menuSep() { var s = document.createElement("div"); s.style.cssText = "height:1px;margin:4px 6px;background:rgba(255,255,255,.12);"; return s; }
  function openMenu(wrap, caret) {
    closeMenu();
    var r = wrap.getBoundingClientRect();
    var m = document.createElement("div");
    m.setAttribute("role", "menu");
    m.setAttribute("aria-label", "PatchGoblin");
    m.style.cssText = "position:fixed;z-index:2147482500;top:" + Math.round(r.bottom + 10) + "px;left:" + Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 310))) + "px;width:300px;" +
      "display:flex;flex-direction:column;gap:2px;background:#1E1F27;color:#fff;border:1px solid #1E1F27;border-radius:12px;box-shadow:0 10px 28px rgba(30,42,51,.28),0 2px 6px rgba(30,42,51,.12);padding:8px;box-sizing:border-box;";
    var head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 8px 8px;font:800 14px/1 " + MENU_FONT + ";color:#fff;";
    head.innerHTML = markSvg(20) + "<span>PatchGoblin</span>" + (IS_BETA ? '<span style="margin-left:auto;padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.12);color:#7ED957;font-size:10px;font-weight:700;letter-spacing:.06em;">BETA</span>' : "");
    m.appendChild(head);
    var n = pendingCount();
    m.appendChild(menuItem("plan", "Plannen", "deze week en volgende", SHORTCUT, toggle));
    m.appendChild(menuItem("fiches", "Lesfiches", "beheren en doelen invullen", "", openLessons));
    m.appendChild(menuItem("print", "Afdrukken deze week", "weekplanning of lesdoelen", "", openPrint));
    if (n) { m.appendChild(menuSep()); m.appendChild(menuItem("check", n + " wijziging" + (n === 1 ? "" : "en") + " controleren", "nog niet weggeschreven", "", toggle, "amber")); }
    m.appendChild(menuSep());
    m.appendChild(menuItem("settings", "Instellingen", "", "", openSettings));
    document.body.appendChild(m);
    caret.setAttribute("aria-expanded", "true");
    _menu = { el: m, caret: caret };
    var first = m.querySelector("button"); if (first) first.focus();
  }
  function closeMenu() {
    if (!_menu) return;
    try { _menu.el.remove(); _menu.caret.setAttribute("aria-expanded", "false"); } catch (e) { /* no-op */ }
    _menu = null;
  }
  document.addEventListener("click", function (e) { if (_menu && !_menu.el.contains(e.target)) closeMenu(); }, true);
  document.addEventListener("keydown", function (e) { if (_menu && e.key === "Escape") { closeMenu(); } }, true);
  window.addEventListener("resize", closeMenu);

  // The launcher belongs only on the calendar view. Questi is an SPA, so the URL can
  // change without a reload — gate on the current path and remove the button elsewhere.
  function onCalendar() { return /\/(calendar|kalender|agenda)/i.test(location.pathname || ""); }
  function haveLauncher() { return !!document.querySelector("[" + LAUNCHER_ATTR + "]"); }
  function removeLauncher() {
    var els = document.querySelectorAll("[" + LAUNCHER_ATTR + "]");
    for (var i = 0; i < els.length; i++) els[i].remove();
    closeMenu();
  }
  function ensureLauncher() {
    if (!onCalendar()) { removeLauncher(); return; }   // off the calendar → no button
    if (stableActive) { removeLauncher(); showDormantNotice(); return; } // beta stays out of the way
    if (haveLauncher()) return;                         // idempotent
    var anchor = findToolbarAnchor();
    if (anchor && anchor.parentNode) { anchor.parentNode.insertBefore(makeLauncher(false), anchor.nextSibling); return; }
    if (document.body) document.body.appendChild(makeLauncher(true)); // fallback
  }
  var _luPending = false;
  function scheduleLauncher() {
    if (_luPending) return; _luPending = true;
    setTimeout(function () { _luPending = false; try { ensureLauncher(); } catch (e) {} }, 300);
  }
  try {
    scheduleLauncher();
    // Re-evaluate on any DOM change: adds the button when the calendar renders, removes it
    // after an SPA navigation to a non-calendar page.
    var mo = new MutationObserver(function () {
      if (!onCalendar()) { if (haveLauncher()) removeLauncher(); return; }
      if (!haveLauncher()) scheduleLauncher();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // Backstop: if the toolbar anchor is never found (SPA/DOM change), guarantee an entry point
    // by dropping the floating button ~2.5s in. Usually the inline one is already there.
    setTimeout(function () {
      try { if (onCalendar() && !stableActive && !haveLauncher() && document.body) document.body.appendChild(makeLauncher(true)); } catch (e) { /* no-op */ }
    }, 2500);
    // The badge mirrors the planner's staged changes; reading a counter costs no request.
    setInterval(function () { try { refreshBadge(); } catch (e) {} }, 2000);
  } catch (e) { /* no-op */ }
})();
