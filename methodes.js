/* Questi Week Planner — methodes.js
 * "Methodevoortgang": per methode, which lessons are already given and which are still open.
 *
 * READS ONLY. The single source of truth is each lesfiche's `last_used_date`: used inside the
 * current school year ⇒ gegeven. Nothing here ever writes to Questi — the only persistence is
 * chrome.storage.local (key pg_methodes_v1), and it stores only the teacher's own decisions
 * (which fiches make up a methode, their order, and manual overrides). Titles and dates are
 * re-fetched live on every open, so the table can never drift from Questi.
 *
 * Two sources:
 *   "questi" — a vendor methode library (/cal/manage/methods + /cal/methods/{KEY}/lessons).
 *              Carries no tags, so blocks are parsed out of the lesson titles.
 *   "tag"    — your own lesfiches, picked once via the Lesfiche-manager in selectiemodus.
 *              Blocks come from the SUBTAGS under the methode's hoofdtag (vak → thema's),
 *              which is real data instead of a title guess.
 * ------------------------------------------------------------------------------------------ */
(function () {
  "use strict";
  if (window.__PG_METHODES) return;

  // Reloading the extension does NOT replace content scripts in tabs that are already open —
  // the page has to be reloaded too. Logging the version makes a stale script obvious instead
  // of looking like a phantom bug at a line number that no longer exists.
  try { console.log("[PGM] methodes.js v" + chrome.runtime.getManifest().version); } catch (e) {}

  // ---------- Shared bridge ----------
  function S() { return window.__PG_SHARED; }
  function ctx() { return S().ctx; }
  function h() { return S().h.apply(null, arguments); }
  function elId(id) { return document.getElementById(id); }

  // ---------- Storage ----------
  var STORE_KEY = "pg_methodes_v1";
  var mstate = { methodes: [], activeId: null, sortKey: "order", onlyOpen: false, search: "", schoolYear: null };
  function loadState() {
    return S().storeGet(STORE_KEY).then(function (s) {
      if (s) {
        if (Array.isArray(s.methodes)) mstate.methodes = s.methodes;
        if (s.activeId != null) mstate.activeId = s.activeId;
        if (s.sortKey) mstate.sortKey = s.sortKey;
        if (s.onlyOpen != null) mstate.onlyOpen = !!s.onlyOpen;
        if (s.schoolYear != null) mstate.schoolYear = s.schoolYear;
      }
      return mstate;
    });
  }
  function saveState() { S().storeSet(STORE_KEY, mstate); }
  function nextId(list) {
    var n = 0;
    (list || mstate.methodes).forEach(function (m) { var k = parseInt(String(m.id).replace(/\D/g, ""), 10); if (k > n) n = k; });
    return "m_" + (n + 1);
  }

  // ---------- Runtime ----------
  var mm = {
    built: false, els: {},
    lessons: [],        // live fiches for the active methode
    blocks: {},         // ficheId -> block label (from subtag, or parsed from the title)
    blockOrder: [],     // block labels in the order they should appear (subtag order)
    numbered: false,    // did the titles yield usable lesson numbers?
    loading: false, err: "",
    info: ""            // neutral note, e.g. how many fiches were followed to a newer version
  };
  var GRADES = ["K0", "K1", "K2", "K3", "L1", "L2", "L3", "L4", "L5", "L6", "NLG"];

  // ---------- Derivation ----------
  // A lesson number only counts when the title actually announces one ("Les 12", "nr. 3").
  var NUM_RE = /(?:^|[^\d])(?:les|nr\.?)\s*(\d+)/i;
  var BLK_RE = /\b(blok|thema|hoofdstuk)\s*(\d+)/i;
  function lessonNum(s) { var m = NUM_RE.exec(String(s || "")); return m ? parseInt(m[1], 10) : null; }
  function blockFromTitle(s) {
    var m = BLK_RE.exec(String(s || ""));
    return m ? (m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() + " " + m[2]) : null;
  }
  function shortTitle(s) { return String(s || "").replace(/^.*?\bles\s*\d+\s*[:\-–]\s*/i, "").replace(/^\s*[-–]\s*/, "") || String(s || ""); }
  // Only trust title numbering when at least half the lessons carry a number — otherwise the
  // order would be a coin flip, and we fall back to the order Questi returned.
  function hasNumbering(list) {
    var n = 0; list.forEach(function (f) { if (lessonNum(f.subject) != null) n++; });
    return list.length > 0 && n * 2 >= list.length;
  }
  function nlDate(d) { return d ? String(d).slice(8, 10) + "-" + String(d).slice(5, 7) + "-" + String(d).slice(0, 4) : ""; }

  // ---------- School year ----------
  // Questi rolls ctx.schoolyear over the summer, so between the roll and 1 September the
  // "current" year has not started yet and NOTHING counts as given. That is correct but
  // useless in August, hence an explicit year picker rather than a silent empty table.
  function questiStartYear() {
    var sy = String(ctx().schoolyear || ""), m = sy.match(/(20\d{2})\s*-\s*(20\d{2})/);
    if (m) return +m[1];
    var d = new Date();
    return (d.getMonth() >= 7) ? d.getFullYear() : d.getFullYear() - 1;
  }
  function activeStartYear() { return mstate.schoolYear != null ? mstate.schoolYear : questiStartYear(); }
  function yearLabel(y) { return y + " - " + (y + 1); }
  function yearBounds(startY) { return { start: new Date(startY, 8, 1), end: new Date(startY + 1, 7, 31, 23, 59, 59) }; }
  function notStartedYet(startY) { return new Date() < yearBounds(startY).start; }
  // Same guards as the planner's usedThisYear(), but against a chosen year instead of ctx's.
  function usedInYear(f, startY) {
    var d = f && f.last_used_date; if (!d) return false;
    var s = String(d); if (s.length <= 4 || s.indexOf("0000") === 0) return false;
    var dt = new Date(s.replace(" ", "T")); if (isNaN(dt.getTime())) return false;
    var b = yearBounds(startY);
    return dt >= b.start && dt <= b.end;
  }
  function ficheById(id) { for (var i = 0; i < mm.lessons.length; i++) if (String(mm.lessons[i].id) === String(id)) return mm.lessons[i]; return null; }
  function activeMethode() { for (var i = 0; i < mstate.methodes.length; i++) if (mstate.methodes[i].id === mstate.activeId) return mstate.methodes[i]; return null; }

  // One row per lesson, with the derived status. An override always beats the derived value.
  function buildRows(m) {
    var year = activeStartYear();
    var rows = mm.lessons.map(function (f, i) {
      var ov = (m.overrides || {})[String(f.id)];
      var auto = usedInYear(f, year);
      return {
        id: String(f.id),
        n: mm.numbered ? lessonNum(f.subject) : (i + 1),
        block: mm.blocks[String(f.id)] || null,
        title: mm.numbered ? shortTitle(f.subject) : (f.subject || "(zonder titel)"),
        grades: (f.grades || []).join(", "),
        given: ov ? ov.status === "given" : auto,
        manual: !!ov,
        date: ov ? ov.on : (auto ? String(f.last_used_date).slice(0, 10) : null),
        // Used, but outside the selected school year — shown greyed so it is obvious why it
        // is not counted, instead of looking like it was never taught.
        staleDate: (!auto && f.last_used_date && String(f.last_used_date).indexOf("0000") !== 0 && String(f.last_used_date).length > 4) ? String(f.last_used_date).slice(0, 10) : null
      };
    });
    if (mm.numbered) rows.sort(function (a, b) { return (a.n || 0) - (b.n || 0); });
    return rows;
  }

  // ---------- Loading a methode's lessons ----------
  function loadMethode(m) {
    if (!m) { mm.lessons = []; mm.blocks = {}; render(); return Promise.resolve(); }
    mm.loading = true; mm.err = ""; mm.info = ""; render();
    var p = (m.source === "questi") ? loadQuestiMethode(m) : loadTagMethode(m);
    return p.then(function () {
      mm.numbered = hasNumbering(mm.lessons);
      // Vendor methodes carry no tags, so their blocks can only come from the titles.
      if (m.source === "questi") {
        mm.blocks = {}; mm.blockOrder = [];
        mm.lessons.forEach(function (f) {
          var b = blockFromTitle(f.subject); if (!b) return;
          mm.blocks[String(f.id)] = b;
          if (mm.blockOrder.indexOf(b) < 0) mm.blockOrder.push(b);   // first-appearance order
        });
      }
      // Honour a stored order when we have one; append anything new at the end.
      if (m.order && m.order.length) {
        var pos = {}; m.order.forEach(function (id, i) { pos[String(id)] = i; });
        mm.lessons.sort(function (a, b) {
          var pa = pos[String(a.id)], pb = pos[String(b.id)];
          if (pa == null && pb == null) return 0;
          if (pa == null) return 1;
          if (pb == null) return -1;
          return pa - pb;
        });
      }
      mm.loading = false; render();
    }).catch(function (err) {
      console.error("[PGM] laden mislukt:", err);
      mm.loading = false; mm.err = "Laden mislukt — zie de console."; render();
    });
  }

  function loadQuestiMethode(m) {
    return S().fetchMethodLessons(m.methodKey, m.isCluster).then(function (list) {
      // Cluster methodes return every leerjaar at once; keep only the one this methode tracks.
      if (m.grade) list = list.filter(function (f) { return (f.grades || []).indexOf(m.grade) >= 0; });
      mm.lessons = list;
    });
  }

  // Own fiches: the stored order[] IS the membership list. Fetch the hoofdtag (and its subtags,
  // because a fiche usually hangs under a thema) and keep only what was picked.
  function loadTagMethode(m) {
    var owner = m.ownerId != null ? m.ownerId : "self";
    var kids = S().childTags(m.tagId, owner) || [];
    var byId = {}, blockOf = {};
    mm.blocks = {}; mm.info = "";
    // childTags() is already sorted by title with numeric collation, so "Blok 2" lands before
    // "Blok 10". That order is the order the thema's appear in the table.
    mm.blockOrder = kids.map(function (t) { return (t.title || "").trim(); });
    // fetchAllFichesByTag resolves to { items, total } — not a bare array.
    var jobs = [S().fetchAllFichesByTag(owner, m.tagId).then(function (res) {
      ((res && res.items) || []).forEach(function (f) { byId[String(f.id)] = f; });
    })];
    // One call per thema, which also tells us which thema each fiche belongs to.
    kids.forEach(function (t) {
      jobs.push(S().fetchAllFichesByTag(owner, t.id).then(function (res) {
        ((res && res.items) || []).forEach(function (f) { byId[String(f.id)] = f; blockOf[String(f.id)] = (t.title || "").trim(); });
      }));
    });
    return Promise.all(jobs).then(function () {
      return followNewVersions(m, byId);
    }).then(function (followed) {
      mm.lessons = (m.order || []).map(function (id) { return byId[String(id)]; }).filter(Boolean);
      mm.lessons.forEach(function (f) { var b = blockOf[String(f.id)]; if (b) mm.blocks[String(f.id)] = b; });
      if (followed) mm.info = followed + " fiche(s) intussen bewerkt in Questi — gevolgd naar de nieuwste versie (volgorde en handmatige status blijven).";
      // A fiche that was deleted in Questi silently drops out — say so rather than hide it.
      var missing = (m.order || []).length - mm.lessons.length;
      if (missing > 0) mm.err = missing + " fiche(s) niet meer gevonden in Questi — via 'Fiches kiezen' bijwerken.";
    });
  }

  // Every fiche PATCH mints a new id, so an edited fiche (even just WEET/KEN/KAN) no longer matches
  // the id stored in m.order / m.overrides. All versions share the edit view's `thread`; the planner
  // keeps { thread: newest id seen } in pg_threads_v1. For each stored id that is not in the list:
  // thread from m.threadOf, else one edit-view read of that old version; then the newest version is
  // the pg_threads_v1 entry when it is in the list, else a same-title fiche in the list whose own
  // edit view carries that thread. Reads go 4 at a time and only happen for ids that went missing.
  // Remaps order + overrides in place and persists. → Promise<number followed>
  var GONE = "?";
  function followNewVersions(m, byId) {
    var stale = (m.order || []).map(String).filter(function (id) { return !byId[id]; });
    if (!stale.length) return Promise.resolve(0);
    var members = {}; (m.order || []).forEach(function (id) { members[String(id)] = true; });
    if (!m.threadOf) m.threadOf = {};
    function readEdit(id) {
      return S().fetchFicheEdit(id).then(function (e) { if (e && S().noteFicheThread) S().noteFicheThread(e); return e; });
    }
    var remap = {};
    return S().storeGet("pg_threads_v1").then(function (threads) {
      threads = threads || {};
      return S().mapLimit(stale, 4, function (oldId) {
        // GONE = Questi answered but the version has no thread: remembered, so it is not re-read every
        // open. A failed read (deleted fiche or a network blip) is tried again next open.
        var known = m.threadOf[oldId];
        var thP = known != null ? Promise.resolve({ thread: known, subject: null })
          : readEdit(oldId).then(function (e) { return { thread: e && e.thread != null ? String(e.thread) : GONE, subject: e && e.subject }; }, function () { return { thread: null }; });
        return thP.then(function (o) {
          if (o.thread == null) return;
          m.threadOf[oldId] = o.thread;
          if (o.thread === GONE) return;
          var newest = threads[o.thread];
          if (newest != null && byId[String(newest)] && !members[String(newest)]) { remap[oldId] = String(newest); return; }
          // Not learned on this machine yet: check the same-title fiches in the list that are not
          // members already (normally one). Without a known title there is nothing cheap to check.
          var title = String(o.subject || "").trim().toLowerCase(); if (!title) return;
          var cands = Object.keys(byId).filter(function (id) {
            return !members[id] && Number(id) > Number(oldId) && String(byId[id].subject || "").trim().toLowerCase() === title;
          });
          var best = null;   // mapLimit resolves without results: collect the newest hit here
          return S().mapLimit(cands, 4, function (cid) {
            return readEdit(cid).then(function (e) {
              if (e && e.thread != null && String(e.thread) === o.thread && (best == null || Number(cid) > Number(best))) best = cid;
            });
          }).then(function () { if (best != null) remap[oldId] = best; });
        });
      });
    }).then(function () {
      var n = 0, seen = {};
      m.order = (m.order || []).map(function (id) {
        var to = remap[String(id)];
        if (!to || seen[to]) return String(id);
        seen[to] = true; n++;
        if (m.overrides && m.overrides[String(id)] && !m.overrides[to]) m.overrides[to] = m.overrides[String(id)];
        if (m.overrides) delete m.overrides[String(id)];
        m.threadOf[to] = m.threadOf[String(id)];
        delete m.threadOf[String(id)];
        return to;
      });
      saveState();
      return n;
    }, function (err) { console.warn("[PGM] nieuwere fiche-versies zoeken:", err); return 0; });
  }

  // ========================================================================
  //  Shell
  // ========================================================================
  function build() {
    if (mm.built) return;
    var header = h("div", { class: "pgm-header" }, [
      h("div", { class: "pgm-title", text: "Methodevoortgang" }),
      S().betaPill ? S().betaPill() : null,
      h("span", { class: "pgm-status", id: "pgm-status", text: "" }),
      h("span", { class: "pgm-hspacer" }),
      h("button", { class: "pgm-btn ghost sm", onclick: openBackupModal, title: "Alle methodes exporteren of importeren (JSON)", text: "Back-up" }),
      h("button", { class: "pgm-x", onclick: close, title: "Sluiten", text: "✕" })
    ]);
    var chips = h("div", { class: "pgm-chips", id: "pgm-chips" });
    var meta = h("div", { class: "pgm-meta", id: "pgm-meta" });
    var ctrls = h("div", { class: "pgm-ctrls", id: "pgm-ctrls" });
    var note = h("div", { class: "pgm-note", id: "pgm-note" });
    var body = h("div", { class: "pgm-body", id: "pgm-body" });
    var foot = h("div", { class: "pgm-foot", id: "pgm-foot" });
    var page = h("div", { class: "pgm-page" }, [header, h("div", { class: "pgm-top" }, [chips, meta, ctrls, note]), body, foot]);
    var overlay = h("div", { class: "pgm-overlay", id: "pgm-overlay" }, [page]);
    document.body.appendChild(overlay);
    mm.els = { root: overlay, chips: chips, meta: meta, ctrls: ctrls, note: note, body: body, foot: foot };
    mm.built = true;
  }
  function setStatus(t) { var s = elId("pgm-status"); if (s) s.textContent = t || ""; }

  function open() {
    if (!window.__PG_SHARED) { console.warn("[PGM] __PG_SHARED ontbreekt — planner niet geladen."); return; }
    build();
    mm.els.root.classList.add("pgm-show");
    document.documentElement.classList.add("pgm-locked");
    var ready = ctx().ready ? Promise.resolve() : S().detectContext();
    Promise.all([loadState(), ready]).then(function () {
      if (!mstate.activeId && mstate.methodes.length) mstate.activeId = mstate.methodes[0].id;
      render();
      // Own-fiche methodes need the tag tree to resolve their thema's.
      return S().fetchOwnTags().then(function () { return loadMethode(activeMethode()); });
    });
  }
  function close() {
    if (mm.els.root) mm.els.root.classList.remove("pgm-show");
    var planner = elId("pg-overlay");
    if (!(planner && planner.classList.contains("pg-show"))) document.documentElement.classList.remove("pgm-locked");
  }

  // ========================================================================
  //  Render
  // ========================================================================
  function render() {
    if (!mm.built) return;
    renderChips();
    var m = activeMethode();
    renderMeta(m);
    renderCtrls(m);
    renderNote(m);
    renderBody(m);
    renderFoot(m);
  }

  function renderChips() {
    var c = mm.els.chips; c.innerHTML = "";
    mstate.methodes.forEach(function (m) {
      c.appendChild(h("button", {
        class: "pgm-chip" + (m.id === mstate.activeId ? " on" : ""), text: m.name,
        onclick: function () { mstate.activeId = m.id; saveState(); loadMethode(activeMethode()); }
      }));
    });
    c.appendChild(h("button", { class: "pgm-chip pgm-add", onclick: openAddMenu, text: "+ methode" }));
  }

  function renderMeta(m) {
    var el = mm.els.meta; el.innerHTML = "";
    if (!m) return;
    var rows = buildRows(m), total = rows.length, done = rows.filter(function (r) { return r.given; }).length;
    var pct = total ? Math.round(done / total * 100) : 0;
    var src = m.source === "questi" ? ("Questi-methode" + (m.publisher ? " · " + m.publisher : "")) : "Eigen lesfiches";
    el.appendChild(h("div", { class: "pgm-meta-l" }, [
      h("div", { class: "pgm-mname" }, [
        h("span", { class: "pgm-vakdot", style: "background:" + (m.color || "#5b6470") }),
        h("span", { text: m.name })
      ]),
      h("div", { class: "pgm-mmeta", text: src + (m.grade ? " · " + m.grade : "") + " · schooljaar " + yearLabel(activeStartYear()) })
    ]));
    el.appendChild(h("div", { class: "pgm-prog" }, [
      h("div", { class: "pgm-progtop" }, [
        h("span", {}, [h("b", { text: done + "/" + total }), h("span", { text: " gegeven" })]),
        h("span", { text: pct + "%" })
      ]),
      h("div", { class: "pgm-bar" }, [h("i", { style: "width:" + pct + "%" })])
    ]));
    el.appendChild(h("div", { class: "pgm-acts" }, [
      h("button", { class: "pgm-btn ghost sm", onclick: function () { loadMethode(m); }, text: "Vernieuwen" }),
      (m.source === "tag" ? h("button", { class: "pgm-btn ghost sm", onclick: function () { pickFiches(m); }, text: "Fiches kiezen" }) : null),
      h("button", { class: "pgm-btn ghost sm", onclick: function () { exportMethode(m); }, text: "Exporteer" }),
      h("button", { class: "pgm-btn ghost sm danger", onclick: function () { removeMethode(m); }, text: "Verwijder" })
    ]));
  }

  function renderCtrls(m) {
    var el = mm.els.ctrls; el.innerHTML = "";
    if (!m) return;
    var search = h("input", { class: "pgm-field", type: "search", placeholder: "Zoek in lessen…", value: mstate.search || "" });
    search.addEventListener("input", function (e) { mstate.search = e.target.value || ""; renderBody(m); renderFoot(m); });
    var seg = h("div", { class: "pgm-seg" }, [segBtn("order", "volgorde"), segBtn("az", "a–z"), segBtn("date", "datum")]);
    var cb = h("input", { type: "checkbox" }); cb.checked = !!mstate.onlyOpen;
    cb.addEventListener("change", function () { mstate.onlyOpen = cb.checked; saveState(); renderBody(m); });
    el.appendChild(search); el.appendChild(seg);
    el.appendChild(h("label", { class: "pgm-toggle" }, [cb, h("span", { text: "alleen open" })]));

    // School-year picker: Questi's current year plus the two before it.
    var qy = questiStartYear(), sel = h("select", { class: "pgm-field pgm-yearsel" });
    [qy, qy - 1, qy - 2].forEach(function (y) {
      var o = h("option", { value: String(y), text: yearLabel(y) + (y === qy ? " (huidig)" : "") });
      if (y === activeStartYear()) o.setAttribute("selected", "selected");
      sel.appendChild(o);
    });
    sel.value = String(activeStartYear());
    sel.addEventListener("change", function () {
      var v = parseInt(sel.value, 10);
      mstate.schoolYear = (v === qy) ? null : v;   // null = follow Questi
      saveState(); render();
    });
    el.appendChild(h("label", { class: "pgm-toggle" }, [h("span", { text: "schooljaar" }), sel]));
  }
  function segBtn(key, label) {
    return h("button", {
      class: mstate.sortKey === key ? "on" : "", text: label,
      onclick: function () { mstate.sortKey = key; saveState(); render(); }
    });
  }

  function renderNote(m) {
    var el = mm.els.note; el.innerHTML = ""; el.className = "pgm-note";
    if (!m) return;
    if (mm.err) { el.className = "pgm-note show warn"; el.textContent = mm.err + (mm.info ? " " + mm.info : ""); return; }
    if (mm.info) { el.className = "pgm-note show"; el.textContent = mm.info; return; }
    // The August dead zone: Questi has rolled the year but 1 September has not arrived, so
    // nothing can count as given yet. Say so instead of showing a silently empty 0/N.
    var y = activeStartYear();
    if (notStartedYet(y)) {
      el.className = "pgm-note show";
      el.textContent = "Schooljaar " + yearLabel(y) + " begint pas op 1 september — er staat nog niets als gegeven. "
        + "Kies hierboven " + yearLabel(y - 1) + " om terug te kijken naar vorig jaar.";
      return;
    }
    if (!mm.loading && mm.lessons.length && !mm.numbered) {
      el.className = "pgm-note show";
      el.textContent = hasBlocks()
        ? "Geen lesnummers in de titels — de volgorde volgt je thema's (subtags)."
        : "Geen lesnummers in de titels — volgorde komt uit Questi. Sleep een rij om ze aan te passen.";
    }
  }

  // Reordering only makes sense in the methode's own order, and only when the titles did not
  // already dictate one — otherwise the number sort would immediately undo the drag.
  function hasBlocks() { for (var k in mm.blocks) { if (mm.blocks[k]) return true; } return false; }
  // Once lessons are grouped by thema, the thema order governs the table and a free drag would
  // fight it — so reordering is only offered on a flat, unnumbered list.
  function canReorder() { return mstate.sortKey === "order" && !mm.numbered && !hasBlocks() && !mstate.onlyOpen && !mstate.search; }
  function wireDrag(row, r) {
    row.setAttribute("draggable", "true");
    row.setAttribute("data-id", r.id);
    row.addEventListener("dragstart", function (e) {
      mm.dragId = r.id; row.classList.add("dragging");
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); } catch (err) {}
    });
    row.addEventListener("dragend", function () { mm.dragId = null; row.classList.remove("dragging"); clearDropMarks(); });
    row.addEventListener("dragover", function (e) {
      if (!mm.dragId || mm.dragId === r.id) return;
      e.preventDefault();
      clearDropMarks();
      // Drop above or below depending on which half of the row the cursor is in.
      var box = row.getBoundingClientRect();
      row.classList.add((e.clientY - box.top) < box.height / 2 ? "drop-before" : "drop-after");
    });
    row.addEventListener("drop", function (e) {
      if (!mm.dragId || mm.dragId === r.id) return;
      e.preventDefault();
      var box = row.getBoundingClientRect();
      var before = (e.clientY - box.top) < box.height / 2;
      moveLesson(mm.dragId, r.id, before);
    });
  }
  function clearDropMarks() {
    if (!mm.els.body) return;
    [].forEach.call(mm.els.body.querySelectorAll(".drop-before,.drop-after"), function (e) { e.classList.remove("drop-before", "drop-after"); });
  }
  function moveLesson(dragId, targetId, before) {
    var m = activeMethode(); if (!m) return;
    var ids = mm.lessons.map(function (f) { return String(f.id); });
    var from = ids.indexOf(String(dragId)); if (from < 0) return;
    ids.splice(from, 1);
    var to = ids.indexOf(String(targetId)); if (to < 0) return;
    ids.splice(before ? to : to + 1, 0, String(dragId));
    m.order = ids;
    saveState();
    // Re-sort the live list in place; no refetch needed, the data did not change.
    var pos = {}; ids.forEach(function (id, i) { pos[id] = i; });
    mm.lessons.sort(function (a, b) { return pos[String(a.id)] - pos[String(b.id)]; });
    mm.dragId = null;
    render();
  }

  function renderBody(m) {
    var el = mm.els.body; el.innerHTML = "";
    if (!mstate.methodes.length) { el.appendChild(emptyState()); return; }
    if (!m) { el.appendChild(h("div", { class: "pgm-empty", text: "Kies een methode." })); return; }
    if (mm.loading) { el.appendChild(h("div", { class: "pgm-empty", text: "Lessen laden…" })); return; }
    if (!mm.lessons.length) { el.appendChild(h("div", { class: "pgm-empty", text: "Geen lessen gevonden voor deze methode." })); return; }

    var rows = buildRows(m);
    if (mstate.search) {
      var q = mstate.search.toLowerCase();
      rows = rows.filter(function (r) { return r.title.toLowerCase().indexOf(q) >= 0; });
    }
    if (mstate.onlyOpen) rows = rows.filter(function (r) { return !r.given; });
    if (mstate.sortKey === "az") rows.sort(function (a, b) { return a.title.localeCompare(b.title, "nl"); });
    else if (mstate.sortKey === "date") rows.sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });

    var table = h("div", { class: "pgm-table" });
    table.appendChild(h("div", { class: "pgm-row pgm-thead" }, [
      h("div", { class: "pgm-c-n", text: "#" }),
      h("div", { class: "pgm-c-les", text: "Les" }),
      h("div", { class: "pgm-c-st", text: "Status" }),
      h("div", { class: "pgm-c-dt", text: "Datum" })
    ]));

    // Blocks and gap markers only mean something in the methode's own order.
    var grouped = mstate.sortKey === "order" && rows.some(function (r) { return r.block; });
    // Group for real: without this the fiche order interleaves thema's, so a header is emitted
    // every time the block changes and one thema ends up split over several places in the list.
    if (grouped) {
      var seq = {}; rows.forEach(function (r, i) { seq[r.id] = i; });   // keep order within a block
      rows.sort(function (a, b) {
        var d = blockRank(a.block) - blockRank(b.block);
        return d !== 0 ? d : (seq[a.id] - seq[b.id]);
      });
    }
    var lastBlock = null, seenGiven = false, pendingGap = [];

    rows.forEach(function (r) {
      if (grouped && r.block !== lastBlock) {
        lastBlock = r.block;
        var inBlk = rows.filter(function (x) { return x.block === r.block; });
        var bd = inBlk.filter(function (x) { return x.given; }).length;
        var pctB = inBlk.length ? Math.round(bd / inBlk.length * 100) : 0;
        table.appendChild(h("div", { class: "pgm-blk" }, [
          h("span", { class: "pgm-bname", text: r.block || "Overige" }),
          h("div", { class: "pgm-bbar" }, [h("i", { style: "width:" + pctB + "%" })]),
          h("span", { class: "pgm-bcount", text: bd + "/" + inBlk.length })
        ]));
        seenGiven = false; pendingGap = [];
      }
      // A run of open lessons sitting between two given ones is a real skip — flag it.
      if (mstate.sortKey === "order" && !mstate.onlyOpen) {
        if (r.given) {
          if (seenGiven && pendingGap.length) {
            var lbl = pendingGap.length === 1
              ? ("les " + pendingGap[0] + " overgeslagen")
              : ("les " + pendingGap[0] + "–" + pendingGap[pendingGap.length - 1] + " overgeslagen");
            table.appendChild(h("div", { class: "pgm-gap", text: lbl }));
          }
          seenGiven = true; pendingGap = [];
        } else if (seenGiven) { pendingGap.push(r.n); }
      }
      table.appendChild(lessonRow(m, r));
    });
    el.appendChild(table);
  }

  // Position of a block in the table. Unknown or block-less lessons sort to the very end
  // ("Overige"), so a fiche that hangs under no thema is visible instead of scattered.
  function blockRank(block) {
    if (!block) return 1e6;
    var i = mm.blockOrder.indexOf(block);
    return i < 0 ? 1e6 - 1 : i;
  }

  function lessonRow(m, r) {
    var st = h("div", { class: "pgm-c-st" }, [
      h("button", {
        class: "pgm-pill " + (r.given ? "given" : "open"),
        title: "Klik: auto → gegeven → open → auto",
        text: r.given ? "gegeven" : "open",
        onclick: function () { cycle(m, r); }
      })
    ]);
    if (r.manual) {
      st.appendChild(h("span", { class: "pgm-hand" }, [
        h("span", { text: "handmatig" }),
        h("button", { title: "Terug naar automatisch", text: "×", onclick: function () { delete m.overrides[r.id]; saveState(); render(); } })
      ]));
    }
    var dt = h("div", { class: "pgm-c-dt" });
    if (r.date) dt.appendChild(h("span", { text: nlDate(r.date) }));
    else if (r.staleDate) dt.appendChild(h("span", { class: "old", title: "Buiten het geselecteerde schooljaar — telt niet als gegeven.", text: "buiten dit jaar: " + nlDate(r.staleDate) }));
    else dt.appendChild(h("span", { class: "none", text: "—" }));

    var row = h("div", { class: "pgm-row" + (r.given ? " given" : "") + (canReorder() ? " drg" : "") }, [
      h("div", { class: "pgm-c-n", text: r.n != null ? String(r.n) : "" }),
      h("div", { class: "pgm-c-les", text: r.title, title: r.title }),
      st, dt
    ]);
    if (canReorder()) wireDrag(row, r);
    return row;
  }

  // auto → gegeven → open → auto
  function cycle(m, r) {
    if (!m.overrides) m.overrides = {};
    if (!r.manual) m.overrides[r.id] = { status: "given", on: todayISO() };
    else if (m.overrides[r.id].status === "given") m.overrides[r.id] = { status: "open", on: null };
    else delete m.overrides[r.id];
    saveState(); render();
  }
  function todayISO() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function renderFoot(m) {
    var el = mm.els.foot; el.innerHTML = "";
    if (!m || !mm.lessons.length) return;
    var open = buildRows(m).filter(function (r) { return !r.given; }).slice(0, 3);
    el.appendChild(h("span", { class: "pgm-lbl", text: "Volgende open:" }));
    var nx = h("span", { class: "pgm-nx" });
    if (open.length) open.forEach(function (r) { nx.appendChild(h("span", { text: mm.numbered ? ("les " + r.n) : r.title })); });
    else nx.appendChild(h("span", { text: "alles gegeven" }));
    el.appendChild(nx);
    el.appendChild(h("span", { class: "pgm-hint", text: "Leest alleen — schrijft nooit naar Questi." }));
  }

  function emptyState() {
    return h("div", { class: "pgm-empty" }, [
      h("div", { text: "Nog geen methode toegevoegd." }),
      h("div", { class: "pgm-empty-sub", text: "Voeg een methode uit Questi toe, of stel er één samen uit je eigen lesfiches." }),
      h("button", { class: "pgm-btn", onclick: openAddMenu, text: "+ methode" })
    ]);
  }

  // ========================================================================
  //  Add / remove a methode
  // ========================================================================
  function openAddMenu() {
    var m = modal("Methode toevoegen", [
      h("div", { class: "pgm-choice", onclick: function () { m.close(); addFromQuesti(); } }, [
        h("div", { class: "pgm-choice-t", text: "Uit Questi" }),
        h("div", { class: "pgm-choice-d", text: "Een methode die je school heeft. Alle lessen worden in één keer opgehaald." })
      ]),
      h("div", { class: "pgm-choice", onclick: function () { m.close(); addFromFiches(); } }, [
        h("div", { class: "pgm-choice-t", text: "Uit eigen lesfiches" }),
        h("div", { class: "pgm-choice-d", text: "Kies zelf welke fiches de methode vormen. Thema's komen uit je subtags." })
      ])
    ]);
  }

  function addFromQuesti() {
    setStatus("Methodes laden…");
    S().fetchMethods().then(function (list) {
      setStatus("");
      if (!list.length) { modal("Geen methodes", [h("div", { class: "pgm-modal-note", text: "Questi geeft geen methodes terug voor deze school." })]); return; }
      var chosen = null, gradeSel = null;
      var listEl = h("div", { class: "pgm-picklist" });
      list.forEach(function (mth) {
        var row = h("div", { class: "pgm-pickrow" }, [
          h("div", { class: "pgm-pickrow-t", text: mth.name || mth.id }),
          h("div", { class: "pgm-pickrow-d", text: ((mth.publisher && mth.publisher.name) || "") + " · " + ((mth.grades || []).join(", ") || "geen leerjaren") })
        ]);
        row.addEventListener("click", function () {
          chosen = mth;
          [].forEach.call(listEl.children, function (c) { c.classList.remove("on"); });
          row.classList.add("on");
          // Cluster methodes span several leerjaren — make the teacher pick one.
          gradeSel.innerHTML = "";
          var gs = (mth.grades && mth.grades.length) ? mth.grades : GRADES;
          gradeSel.appendChild(h("option", { value: "", text: "Alle leerjaren" }));
          gs.forEach(function (g) { gradeSel.appendChild(h("option", { value: g, text: g })); });
          gradeSel.parentNode.style.display = (mth.grades && mth.grades.length > 1) ? "" : "none";
        });
        listEl.appendChild(row);
      });
      gradeSel = h("select", { class: "pgm-field" });
      var gradeWrap = h("div", { class: "pgm-graderow", style: "display:none" }, [
        h("span", { class: "pgm-modal-note", text: "Deze methode loopt over meerdere leerjaren. Welk leerjaar volg je?" }),
        gradeSel
      ]);
      var hint = h("div", { class: "pgm-modal-note" });
      var dlg = modal("Methode uit Questi", [listEl, gradeWrap, hint], [
        h("button", { class: "pgm-btn", text: "Toevoegen", onclick: function () {
          if (!chosen) { hint.textContent = "Kies eerst een methode uit de lijst."; return; }
          var m = {
            id: nextId(), name: chosen.name || chosen.id, source: "questi",
            methodKey: chosen.id, isCluster: !!chosen.is_cluster,
            publisher: (chosen.publisher && chosen.publisher.name) || "",
            grade: gradeSel.value || null, grades: chosen.grades || [],
            color: "#3f7f8f", order: [], overrides: {}
          };
          mstate.methodes.push(m); mstate.activeId = m.id; saveState();
          dlg.close(); render(); loadMethode(m);
        } })
      ]);
    });
  }

  // Own fiches: pick the hoofdtag first (that fixes the thema's), then the fiches themselves.
  function addFromFiches() {
    function withTags(tags) {
      var subject = tags.filter(function (t) { return t.type !== "default"; });
      if (!subject.length) { modal("Geen tags", [h("div", { class: "pgm-modal-note", text: "Geen eigen vaktags gevonden." })]); return; }
      var chosen = null;
      var listEl = h("div", { class: "pgm-picklist" });
      subject.forEach(function (t) {
        var kids = S().childTags(t.id, "self") || [];
        var row = h("div", { class: "pgm-pickrow" }, [
          h("div", { class: "pgm-pickrow-t" }, [h("span", { class: "pgm-vakdot", style: "background:" + (t.color || "#c7ccd1") }), h("span", { text: (t.title || "").trim() })]),
          h("div", { class: "pgm-pickrow-d", text: kids.length ? (kids.length + " thema's") : "geen subtags — alles in één groep" })
        ]);
        row.addEventListener("click", function () {
          chosen = t;
          [].forEach.call(listEl.children, function (c) { c.classList.remove("on"); });
          row.classList.add("on");
        });
        listEl.appendChild(row);
      });
      var nameInp = h("input", { class: "pgm-field", type: "text", placeholder: "Naam van de methode" });
      var hint = h("div", { class: "pgm-modal-note" });
      var dlg = modal("Methode uit eigen lesfiches", [
        h("div", { class: "pgm-modal-note", text: "Kies de hoofdtag (het vak). De subtags eronder worden de thema's." }),
        listEl,
        h("div", { class: "pgm-graderow" }, [h("span", { class: "pgm-modal-note", text: "Naam" }), nameInp]),
        hint
      ], [
        h("button", { class: "pgm-btn", text: "Fiches kiezen →", onclick: function () {
          if (!chosen) { hint.textContent = "Kies eerst een hoofdtag."; return; }
          var m = {
            id: nextId(), name: (nameInp.value || "").trim() || (chosen.title || "").trim(), source: "tag",
            tagId: chosen.id, ownerId: "self", color: chosen.color || "#5b6470",
            order: [], overrides: {}
          };
          mstate.methodes.push(m); mstate.activeId = m.id; saveState();
          dlg.close(); render();
          pickFiches(m, true);
        } })
      ]);
    }
    // fetchOwnTags is cached, so this is a no-op call once the planner has loaded the tree.
    S().fetchOwnTags().then(function (tags) { withTags(S().topTagsForOwner(tags || [], ctx().ownerId)); });
  }

  // Hand off to the Lesfiche-manager in selectiemodus and take the selection back.
  function pickFiches(m, isNew) {
    if (!window.__PG_LESSONS || !window.__PG_LESSONS.openPicker) {
      modal("Niet beschikbaar", [h("div", { class: "pgm-modal-note", text: "De Lesfiche-manager is niet geladen." })]);
      return;
    }
    mm.els.root.classList.remove("pgm-show");
    window.__PG_LESSONS.openPicker({
      title: "Fiches kiezen — " + m.name,
      preselected: (m.order || []).slice(),
      startTagId: m.tagId,
      onDone: function (fiches) {
        m.order = fiches.map(function (f) { return String(f.id); });
        saveState();
        mm.els.root.classList.add("pgm-show");
        document.documentElement.classList.add("pgm-locked");
        loadMethode(m);
      },
      onCancel: function () {
        mm.els.root.classList.add("pgm-show");
        document.documentElement.classList.add("pgm-locked");
        // A brand-new methode with nothing picked is just noise — drop it again.
        if (isNew && !(m.order || []).length) removeMethode(m, true);
        else render();
      }
    });
  }

  function removeMethode(m, silent) {
    function drop() {
      mstate.methodes = mstate.methodes.filter(function (x) { return x.id !== m.id; });
      if (mstate.activeId === m.id) mstate.activeId = mstate.methodes.length ? mstate.methodes[0].id : null;
      saveState(); render(); loadMethode(activeMethode());
    }
    if (silent) { drop(); return; }
    var dlg = modal("Methode verwijderen", [
      h("div", { class: "pgm-modal-note", text: "\"" + m.name + "\" uit de tracker halen? Je lesfiches in Questi blijven ongemoeid — alleen deze voortgangslijst verdwijnt." })
    ], [
      h("button", { class: "pgm-btn danger", text: "Verwijderen", onclick: function () { dlg.close(); drop(); } })
    ]);
  }

  function exportMethode(m) {
    var rows = buildRows(m);
    var head = ["nr", "les", "thema", "status", "datum"];
    var lines = [head.join(";")].concat(rows.map(function (r) {
      return [r.n != null ? r.n : "", csv(r.title), csv(r.block || ""), r.given ? "gegeven" : "open", r.date ? nlDate(r.date) : ""].join(";");
    }));
    download("methodevoortgang-" + String(m.name).replace(/[^\w-]+/g, "_").toLowerCase() + ".csv",
      "﻿" + lines.join("\r\n"), "text/csv;charset=utf-8");
  }
  // A cell starting with = + - @ tab or CR is a formula to Excel/Sheets — a fiche title must stay text.
  function csv(s) { s = String(s == null ? "" : s); if (/^([=@\t\r]|[+\-]\S)/.test(s)) s = "'" + s;   /* + or - followed by a space ("- Les 1") is no formula */ return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  // ========================================================================
  //  Back-up — move the whole tracker between machines (school laptop ↔ home pc)
  //  Only setup travels: which fiches, their order, manual overrides. Titles and
  //  dates are always re-read from Questi, so an import is never stale.
  // ========================================================================
  function backupPayload() {
    return {
      tool: "pg-methodes", format: 1,
      schoolId: ctx().schoolId, ownerId: ctx().ownerId,
      exported_at: new Date().toISOString(),
      count: mstate.methodes.length,
      methodes: mstate.methodes
    };
  }
  function download(name, text, mime) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function openBackupModal() {
    var file = h("input", { type: "file", accept: "application/json,.json", class: "pgm-field" });
    var hint = h("div", { class: "pgm-modal-note" });
    var dlg = modal("Back-up van je methodes", [
      h("div", { class: "pgm-modal-note", text: "Zet je methodes over naar een andere computer. Alleen je eigen instellingen gaan mee (welke fiches, hun volgorde, handmatige aanpassingen) — titels en datums worden daar opnieuw uit Questi gelezen." }),
      h("button", { class: "pgm-btn", text: "Exporteer alles (JSON)", onclick: function () {
        if (!mstate.methodes.length) { hint.textContent = "Er zijn nog geen methodes om te exporteren."; return; }
        download("questi-methodes-backup.json", JSON.stringify(backupPayload(), null, 2), "application/json");
        hint.textContent = mstate.methodes.length + " methode(s) geëxporteerd.";
      } }),
      h("div", { class: "pgm-modal-note", text: "Importeren: kies het JSON-bestand van je andere computer. Je ziet eerst wat er gebeurt." }),
      file, hint
    ], []);
    file.addEventListener("change", function () {
      var f = file.files && file.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var data;
        try { data = JSON.parse(rd.result); } catch (e) { hint.textContent = "Dit is geen geldig JSON-bestand."; return; }
        if (!data || data.tool !== "pg-methodes" || !Array.isArray(data.methodes)) {
          hint.textContent = "Dit bestand komt niet van de methodetracker."; return;
        }
        dlg.close(); confirmImport(data);
      };
      rd.onerror = function () { hint.textContent = "Kon het bestand niet lezen."; };
      rd.readAsText(f);
    });
  }
  // What a methode IS, independent of its local id: the vendor library (+ leerjaar) or the own hoofdtag.
  function methodeIdentity(x) {
    if (!x) return null;
    if (x.source === "questi" && x.methodKey != null) return "q:" + x.methodKey + "|" + (x.grade || "");
    if (x.source === "tag" && x.tagId != null) return "t:" + x.tagId + "|" + (x.ownerId != null ? x.ownerId : "self");
    return null;
  }
  function nameKey(s) { return String(s || "").trim().toLowerCase(); }
  // Local ids (m_1, m_2…) are per machine, so a backup's id says nothing about which local methode
  // it is. Match by source identity first, then by name; each local methode is replaced at most once.
  // → [{ x: imported, match: local methode | null }]
  function planImport(list) {
    var claimed = {};
    function find(test) {
      for (var i = 0; i < mstate.methodes.length; i++) {
        var l = mstate.methodes[i];
        if (!claimed[l.id] && test(l)) { claimed[l.id] = true; return l; }
      }
      return null;
    }
    var plan = list.map(function (x) { return { x: x, match: null }; });
    plan.forEach(function (p) {
      var idt = methodeIdentity(p.x);
      if (idt) p.match = find(function (l) { return methodeIdentity(l) === idt; });
    });
    plan.forEach(function (p) {
      var nk = nameKey(p.x.name);
      if (!p.match && nk) p.match = find(function (l) { return nameKey(l.name) === nk; });
    });
    return plan;
  }
  function confirmImport(data) {
    var plan = planImport(data.methodes.filter(function (x) { return x && typeof x === "object"; }));
    var skipped = data.methodes.length - plan.length;
    var upd = plan.filter(function (p) { return p.match; }).length, add = plan.length - upd;
    var body = [
      h("div", { class: "pgm-modal-note", text: add + " nieuwe methode(s), " + upd + " bestaande worden vervangen." + (skipped ? " " + skipped + " onleesbare regel(s) overgeslagen." : "") })
    ];
    // Fiche ids belong to one school. Importing another school's file would produce a table
    // full of "niet meer gevonden", so flag it rather than let it fail silently later.
    if (data.schoolId != null && ctx().schoolId != null && String(data.schoolId) !== String(ctx().schoolId)) {
      body.push(h("div", { class: "pgm-modal-note", text: "⚠ Dit bestand komt van school " + data.schoolId + ", jij zit op " + ctx().schoolId + ". De lesfiche-ids zullen niet kloppen." }));
    }
    plan.forEach(function (p) {
      var x = p.x;
      body.push(h("div", { class: "pgm-pickrow" }, [
        h("div", { class: "pgm-pickrow-t", text: (x.name || x.id || "(zonder naam)") + " · " + (p.match ? "vervangt " + (p.match.name || p.match.id) : "nieuw") }),
        h("div", { class: "pgm-pickrow-d", text: (x.source === "questi" ? "Questi-methode" : "eigen lesfiches") + " · " + (Array.isArray(x.order) ? x.order.length : 0) + " lessen" })
      ]));
    });
    var dlg = modal("Importeren bevestigen", body, [
      h("button", { class: "pgm-btn", text: "Importeren", onclick: function () {
        applyImportPlan(plan);
        saveState(); dlg.close(); render();
        S().fetchOwnTags().then(function () { return loadMethode(activeMethode()); });
      } })
    ]);
  }
  // Apply planImport's result to mstate (no save, no render).
  function applyImportPlan(plan) {
    var list = mstate.methodes.slice(), used = {};
    list.forEach(function (l) { used[String(l.id)] = true; });
    plan.forEach(function (p) {
      var x = {}; for (var k in p.x) if (Object.prototype.hasOwnProperty.call(p.x, k)) x[k] = p.x[k];
      if (p.match) {
        // Replaced in place: keeps the local id (activeId and chip position follow).
        x.id = p.match.id;
        list[list.indexOf(p.match)] = x;
      } else {
        // New here: keep the file's id only when nothing local uses it yet.
        if (x.id == null || used[String(x.id)]) x.id = nextId(list);
        used[String(x.id)] = true;
        list.push(x);
      }
    });
    mstate.methodes = list;
    if (!mstate.activeId || !activeMethode()) mstate.activeId = mstate.methodes.length ? mstate.methodes[0].id : null;
  }

  // ========================================================================
  //  Modal plumbing (mirrors the Lesfiche-manager's)
  // ========================================================================
  function modal(titleText, bodyEls, footerEls) {
    var back = h("div", { class: "pgm-modal-back" });
    function close() { back.remove(); }
    var box = h("div", { class: "pgm-modal" }, [
      h("div", { class: "pgm-modal-hd" }, [h("div", { class: "pgm-modal-t", text: titleText }), h("button", { class: "pgm-x", onclick: close, text: "✕" })]),
      h("div", { class: "pgm-modal-bd" }, bodyEls || []),
      h("div", { class: "pgm-modal-ft" }, (footerEls || []).concat([h("button", { class: "pgm-btn ghost", onclick: close, text: "Sluiten" })]))
    ]);
    back.appendChild(box);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    (mm.els.root || document.body).appendChild(back);
    back.close = close; box.close = close;
    return back;
  }

  // ---------- Export ----------
  window.__PG_METHODES = { open: open, close: close };
  // Internals for the offline checks only; never set in the extension.
  if (window.__PG_TEST_HOOKS) window.__PG_METHODES_TEST = { mstate: mstate, planImport: planImport, applyImportPlan: applyImportPlan, followNewVersions: followNewVersions };
})();
