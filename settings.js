/* UnQuesti — settings.js
 * Instellingen (7 sections), the first-run setup wizard, settings export/import, and the
 * Zelftest "Opslaan als .json" report. Overlay #qws-overlay, CSS prefix qws-.
 *
 * Owns no state of its own: everything lives in the planner's qwp_state_v6 object, shared BY
 * REFERENCE through __QWP_SHARED.state and persisted with __QWP_SHARED.saveState(). Print choices
 * stay in qwp_print_v1 (the print window reads them).
 *
 * Writes to Questi: only creating a tag (a missing vak), and only after an explicit confirm.
 * Everything else here is local.
 *
 * Exposes window.__UQ_SETTINGS = { open(sectionId?), openSetup(), close(), exportSettings(opts),
 *   saveDebugJson(rows, opts), vakTops(includeNonVak) }.
 */
(function () {
  "use strict";
  if (window.__UQ_SETTINGS_LOADED) return;
  window.__UQ_SETTINGS_LOADED = true;

  function S() { return window.__QWP_SHARED; }
  function h(tag, attrs, kids) { return S().h(tag, attrs, kids); }
  function ctx() { return S().ctx; }
  function st() { return S().state; }
  function save() { S().saveState(); }

  var EXPORT_FORMAT = "unquesti-settings", EXPORT_VERSION = 1;
  var PRINT_KEY = "qwp_print_v1", XHIDE_KEY = "qwp_xhide_v1";
  var DAYS = ["Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag"];

  function manifestVersion() { try { var m = chrome.runtime.getManifest(); return m.version_name || m.version || "?"; } catch (e) { return "?"; } }
  function manifestSemver() { try { return chrome.runtime.getManifest().version || "0"; } catch (e) { return "0"; } }
  console.log("[UQS] settings.js geladen — " + manifestVersion());

  // ========================================================================
  //  Tags / vakken
  // ========================================================================
  // Title normalisation for matching across accounts: case, accents and punctuation ignored.
  function norm(s) {
    var t = String(s == null ? "" : s).toLowerCase();
    try { t = t.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (e) {}
    return t.replace(/[^a-z0-9]+/g, " ").trim();
  }
  function ownTags() { return (S().ownTagsList && S().ownTagsList()) || []; }
  function isSubjectTop(t) { return !!t && !(t.type === "default" || /alle.*lesfiches/i.test(t.title || "")); }
  function subjectTops() { return S().topTagsForOwner(ownTags(), ctx().ownerId).filter(isSubjectTop); }
  function tagById(id) { return id == null || id === "" ? null : S().anyTagById(id); }
  function tagName(t) { return ((t && t.title) || "").trim(); }
  function tagHex(t) { return (t && t.color) || "#c7ccd1"; }
  function childrenOf(id) { return ownTags().filter(function (t) { return String(t.parent) === String(id); }); }
  function sameId(a, b) { return a != null && b != null && String(a) === String(b); }
  function inList(list, id) { return (list || []).some(function (x) { return sameId(x, id); }); }
  // state.vakTags null = every own top tag is a vak (the behaviour before this setting existed).
  // `list` undefined → the saved state.vakTags; the wizard passes its own draft (null = all).
  function isVakId(id, list) { var v = list === undefined ? st().vakTags : list; return !Array.isArray(v) || inList(v, id); }
  // Own subject top tags in legend order (state.vakOrder first, the rest A→Z as topTagsForOwner sorts).
  function orderedTops() {
    var order = st().vakOrder || [];
    function rank(t) { for (var i = 0; i < order.length; i++) if (sameId(order[i], t.id)) return i; return 1e6; }
    return subjectTops().map(function (t, i) { return { t: t, i: i }; })
      .sort(function (a, b) { return (rank(a.t) - rank(b.t)) || (a.i - b.i); })
      .map(function (x) { return x.t; });
  }
  function vakTops(includeNonVak, list) {
    var tops = orderedTops();
    if (includeNonVak) return tops;
    return tops.filter(function (t) { return isVakId(t.id, list); });
  }
  // A vakTags list equal to "all tops" collapses back to null, so a tag created later counts too.
  function compactVakTags(list) {
    if (!Array.isArray(list)) return null;
    var all = subjectTops();
    var covers = all.every(function (t) { return inList(list, t.id); });
    return covers ? null : list.filter(function (id) { return all.some(function (t) { return sameId(t.id, id); }); });
  }
  function ensureReady() {
    // Opened before the planner ever booted: state is still the in-memory default, and the first
    // saveState() would overwrite what is stored. Load it first (the planner's boot does the same).
    var p = document.getElementById("qwp-overlay") ? Promise.resolve() : S().loadState();
    p = p.then(function () { return ctx().ready ? null : S().detectContext(); });
    return p.then(function () { return S().fetchOwnTags(); }).catch(function (e) { console.warn("[UQS] context/tags:", e); });
  }
  function plannerLoaded() { var v = S().view; return !!(v && v.weekStart && v.slots); }
  function plannerShown() { var p = document.getElementById("qwp-overlay"); return !!(p && p.classList.contains("qwp-show")); }
  function timeRows() {
    if (!plannerLoaded()) return [];
    try { S().computeTimeRows(); } catch (e) { return []; }
    return (S().view.timeRows || []).slice();
  }
  // Create a vak tag in Questi. Callers ALWAYS confirm first. Uses the Lesfiche-manager's create
  // call (same endpoint, same body), then refreshes the shared own-tag cache.
  function createTag(title, color, parentId) {
    var L = window.__QWP_LESSONS;
    if (!L || !L.createUserTag) return Promise.reject(new Error("Lesfiche-module niet geladen"));
    var body = { title: title, color: color || "#e0e0e0", schoolId: ctx().schoolId };
    if (parentId != null) body.parent = Number(parentId);
    return L.createUserTag(body).then(function (tag) {
      S().invalidateOwnTags();
      return S().fetchOwnTags().then(function (tags) {
        try { S().view.ownTags = tags; S().view.ownTopTags = S().topTagsForOwner(tags, ctx().ownerId); } catch (e) {}
        if (tag && tag.id != null) return tag;
        // Response without an id: find the new tag by title under the same parent.
        return (tags || []).filter(function (t) {
          return norm(t.title) === norm(title) && (parentId == null ? (t.parent == null || t.parent === 0) : sameId(t.parent, parentId));
        })[0] || null;
      });
    });
  }

  // ========================================================================
  //  Overlay shell
  // ========================================================================
  var ui = { root: null, mode: null, sec: "lesrooster", body: null, plannerDirty: false, sourcesDirty: false, keyBound: false };
  var SECTIONS = [
    { id: "lesrooster", t: "Lesrooster", d: "vak per lesuur, thema’s", sub: "Welk vak geef je op welk lesuur — geldt voor elke week, tenzij je een lesuur in Plannen zelf aanpast." },
    { id: "vakken", t: "Vakken", d: "welke tags, volgorde", sub: "Welke van je Questi-tags vakken zijn, en hun volgorde." },
    { id: "agenda", t: "Agenda", d: "beschrijving, werkagenda", sub: "Hoe de planner in je Questi-agenda schrijft." },
    { id: "bronnen", t: "Collega’s & methodes", d: "wiens fiches je ziet", sub: "Extra bronnen voor de lijst met lesfiches." },
    { id: "afdrukken", t: "Afdrukken", d: "standaardversie, legende", sub: "Wat het afdrukvenster standaard kiest." },
    { id: "delen", t: "Delen & back-up", d: "export / import .json", sub: "Je instellingen bewaren of doorgeven aan een collega." },
    { id: "over", t: "Over", d: "versie " + manifestVersion(), sub: "Versie, bijwerken en privacy." }
  ];
  function secById(id) { for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].id === id) return SECTIONS[i]; return null; }

  function build() {
    if (!ui.root || !document.body.contains(ui.root)) {
      ui.root = h("div", { id: "qws-overlay" });
      document.body.appendChild(ui.root);
    }
    if (!ui.keyBound) {
      ui.keyBound = true;
      document.addEventListener("keydown", function (e) {
        if (e.key !== "Escape" || !ui.root || !ui.root.classList.contains("qws-show")) return;
        e.stopPropagation(); e.preventDefault();
        var c = ui.root.querySelector(".qws-confirm");
        if (c) c.remove(); else close();
      }, true);
    }
  }
  function show() { ui.root.classList.add("qws-show"); document.documentElement.classList.add("qws-locked"); }
  function close() {
    if (!ui.root) return;
    if (ui.mode === "setup" && !st().setupDone) { st().setupDone = true; save(); }
    ui.root.classList.remove("qws-show"); ui.root.innerHTML = "";
    document.documentElement.classList.remove("qws-locked");
    ui.mode = null;
    flushPlanner();
  }
  // Push settings changes into the open planner once, on close, rather than on every click.
  function flushPlanner() {
    var P = S();
    if (ui.plannerDirty) {
      ui.plannerDirty = false;
      try { P.reloadSlotVakLabels(); P.ensureThemaKeys(P.view.slots); if (plannerShown()) P.renderTimetable(); } catch (e) { console.warn("[UQS] planner verversen:", e); }
    }
    if (ui.sourcesDirty) {
      ui.sourcesDirty = false;
      try { if (plannerShown()) P.loadColleagueFiches(); } catch (e) { console.warn("[UQS] collega's laden:", e); }
    }
  }
  function loading(text) {
    ui.root.innerHTML = "";
    ui.root.appendChild(h("div", { class: "qws-loading" }, [h("div", { class: "qws-spinner" }), h("div", { text: text || "Laden…" })]));
  }

  // ---------- Small UI parts ----------
  function btn(text, onclick, cls, attrs) {
    var a = { class: "qws-btn" + (cls ? " " + cls : ""), type: "button", text: text, onclick: onclick };
    if (attrs) Object.keys(attrs).forEach(function (k) { a[k] = attrs[k]; });
    return h("button", a);
  }
  function note(text, kind) { return h("div", { class: "qws-note" + (kind ? " " + kind : ""), text: text }); }
  function card(kids, cls) { return h("section", { class: "qws-card" + (cls ? " " + cls : "") }, kids); }
  function cardTitle(t, sub) { return h("div", { class: "qws-card-hd" }, [h("span", { class: "qws-card-t", text: t }), sub ? h("span", { class: "qws-muted", text: sub }) : null]); }
  function field(label, control, hint) {
    var single = control && /^(SELECT|INPUT|TEXTAREA)$/.test(control.tagName || "");
    return h(single ? "label" : "div", { class: "qws-field" }, [h("span", { class: "qws-field-l", text: label }), control, hint ? h("span", { class: "qws-muted", text: hint }) : null]);
  }
  function toggle(on, label, desc, onFlip) {
    var b = h("button", { class: "qws-switch" + (on ? " on" : ""), type: "button", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": label },
      [h("span", { class: "qws-knob" })]);
    b.addEventListener("click", function () { onFlip(!on); });
    return h("div", { class: "qws-card qws-toggle" }, [b, h("div", { class: "qws-toggle-txt" }, [h("span", { class: "qws-card-t", text: label }), desc ? h("span", { class: "qws-muted", text: desc }) : null])]);
  }
  function selectEl(options, value, onchange, attrs) {
    var sel = h("select", Object.assign({ class: "qws-select" }, attrs || {}), options.map(function (o) {
      return h("option", { value: String(o.v), text: o.n, selected: String(o.v) === String(value == null ? "" : value) ? "selected" : null });
    }));
    if (onchange) sel.addEventListener("change", function () { onchange(sel.value, sel); });
    return sel;
  }
  // Modal confirm inside the overlay. lines: strings or nodes.
  function confirmBox(title, lines, okText, onOk, opts) {
    opts = opts || {};
    var box = h("div", { class: "qws-confirm" }, [
      h("div", { class: "qws-confirm-box", role: "dialog", "aria-modal": "true", "aria-label": title }, [
        h("div", { class: "qws-card-t", text: title }),
        h("div", { class: "qws-confirm-body" }, lines.map(function (l) { return typeof l === "string" ? h("p", { text: l }) : l; })),
        h("div", { class: "qws-confirm-ft" }, [
          btn(opts.cancelText || "Annuleren", function () { box.remove(); }, "ghost"),
          btn(okText, function () { box.remove(); onOk(); }, opts.danger ? "danger" : "primary")
        ])
      ])
    ]);
    ui.root.appendChild(box);
    var ok = box.querySelector(".qws-confirm-ft .qws-btn:last-child"); if (ok) setTimeout(function () { try { ok.focus(); } catch (e) {} }, 0);
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function tsStamp() { var d = new Date(); return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" + pad2(d.getHours()) + pad2(d.getMinutes()); }
  function downloadJson(obj, filename) {
    try {
      var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = h("a", { href: url, download: filename, style: "display:none" });
      document.body.appendChild(a); a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 0);
      return true;
    } catch (e) { console.error("[UQS] download faalde:", e); return false; }
  }
  function storeGet(k) { return S().storeGet(k); }
  function storeSet(k, v) { S().storeSet(k, v); }

  // ========================================================================
  //  Instellingen
  // ========================================================================
  function open(sectionId) {
    if (!S()) { console.warn("[UQS] __QWP_SHARED ontbreekt — planner niet geladen."); return; }
    build(); ui.mode = "settings";
    if (sectionId && secById(sectionId)) ui.sec = sectionId;
    show(); loading("Instellingen laden…");
    ensureReady().then(function () { if (ui.mode === "settings") renderSettings(); });
  }
  function renderSettings() {
    ui.root.innerHTML = "";
    var sec = secById(ui.sec) || SECTIONS[0];
    var nav = h("nav", { class: "qws-navlist", "aria-label": "Instellingen" }, SECTIONS.map(function (s) {
      return h("button", { type: "button", class: "qws-navbtn" + (s.id === sec.id ? " on" : ""), "aria-current": s.id === sec.id ? "page" : null,
        onclick: function () { ui.sec = s.id; renderSettings(); } }, [h("span", { class: "qws-navbtn-t", text: s.t }), h("span", { class: "qws-navbtn-d", text: s.d })]);
    }));
    var aside = h("aside", { class: "qws-aside" }, [
      h("div", { class: "qws-aside-t" }, [h("span", { text: "Instellingen" }), S().betaPill ? S().betaPill() : null]),
      nav,
      h("div", { class: "qws-aside-ft" }, [btn("Sluiten", close, "ghost wide")])
    ]);
    ui.body = h("div", { class: "qws-body" });
    var main = h("main", { class: "qws-main" }, [
      h("header", { class: "qws-hdr" }, [
        h("div", { class: "qws-hdr-txt" }, [h("span", { class: "qws-hdr-t", text: sec.t }), h("span", { class: "qws-hdr-s", text: sec.sub })]),
        h("button", { class: "qws-x", type: "button", title: "Sluiten (Esc)", "aria-label": "Sluiten", text: "×", onclick: close })
      ]),
      ui.body
    ]);
    ui.root.appendChild(h("div", { class: "qws-shell" }, [aside, main]));
    renderSection();
  }
  function renderSection() {
    if (!ui.body) return;
    ui.body.innerHTML = "";
    var fn = { lesrooster: secLesrooster, vakken: secVakken, agenda: secAgenda, bronnen: secBronnen, afdrukken: secAfdrukken, delen: secDelen, over: secOver }[ui.sec];
    try { fn(ui.body); } catch (e) { console.error("[UQS] sectie " + ui.sec + ":", e); ui.body.appendChild(note("Dit onderdeel kon niet getoond worden: " + (e && e.message || e), "warn")); }
  }

  // ---------- Lesrooster: slot→vak grid (shared with the wizard) ----------
  // o: { value(key) → tagId|null, guess(key) → {id, why}|null, onChange(key, tagId|null), onAccept(key), vakList }
  function slotGrid(o) {
    var rows = timeRows(), opts = vakTops(false, o.vakList);
    var wrap = h("div", { class: "qws-grid" });
    wrap.appendChild(h("span"));
    DAYS.forEach(function (d) { wrap.appendChild(h("span", { class: "qws-grid-hd", text: d })); });
    rows.forEach(function (t) {
      wrap.appendChild(h("span", { class: "qws-grid-time", text: t }));
      for (var d = 0; d < 5; d++) wrap.appendChild(slotCell(o, opts, d, t));
    });
    return wrap;
  }
  function slotCell(o, opts, day, time) {
    if (S().isNoSchool(day, time)) return h("div", { class: "qws-cell free", text: "vrij" });
    var key = day + "|" + time, val = o.value(key), g = (val == null && o.guess) ? o.guess(key) : null;
    var shown = val != null ? val : (g ? g.id : null);
    var list = [{ v: "", n: "— geen —" }].concat(opts.map(function (t) { return { v: t.id, n: tagName(t) }; }));
    // Keep a stored value visible even when it is no longer a vak (or the tag is gone) — never drop it silently.
    if (shown != null && !opts.some(function (t) { return sameId(t.id, shown); })) {
      var tt = tagById(shown);
      list.push({ v: shown, n: tt ? tagName(tt) + " (geen vak meer)" : "onbekende tag #" + shown });
    }
    var sel = selectEl(list, shown == null ? "" : shown, function (v) { o.onChange(key, v ? +v : null); }, { "aria-label": DAYS[day] + " " + time });
    var stripe = h("span", { class: "qws-stripe", style: "background:" + (shown != null ? tagHex(tagById(shown)) : "transparent") });
    var kids = [stripe, sel];
    if (g) kids.push(h("button", { class: "qws-accept", type: "button", title: "Voorstel overnemen", "aria-label": "Voorstel overnemen", text: "✓", onclick: function () { o.onAccept(key); } }));
    return h("div", { class: "qws-cell" + (g ? " guess" : "") + (shown == null ? " empty" : ""), title: g ? ("Voorstel " + g.why + " — kies of bevestig") : null }, kids);
  }
  // Whole-week items (thema bars) in the loaded week, grouped by their stable identity.
  function themaGroups() {
    var P = S(), out = [], byId = {};
    if (!plannerLoaded()) return out;
    try { P.ensureThemaKeys(P.view.slots); } catch (e) {}
    P.view.slots.forEach(function (s) {
      if (!P.isThemaSlot(s)) return;
      var id = P.themaIdentity(s); if (!id) return;
      if (byId[id]) { byId[id].slots.push(s); return; }
      byId[id] = { id: id, title: String(P.stripQuestiDecoration(s.origTitle || s.title) || "").trim(), norm: P.normTitle(s.origTitle || s.title), slots: [s] };
      out.push(byId[id]);
    });
    return out;
  }
  function applyThemaVak(group, tagId) {
    var P = S();
    P.setThemaVakOverride(group.slots[0], tagId);   // saves; keyed by themaIdentity
    group.slots.forEach(function (s) { s.themaTagId = tagId; s.vak = tagId != null ? tagId : ""; if (tagId != null) s.themaFiche = true; });
    if (tagId == null) P.ensureThemaKeys(P.view.slots);   // re-resolve the automatic tag
    ui.plannerDirty = true;
  }
  // o: { value(group) → tagId|null, onChange(group, tagId|null), vakList }
  function themaList(o) {
    var groups = themaGroups(), opts = vakTops(false, o.vakList);
    if (!groups.length) return note(plannerLoaded() ? "Geen items van een volledige week in de geladen week." : "Open eerst Plannen: thema’s worden uit de geladen week gelezen.");
    return h("div", { class: "qws-themas" }, groups.map(function (g) {
      var cur = o.value(g);
      var auto = g.slots[0].themaTagId != null && cur == null ? tagName(tagById(g.slots[0].themaTagId)) : "";
      var list = [{ v: "", n: "automatisch" + (cur == null ? (auto ? " (nu: " + auto + ")" : " (geen gevonden)") : "") }]
        .concat(opts.map(function (t) { return { v: t.id, n: tagName(t) }; }));
      if (cur != null && !opts.some(function (t) { return sameId(t.id, cur); })) list.push({ v: cur, n: (tagName(tagById(cur)) || "tag #" + cur) + " (geen vak meer)" });
      return h("div", { class: "qws-thema" }, [
        h("span", { class: "qws-thema-t", text: "“" + (g.title || "?") + "”" }),
        h("span", { class: "qws-muted", text: "hoort bij" }),
        selectEl(list, cur == null ? "" : cur, function (v) { o.onChange(g, v ? +v : null); }, { "aria-label": "Vak voor " + g.title })
      ]);
    }));
  }
  function secLesrooster(body) {
    var s = st(), reread = btn("Opnieuw uit agenda lezen", function () {
      if (!plannerLoaded() || !plannerShown()) { status.textContent = "Open eerst Plannen met een week met lesuren."; return; }
      reread.disabled = true; reread.textContent = "Lezen…";
      S().reloadAndRender().then(renderSection, function () { reread.disabled = false; reread.textContent = "Opnieuw uit agenda lezen"; status.textContent = "Lezen mislukt."; });
    });
    var status = h("span", { class: "qws-muted", text: plannerLoaded() ? ("Lesuren uit de geladen week (" + S().view.weekStart + ").") : "" });
    body.appendChild(h("div", { class: "qws-bar" }, [h("span", { class: "qws-grow", text: "Kies per lesuur het vak. Dit bepaalt welk vak een leeg lesuur krijgt." }), reread]));
    body.appendChild(status);
    var rows = timeRows();
    var c = card([]);
    if (!rows.length) c.appendChild(note(plannerLoaded() ? "Geen lesuren in de geladen week (vakantie?). Ga in Plannen naar een week met lesuren en klik ‘Opnieuw uit agenda lezen’." : "Open eerst Plannen: het lesrooster wordt uit je Questi-agenda gelezen.", "warn"));
    else c.appendChild(slotGrid({
      value: function (k) { var v = s.settings[k]; return v != null && v !== "" ? v : null; },
      onChange: function (k, v) { if (v == null) delete s.settings[k]; else s.settings[k] = v; save(); ui.plannerDirty = true; renderSection(); }
    }));
    var setCount = Object.keys(s.settings || {}).length;
    c.appendChild(h("div", { class: "qws-muted", text: setCount + " lesuur/lesuren hebben een vast vak. Een lesuur dat je in Plannen zelf aanpast, houdt die keuze." }));
    body.appendChild(c);
    body.appendChild(card([
      cardTitle("Hele week", "Items van een volledige week (bv. thema WO, Godsdienst). Kies bij welk vak ze horen; ‘automatisch’ laat de planner het uit de titel afleiden."),
      themaList({ value: function (g) { var v = (s.themaVak || {})[g.id]; return v != null ? v : null; }, onChange: function (g, v) { applyThemaVak(g, v); renderSection(); } })
    ]));
  }

  // ---------- Vakken ----------
  function secVakken(body) {
    var s = st(), tops = vakTops(true);
    var table = h("div", { class: "qws-vaktable" }, [
      h("div", { class: "qws-vakrow hd" }, [h("span", { text: "Volgorde" }), h("span", { text: "Kleur" }), h("span", { text: "Tag" }), h("span", { text: "Subtags" }), h("span", { text: "Vak?" })])
    ]);
    if (!tops.length) table.appendChild(note("Geen eigen hoofdtags gevonden. Maak hieronder een vak aan, of controleer de Zelftest.", "warn"));
    tops.forEach(function (t, i) {
      var on = isVakId(t.id);
      var chk = h("input", { type: "checkbox", "aria-label": tagName(t) + " is een vak" }); chk.checked = on;
      chk.addEventListener("change", function () {
        var cur = Array.isArray(s.vakTags) ? s.vakTags.slice() : subjectTops().map(function (x) { return x.id; });
        cur = cur.filter(function (x) { return !sameId(x, t.id); });
        if (chk.checked) cur.push(t.id);
        s.vakTags = compactVakTags(cur); save(); ui.plannerDirty = true; renderSection();
      });
      table.appendChild(h("div", { class: "qws-vakrow" + (on ? "" : " off") }, [
        h("span", { class: "qws-move" }, [
          btn("↑", function () { moveVak(i, -1); }, "icon", { title: "Hoger", "aria-label": tagName(t) + " hoger", disabled: i === 0 ? "disabled" : null }),
          btn("↓", function () { moveVak(i, 1); }, "icon", { title: "Lager", "aria-label": tagName(t) + " lager", disabled: i === tops.length - 1 ? "disabled" : null })
        ]),
        h("span", { class: "qws-swatch", style: "background:" + tagHex(t), title: "Kleur uit Questi: " + (t.color || "geen") }),
        h("span", { class: "qws-vakname", text: tagName(t) }),
        h("span", { class: "qws-muted", text: String(childrenOf(t.id).length) }),
        chk
      ]));
    });
    function moveVak(i, dir) {
      var ids = tops.map(function (t) { return t.id; }), j = i + dir;
      if (j < 0 || j >= ids.length) return;
      var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
      s.vakOrder = ids; save(); renderSection();
    }
    // New vak = a new top tag in Questi → explicit confirm.
    var nameInp = h("input", { class: "qws-input", type: "text", placeholder: "naam van het vak, bv. Lichamelijke opvoeding" });
    var colorInp = h("input", { class: "qws-color", type: "color", value: "#e0e0e0", "aria-label": "Kleur" });
    var msg = h("span", { class: "qws-muted" });
    var addRow = h("div", { class: "qws-addrow" }, [nameInp, colorInp, btn("Nieuw vak…", function () {
      var title = (nameInp.value || "").trim(); if (!title) { msg.textContent = "Geef een naam op."; return; }
      if (subjectTops().some(function (t) { return norm(t.title) === norm(title); })) { msg.textContent = "Die tag bestaat al."; return; }
      confirmBox("Nieuwe tag in Questi", ["Dit maakt de hoofdtag “" + title + "” aan in je Questi-lesfiches.", "Verwijderen kan later in Lesfiches → Tags."], "Aanmaken", function () {
        msg.textContent = "Aanmaken…";
        createTag(title, colorInp.value).then(function () { renderSection(); }, function (e) { msg.textContent = "Aanmaken mislukt: " + ((e && e.message) || e); });
      });
    }), msg]);
    body.appendChild(h("div", { class: "qws-two" }, [
      card([table, addRow, h("div", { class: "qws-bar" }, [btn("Volgorde terug alfabetisch", function () { s.vakOrder = null; save(); renderSection(); }, "ghost")])]),
      h("div", { class: "qws-stack" }, [
        card([cardTitle("Wat is een vak?"), h("p", { class: "qws-p", text: "Een hoofdtag uit Questi die je hier aanvinkt. Overal waar je een vak kiest of op vak filtert, zie je enkel deze — in deze volgorde, ook in de legende op papier." }),
          note("Een lesuur dat al een tag heeft die je hier uitvinkt, houdt die tag; je ziet ze dan nog als keuze bij dat lesuur.")]),
        card([cardTitle("Kleur"), h("p", { class: "qws-p", text: "Kleuren komen uit Questi en zijn hier alleen-lezen. Een kleur wijzigen is een schrijfactie in Questi; dat kan deze versie nog niet." })])
      ])
    ]));
  }

  // ---------- Agenda ----------
  function secAgenda(body) {
    var s = st();
    body.appendChild(toggle(s.writeVakDescription === true, "Vak als beschrijving schrijven (optioneel)",
      "Voor klaswebsites zoals Enderklas, die de beschrijving als vak tonen. Uit = de planner laat de beschrijving van je lesuren én van de themabalk (‘Zie themafiche.’) volledig met rust.",
      function (on) { s.writeVakDescription = on; save(); ui.plannerDirty = true; renderSection(); }));
    body.appendChild(note(s.writeVakDescription === true ? "Aan — elk lesuur krijgt bij wegschrijven het vak als beschrijving." : "Uit — beschrijvingen blijven onaangeroerd.", s.writeVakDescription === true ? "ok" : ""));

    var cals = ctx().calendars || [], calMsg = h("span", { class: "qws-muted" });
    var calCtl;
    if (cals.length > 1) {
      var calSel = selectEl([{ v: "", n: "— automatisch (agenda met de meeste lesuren) —" }].concat(cals.map(function (c) { return { v: c.id, n: c.name }; })), s.workingCalendarId == null ? "" : s.workingCalendarId);
      calCtl = h("div", { class: "qws-inline" }, [calSel, btn("Toepassen", function () { applyCalendar(calSel.value || null, calMsg); }, "ghost")]);
    } else {
      calCtl = h("span", { class: "qws-p", text: cals.length ? cals[0].name + " (je enige agenda)" : "Geen agenda gevonden." });
    }
    var thr = h("input", { class: "qws-input", type: "number", min: "0", max: "10000", step: "50", style: "width:130px", value: String(s.saveThrottleMs != null ? s.saveThrottleMs : 250) });
    thr.addEventListener("change", function () { var v = parseInt(thr.value, 10); s.saveThrottleMs = (isNaN(v) || v < 0) ? 250 : Math.min(v, 10000); thr.value = String(s.saveThrottleMs); save(); });
    body.appendChild(card([
      field("Agenda om in te plannen", calCtl, "Welke agenda Plannen toont en waarnaar het wegschrijft."), calMsg,
      field("Vertraging tussen opgeslagen lesuren (ms)", thr, "Basisvertraging + toevallige spreiding. Verhoog dit (bv. 2000) als Questi klaagt dat je te snel opslaat. Standaard 250.")
    ], "qws-grid2"));
    body.appendChild(card([cardTitle("Vast gedrag (geen instelling)"),
      h("ul", { class: "qws-ul" }, [
        h("li", { text: "Gym: een lesuur met het gym-vinkje krijgt enkel een titel (Lichamelijke opvoeding of Zwemmen), geen fiche en geen beschrijving." }),
        h("li", { text: "Een leeg WO/Godsdienst-lesuur krijgt de naam van de themafiche van die week als titel; een leeg lesuur zonder thema houdt ‘Lesuur 1, 2, 3 …’." }),
        h("li", { text: "Questi’s eigen titel “* fiche (1)” wordt bij wegschrijven vervangen door je eigen titel. ‘Titels opschonen’ in Plannen herstelt oudere lesuren." })
      ])]));
  }
  function applyCalendar(newWc, msgEl) {
    var s = st();
    if (String(newWc) === String(s.workingCalendarId)) { if (msgEl) msgEl.textContent = "Ongewijzigd."; return; }
    s.workingCalendarId = newWc; if (newWc != null) ctx().calendarId = newWc; save();
    if (newWc == null) {
      confirmBox("Agenda automatisch kiezen", ["Om opnieuw de agenda met de meeste lesuren te kiezen, moet Questi herladen worden."], "Nu herladen", function () { try { location.reload(); } catch (e) {} }, { cancelText: "Later" });
      if (msgEl) msgEl.textContent = "Bewaard — wordt actief na herladen.";
      return;
    }
    if (plannerShown()) { S().reloadAndRender(); if (msgEl) msgEl.textContent = "Werkagenda gewijzigd — week herladen in Plannen."; }
    else if (msgEl) msgEl.textContent = "Bewaard.";
  }

  // ---------- Collega's & methodes ----------
  function initials(n) { return String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join(""); }
  function secBronnen(body) {
    var s = st(), P = S();
    var people = (P.view && P.view.people) || [];
    var listEl = h("div", { class: "qws-stack" }), results = h("div", { class: "qws-results" });
    function renderColleagues() {
      listEl.innerHTML = "";
      var mine = s.colleagues.filter(function (c) { return !c.isMethod; });
      if (!mine.length) listEl.appendChild(h("span", { class: "qws-muted", text: "Nog geen collega’s." }));
      mine.forEach(function (c) {
        listEl.appendChild(h("div", { class: "qws-person" }, [
          h("span", { class: "qws-avatar", text: initials(c.name) }), h("span", { class: "qws-grow", text: c.name }),
          btn("×", function () { s.colleagues = s.colleagues.filter(function (x) { return !sameId(x.id, c.id) || x.isMethod; }); save(); ui.sourcesDirty = true; renderColleagues(); }, "icon", { title: "Verwijderen", "aria-label": c.name + " verwijderen" })
        ]));
      });
    }
    var search = h("input", { class: "qws-input dashed", type: "text", placeholder: "+ collega zoeken op naam…", "aria-label": "Collega zoeken" });
    search.addEventListener("input", function () {
      results.innerHTML = "";
      var q = norm(search.value); if (!q) return;
      var hits = people.filter(function (p) { return norm(p.name).indexOf(q) > -1 && !sameId(p.id, ctx().ownerId) && !s.colleagues.some(function (c) { return sameId(c.id, p.id); }); }).slice(0, 8);
      if (!hits.length) results.appendChild(h("span", { class: "qws-muted", text: people.length ? "Niemand gevonden." : "Collega’s laden…" }));
      hits.forEach(function (p) {
        results.appendChild(btn(p.name, function () { s.colleagues.push({ id: p.id, name: p.name }); save(); ui.sourcesDirty = true; search.value = ""; results.innerHTML = ""; renderColleagues(); }, "ghost result"));
      });
    });
    if (!people.length) P.fetchPeople().then(function (ps) { people = ps || []; try { P.view.people = people; } catch (e) {} });
    renderColleagues();

    var methList = h("div", { class: "qws-stack" }, [h("span", { class: "qws-muted", text: "Methodes laden…" })]);
    P.fetchMethods().then(function (methods) {
      methList.innerHTML = "";
      if (!methods.length) { methList.appendChild(h("span", { class: "qws-muted", text: "Geen methodes beschikbaar voor je school." })); return; }
      methods.sort(function (a, b) { return (a.name || "").localeCompare(b.name || "", undefined, { numeric: true }); });
      methods.forEach(function (m) {
        var chk = h("input", { type: "checkbox" });
        chk.checked = s.colleagues.some(function (c) { return c.isMethod && String(c.methodKey) === String(m.id); });
        chk.addEventListener("change", function () {
          s.colleagues = s.colleagues.filter(function (c) { return !(c.isMethod && String(c.methodKey) === String(m.id)); });
          if (chk.checked) s.colleagues.push(methodEntry(m));
          save(); ui.sourcesDirty = true;
        });
        var sub = ((m.publisher && m.publisher.name) ? m.publisher.name : "") + ((m.grades || []).length ? " · " + m.grades.join(", ") : "");
        methList.appendChild(h("label", { class: "qws-check" }, [chk, h("span", { class: "qws-grow", text: m.name }), h("span", { class: "qws-muted", text: sub })]));
      });
    });
    body.appendChild(h("div", { class: "qws-two even" }, [
      card([cardTitle("Collega’s", "Hun gedeelde lesfiches verschijnen in de lijst met lesfiches."), listEl, search, results]),
      card([cardTitle("Methodes van de school", "Aangevinkte methodes kan je in Plannen naar een lesuur slepen."), methList,
        note("Methodevoortgang volg je apart, in het Methodes-paneel.")])
    ]));
  }
  // Same pseudo-colleague shape as the planner's methode popover.
  function methodEntry(m) { return { id: S().METHOD_PREFIX + m.id, name: m.name, isMethod: true, methodKey: m.id, isCluster: !!m.is_cluster }; }

  // ---------- Afdrukken ----------
  var PRINT_DEFAULTS = { mode: "plain", tabs: "word", legend: true };
  function secAfdrukken(body) {
    var holder = h("div", { class: "qws-two even" }, [h("span", { class: "qws-muted", text: "Laden…" })]);
    body.appendChild(holder);
    Promise.all([storeGet(PRINT_KEY), storeGet(XHIDE_KEY)]).then(function (r) {
      var prefs = Object.assign({}, PRINT_DEFAULTS, r[0] || {}), hidden = Object.keys(r[1] || {}).length;
      function put(k, v) { prefs[k] = v; storeSet(PRINT_KEY, prefs); }
      var legend = h("input", { type: "checkbox" }); legend.checked = prefs.legend !== false;
      legend.addEventListener("change", function () { put("legend", legend.checked); });
      holder.innerHTML = "";
      holder.appendChild(card([cardTitle("Standaard bij openen", "Het afdrukvenster onthoudt ook zelf je laatste keuze."),
        field("Versie", selectEl([{ v: "plain", n: "Gewoon" }, { v: "goals1", n: "Lesdoelen · 1 A4" }, { v: "goals2", n: "Lesdoelen · 2 A4" }], prefs.mode, function (v) { put("mode", v); })),
        field("Labels bij lesdoelen", selectEl([{ v: "word", n: "WEET / KEN / KAN" }, { v: "icon", n: "Pictogrammen" }], prefs.tabs, function (v) { put("tabs", v); })),
        h("label", { class: "qws-check" }, [legend, h("span", { text: "Vakkenlegende" })])
      ]));
      var hidMsg = h("span", { class: "qws-muted", text: hidden ? (hidden + " item(s) van andere agenda’s verborgen op de Lesdoelen-afdruk.") : "Geen verborgen items." });
      holder.appendChild(card([cardTitle("Andere agenda’s"),
        h("p", { class: "qws-p", text: "Items die je in het afdrukvenster wegklikte, blijven verborgen (een terugkerend item in elke week)." }),
        hidMsg,
        hidden ? btn("Alles weer tonen", function () { confirmBox("Verborgen items tonen", [hidden + " verborgen item(s) worden weer afgedrukt."], "Weer tonen", function () { storeSet(XHIDE_KEY, {}); renderSection(); }); }, "ghost") : null
      ]));
    });
  }

  // ========================================================================
  //  Export / import
  // ========================================================================
  // A tag as it travels between accounts: title + colour (+ parent title), never an id.
  function vakRef(id) {
    var t = tagById(id); if (!t) return null;
    var ref = { title: tagName(t), color: t.color || null };
    if (t.parent != null && t.parent !== 0 && t.parent !== "0") { var p = tagById(t.parent); ref.parent = p ? tagName(p) : null; }
    return ref;
  }
  // A thema override key → the item title it stands for. "rep:" ids are per account, so they are
  // exported as the title of a loaded item of that series — or skipped (and reported) if none is loaded.
  function themaTitleForKey(key) {
    if (key.indexOf("title:") === 0) return key.slice(6);
    if (key.indexOf("rep:") === 0 && plannerLoaded()) {
      var rid = key.slice(4), s = S().view.slots.filter(function (x) { return String(x.repeatId) === rid; })[0];
      if (s) return S().normTitle(s.origTitle || s.title);
    }
    return null;
  }
  var EXPORT_PARTS = [
    { id: "lesrooster", n: "Lesrooster", on: true }, { id: "vakken", n: "Vakken", on: true }, { id: "themas", n: "Thema’s", on: true },
    { id: "agenda", n: "Agenda-keuzes", on: true }, { id: "afdrukken", n: "Afdrukkeuzes", on: true }, { id: "collegas", n: "Collega’s & methodes", on: false }
  ];
  // → Promise<{ data, skipped: [strings] }>
  function exportSettings(opts) {
    opts = opts || {};
    var parts = opts.parts || {}; EXPORT_PARTS.forEach(function (p) { if (parts[p.id] == null) parts[p.id] = p.on; });
    var s = st(), skipped = [];
    var out = {
      format: EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: new Date().toISOString(), tool: "UnQuesti " + manifestVersion(),
      from: { school: (ctx().school && ctx().school.name) || null, schoolyear: ctx().schoolyear != null ? String(ctx().schoolyear) : null }
    };
    if (parts.vakken) out.vakken = vakTops(true).map(function (t, i) { return { title: tagName(t), color: t.color || null, vak: isVakId(t.id), order: i }; });
    if (parts.lesrooster) {
      out.lesrooster = [];
      Object.keys(s.settings || {}).sort().forEach(function (k) {
        var m = /^(\d)\|(\d{1,2}:\d{2})$/.exec(k), ref = vakRef(s.settings[k]);
        if (!m || !ref) { skipped.push("lesuur " + k + ": tag niet gevonden"); return; }
        out.lesrooster.push({ day: +m[1], time: m[2], vak: ref });
      });
    }
    if (parts.themas) {
      out.themas = [];
      Object.keys(s.themaVak || {}).forEach(function (key) {
        var title = themaTitleForKey(key), ref = vakRef(s.themaVak[key]);
        if (!title || !ref) { skipped.push("thema-koppeling " + (title || "(item niet in de geladen week)") + (ref ? "" : ": tag niet gevonden")); return; }
        out.themas.push({ title: title, vak: ref });
      });
    }
    if (parts.agenda) out.agenda = { writeVakDescription: s.writeVakDescription === true, saveThrottleMs: s.saveThrottleMs != null ? s.saveThrottleMs : 250 };
    if (parts.collegas) {
      out.collegas = s.colleagues.filter(function (c) { return !c.isMethod; }).map(function (c) { return { name: c.name }; });
      out.methodes = s.colleagues.filter(function (c) { return c.isMethod; }).map(function (c) { return { key: c.methodKey, name: c.name, isCluster: !!c.isCluster }; });
    }
    var pp = parts.afdrukken ? storeGet(PRINT_KEY) : Promise.resolve(null);
    return pp.then(function (prefs) {
      if (parts.afdrukken) out.afdrukken = Object.assign({}, PRINT_DEFAULTS, prefs || {});
      return { data: out, skipped: skipped };
    });
  }

  // Abbreviations that name the same vak. Normalised (see norm()). A hit here is shown as a GUESS.
  var ALIASES = [
    ["wo", "wero", "wereldorientatie", "wereldori"],
    ["lo", "l o", "lichamelijke opvoeding", "bewegingsopvoeding", "gym", "turnen"],
    ["muvo", "muzo", "muzische vorming", "muzische opvoeding", "muzisch"],
    ["godsdienst", "rk", "rkg", "katholieke godsdienst", "rooms katholieke godsdienst"],
    ["wiskunde", "wisk", "rekenen"],
    ["frans", "fr"],
    ["nederlands", "ned", "taal"],
    ["schrift", "schrijven", "schrijfles"]
  ];
  // Best own tag for a title in a pool: exact → alias → prefix/first word. kind = exact | alias | close.
  function matchIn(pool, title) {
    var n = norm(title); if (!n) return null;
    var i, t;
    for (i = 0; i < pool.length; i++) if (norm(pool[i].title) === n) return { tag: pool[i], kind: "exact" };
    var first = n.split(" ")[0];
    var tries = [n, first];
    for (var k = 0; k < tries.length; k++) {
      var grp = null;
      for (i = 0; i < ALIASES.length; i++) if (ALIASES[i].indexOf(tries[k]) > -1) { grp = ALIASES[i]; break; }
      if (!grp) continue;
      for (i = 0; i < pool.length; i++) { t = norm(pool[i].title); if (grp.indexOf(t) > -1 || grp.indexOf(t.split(" ")[0]) > -1) return { tag: pool[i], kind: "alias" }; }
    }
    if (n.length >= 3) {
      for (i = 0; i < pool.length; i++) {
        t = norm(pool[i].title); if (t.length < 3) continue;
        if (n.indexOf(t + " ") === 0 || t.indexOf(n + " ") === 0 || first === t) return { tag: pool[i], kind: "close" };
      }
    }
    return null;
  }
  function refKey(ref) { return norm(ref.parent || "") + ">" + norm(ref.title); }
  function refLabel(ref) { return (ref.parent ? ref.parent + " › " : "") + ref.title; }
  // One mapping row per distinct exported tag.
  function buildImport(data) {
    var rows = [], byKey = {};
    function add(ref) {
      if (!ref || !ref.title) return;
      var k = refKey(ref); if (byKey[k]) return;
      var r = { key: k, ref: ref, sel: null, kind: "missing", create: false };
      byKey[k] = r; rows.push(r);
    }
    (data.vakken || []).forEach(function (v) { add({ title: v.title, color: v.color }); });
    (data.lesrooster || []).forEach(function (e) { if (e.vak && e.vak.parent) add({ title: e.vak.parent }); add(e.vak); });
    (data.themas || []).forEach(function (e) { if (e.vak && e.vak.parent) add({ title: e.vak.parent }); add(e.vak); });
    rows.forEach(function (r) { if (!r.ref.parent) autoMatch(r, byKey); });
    rows.forEach(function (r) { if (r.ref.parent) autoMatch(r, byKey); });
    return { rows: rows, byKey: byKey };
  }
  function parentRow(r, byKey) { return r.ref.parent ? byKey[refKey({ title: r.ref.parent })] : null; }
  function poolFor(r, byKey) {
    if (!r.ref.parent) return subjectTops();
    var pr = parentRow(r, byKey);
    return pr && pr.sel != null ? childrenOf(pr.sel) : [];
  }
  function autoMatch(r, byKey) {
    var m = matchIn(poolFor(r, byKey), r.ref.title);
    if (m) { r.sel = m.tag.id; r.kind = m.kind; } else { r.sel = null; r.kind = "missing"; }
  }

  // Import UI. container gets the whole panel; opts.onApplied(summary) after a successful apply.
  function importPanel(container, opts) {
    opts = opts || {};
    var imp = null;
    var fileInp = h("input", { type: "file", accept: ".json,application/json", style: "display:none" });
    var drop = h("div", { class: "qws-drop", tabindex: "0", role: "button", "aria-label": "Kies een .json-bestand" }, [
      h("span", { text: "Sleep een .json hierheen of " }), h("u", { text: "kies een bestand" })
    ]);
    var preview = h("div", { class: "qws-stack" });
    drop.addEventListener("click", function () { fileInp.click(); });
    drop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInp.click(); } });
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
    drop.addEventListener("drop", function (e) { e.preventDefault(); drop.classList.remove("over"); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f); });
    fileInp.addEventListener("change", function () { var f = fileInp.files && fileInp.files[0]; if (f) readFile(f); fileInp.value = ""; });
    container.appendChild(drop); container.appendChild(fileInp); container.appendChild(preview);

    function readFile(f) {
      var rd = new FileReader();
      rd.onload = function () {
        var data = null;
        try { data = JSON.parse(String(rd.result || "")); } catch (e) { showError("Dit bestand is geen geldige JSON."); return; }
        if (!data || data.format !== EXPORT_FORMAT) { showError("Dit is geen UnQuesti-instellingenbestand (veld ‘format’ ontbreekt of klopt niet)."); return; }
        if (typeof data.version !== "number") { showError("Dit bestand heeft geen schemaversie."); return; }
        var b = buildImport(data);
        imp = { name: f.name, data: data, rows: b.rows, byKey: b.byKey, parts: {} };
        ["lesrooster", "vakken", "themas", "agenda", "afdrukken", "collegas"].forEach(function (p) { imp.parts[p] = partPresent(data, p) && p !== "collegas"; });
        renderPreview();
      };
      rd.onerror = function () { showError("Bestand kon niet gelezen worden."); };
      rd.readAsText(f);
    }
    function showError(t) { preview.innerHTML = ""; preview.appendChild(note(t, "warn")); }
    function partPresent(d, p) {
      if (p === "collegas") return !!((d.collegas && d.collegas.length) || (d.methodes && d.methodes.length));
      if (p === "agenda" || p === "afdrukken") return !!d[p];
      return Array.isArray(d[p]) && d[p].length > 0;
    }
    function partLabel(d, p) {
      if (p === "lesrooster") return ["Lesrooster", d.lesrooster.length + " lesuren — overschrijft je vak op dezelfde lesuren"];
      if (p === "vakken") return ["Vakken", "welke tags vakken zijn + volgorde"];
      if (p === "themas") return ["Thema’s", d.themas.length + " koppeling(en)"];
      if (p === "agenda") return ["Agenda-keuzes", "vak als beschrijving: " + (d.agenda.writeVakDescription ? "aan" : "uit")];
      if (p === "afdrukken") return ["Afdrukkeuzes", ""];
      return ["Collega’s & methodes", ((d.collegas || []).length) + " collega(’s), " + ((d.methodes || []).length) + " methode(s) — op naam"];
    }
    function renderPreview() {
      preview.innerHTML = "";
      var d = imp.data;
      preview.appendChild(h("div", { class: "qws-card-t", text: "Voorbeeld: " + imp.name }));
      preview.appendChild(h("span", { class: "qws-muted", text: "Uit " + (d.tool || "?") + (d.from && d.from.school ? " · " + d.from.school : "") + (d.exported_at ? " · " + String(d.exported_at).slice(0, 10) : "") }));
      if (d.version > EXPORT_VERSION) preview.appendChild(note("Dit bestand komt uit een nieuwere versie (schema " + d.version + "). Onderdelen die deze versie niet kent, worden overgeslagen.", "warn"));
      // Tag mapping
      if (imp.rows.length) {
        var map = h("div", { class: "qws-map" });
        imp.rows.forEach(function (r) {
          var pool = poolFor(r, imp.byKey);
          var list = [{ v: "", n: "— niet koppelen —" }].concat(pool.map(function (t) { return { v: t.id, n: tagName(t) }; }));
          var sel = selectEl(list, r.sel == null ? "" : r.sel, function (v) {
            r.sel = v ? +v : null; r.kind = r.sel != null ? "manual" : "missing"; if (r.sel != null) r.create = false;
            // A re-mapped parent changes the pool of its subtags: re-match them.
            imp.rows.forEach(function (c) { if (c.ref.parent && parentRow(c, imp.byKey) === r) autoMatch(c, imp.byKey); });
            renderPreview();
          }, { "aria-label": "Koppeling voor " + refLabel(r.ref) });
          var chip = { exact: ["✓ gevonden", "ok"], manual: ["✓ gekozen", "ok"], alias: ["≈ gok — controleer", "guess"], close: ["≈ gok — controleer", "guess"], missing: ["ontbreekt", "missing"] }[r.kind];
          var extra = null;
          var canCreate = r.sel == null && (!r.ref.parent || (parentRow(r, imp.byKey) && (parentRow(r, imp.byKey).sel != null || parentRow(r, imp.byKey).create)));
          if (canCreate) {
            var c = h("input", { type: "checkbox" }); c.checked = !!r.create;
            c.addEventListener("change", function () { r.create = c.checked; renderPreview(); });
            extra = h("label", { class: "qws-check small" }, [c, h("span", { text: "aanmaken in Questi" })]);
          }
          map.appendChild(h("div", { class: "qws-maprow" }, [
            h("span", { class: "qws-swatch sm", style: "background:" + (r.ref.color || "#c7ccd1") }),
            h("span", { class: "qws-mapfrom", text: refLabel(r.ref) }), h("span", { class: "qws-muted", text: "→" }), sel,
            h("span", { class: "qws-chip " + chip[1], text: r.create ? "wordt aangemaakt" : chip[0] }), extra
          ]));
        });
        preview.appendChild(map);
        var unmapped = imp.rows.filter(function (r) { return r.sel == null && !r.create; }).length;
        if (unmapped) preview.appendChild(note(unmapped + " vak(ken) niet gekoppeld: lesuren en thema’s met dat vak worden overgeslagen.", "warn"));
      }
      // Parts
      var partsBox = h("div", { class: "qws-stack" }, [h("span", { class: "qws-field-l", text: "Wat overnemen?" })]);
      ["lesrooster", "vakken", "themas", "agenda", "afdrukken", "collegas"].forEach(function (p) {
        if (!partPresent(d, p)) return;
        var lab = partLabel(d, p), c = h("input", { type: "checkbox" }); c.checked = !!imp.parts[p];
        c.addEventListener("change", function () { imp.parts[p] = c.checked; });
        partsBox.appendChild(h("label", { class: "qws-check" }, [c, h("span", { class: "qws-grow", text: lab[0] }), h("span", { class: "qws-muted", text: lab[1] })]));
      });
      preview.appendChild(partsBox);
      var result = h("div", { class: "qws-stack" });
      preview.appendChild(h("div", { class: "qws-bar" }, [
        h("span", { class: "qws-muted qws-grow", text: "Niets wordt overschreven tot je op Importeren klikt. Nieuwe tags vragen nog een bevestiging." }),
        btn("Importeren", function () { startApply(result); }, "primary")
      ]));
      preview.appendChild(result);
    }
    function startApply(result) {
      var creates = imp.rows.filter(function (r) { return r.create && r.sel == null; });
      function go() {
        result.innerHTML = ""; result.appendChild(note(creates.length ? "Tags aanmaken…" : "Importeren…"));
        runCreates(creates).then(function (fails) { return applyImport(imp).then(function (sum) { sum.unshift.apply(sum, fails); return sum; }); })
          .then(function (sum) {
            result.innerHTML = "";
            result.appendChild(note("Geïmporteerd uit " + imp.name + ".", "ok"));
            sum.forEach(function (l) { result.appendChild(note(l, /niet|mislukt|overgeslagen/.test(l) ? "warn" : "")); });
            if (opts.onApplied) opts.onApplied({ name: imp.name, lines: sum });
          }, function (e) { result.innerHTML = ""; result.appendChild(note("Importeren mislukt: " + ((e && e.message) || e), "warn")); });
      }
      if (creates.length) {
        confirmBox("Tags aanmaken in Questi", [
          "Deze tag(s) worden aangemaakt in je Questi-lesfiches:",
          h("ul", { class: "qws-ul" }, creates.map(function (r) { return h("li", { text: refLabel(r.ref) }); })),
          "Daarna worden de instellingen overgenomen. Verwijderen kan later in Lesfiches → Tags."
        ], "Aanmaken en importeren", go);
      } else go();
    }
    // Top-level first, so a new subtag can hang under a parent created a moment earlier.
    function runCreates(list) {
      var fails = [], chain = Promise.resolve();
      list.slice().sort(function (a, b) { return (a.ref.parent ? 1 : 0) - (b.ref.parent ? 1 : 0); }).forEach(function (r) {
        chain = chain.then(function () {
          var pid = null;
          if (r.ref.parent) { var pr = parentRow(r, imp.byKey); pid = pr ? pr.sel : null; if (pid == null) { fails.push("Subtag " + refLabel(r.ref) + " niet aangemaakt: vak ontbreekt."); return; } }
          return createTag(r.ref.title, r.ref.color, pid).then(function (tag) {
            if (tag && tag.id != null) { r.sel = tag.id; r.kind = "manual"; }
            else fails.push("Tag " + refLabel(r.ref) + " aangemaakt, maar niet teruggevonden — niet gekoppeld.");
          }, function (e) { fails.push("Tag " + refLabel(r.ref) + " aanmaken mislukt: " + ((e && e.message) || e)); })
            .then(function () { return new Promise(function (res) { setTimeout(res, 300); }); });
        });
      });
      return chain.then(function () { return fails; });
    }
  }
  function resolveRef(imp, ref) { if (!ref) return null; var r = imp.byKey[refKey(ref)]; return r && r.sel != null ? r.sel : null; }
  // Apply the chosen parts to local state. → Promise<summary lines>
  function applyImport(imp) {
    var s = st(), d = imp.data, want = imp.parts, sum = [];
    if (want.lesrooster) {
      var ok = 0, skip = 0;
      d.lesrooster.forEach(function (e) {
        var id = resolveRef(imp, e.vak);
        if (id == null || e.day == null || !/^\d{1,2}:\d{2}$/.test(e.time || "")) { skip++; return; }
        s.settings[e.day + "|" + e.time] = +id; ok++;
      });
      sum.push("Lesrooster: " + ok + " lesuur/lesuren overgenomen" + (skip ? ", " + skip + " overgeslagen (vak niet gekoppeld)" : "") + ".");
    }
    if (want.vakken) {
      var on = [], off = [], order = [];
      d.vakken.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); }).forEach(function (v) {
        var id = resolveRef(imp, { title: v.title }); if (id == null) return;
        order.push(id); (v.vak === false ? off : on).push(id);
      });
      // Merge: the importer's own tags the file does not mention keep their current status.
      var cur = subjectTops().filter(function (t) { return isVakId(t.id) && !inList(off, t.id); }).map(function (t) { return t.id; });
      on.forEach(function (id) { if (!inList(cur, id)) cur.push(id); });
      s.vakTags = compactVakTags(cur);
      s.vakOrder = order.concat(orderedTops().map(function (t) { return t.id; }).filter(function (id) { return !inList(order, id); }));
      sum.push("Vakken: " + on.length + " vak(ken) gekoppeld, volgorde overgenomen.");
    }
    if (want.themas) {
      var groups = themaGroups(), done = 0, missing = [];
      d.themas.forEach(function (e) {
        var id = resolveRef(imp, e.vak), n = S().normTitle(e.title);
        var gs = groups.filter(function (g) { return g.norm === n; });
        if (id == null || !gs.length) { missing.push(e.title); return; }
        gs.forEach(function (g) { applyThemaVak(g, +id); }); done++;
      });
      sum.push("Thema’s: " + done + " gekoppeld." + (missing.length ? " Niet in de geladen week gevonden of vak niet gekoppeld, overgeslagen: " + missing.join(", ") + " — koppel ze later in Lesrooster." : ""));
    }
    if (want.agenda && d.agenda) {
      if (typeof d.agenda.writeVakDescription === "boolean") s.writeVakDescription = d.agenda.writeVakDescription;
      if (d.agenda.saveThrottleMs != null && !isNaN(+d.agenda.saveThrottleMs)) s.saveThrottleMs = Math.max(0, Math.min(+d.agenda.saveThrottleMs, 10000));
      sum.push("Agenda: vak als beschrijving " + (s.writeVakDescription ? "aan" : "uit") + ".");
    }
    var tail = Promise.resolve();
    if (want.afdrukken && d.afdrukken) {
      tail = tail.then(function () { return storeGet(PRINT_KEY); }).then(function (cur) {
        var a = d.afdrukken, next = Object.assign({}, PRINT_DEFAULTS, cur || {});
        if (/^(plain|goals1|goals2)$/.test(a.mode || "")) next.mode = a.mode;
        if (/^(word|icon)$/.test(a.tabs || "")) next.tabs = a.tabs;
        if (typeof a.legend === "boolean") next.legend = a.legend;
        storeSet(PRINT_KEY, next); sum.push("Afdrukkeuzes overgenomen.");
      });
    }
    if (want.collegas) {
      tail = tail.then(function () {
        var pp = (S().view.people && S().view.people.length) ? Promise.resolve(S().view.people) : S().fetchPeople();
        return Promise.all([pp, (d.methodes || []).length ? S().fetchMethods() : Promise.resolve([])]);
      }).then(function (r) {
        var people = r[0] || [], methods = r[1] || [], added = 0, miss = [];
        (d.collegas || []).forEach(function (c) {
          var p = people.filter(function (x) { return norm(x.name) === norm(c.name); })[0];
          if (!p) { miss.push(c.name); return; }
          if (!s.colleagues.some(function (x) { return sameId(x.id, p.id); })) { s.colleagues.push({ id: p.id, name: p.name }); added++; }
        });
        (d.methodes || []).forEach(function (m) {
          var hit = methods.filter(function (x) { return String(x.id) === String(m.key); })[0] || methods.filter(function (x) { return norm(x.name) === norm(m.name); })[0];
          if (!hit) { miss.push(m.name); return; }
          if (!s.colleagues.some(function (x) { return x.isMethod && String(x.methodKey) === String(hit.id); })) { s.colleagues.push(methodEntry(hit)); added++; }
        });
        ui.sourcesDirty = true;
        sum.push("Collega’s & methodes: " + added + " toegevoegd." + (miss.length ? " Niet gevonden in je school, overgeslagen: " + miss.join(", ") + "." : ""));
      });
    }
    return tail.then(function () { save(); ui.plannerDirty = true; return sum; });
  }

  function secDelen(body) {
    var parts = {}; EXPORT_PARTS.forEach(function (p) { parts[p.id] = p.on; });
    var s = st();
    var counts = { lesrooster: Object.keys(s.settings || {}).length + " lesuren", vakken: "op naam + kleur", themas: Object.keys(s.themaVak || {}).length + "", agenda: "", afdrukken: "", collegas: "enkel namen" };
    var expMsg = h("div", { class: "qws-stack" });
    var exp = card([cardTitle("Exporteren", "Wat gaat er in het bestand?")].concat(EXPORT_PARTS.map(function (p) {
      var c = h("input", { type: "checkbox" }); c.checked = p.on;
      c.addEventListener("change", function () { parts[p.id] = c.checked; });
      return h("label", { class: "qws-check" }, [c, h("span", { class: "qws-grow", text: p.n }), h("span", { class: "qws-muted", text: counts[p.id] })]);
    })).concat([
      btn("Exporteren (.json)", function () {
        exportSettings({ parts: parts }).then(function (r) {
          var ok = downloadJson(r.data, "unquesti-instellingen-" + tsStamp() + ".json");
          expMsg.innerHTML = "";
          expMsg.appendChild(note(ok ? "Bestand gedownload." : "Downloaden mislukt — zie console.", ok ? "ok" : "warn"));
          if (r.skipped.length) expMsg.appendChild(note("Niet in het bestand: " + r.skipped.join("; ") + ".", "warn"));
        });
      }, "primary"),
      expMsg,
      h("span", { class: "qws-muted", text: "Vakken staan erin op naam en kleur, niet als Questi-nummer — zo werkt het bestand ook in het account van een collega." })
    ]));
    var imp = card([cardTitle("Importeren", "Van een collega of uit je eigen back-up.")]);
    importPanel(imp, { onApplied: function () { /* stay on the result; the nav re-renders on demand */ } });
    body.appendChild(h("div", { class: "qws-two even" }, [exp, imp]));
  }

  // ---------- Over ----------
  function cmpVersion(a, b) {
    var x = String(a).split("."), y = String(b).split(".");
    for (var i = 0; i < Math.max(x.length, y.length); i++) { var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d; }
    return 0;
  }
  function secOver(body) {
    var verLine = h("span", { class: "qws-p", text: "Versie " + manifestVersion() + " · controleren…" });
    try {
      chrome.runtime.sendMessage({ type: "QWP_CHECK_VERSION" }, function (r) {
        void chrome.runtime.lastError;
        if (!r || !r.ok) { verLine.textContent = "Versie " + manifestVersion() + " · kon niet controleren of er een nieuwere is."; return; }
        verLine.textContent = "Versie " + manifestVersion() + " · " + (cmpVersion(r.latest, manifestSemver()) > 0 ? "nieuwe versie " + r.latest + " beschikbaar" : "up-to-date");
      });
    } catch (e) { verLine.textContent = "Versie " + manifestVersion(); }
    var diagMsg = h("span", { class: "qws-muted" });
    body.appendChild(h("div", { class: "qws-two even" }, [
      card([
        h("span", { class: "qws-big", text: "UnQuesti" }), verLine,
        h("p", { class: "qws-p", text: "Bijwerken: dubbelklik update.bat in de map van de planner, laad de extensie opnieuw op chrome://extensions en herlaad daarna Questi. De planner meldt zelf wanneer er een nieuwe versie is." }),
        h("div", { class: "qws-inline" }, [
          btn("Zelftest openen", function () {
            if (!plannerShown()) { diagMsg.textContent = "Open eerst Plannen; de Zelftest draait daar."; return; }
            close(); S().openDiagnose();
          }, "ghost"),
          btn("Eerste installatie opnieuw", function () { openSetup(); }, "ghost")
        ]),
        diagMsg,
        h("p", { class: "qws-p muted", text: "Werkt bovenop Questi zonder officiële koppeling. Je gegevens blijven in je browser en in je eigen Questi-account; er gaat niets naar een andere server. Enkel de versiecontrole leest een bestand van GitHub." })
      ]),
      card([cardTitle("Waar staan je instellingen?"),
        h("p", { class: "qws-p", text: "In deze browser (chrome.storage van de extensie), niet in Questi. Op een andere computer begin je opnieuw — of je neemt ze mee via Delen & back-up." })])
    ]));
  }

  // ========================================================================
  //  First-run setup wizard
  // ========================================================================
  var wz = null;
  var STEPS = [["Welkom", "je account"], ["Vakken", "welke tags zijn vakken"], ["Lesrooster", "vak per lesuur"], ["Agenda", "beschrijving & thema’s"], ["Klaar", "samenvatting"]];
  function openSetup() {
    if (!S()) return;
    build(); ui.mode = "setup"; show(); loading("Eerste installatie voorbereiden…");
    ensureReady().then(function () { if (ui.mode !== "setup") return; wz = newWizard(); renderSetup(); });
  }
  function newWizard() {
    var s = st(), tv = {};
    Object.keys(s.themaVak || {}).forEach(function (k) { tv[k] = s.themaVak[k]; });
    return {
      step: 0, importing: false, imported: null,
      vakTags: Array.isArray(s.vakTags) ? s.vakTags.slice() : null,
      settings: Object.assign({}, s.settings || {}), guesses: null,
      // A new install has false here (the setup default); a re-run keeps what the user has.
      writeDesc: s.writeVakDescription === true,
      themaVak: tv, calendar: s.workingCalendarId == null ? "" : String(s.workingCalendarId),
      result: null, msg: ""
    };
  }
  // Bootstrap suggestions for empty lesuren (rule 3b: never a live rule — only a flagged voorstel
  // the user must confirm). 1) the vak the planner already resolved for that lesuur from its fiche
  // or stored description (a TAG, not a title); 2) the ORIGINAL item title matched against vak names.
  function computeGuesses() {
    var out = {}, P = S(); if (!plannerLoaded()) return out;
    var pool = vakTops(false, wz.vakTags);
    P.view.slots.forEach(function (s) {
      if (s.isFullday || s.idCalendar === "cal_holidays" || !s.time) return;
      var key = s.dayIdx + "|" + s.time; if (wz.settings[key] != null || out[key]) return;
      var top = (s.vak != null && s.vak !== "") ? P.topTagIdOf(s.vak) : null;
      if (top != null && pool.some(function (t) { return sameId(t.id, top); })) { out[key] = { id: top, why: "uit de lesfiche of beschrijving van dit lesuur" }; return; }
      var t = String(P.stripQuestiDecoration(s.origTitle || "") || "").trim();
      if (!t || /^lesuur\s*\d*$/i.test(t)) return;
      var m = matchIn(pool, t);
      if (m) out[key] = { id: m.tag.id, why: "uit de titel “" + t + "”" };
    });
    return out;
  }
  function renderSetup() {
    ui.root.innerHTML = "";
    var steps = h("aside", { class: "qws-steps" }, [
      h("div", { class: "qws-steps-k", text: "UNQUESTI" }),
      h("div", { class: "qws-steps-t", text: "Eerste installatie" })
    ].concat(STEPS.map(function (s, i) {
      var cur = i === wz.step, done = i < wz.step;
      // Steps after Agenda only open via Afronden (that is where settings are saved).
      var reachable = i <= 3 || wz.result;
      return h("button", { type: "button", class: "qws-step" + (cur ? " cur" : "") + (done ? " done" : ""), disabled: reachable ? null : "disabled",
        onclick: function () { if (!reachable) return; wz.step = i; wz.importing = false; renderSetup(); } }, [
        h("span", { class: "qws-step-dot", text: done ? "✓" : String(i + 1) }),
        h("span", { class: "qws-step-txt" }, [h("span", { class: "qws-step-t", text: s[0] }), h("span", { class: "qws-step-d", text: s[1] })])
      ]);
    })).concat([
      h("div", { class: "qws-grow" }),
      h("div", { class: "qws-steps-ft", text: "Er wordt niets in Questi aangepast, behalve een tag die je zelf bevestigt. Je vindt dit later terug in Instellingen → Over." })
    ]));
    var content = h("div", { class: "qws-setup-body" });
    if (wz.imported) content.appendChild(note("Ingevuld vanuit " + wz.imported.name + ". Controleer elke stap.", "ok"));
    [stepWelkom, stepVakken, stepLesrooster, stepAgenda, stepKlaar][wz.step](content);
    var ft = h("footer", { class: "qws-setup-ft" }, [
      wz.step > 0 && wz.step < 4 ? btn("Terug", function () { wz.step--; renderSetup(); }, "ghost") : null,
      h("span", { class: "qws-grow qws-muted", text: "Stap " + (wz.step + 1) + " van 5" }),
      wz.step < 4 ? btn("Later", function () { close(); }, "ghost", { title: "Sluiten zonder te bewaren — je vindt dit terug in Instellingen → Over" }) : null,
      wz.step > 0 && wz.step < 4 ? btn(wz.step === 3 ? "Afronden" : "Volgende", function () {
        if (wz.step === 3) applyWizard();
        wz.step++; renderSetup();
      }, "primary") : null
    ]);
    ui.root.appendChild(h("div", { class: "qws-setup" }, [steps, h("main", { class: "qws-setup-main" }, [content, ft])]));
  }
  function stepWelkom(c) {
    var x = ctx(), P = S(), first = String(x.ownerName || "").split(" ")[0];
    c.appendChild(h("h1", { class: "qws-h1", text: "Welkom" + (first ? ", " + first : "") }));
    c.appendChild(h("p", { class: "qws-lead", text: "De planner heeft je Questi-account gelezen. Alles hieronder komt rechtstreeks uit Questi — je hoeft niets in te typen." }));
    var tops = subjectTops(), subs = ownTags().filter(function (t) { return t.parent != null && t.parent !== 0; }).length;
    var cal = (x.calendars || []).filter(function (cc) { return sameId(cc.id, x.calendarId); })[0];
    var lesuren = plannerLoaded() ? P.view.slots.filter(function (s) { return !s.isFullday && s.idCalendar !== "cal_holidays" && s.weekIdx === 0; }).length : 0;
    var own = ((P.view && P.view.ficheGroups) || []).filter(function (g) { return sameId(g.ownerId, x.ownerId) || g.ownerId === "self"; })[0];
    var checks = [
      ["School", x.school && x.school.name ? x.school.name : null],
      ["Schooljaar", x.schoolyear ? String(x.schoolyear) : null],
      ["Agenda met lesuren", cal ? cal.name + (plannerLoaded() ? " (" + lesuren + " lesuren in de geladen week)" : "") : null],
      ["Klas", x.groupId != null ? "gevonden" : null],
      ["Eigen tags", tops.length ? tops.length + " hoofdtags, " + subs + " subtags" : null],
      ["Eigen lesfiches", own && own.items ? own.items.length + " fiches" : null]
    ];
    c.appendChild(h("div", { class: "qws-checks" }, checks.map(function (k) {
      var ok = k[1] != null;
      return h("div", { class: "qws-ctxcheck" + (ok ? "" : " warn") }, [
        h("span", { class: "qws-ctxdot", text: ok ? "✓" : "?" }),
        h("span", { class: "qws-step-txt" }, [h("span", { class: "qws-muted", text: k[0] }), h("span", { class: "qws-ctxv", text: ok ? k[1] : (k[0] === "Klas" ? "onbekend — normaal in vakanties" : "niet gevonden") })])
      ]);
    })));
    if (!plannerLoaded()) c.appendChild(note("Je lesrooster wordt uit de week in Plannen gelezen. Open Plannen op een week met lesuren voor stap 3.", "warn"));
    if (wz.importing) {
      var box = card([cardTitle("Overnemen van een collega", "Kies het .json-bestand dat een collega exporteerde. Vakken worden op naam gekoppeld aan jouw tags.")]);
      importPanel(box, { onApplied: function (r) {
        // Re-read the draft from the state the import just filled; show the result, then continue.
        wz = newWizard(); wz.imported = r; wz.step = 1;
        box.appendChild(btn("Verder naar Vakken", function () { renderSetup(); }, "primary"));
      } });
      c.appendChild(box);
      c.appendChild(btn("← Toch zelf instellen", function () { wz.importing = false; wz.step = 1; renderSetup(); }, "ghost"));
      return;
    }
    c.appendChild(h("div", { class: "qws-choices" }, [
      h("button", { type: "button", class: "qws-choice primary", onclick: function () { wz.step = 1; renderSetup(); } }, [
        h("span", { class: "qws-choice-t", text: "Zelf instellen" }), h("span", { class: "qws-muted", text: "± 3 minuten · vakken kiezen en je lesrooster aanduiden" })]),
      h("button", { type: "button", class: "qws-choice", onclick: function () { wz.importing = true; renderSetup(); } }, [
        h("span", { class: "qws-choice-t", text: "Overnemen van een collega" }), h("span", { class: "qws-muted", text: "Kies het .json-bestand dat een collega exporteerde. Vakken worden op naam gekoppeld aan jouw tags." })])
    ]));
  }
  function stepVakken(c) {
    c.appendChild(h("h1", { class: "qws-h1", text: "Welke van je tags zijn vakken?" }));
    c.appendChild(h("p", { class: "qws-lead", text: "Een vak is een hoofdtag die je kiest voor een lesuur. Je tags blijven gewoon bestaan — je duidt enkel aan welke een vak zijn." }));
    var tops = vakTops(true), list = h("div", { class: "qws-card qws-taglist" });
    if (!tops.length) list.appendChild(note("Geen eigen hoofdtags gevonden. Maak hieronder een vak aan.", "warn"));
    tops.forEach(function (t) {
      var on = isVakId(t.id, wz.vakTags), chk = h("input", { type: "checkbox" }); chk.checked = on;
      chk.addEventListener("change", function () {
        var cur = Array.isArray(wz.vakTags) ? wz.vakTags.slice() : subjectTops().map(function (x) { return x.id; });
        cur = cur.filter(function (x) { return !sameId(x, t.id); }); if (chk.checked) cur.push(t.id);
        wz.vakTags = compactVakTags(cur); wz.guesses = null; renderSetup();
      });
      var n = childrenOf(t.id).length;
      list.appendChild(h("label", { class: "qws-tagrow" + (on ? "" : " off") }, [chk, h("span", { class: "qws-swatch sm", style: "background:" + tagHex(t) }),
        h("span", { class: "qws-step-txt" }, [h("span", { class: "qws-vakname", text: tagName(t) }), h("span", { class: "qws-muted", text: n ? n + " subtags" : "geen subtags" })])]));
    });
    var nameInp = h("input", { class: "qws-input", type: "text", placeholder: "bv. Lichamelijke opvoeding" });
    var colorInp = h("input", { class: "qws-color", type: "color", value: "#c9d2d7", "aria-label": "Kleur" });
    var msg = h("span", { class: "qws-muted", text: wz.msg || "" }); wz.msg = "";
    list.appendChild(h("div", { class: "qws-addrow foot" }, [h("span", { class: "qws-grow qws-p", text: "Ontbreekt er een vak?" }), nameInp, colorInp, btn("Vak aanmaken…", function () {
      var title = (nameInp.value || "").trim(); if (!title) { msg.textContent = "Geef een naam op."; return; }
      if (subjectTops().some(function (t) { return norm(t.title) === norm(title); })) { msg.textContent = "Die tag bestaat al."; return; }
      confirmBox("Nieuwe tag in Questi", ["Dit maakt de hoofdtag “" + title + "” aan in je Questi-lesfiches. Het is de enige wijziging die de installatie in Questi doet.", "Verwijderen kan later in Lesfiches → Tags."], "Aanmaken", function () {
        msg.textContent = "Aanmaken…";
        createTag(title, colorInp.value).then(function (tag) {
          if (tag && Array.isArray(wz.vakTags)) wz.vakTags.push(tag.id);
          wz.msg = "“" + title + "” aangemaakt in Questi."; wz.guesses = null; renderSetup();
        }, function (e) { msg.textContent = "Aanmaken mislukt: " + ((e && e.message) || e); });
      });
    }, "ghost"), msg]));
    c.appendChild(list);
  }
  function stepLesrooster(c) {
    c.appendChild(h("h1", { class: "qws-h1", text: "Welk vak geef je wanneer?" }));
    c.appendChild(h("p", { class: "qws-lead", text: "Dit zijn de vaste lesuren uit je Questi-agenda. Gele randjes zijn een voorstel op basis van je agenda — kies of bevestig ze (✓). Een voorstel dat je niet bevestigt, wordt niet bewaard." }));
    if (!timeRows().length) {
      c.appendChild(note(plannerLoaded() ? "Geen lesuren in de geladen week (vakantie?). Je kan dit later invullen in Instellingen → Lesrooster." : "Open eerst Plannen op een week met lesuren; je kan dit ook later invullen in Instellingen → Lesrooster.", "warn"));
      return;
    }
    if (!wz.guesses) wz.guesses = computeGuesses();
    var g = wz.guesses;
    var nGuess = Object.keys(g).filter(function (k) { return wz.settings[k] == null; }).length;
    if (nGuess) c.appendChild(h("div", { class: "qws-bar" }, [
      h("span", { class: "qws-grow qws-p", text: nGuess + " voorstel(len) nog niet bevestigd." }),
      btn("Alle voorstellen bevestigen", function () { Object.keys(g).forEach(function (k) { if (wz.settings[k] == null) wz.settings[k] = g[k].id; }); renderSetup(); }, "ghost")
    ]));
    c.appendChild(card([slotGrid({
      vakList: wz.vakTags,
      value: function (k) { var v = wz.settings[k]; return v != null && v !== "" ? v : null; },
      guess: function (k) { return g[k] || null; },
      onChange: function (k, v) { if (v == null) { delete wz.settings[k]; delete g[k]; } else wz.settings[k] = v; renderSetup(); },
      onAccept: function (k) { if (g[k]) wz.settings[k] = g[k].id; renderSetup(); }
    })]));
    var cells = 0; timeRows().forEach(function (t) { for (var d = 0; d < 5; d++) if (!S().isNoSchool(d, t)) cells++; });
    var filled = Object.keys(wz.settings).length;
    c.appendChild(h("div", { class: "qws-muted", text: filled + " van " + cells + " lesuren hebben een vak." }));
  }
  function stepAgenda(c) {
    c.appendChild(h("h1", { class: "qws-h1", text: "Hoe schrijft de planner in je agenda?" }));
    c.appendChild(toggle(wz.writeDesc, "Vak als beschrijving in de agenda zetten · optioneel",
      "Handig als je klaswebsite (bv. Enderklas) de beschrijving toont als vak. Staat dit uit, dan laat de planner de beschrijving van je lesuren volledig met rust.",
      function (on) { wz.writeDesc = on; renderSetup(); }));
    c.appendChild(note(wz.writeDesc ? "Aan — elk lesuur krijgt het vak als beschrijving." : "Uit — beschrijvingen blijven onaangeroerd.", wz.writeDesc ? "ok" : ""));
    c.appendChild(card([cardTitle("Thema’s die de hele week lopen", "Gevonden in je agenda als items van een volledige week. Kies bij welk vak ze horen."),
      themaList({ vakList: wz.vakTags, value: function (g) { var v = wz.themaVak[g.id]; return v != null ? v : null; }, onChange: function (g, v) { if (v == null) delete wz.themaVak[g.id]; else wz.themaVak[g.id] = v; renderSetup(); } })]));
    var cals = ctx().calendars || [];
    if (cals.length > 1) {
      c.appendChild(card([field("Agenda om in te plannen",
        selectEl([{ v: "", n: "automatisch (nu: " + ((cals.filter(function (x) { return sameId(x.id, ctx().calendarId); })[0] || {}).name || "?") + ")" }].concat(cals.map(function (x) { return { v: x.id, n: x.name }; })), wz.calendar, function (v) { wz.calendar = v; }),
        "Je hebt " + cals.length + " agenda’s. ‘Automatisch’ kiest de agenda met de meeste lesuren.")]));
    }
  }
  // Afronden: the only moment the wizard saves (local state; no Questi writes).
  function applyWizard() {
    var s = st(), dropped = 0;
    if (wz.guesses) Object.keys(wz.guesses).forEach(function (k) { if (wz.settings[k] == null) dropped++; });
    s.vakTags = compactVakTags(wz.vakTags);
    Object.keys(s.settings).forEach(function (k) { delete s.settings[k]; });
    Object.keys(wz.settings).forEach(function (k) { if (wz.settings[k] != null && wz.settings[k] !== "") s.settings[k] = +wz.settings[k]; });
    s.writeVakDescription = !!wz.writeDesc;
    var groups = themaGroups();
    groups.forEach(function (g) {
      var want = wz.themaVak[g.id] != null ? +wz.themaVak[g.id] : null, have = (s.themaVak || {})[g.id];
      if (String(want) !== String(have == null ? null : have)) applyThemaVak(g, want);
    });
    s.setupDone = true;
    save(); ui.plannerDirty = true;
    var calNote = "";
    var newWc = wz.calendar ? wz.calendar : null;
    if (String(newWc) !== String(s.workingCalendarId)) {
      s.workingCalendarId = newWc; save();
      if (newWc != null) { ctx().calendarId = newWc; if (plannerShown()) S().reloadAndRender(); calNote = "Werkagenda gewijzigd — Plannen laadt die agenda."; }
      else calNote = "Agenda op ‘automatisch’ gezet — herlaad Questi om opnieuw te kiezen.";
    }
    wz.result = { vakken: vakTops(false).length, filled: Object.keys(s.settings).length, desc: s.writeVakDescription, dropped: dropped, calNote: calNote };
  }
  function stepKlaar(c) {
    var r = wz.result || { vakken: 0, filled: 0, desc: false, dropped: 0 };
    c.appendChild(h("h1", { class: "qws-h1", text: "Klaar om te plannen" }));
    c.appendChild(h("div", { class: "qws-stats" }, [
      h("div", { class: "qws-card" }, [h("div", { class: "qws-stat", text: String(r.vakken) }), h("div", { class: "qws-muted", text: "vakken" })]),
      h("div", { class: "qws-card" }, [h("div", { class: "qws-stat", text: String(r.filled) }), h("div", { class: "qws-muted", text: "lesuren met een vak" })]),
      h("div", { class: "qws-card" }, [h("div", { class: "qws-stat", text: r.desc ? "aan" : "uit" }), h("div", { class: "qws-muted", text: "vak in beschrijving" })])
    ]));
    if (r.dropped) c.appendChild(note(r.dropped + " voorstel(len) niet bevestigd — niet bewaard. Vul ze aan in Instellingen → Lesrooster.", "warn"));
    if (r.calNote) c.appendChild(note(r.calNote));
    var exMsg = h("span", { class: "qws-muted" });
    c.appendChild(h("div", { class: "qws-inline" }, [
      btn("Naar Plannen", function () { close(); }, "primary big"),
      btn("Instellingen exporteren voor collega’s (.json)", function () {
        exportSettings({}).then(function (x) { exMsg.textContent = downloadJson(x.data, "unquesti-instellingen-" + tsStamp() + ".json") ? "Bestand gedownload." : "Downloaden mislukt."; });
      }, "ghost big"),
      exMsg
    ]));
    c.appendChild(h("p", { class: "qws-p muted", text: "De export bewaart vakken op naam en kleur, niet als Questi-nummers — zo werkt ze ook in het account van een collega." }));
  }

  // Auto-open once for a brand-new user: no slot settings yet and the wizard never shown.
  document.addEventListener("qwp:loaded", function () {
    var P = S(); if (!P || !P.state) return;
    var s = P.state;
    if (s.setupDone || Object.keys(s.settings || {}).length) return;
    if (ui.root && ui.root.classList.contains("qws-show")) return;
    openSetup();
  });

  // ========================================================================
  //  Zelftest → "Opslaan als .json"
  // ========================================================================
  // Titles the user may want out of a shared report: lesuur, item and fiche titles in view.
  function knownTitles() {
    var P = S(), set = {};
    function add(t) { t = String(t == null ? "" : t).trim(); if (t.length >= 3) set[t] = true; var d = P.stripQuestiDecoration(t); if (d && d.length >= 3) set[d.trim()] = true; }
    ((P.view && P.view.slots) || []).forEach(function (s) { add(s.title); add(s.origTitle); add(s.ficheTitle); add(s.origFicheTitle); });
    ((P.view && P.view.ficheGroups) || []).forEach(function (g) { (g.items || []).forEach(function (f) { add(f.subject); }); });
    return Object.keys(set).sort(function (a, b) { return b.length - a.length; });
  }
  // rows: the Zelftest rows; opts: { omitTitles, toolVersion }. Never includes cookies, the xsrf
  // token or any session value — only what the tool itself detected and stored.
  function saveDebugJson(rows, opts) {
    opts = opts || {};
    var titles = opts.omitTitles ? knownTitles() : [];
    function red(v) {
      if (!opts.omitTitles || v == null) return v;
      var s = String(v);
      titles.forEach(function (t) { if (s.indexOf(t) > -1) s = s.split(t).join("[titel]"); });
      return s;
    }
    var x = ctx(), P = S();
    return exportSettings({ parts: { lesrooster: true, vakken: true, themas: true, agenda: true, afdrukken: true, collegas: false } }).then(function (r) {
      var settings = r.data;
      if (opts.omitTitles && settings.themas) settings.themas.forEach(function (e) { e.title = red(e.title); });
      var payload = {
        tool: "UnQuesti", version: manifestVersion(), zelftest: opts.toolVersion || null,
        created_at: new Date().toISOString(), userAgent: navigator.userAgent, titlesOmitted: !!opts.omitTitles,
        context: {
          school: (x.school && x.school.name) || null, schoolyear: x.schoolyear != null ? String(x.schoolyear) : null,
          schoolId: x.schoolId, calendarId: x.calendarId, groupId: x.groupId, ownerId: x.ownerId, ownDefaultTagId: x.ownDefaultTagId,
          calendars: (x.calendars || []).map(function (c) { return { id: c.id, name: c.name }; }), ready: !!x.ready,
          weekStart: (P.view && P.view.weekStart) || null, slotsLoaded: ((P.view && P.view.slots) || []).length, ownTags: ownTags().length
        },
        state: { setupDone: !!st().setupDone, writeVakDescription: st().writeVakDescription === true, vakTagsCustom: Array.isArray(st().vakTags), workingCalendarId: st().workingCalendarId, colleagues: st().colleagues.length },
        rows: (rows || []).map(function (rw) { return { status: rw.status, name: rw.name, expected: red(rw.expected), found: red(rw.found), next: red(rw.next) }; }),
        settings: settings, settingsSkipped: r.skipped.map(red),
        errors: (P.recentApiErrors ? P.recentApiErrors() : []).map(function (e) { return { at: e.at, kind: e.kind, id: e.id, status: e.status, msg: red(e.msg) }; })
      };
      var ok = downloadJson(payload, "unquesti-zelftest-" + tsStamp() + ".json");
      try { P.setStatus(ok ? "Zelftest opgeslagen als .json." : "Opslaan als .json mislukt — zie console."); } catch (e) {}
      return ok;
    });
  }

  window.__UQ_SETTINGS = {
    open: open, openSetup: openSetup, close: close,
    exportSettings: exportSettings, saveDebugJson: saveDebugJson,
    vakTops: function (includeNonVak) { return vakTops(!!includeNonVak); }
  };
})();
