/* Questi Week Planner — lessons.js
 * Lesfiche-manager: a separate, write-heavy module for browsing and bulk-managing
 * the teacher's own fiche library (overview · tag filter · rename/edit · mass-edit
 * tags · bulk delete). Isolated from the planner: own overlay (#qwl-overlay) + own
 * storage key. Reuses the planner's ctx + helpers via window.__QWP_SHARED.
 *
 * Two hosts for the same manager state (`mgr`):
 *  - MOUNTED (normal use): the planner's "Lesfiches" tab calls mount(sideEl, mainEl) — a tag tree
 *    in the planner's sidebar, a header + table + side-sheet editor in its main column. Staged
 *    edits are written through the planner's ONE shared Controleer (pendingSummary / writeTags /
 *    writeFiches below), never from here.
 *  - STANDALONE overlay (#qwl-overlay): header(title · search · ✕) / main[ left sidebar (actions) |
 *    content( top tag bar + fiche list) ]. Used by openPicker (Methodevoortgang, read-only) and by
 *    a direct open(); it keeps its own "Wijzigingen controleren" gate.
 *  While the standalone overlay is up over a mounted manager, the mounted list state is stashed
 *  and restored afterwards (enterStandalone / leaveStandalone).
 *
 * SAFETY: title/text/tag edits are STAGED locally and written only via the single
 * "Wijzigingen controleren" gate. Fiche edits use REPLACE semantics on tags[] (echo
 * current set) and OMIT selected_goals on the goals field, so tags/goals are never
 * silently wiped. Every edit mints a NEW fiche id — we re-read result.id after. */
(function () {
  "use strict";
  if (window.__QWP_LESSONS_LOADED) return;
  window.__QWP_LESSONS_LOADED = true;

  // ---------- Shared bridge ----------
  function S() { return window.__QWP_SHARED; }
  function ctx() { return S().ctx; }
  function api() { return S().API; }               // "/api/cal"
  function sid() { return ctx().schoolId; }
  function h() { return S().h.apply(null, arguments); }
  function qs(o) { return S().qs(o); }
  function jget(u) { return S().jget(u); }

  function allOwnTagId() { return ctx().ownDefaultTagId != null ? ctx().ownDefaultTagId : 5; }
  // Questi filters by tag with TWO params: default-bucket tags (Alle/zonder tag/samenwerk) use
  // default_tagId; a real category (type "user") uses user_tagId. default_tagId on a user tag 400s.
  function lessonsUrl(tagId, num, offset) {
    var t = ownTagById(tagId);
    var isDefault = (t && t.type === "default") || String(tagId) === String(allOwnTagId());
    var p = { schoolId: sid(), sorting: "new_items", status: "active", num: num, offset: offset };
    if (isDefault) p.default_tagId = tagId; else p.user_tagId = tagId;
    return api() + "/lessons?" + qs(p);
  }

  // ---------- Storage ----------
  var STORE_KEY = "qwp_lessons_v1";
  var lstate = { lastTagId: null, pageSize: 100, cols: 1, sortKey: null, sortDir: "asc" };
  function loadState() {
    return new Promise(function (res) {
      try {
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get([STORE_KEY], function (o) { if (o && o[STORE_KEY]) Object.assign(lstate, o[STORE_KEY]); res(); });
          return;
        }
      } catch (e) { /* fall through */ }
      try { var raw = localStorage.getItem(STORE_KEY); if (raw) Object.assign(lstate, JSON.parse(raw)); } catch (e2) {}
      res();
    });
  }
  function saveState() {
    try { if (chrome && chrome.storage && chrome.storage.local) { chrome.storage.local.set({ ["" + STORE_KEY]: lstate }); return; } } catch (e) {}
    try { localStorage.setItem(STORE_KEY, JSON.stringify(lstate)); } catch (e2) {}
  }

  // ---------- Runtime state ----------
  var mgr = {
    built: false, els: {},
    elsStandalone: null,        // the #qwl-overlay host (pick mode / direct open)
    elsMounted: null,           // the planner-tab host (mount)
    mountOpts: null,            // { onClose }
    stash: null,                // mounted list state, kept while the standalone overlay is up
    sheetToken: 0,              // guards the side sheet against a late read of a previous fiche
    pendingTags: [],            // [{ key, title, color, parent }] — tags to CREATE, written by the shared Controleer
    ownTags: [], fiches: [], filtered: [],
    selected: {},              // ficheId -> true
    pending: {},               // ficheId -> { fiche, edit, subject?, text?{}, tags?[], createTags?[], changes[] }
    tagFilter: null, unionParent: null, expandedTop: null,
    search: "", gradeFilter: "", tagChips: {},   // ficheId -> [tagId,…]
    cols: 1, sortKey: null, sortDir: "asc",
    loading: false,
    dirtyWrites: false,         // any live write this session → reload Questi on close (like planner)
    importEnabled: false,       // import stays gated until the OPSTAP resolver lands (August)
    // Pick mode: the Methodes panel borrows this overlay to let the teacher pick the fiches that
    // make up a methode. Read-only — every write affordance is hidden while it is set.
    pick: null,                 // { title, onDone, onCancel }
    pickStore: {},              // ficheId -> fiche, so a selection survives switching tags
    // Goals mode: the list as a WEET/KEN/KAN sheet (see makeGoalsTable).
    goalsMode: false,
    goalLoading: {},            // ficheId -> true while its read is in flight
    rowFill: {}                 // ficheId -> refreshes that row (goals/tag chips) once its fiche info arrives
  };
  var GRADES = ["K0", "K1", "K2", "K3", "L1", "L2", "L3", "L4", "L5", "L6", "NLG"];

  // ---------- Write helpers ----------
  function resolveJson(kind, id, sent) {
    return function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (r.ok && !(j && j.status === "error")) return (j && j.result !== undefined) ? j.result : j;
        var msg = (j && (j.error_msg || j.message)) || ("HTTP " + r.status);
        console.error("[QWL] " + kind + " " + id + " faalde:", msg, sent ? ("| sent: " + JSON.stringify(sent)) : "");
        if (S() && S().noteApiError) S().noteApiError(kind, id, r.status, msg);   // Zelftest .json report
        throw new Error(msg);
      });
    };
  }
  // Every edit view read here also teaches the planner which fiche id is the newest of its thread.
  function readFicheEdit(id) {
    return jget(api() + "/lessons/" + id + "?" + qs({ schoolId: sid(), return_format: "edit" })).then(function (j) {
      var r = (j && j.result) || j;
      if (S().noteFicheThread) S().noteFicheThread(r);
      return r;
    });
  }
  // Key for a text field in opts.text / the edit dialog. Template fields use their template_field_id;
  // per-fiche extra fields have none (null), so they key on their own id — keying them all on
  // "null" would write one field's text into every extra field.
  function fieldKey(f) { return f.template_field_id != null ? String(f.template_field_id) : "x" + f.id; }
  var GOAL_KINDS = ["weet", "ken", "kan"];
  // Build a PATCH body that changes ONLY what opts specifies and preserves the rest.
  // opts.goals = { weet?, ken?, kan? }: plain text for the WEET/KEN/KAN extra fields — updates an
  // existing field, or appends a new one when the text is non-empty.
  function buildPatch(ficheId, edit, opts) {
    opts = opts || {};
    var tags = opts.tags != null ? opts.tags : (edit.tags || []).map(function (t) { return t.id; });
    var goals = opts.goals || {}, goalFields = S().ficheGoalFields(edit), maxOrder = 0;
    var fields = (edit.fields || []).map(function (f) {
      if (typeof f.order === "number" && f.order > maxOrder) maxOrder = f.order;
      var key = fieldKey(f);
      var has = opts.text && Object.prototype.hasOwnProperty.call(opts.text, key);
      var content = has ? opts.text[key] : (f.content != null ? f.content : "");
      GOAL_KINDS.forEach(function (k) { if (goalFields[k] === f && Object.prototype.hasOwnProperty.call(goals, k)) content = goals[k]; });
      // Extra field: exactly what Questi's own editor sends — { id, content }, no template_field_id.
      if (f.template_field_id == null) return f.type === "text" ? { id: f.id, content: content } : { id: f.id };
      var item = { template_field_id: f.template_field_id, id: f.id };
      if (f.type === "text") item.content = content;
      return item; // goals/methods: id + template_field_id only ⇒ unchanged
    });
    GOAL_KINDS.forEach(function (k) {
      if (goalFields[k] || !goals[k]) return;
      fields.push({ field_type: "text", title: k.toUpperCase(), description: "", order: ++maxOrder, content: goals[k] });
    });
    (opts.newFields || []).forEach(function (nf) {
      fields.push({ field_type: "text", title: nf.title, description: "", order: ++maxOrder, content: nf.content || "" });
    });
    var body = {
      lessonId: ficheId, subject: opts.subject != null ? opts.subject : edit.subject,
      schoolId: sid(), attachments: [], tags: tags, create_tags: opts.create_tags || [], fields: fields
    };
    // Proef: same keys as the create call; writePending verifies them by reading the new version back.
    if (opts.grades) body.grades = opts.grades;
    if (opts.visibility) body.visibility = opts.visibility;
    return body;
  }
  function writePatch(ficheId, body) {
    return fetch(api() + "/lessons/" + ficheId + "?return_format=short",
      { method: "PATCH", credentials: "include", headers: S().writeHeaders(), body: JSON.stringify(body) })
      .then(resolveJson("PATCH lesson", ficheId, body)); // → result (has NEW id)
  }
  // Bodyless DELETE: NO Content-Type — Questi 500s on application/json with an empty body
  // (the captured delete omits content-type). Only Accept + x-xsrf-token.
  function bodylessHeaders() { var hd = { "Accept": "application/json" }; var t = S().xsrfToken(); if (t) hd["x-xsrf-token"] = t; return hd; }
  function deleteFiches(ids) {
    return fetch(api() + "/lessons?" + qs({ schoolId: sid(), lessons: ids }),
      { method: "DELETE", credentials: "include", headers: bodylessHeaders() })
      .then(resolveJson("DELETE lessons", ids.join(","), null));
  }
  // ---------- Tag-catalog CRUD (standalone tags, not fiche membership) ----------
  // Create a user tag. body: { title, color, schoolId, [parent] }. → new tag object.
  function createUserTag(body) {
    return fetch(api() + "/lessons/user-tags",
      { method: "POST", credentials: "include", headers: S().writeHeaders(), body: JSON.stringify(body) })
      .then(resolveJson("POST user-tag", body.title, body));
  }
  // Delete a user tag. action "unlink" (fiches keep, lose this tag) or "move" (re-tag fiches to
  // secondTagId, then delete). Bodyless DELETE — same header shape as deleteFiches.
  function deleteUserTag(id, action, secondTagId) {
    var p = { schoolId: sid(), action: action };
    if (action === "move") p.secondTagId = secondTagId;
    return fetch(api() + "/lessons/user-tags/" + id + "?" + qs(p),
      { method: "DELETE", credentials: "include", headers: bodylessHeaders() })
      .then(resolveJson("DELETE user-tag", id, null));
  }

  // ---------- Small data helpers ----------
  function ownTagById(id) { for (var i = 0; i < mgr.ownTags.length; i++) if (String(mgr.ownTags[i].id) === String(id)) return mgr.ownTags[i]; return null; }
  function tagName(id) { var t = ownTagById(id); return t ? (t.title || "").trim() : ("#" + id); }
  function tagHex(id) { var t = ownTagById(id); return (t && t.color) || "#c7ccd1"; }
  function ficheName(f) { return (f && f.subject) || "(zonder titel)"; }
  function gradesOf(f) { return (f && f.grades && f.grades.length) ? f.grades.join(", ") : "—"; }
  function usedOf(f) { var d = f && f.last_used_date; if (!d) return "nooit"; return String(d).slice(0, 10); }
  function selCount() { return Object.keys(mgr.selected).length; }
  function selectedIds() { return Object.keys(mgr.selected); }
  function pendCount() { return Object.keys(mgr.pending).length; }
  function fiskById(id) { for (var i = 0; i < mgr.fiches.length; i++) if (String(mgr.fiches[i].id) === String(id)) return mgr.fiches[i]; return null; }

  function runSequential(items, fn, onProgress) {
    var i = 0, fails = [];
    return new Promise(function (resolve) {
      function next() {
        if (i >= items.length) { resolve(fails); return; }
        var it = items[i], idx = i; i++;
        Promise.resolve().then(function () { return fn(it, idx); })
          .catch(function (e) { fails.push({ item: it, error: (e && e.message) || String(e) }); })
          .then(function () { if (onProgress) onProgress(idx + 1, items.length); setTimeout(next, 150); });
      }
      next();
    });
  }

  // ========================================================================
  //  Hosts — standalone overlay (pick mode / direct open) and the mounted planner tab.
  //  Both hosts use the same element ids, so every lookup goes through E(), which only
  //  searches the ACTIVE host (mgr.els.scopes) — never the whole document.
  // ========================================================================
  function E(id) {
    var sc = (mgr.els && mgr.els.scopes) || [];
    for (var i = 0; i < sc.length; i++) { var e = sc[i] && sc[i].querySelector("#" + id); if (e) return e; }
    return null;
  }
  function isMounted() { return !!(mgr.elsMounted && mgr.els === mgr.elsMounted); }
  function searchInput() {
    return h("input", { class: "qwl-search", id: "qwl-search", type: "text", placeholder: "Zoek in titels…", oninput: function (e) { mgr.search = e.target.value || ""; applyFilter(); } });
  }
  function gradeSelect() {
    return h("select", { class: "qwl-gradesel", id: "qwl-gradesel", onchange: function (e) { mgr.gradeFilter = e.target.value || ""; applyFilter(); } },
      [h("option", { value: "", text: "Alle leerjaren" })].concat(GRADES.map(function (g) { return h("option", { value: g, text: g }); })));
  }
  function build() {
    if (mgr.built) return;
    var search = searchInput(), gradeSel = gradeSelect();
    var header = h("div", { class: "qwl-header" }, [
      h("div", { class: "qwl-title", id: "qwl-title", text: "Lesfiches beheren" }),
      S().betaPill ? S().betaPill() : null,
      search, gradeSel,
      h("span", { class: "qwl-status", id: "qwl-status", text: "" }),
      h("span", { class: "qwl-hspacer" }),
      h("button", { class: "qwl-x", onclick: close, title: "Sluiten", text: "✕" })
    ]);
    var side = h("div", { class: "qwl-side", id: "qwl-side" }, [
      h("div", { class: "qwl-side-lbl", text: "Selectie" }),
      h("button", { class: "qwl-sbtn", id: "qwl-selall", onclick: toggleSelectAll, text: "Alles selecteren" }),
      // Pick mode only — confirm/cancel the selection back to whoever opened the picker.
      h("button", { class: "qwl-sbtn qwl-pickok", id: "qwl-pickok", onclick: pickConfirm, text: "Selectie gebruiken" }),
      h("button", { class: "qwl-sbtn", id: "qwl-pickcancel", onclick: pickCancel, text: "Annuleer" }),
      h("button", { class: "qwl-sbtn", id: "qwl-tags", onclick: openTagsModal, text: "Tags bewerken" }),
      h("button", { class: "qwl-sbtn qwl-danger", id: "qwl-del", onclick: openDeleteModal, text: "Verwijderen" }),
      h("div", { class: "qwl-side-sep", id: "qwl-sep1" }),
      h("div", { class: "qwl-side-lbl", text: "Weergave" }),
      h("button", { class: "qwl-sbtn", id: "qwl-cols", onclick: toggleCols, text: "" }),
      h("button", { class: "qwl-sbtn", id: "qwl-goalsmode", onclick: toggleGoalsMode, title: "WEET / KEN / KAN per fiche invullen — wordt in de lesfiche zelf bewaard", text: "Lesdoelen invullen" }),
      h("button", { class: "qwl-sbtn", id: "qwl-goalsimport", onclick: importLocalGoals, title: "Doelen die je eerder in het afdrukvoorbeeld typte (alleen in deze browser) in de fiches zetten", text: "Lokale doelen overnemen" }),
      h("button", { class: "qwl-sbtn", onclick: reload, text: "Vernieuwen" }),
      h("button", { class: "qwl-sbtn qwl-import", id: "qwl-import", onclick: function () { if (mgr.importEnabled) openImportView(); }, title: "Binnenkort — OPSTAP volgt", disabled: mgr.importEnabled ? null : "true", text: "Importeren" }),
      h("div", { class: "qwl-side-sep", id: "qwl-sep2" }),
      h("div", { class: "qwl-side-lbl", id: "qwl-taglbl", text: "Tags beheren" }),
      h("button", { class: "qwl-sbtn", id: "qwl-tagadd", onclick: openAddTagModal, text: "Tag toevoegen" }),
      h("button", { class: "qwl-sbtn qwl-danger", id: "qwl-tagdel", onclick: openRemoveTagModal, text: "Tag verwijderen" }),
      h("div", { class: "qwl-side-grow" }),
      h("button", { class: "qwl-sbtn qwl-review", id: "qwl-review", onclick: openReviewEdits, text: "Wijzigingen controleren" }),
      h("button", { class: "qwl-sbtn qwl-muted", onclick: openDiag, title: "Zelftest — leest alleen", text: "Diagnose" })
    ]);
    var tagbar = h("div", { class: "qwl-tagbar", id: "qwl-tagbar" });
    var listWrap = h("div", { class: "qwl-listwrap", id: "qwl-listwrap" });
    var content = h("div", { class: "qwl-content" }, [tagbar, h("div", { class: "qwl-count", id: "qwl-count", text: "" }), listWrap]);
    var main = h("div", { class: "qwl-main" }, [side, content]);
    var page = h("div", { class: "qwl-page" }, [header, main]);
    var overlay = h("div", { class: "qwl-overlay", id: "qwl-overlay" }, [page]);
    document.body.appendChild(overlay);
    mgr.elsStandalone = { root: overlay, page: page, tagbar: tagbar, list: listWrap, scopes: [overlay] };
    if (!mgr.els || !mgr.els.root) mgr.els = mgr.elsStandalone;
    mgr.built = true;
  }

  // Mounted host: the planner's Lesfiches tab (Lesfiches.dc.html). Sidebar = tag tree with
  // "+ Tag"; main = header (tag · count · search · leerjaar · Lijst|Doelen invullen), a selection
  // bar, the table, and a side sheet with the full fiche editor. No review button of its own —
  // the planner's Controleer covers fiche edits and tags to create.
  function buildMounted(sideHost, mainHost) {
    var tree = h("div", { class: "qwl-tree", id: "qwl-tree", role: "tree", "aria-label": "Tags" });
    var side = h("div", { class: "qwl-mounted qwl-mside" }, [
      h("div", { class: "qwl-mside-hd" }, [
        h("span", { class: "qwl-mside-t", text: "Tags" }),
        h("span", { class: "qwl-hspacer" }),
        h("button", { class: "qwl-mbtn", onclick: openAddTagModal, title: "Nieuwe tag klaarzetten — wordt aangemaakt bij Controleer", text: "+ Tag" }),
        h("button", { class: "qwl-mbtn qwl-mbtn-danger", onclick: openRemoveTagModal, title: "Een tag verwijderen (vraagt bevestiging)", text: "− Tag" })
      ]),
      tree
    ]);
    var seg = h("div", { class: "qwl-seg", id: "qwl-modeseg", role: "group", "aria-label": "Weergave" }, [
      h("button", { "data-m": "list", onclick: function () { if (mgr.goalsMode) toggleGoalsMode(); }, text: "Lijst" }),
      h("button", { "data-m": "goals", onclick: function () { if (!mgr.goalsMode) toggleGoalsMode(); }, title: "WEET / KEN / KAN per fiche invullen — wordt in de lesfiche zelf bewaard", text: "Doelen invullen" })
    ]);
    var header = h("header", { class: "qwl-mhdr" }, [
      h("div", { class: "qwl-mtitle" }, [h("span", { id: "qwl-title", text: "Lesfiches" }), h("span", { class: "qwl-msub", id: "qwl-count", text: "" })]),
      h("span", { class: "qwl-status", id: "qwl-status", text: "" }),
      h("span", { class: "qwl-hspacer" }),
      searchInput(), gradeSelect(), seg,
      h("button", { class: "qwl-mbtn", id: "qwl-cols", onclick: toggleCols, text: "" }),
      h("button", { class: "qwl-mbtn", onclick: reload, title: "Deze tag opnieuw uit Questi laden", text: "Vernieuwen" }),
      h("button", { class: "qwl-mbtn qwl-mbtn-muted", onclick: openDiag, title: "Zelftest — leest alleen", text: "Diagnose" }),
      h("button", { class: "qwl-x", onclick: closeMounted, title: "Sluiten", text: "✕" })
    ]);
    var selbar = h("div", { class: "qwl-selbar" }, [
      h("span", { class: "qwl-selcount", id: "qwl-selcount", text: "0 geselecteerd" }),
      h("button", { class: "qwl-mbtn", id: "qwl-selall", onclick: toggleSelectAll, text: "Alles selecteren" }),
      h("button", { class: "qwl-mbtn", id: "qwl-tags", onclick: openTagsModal, text: "Tags bewerken" }),
      h("button", { class: "qwl-mbtn qwl-mbtn-danger", id: "qwl-del", onclick: openDeleteModal, text: "Verwijderen" }),
      h("button", { class: "qwl-mbtn", id: "qwl-goalsimport", onclick: importLocalGoals, title: "Doelen die je eerder in het afdrukvoorbeeld typte (alleen in deze browser) in de fiches zetten", text: "Lokale doelen overnemen" }),
      h("span", { class: "qwl-hspacer" }),
      h("span", { class: "qwl-mnote", text: "Klaargezet wordt pas weggeschreven via Controleer." })
    ]);
    var listWrap = h("div", { class: "qwl-listwrap", id: "qwl-listwrap" });
    var sheet = h("aside", { class: "qwl-sheet", id: "qwl-sheet", "aria-label": "Fiche bewerken", style: "display:none" });
    var main = h("div", { class: "qwl-mounted qwl-mmain" }, [header, selbar, h("div", { class: "qwl-mbody" }, [listWrap, sheet])]);
    sideHost.appendChild(side); mainHost.appendChild(main);
    mgr.elsMounted = { root: main, side: side, page: main, tree: tree, list: listWrap, sheet: sheet, scopes: [main, side] };
  }

  function setStatus(t) { var s = E("qwl-status"); if (s) s.textContent = t || ""; }
  function show() { mgr.els.root.classList.add("qwl-show"); document.documentElement.classList.add("qwl-locked"); }

  // Load lstate and either the tags or the list the active host should show.
  function startHost() {
    return loadState().then(function () {
      mgr.cols = lstate.cols || 1; mgr.sortKey = lstate.sortKey || null; mgr.sortDir = lstate.sortDir || "asc";
      // A picker always opens on its own tag — including on a warm manager, which would
      // otherwise keep showing whatever tag was last browsed.
      if (mgr.pick && mgr.pick.startTagId != null) {
        var startPick = mgr.pick.startTagId;
        var go = function () { renderTagBar(); return loadListUnion(startPick); };
        return mgr.ownTags.length ? go() : S().fetchOwnTags().then(function (tags) { mgr.ownTags = tags || []; return go(); });
      }
      if (mgr.ownTags.length && mgr.fiches.length) { renderTagBar(); applyFilter(); return; }
      setStatus("Tags laden…");
      return S().fetchOwnTags().then(function (tags) {
        mgr.ownTags = tags || [];
        renderTagBar();
        var startTag = lstate.lastTagId != null ? lstate.lastTagId : allOwnTagId();
        if (mgr.tagFilter != null) startTag = mgr.tagFilter;
        return (mgr.unionParent != null ? loadListUnion(mgr.unionParent) : loadList(startTag));
      });
    });
  }
  // The standalone overlay borrows mgr: keep the mounted tab's list, selection and mode aside.
  function enterStandalone() {
    build();
    if (isMounted() && !mgr.stash) {
      closeSheet();
      mgr.stash = { tagFilter: mgr.tagFilter, unionParent: mgr.unionParent, expandedTop: mgr.expandedTop, fiches: mgr.fiches,
        filtered: mgr.filtered, selected: mgr.selected, goalsMode: mgr.goalsMode, search: mgr.search, gradeFilter: mgr.gradeFilter, lastTagId: lstate.lastTagId };
      mgr.selected = {}; mgr.fiches = []; mgr.filtered = []; mgr.search = ""; mgr.gradeFilter = "";
    }
    mgr.els = mgr.elsStandalone;
    var si = E("qwl-search"); if (si) si.value = mgr.search || "";
    var gs = E("qwl-gradesel"); if (gs) gs.value = mgr.gradeFilter || "";
  }
  function leaveStandalone() {
    if (!mgr.stash || !mgr.elsMounted) return;
    var st = mgr.stash; mgr.stash = null;
    mgr.tagFilter = st.tagFilter; mgr.unionParent = st.unionParent; mgr.expandedTop = st.expandedTop; mgr.fiches = st.fiches;
    mgr.filtered = st.filtered; mgr.selected = st.selected; mgr.goalsMode = st.goalsMode; mgr.search = st.search; mgr.gradeFilter = st.gradeFilter;
    lstate.lastTagId = st.lastTagId; saveState();
    mgr.els = mgr.elsMounted;
    renderTagBar(); applyFilter();
  }

  function open() {
    if (!window.__QWP_SHARED) { console.warn("[QWL] __QWP_SHARED ontbreekt — planner niet geladen."); return; }
    enterStandalone(); show(); applyPickMode();
    startHost();
  }
  function close() {
    if (mgr.pick) { pickCancel(); return; }
    if (mgr.elsStandalone) mgr.elsStandalone.root.classList.remove("qwl-show");
    var planner = document.getElementById("qwp-overlay");
    if (!(planner && planner.classList.contains("qwp-show"))) document.documentElement.classList.remove("qwl-locked");
    // Mirror the planner: if we wrote anything (tags/fiches), reload so Questi's SPA reflects it.
    if (mgr.dirtyWrites) { try { location.reload(); } catch (e) {} return; }
    leaveStandalone();
  }

  // ---- Mounted host API (the planner's Lesfiches tab) ----
  // mount(sideEl, mainEl, { onClose }) builds into the planner's sidebar slot + main column once,
  // then just re-shows. The planner hides/shows the hosts on tab switches; unmount() only stops
  // background work (the goal-read queue checks hostVisible() itself, too).
  function mount(sideHost, mainHost, opts) {
    if (!window.__QWP_SHARED) { console.warn("[QWL] __QWP_SHARED ontbreekt — planner niet geladen."); return; }
    if (!sideHost || !mainHost) return;
    mgr.mountOpts = opts || {};
    if (!mgr.elsMounted || !mgr.elsMounted.root.isConnected) buildMounted(sideHost, mainHost);
    // A standalone picker that is still up keeps mgr until it closes (leaveStandalone restores).
    if (mgr.stash || mgr.pick) return;
    mgr.els = mgr.elsMounted;
    startHost();
  }
  function unmount() {
    closeSheet();
    if (_goalObserver) _goalObserver.disconnect();
    _goalQueue = [];
  }
  // ✕ in the mounted header: the planner closes. Live tag/fiche deletes need Questi's own page to
  // refetch, exactly like the standalone close.
  function closeMounted() {
    if (mgr.dirtyWrites) { try { location.reload(); } catch (e) {} return; }
    if (mgr.mountOpts && mgr.mountOpts.onClose) mgr.mountOpts.onClose();
  }

  // ========================================================================
  //  Pick mode — the Methodes panel borrows this overlay to select fiches.
  //  Strictly read-only: every write affordance is hidden while mgr.pick is set,
  //  so a picker can never delete a fiche or stage a tag change by accident.
  //  Staged edits (mgr.pending) are NOT touched — they belong to the shared Controleer.
  // ========================================================================
  // opts: { title, preselected:[ficheId…], startTagId?, onDone(fiches), onCancel? }
  function openPicker(opts) {
    if (!window.__QWP_SHARED) { console.warn("[QWL] __QWP_SHARED ontbreekt — planner niet geladen."); return; }
    enterStandalone();
    mgr.pick = opts || {};
    mgr.selected = {}; mgr.pickStore = {};
    (mgr.pick.preselected || []).forEach(function (id) { mgr.selected[String(id)] = true; });
    if (mgr.pick.startTagId != null) lstate.lastTagId = mgr.pick.startTagId;
    show(); applyPickMode();
    startHost();
  }
  function applyPickMode() {
    var on = !!mgr.pick;
    var t = E("qwl-title");
    if (t) t.textContent = on ? (mgr.pick.title || "Fiches kiezen") : "Lesfiches beheren";
    // Hide everything that writes, plus the now-meaningless separators/labels.
    if (on) mgr.goalsMode = false;
    ["qwl-tags", "qwl-del", "qwl-import", "qwl-review", "qwl-tagadd", "qwl-tagdel", "qwl-taglbl", "qwl-sep2", "qwl-goalsmode", "qwl-goalsimport"]
      .forEach(function (id) { var e = E(id); if (e) e.style.display = on ? "none" : ""; });
    ["qwl-pickok", "qwl-pickcancel"].forEach(function (id) { var e = E(id); if (e) e.style.display = on ? "" : "none"; });
  }
  // Keep the full fiche object for anything ticked, so switching tags never loses a selection.
  function rememberPicked(f) { if (mgr.selected[f.id]) mgr.pickStore[String(f.id)] = f; else delete mgr.pickStore[String(f.id)]; }
  function pickConfirm() {
    var p = mgr.pick; if (!p) return;
    var picked = Object.keys(mgr.selected).map(function (id) { return mgr.pickStore[id] || fiskById(id); }).filter(Boolean);
    endPick();
    if (p.onDone) p.onDone(picked);
  }
  function pickCancel() {
    var p = mgr.pick; if (!p) return;
    endPick();
    if (p.onCancel) p.onCancel();
  }
  function endPick() {
    mgr.pick = null; mgr.selected = {}; mgr.pickStore = {};
    applyPickMode();
    if (mgr.elsStandalone) mgr.elsStandalone.root.classList.remove("qwl-show");
    var planner = document.getElementById("qwp-overlay");
    if (!(planner && planner.classList.contains("qwp-show"))) document.documentElement.classList.remove("qwl-locked");
    leaveStandalone();
  }
  function reload() { if (mgr.unionParent != null) loadListUnion(mgr.unionParent); else loadList(mgr.tagFilter != null ? mgr.tagFilter : allOwnTagId()); }
  function toggleCols() { mgr.cols = (mgr.cols === 2 ? 1 : 2); lstate.cols = mgr.cols; saveState(); renderList(); }

  // ========================================================================
  //  Top tag bar (tops + subtags of the expanded/active top)
  // ========================================================================
  function chipEl(label, color, active, onclick, num) {
    return h("button", { class: "qwl-tagchip" + (active ? " active" : ""), onclick: onclick }, [
      color ? h("span", { class: "qwl-dot", style: "background:" + color }) : null,
      h("span", { text: label }),
      (typeof num === "number" && num > 0) ? h("span", { class: "qwl-tagnum", text: String(num) }) : null
    ]);
  }
  function isSubjectTop(t) { return !(t.type === "default" || /alle.*lesfiches/i.test(t.title || "")); }
  function renderTagBar() {
    if (mgr.els.tree) { renderTagTree(); return; }
    var bar = mgr.els.tagbar; if (!bar) return; bar.innerHTML = "";
    var tops = S().topTagsForOwner(mgr.ownTags, ctx().ownerId);
    var row1 = h("div", { class: "qwl-tagrow" });
    tops.forEach(function (t) {
      var subj = isSubjectTop(t);
      var active = String(mgr.tagFilter) === String(t.id);
      // No count on chips: Questi's per-tag number_of_lessons is a stale server cache (counts
      // deleted fiches). The accurate "N fiches" line below the search is the source of truth.
      row1.appendChild(chipEl((t.title || "").trim(), (t.color || "#c7ccd1"), active,
        subj ? function () { loadListUnion(t.id); } : function () { mgr.expandedTop = null; loadList(t.id); }));
    });
    // "Zonder tag" (default tag id 1) — untagged / old-year triage.
    var zt = ownTagById(1) || { id: 1, title: "Zonder tag", color: "#c7ccd1" };
    row1.appendChild(chipEl((zt.title || "Zonder tag").trim(), "#c7ccd1", String(mgr.tagFilter) === "1", function () { mgr.expandedTop = null; loadList(1); }));
    bar.appendChild(row1);
    // Subtag row for the expanded subject: "Alle [vak]" union chip + each subtag.
    if (mgr.expandedTop != null) {
      var parent = ownTagById(mgr.expandedTop);
      var kids = mgr.ownTags.filter(function (k) { return String(k.parent) === String(mgr.expandedTop); })
        .sort(function (a, b) { return (a.title || "").localeCompare((b.title || ""), undefined, { numeric: true }); });
      if (parent) {
        var row2 = h("div", { class: "qwl-tagrow qwl-subrow" });
        row2.appendChild(chipEl("Alle " + (parent.title || "").trim(), (parent.color || "#c7ccd1"), String(mgr.unionParent) === String(parent.id), function () { loadListUnion(parent.id); }));
        kids.forEach(function (k) {
          row2.appendChild(chipEl((k.title || "").trim(), (k.color || "#c7ccd1"), (String(mgr.tagFilter) === String(k.id) && mgr.unionParent == null), function () { loadList(k.id); }));
        });
        bar.appendChild(row2);
      }
    }
  }
  // Mounted host: the same choices as a tree in the planner's sidebar. Buckets (Alle eigen
  // lesfiches, Zonder tag) first, then each vak; the active vak unfolds its subtags. Tags staged
  // for creation show greyed with "nieuw" — they exist only after Controleer.
  function renderTagTree() {
    var tree = mgr.els.tree; if (!tree) return; tree.innerHTML = "";
    function node(label, color, depth, active, onclick, extra) {
      return h("button", { class: "qwl-tnode d" + depth + (active ? " active" : "") + (onclick ? "" : " off"), role: "treeitem", "aria-selected": active ? "true" : "false", onclick: onclick || null, disabled: onclick ? null : "true" }, [
        h("span", { class: "qwl-tsq", style: "background:" + (color || "#c9d2d7") }),
        h("span", { class: "qwl-tlbl", text: label }),
        extra || null
      ]);
    }
    function newBadge() { return h("span", { class: "qwl-tnew", text: "nieuw" }); }
    function pendingUnder(parentId) {
      return mgr.pendingTags.filter(function (p) { return String(p.parent || "") === String(parentId || ""); });
    }
    var tops = S().topTagsForOwner(mgr.ownTags, ctx().ownerId);
    var buckets = tops.filter(function (t) { return !isSubjectTop(t); }), subjects = tops.filter(isSubjectTop);
    buckets.forEach(function (t) {
      tree.appendChild(node((t.title || "").trim(), t.color || null, 0, String(mgr.tagFilter) === String(t.id) && mgr.unionParent == null, function () { mgr.expandedTop = null; loadList(t.id); }));
    });
    var zt = ownTagById(1) || { id: 1, title: "Zonder tag" };
    tree.appendChild(node((zt.title || "Zonder tag").trim(), null, 0, String(mgr.tagFilter) === "1", function () { mgr.expandedTop = null; loadList(1); }));
    subjects.forEach(function (t) {
      var open = String(mgr.expandedTop) === String(t.id);
      tree.appendChild(node((t.title || "").trim(), t.color, 0, String(mgr.unionParent) === String(t.id), function () { loadListUnion(t.id); },
        h("span", { class: "qwl-tcaret", text: open ? "▾" : "▸" })));
      if (!open) return;
      mgr.ownTags.filter(function (k) { return String(k.parent) === String(t.id); })
        .sort(function (a, b) { return (a.title || "").localeCompare((b.title || ""), undefined, { numeric: true }); })
        .forEach(function (k) {
          tree.appendChild(node((k.title || "").trim(), k.color || t.color, 1, String(mgr.tagFilter) === String(k.id) && mgr.unionParent == null, function () { loadList(k.id); }));
        });
      pendingUnder(t.id).forEach(function (p) { tree.appendChild(node(p.title, p.color, 1, false, function () { dropPendingTag(p); }, newBadge())); });
    });
    // Staged tags under a vak that is folded, or without a parent: never hidden.
    mgr.pendingTags.forEach(function (p) {
      if (p.parent && String(mgr.expandedTop) === String(p.parent)) return;
      var par = p.parent ? ownTagById(p.parent) : null;
      tree.appendChild(node((par ? (par.title || "").trim() + " › " : "") + p.title, p.color, 0, false, function () { dropPendingTag(p); }, newBadge()));
    });
  }
  // A staged tag is not a list yet — clicking it offers to take it back out of Controleer.
  function dropPendingTag(p) {
    var ok = true; try { ok = window.confirm("De klaargezette tag '" + p.title + "' bestaat nog niet in Questi. Weghalen uit Controleer?"); } catch (e) {}
    if (!ok) return;
    mgr.pendingTags = mgr.pendingTags.filter(function (x) { return x.key !== p.key; });
    renderTagBar(); notifyPending(); setStatus("Klaargezette tag weggehaald.");
  }

  // ========================================================================
  //  Fiche list
  // ========================================================================
  // Page through one tag → full fiche objects; learns per-fiche tag membership (chips).
  function fetchTagFiches(tagId) {
    var acc = [], PAGE = lstate.pageSize || 100, MAXP = 60;
    function page(offset, guard) {
      return jget(lessonsUrl(tagId, PAGE, offset)).then(function (j) {
        var res = (j && j.result) || [], total = (j && j.num_records) != null ? j.num_records : acc.length + res.length;
        acc = acc.concat(res);
        if (res.length === PAGE && acc.length < total && guard < MAXP) return page(offset + PAGE, guard + 1);
        return acc;
      });
    }
    return page(0, 0).then(function (all) {
      if (String(tagId) !== String(allOwnTagId())) all.forEach(function (f) { var l = mgr.tagChips[f.id] || (mgr.tagChips[f.id] = []); if (l.indexOf(tagId) < 0) l.push(tagId); });
      return all;
    });
  }
  function childIdsOf(parentId) { return mgr.ownTags.filter(function (k) { return String(k.parent) === String(parentId); }).map(function (k) { return k.id; }); }

  function loadList(tagId) {
    mgr.loading = true; mgr.tagFilter = tagId; mgr.unionParent = null; lstate.lastTagId = tagId; saveState();
    renderTagBar(); renderList(); setStatus("Lesfiches laden…");
    return fetchTagFiches(tagId).then(function (all) {
      mgr.fiches = all; mgr.loading = false; setStatus(""); applyFilter();
    }).catch(function (e) { mgr.loading = false; setStatus("Laadfout: " + ((e && e.message) || e)); });
  }
  // "Alle [vak]" = union of the parent subject tag + all its child tags (a bare parent fetch
  // misses fiches tagged only under a child). Merge full fiche objects, dedupe by id.
  function loadListUnion(parentId) {
    mgr.loading = true; mgr.tagFilter = parentId; mgr.unionParent = parentId; mgr.expandedTop = parentId;
    lstate.lastTagId = parentId; saveState();
    renderTagBar(); renderList(); setStatus("Lesfiches laden…");
    var ids = [parentId].concat(childIdsOf(parentId));
    var lists = [], failed = 0;   // at most 4 tag lists in flight (a vak can have a dozen subtags)
    return S().mapLimit(ids.map(function (id, i) { return i; }), 4, function (i) {
      return fetchTagFiches(ids[i]).then(function (arr) { lists[i] = arr; }, function () { failed++; });
    }).then(function () {
      var seen = {}, merged = [];
      lists.forEach(function (arr) { (arr || []).forEach(function (f) { if (f && !seen[f.id]) { seen[f.id] = true; merged.push(f); } }); });
      mgr.fiches = merged; mgr.loading = false; setStatus(failed ? failed + " tag(s) konden niet geladen worden — lijst onvolledig, probeer 'Vernieuwen'." : ""); applyFilter();
    }).catch(function (e) { mgr.loading = false; setStatus("Laadfout: " + ((e && e.message) || e)); });
  }

  // Tag chips come from each fiche's own edit view (the list carries no tags), read lazily per
  // visible row and cached per version — see loadFicheInfo. This replaced a walk over every tag
  // (~130 list requests on each open).
  var _renderTimer = null;
  // Background refreshes (tag chips arriving) never rebuild the goals sheet under the cursor.
  function scheduleRender() { if (_renderTimer) return; _renderTimer = setTimeout(function () { _renderTimer = null; if (goalsListHasFocus()) scheduleRender(); else renderList(); }, 400); }

  var SORTERS = {
    subject: function (a, b) { return ficheName(a).localeCompare(ficheName(b), undefined, { numeric: true }); },
    grades: function (a, b) { return gradesOf(a).localeCompare(gradesOf(b), undefined, { numeric: true }); },
    used: function (a, b) { return String(a.last_used_date || "").localeCompare(String(b.last_used_date || "")); },
    tags: function (a, b) { return (mgr.tagChips[a.id] || []).length - (mgr.tagChips[b.id] || []).length; }
  };
  function applyFilter() {
    var q = (mgr.search || "").trim().toLowerCase(), g = mgr.gradeFilter || "";
    mgr.filtered = mgr.fiches.filter(function (f) {
      if (q && ficheName(f).toLowerCase().indexOf(q) === -1) return false;
      if (g && (!f.grades || f.grades.indexOf(g) === -1)) return false;
      return true;
    });
    if (mgr.sortKey && SORTERS[mgr.sortKey]) { mgr.filtered.sort(SORTERS[mgr.sortKey]); if (mgr.sortDir === "desc") mgr.filtered.reverse(); }
    renderList();
  }
  function sortBy(key) {
    if (mgr.sortKey === key) mgr.sortDir = (mgr.sortDir === "asc" ? "desc" : "asc");
    else { mgr.sortKey = key; mgr.sortDir = "asc"; }
    lstate.sortKey = mgr.sortKey; lstate.sortDir = mgr.sortDir; saveState();
    applyFilter();
  }
  function sortArrow(key) { return mgr.sortKey === key ? (mgr.sortDir === "asc" ? " ▲" : " ▼") : ""; }

  function headCell(cls, key, label) {
    return h("div", { class: cls + " qwl-sortable", onclick: function () { sortBy(key); }, text: label + sortArrow(key) });
  }
  function ficheRow(f) {
    var checked = !!mgr.selected[f.id], pending = !!mgr.pending[f.id];
    function chipEls() {
      return (mgr.tagChips[f.id] || []).map(function (tid) {
        return h("span", { class: "qwl-chip", style: "border-color:" + tagHex(tid) }, [h("span", { class: "qwl-dot", style: "background:" + tagHex(tid) }), h("span", { text: tagName(tid) })]);
      });
    }
    var tagsCell = h("div", { class: "qwl-c-tags" }, chipEls());
    var picking = !!mgr.pick;
    var cb = h("input", { class: "qwl-cb", type: "checkbox" }); cb.checked = checked;
    cb.addEventListener("change", function () {
      if (cb.checked) mgr.selected[f.id] = true; else delete mgr.selected[f.id];
      if (picking) { rememberPicked(f); row.classList.toggle("sel", cb.checked); }
      updateSidebar();
    });
    var curTitle = (pending && mgr.pending[f.id].subject != null) ? mgr.pending[f.id].subject : ficheName(f);
    var subjectCell = h("div", { class: "qwl-c-subject" });
    var mounted = isMounted();
    var txt = h("span", { class: "qwl-c-subject-txt", text: curTitle, title: picking ? "Klik om te (de)selecteren" : (mounted ? "Klik om te bewerken" : "Klik om de titel te bewerken") });
    // In pick mode the title must not become an editor — the whole row just toggles selection.
    // Mounted: the whole row opens the side sheet, which has the title field.
    if (!picking && !mounted) txt.addEventListener("click", function (e) { e.stopPropagation(); startInlineTitle(f, subjectCell, ficheName(f)); });
    subjectCell.appendChild(txt);
    if (pending) subjectCell.appendChild(h("span", { class: "qwl-badge", text: "gewijzigd" }));
    // Mounted: W/K/K squares from the goal cache (filled as each row's fiche info arrives).
    var goalsCell = mounted ? h("div", { class: "qwl-c-goals" }) : null;
    function fillGoals(entry) {
      if (!goalsCell) return; goalsCell.innerHTML = "";
      var g = entry && entry.g, pg = mgr.pending[f.id] && mgr.pending[f.id].goals;
      [["weet", "W"], ["ken", "K"], ["kan", "K"]].forEach(function (k) {
        var v = (pg && Object.prototype.hasOwnProperty.call(pg, k[0])) ? pg[k[0]] : (g ? g[k[0]] : "");
        goalsCell.appendChild(h("span", { class: "qwl-gsq" + (v ? " on" : "") + (g ? "" : " unk"), title: k[0].toUpperCase() + (g ? (v ? ": " + v : ": leeg") : ": nog niet gelezen"), text: k[1] }));
      });
    }
    fillGoals(_goalCache && _goalCache[f.id]);
    var row = h("div", { class: "qwl-row" + (mounted ? " qwl-row6" : "") + (checked ? " sel" : "") + (pending ? " pend" : "") + (mounted && String(mgr.sheetFid) === String(f.id) ? " open" : ""), "data-fid": String(f.id), title: picking ? "" : (mounted ? "Klik om te bewerken" : "Dubbelklik om volledig te bewerken") }, [
      h("label", { class: "qwl-cbcell" }, [cb]),
      subjectCell,
      h("div", { class: "qwl-c-grades", text: gradesOf(f) }),
      h("div", { class: "qwl-c-used", text: usedOf(f) }),
      goalsCell,
      tagsCell
    ]);
    mgr.rowFill[f.id] = function (entry) { tagsCell.innerHTML = ""; chipEls().forEach(function (c) { tagsCell.appendChild(c); }); fillGoals(entry); };
    if (picking) {
      row.addEventListener("click", function (e) {
        if (e.target === cb) return;            // the checkbox fires its own change event
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      });
    } else if (mounted) {
      row.addEventListener("click", function (e) {
        if (e.target === cb || (e.target.closest && e.target.closest(".qwl-cbcell"))) return;
        openEditModal(f);
      });
    } else {
      row.addEventListener("dblclick", function () { openEditModal(f); });
    }
    return row;
  }
  // Inline title edit: swap the title text for an input; Enter/blur stages a title-only change.
  function startInlineTitle(f, cell, origTitle) {
    cell.innerHTML = "";
    var inp = h("input", { class: "qwl-titleinput", type: "text", value: (mgr.pending[f.id] && mgr.pending[f.id].subject != null) ? mgr.pending[f.id].subject : origTitle });
    cell.appendChild(inp); inp.focus(); inp.select();
    var done = false;
    function commit() {
      if (done) return; done = true;
      var nv = inp.value;
      if (nv !== origTitle) stagePending(f, null, { subject: nv }, [{ label: "Titel", old: origTitle, nw: nv }]);
      renderList();
    }
    inp.addEventListener("click", function (e) { e.stopPropagation(); });
    inp.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") inp.blur(); else if (e.key === "Escape") { done = true; renderList(); } });
    inp.addEventListener("blur", commit);
  }
  function makeTable(items) {
    if (mgr.goalsMode) return makeGoalsTable(items);
    var table = h("div", { class: "qwl-table" });
    var mounted = isMounted();
    table.appendChild(h("div", { class: "qwl-row qwl-thead" + (mounted ? " qwl-row6" : "") }, [
      h("div", { class: "qwl-cbcell" }),
      headCell("qwl-c-subject", "subject", "Titel"),
      headCell("qwl-c-grades", "grades", mounted ? "Jaar" : "Leerjaar"),
      headCell("qwl-c-used", "used", mounted ? "Gebruikt" : "Laatst gebruikt"),
      mounted ? h("div", { class: "qwl-c-goals", text: "Doelen" }) : null,
      headCell("qwl-c-tags", "tags", "Tags")
    ]));
    items.forEach(function (f) { table.appendChild(ficheRow(f)); });
    return table;
  }

  // ========================================================================
  //  Goals mode — the list becomes a sheet: Titel | WEET | KEN | KAN.
  //  Values live in the fiche (extra fields, see buildPatch); every edit STAGES into
  //  mgr.pending and is written through the normal review gate. Tab walks the cells,
  //  Enter jumps to the same column on the next row (Shift+Enter = new line).
  // ========================================================================
  function toggleGoalsMode() {
    mgr.goalsMode = !mgr.goalsMode;
    if (mgr.goalsMode) closeSheet();
    setStatus(mgr.goalsMode ? "Lesdoelen: typ per fiche, Tab = volgende cel, Enter = volgende fiche. Niets wordt geschreven zonder '" + reviewName() + "'." : "");
    renderList();
  }
  function goalsListHasFocus() { var a = document.activeElement; return !!(mgr.goalsMode && a && mgr.els.list && mgr.els.list.contains(a)); }
  // Fiche info per VERSION, saved under qwp_goalcache_v1: { "<fiche id>": { g: {weet,ken,kan}, m: methode hint, t: [tag ids] } }.
  // Safe to keep: a fiche id never changes content (every edit — tags included — mints a new id), so a
  // cached id is exact forever and a fiche seen once costs no request. Only unseen versions are read.
  var GOALCACHE_KEY = "qwp_goalcache_v1", _goalCache = null, _goalCacheSaveT = null;
  function loadGoalCache() {
    if (_goalCache) return Promise.resolve();
    return S().storeGet(GOALCACHE_KEY).then(function (v) { if (!_goalCache) _goalCache = v || {}; });
  }
  function cacheGoals(id, edit) {
    var gf = S().ficheGoalFields(edit), g = {};
    GOAL_KINDS.forEach(function (k) { g[k] = gf[k] ? S().goalText(gf[k].content) : ""; });
    var entry = { g: g, m: methodGoalsHint(edit), t: (edit.tags || []).map(function (t) { return t.id; }) };
    _goalCache[id] = entry;
    applyCachedTags(id, entry);
    clearTimeout(_goalCacheSaveT);
    _goalCacheSaveT = setTimeout(function () { S().storeSet(GOALCACHE_KEY, _goalCache); }, 800);
    return entry;
  }
  function infoCached(id) { var e = _goalCache && _goalCache[id]; return !!(e && e.t); }
  // The active host is on screen: the standalone overlay shown, or the planner's Lesfiches tab
  // visible (its host is display:none on the other tabs and while the planner is closed).
  function overlayOpen() { var r = mgr.els && mgr.els.root; return !!(r && r.isConnected && r.getClientRects().length); }
  // Tags of deleted catalog tags are dropped, never shown as a bare id.
  function applyCachedTags(id, entry) { if (entry && entry.t) mgr.tagChips[id] = entry.t.filter(function (tid) { return ownTagById(tid); }); }
  // Read queue, fed by rows scrolling into view (+200px) — only what you look at is read, a few at a
  // time, so a big tag costs no request burst. "Lokale doelen overnemen" queues the whole list.
  var GOAL_READ_CONCURRENCY = 4, _goalQueue = [], _goalWorkers = 0, _goalObserver = null, _goalFailed = 0, _goalReadRound = 0;
  function queueGoalRead(id, front) {
    if (!_goalCache || infoCached(id) || mgr.goalLoading[id]) return;
    var at = _goalQueue.indexOf(id);
    if (at >= 0) { if (!front) return; _goalQueue.splice(at, 1); }
    if (front) _goalQueue.unshift(id); else _goalQueue.push(id);
    pumpGoalReads();
  }
  function pumpGoalReads() {
    while (overlayOpen() && _goalWorkers < GOAL_READ_CONCURRENCY && _goalQueue.length) {
      var id = _goalQueue.shift();
      if (!infoCached(id) && !mgr.goalLoading[id]) startGoalRead(id);
    }
    goalLoadStatus();
  }
  function startGoalRead(id) {
    _goalWorkers++; _goalReadRound++; mgr.goalLoading[id] = true;
    readFicheEdit(id).then(function (edit) {
      var entry = cacheGoals(id, edit);
      if (mgr.rowFill[id]) mgr.rowFill[id](entry);
    }).catch(function () { _goalFailed++; if (mgr.rowFill[id]) mgr.rowFill[id](null); })
      .then(function () { delete mgr.goalLoading[id]; _goalWorkers--; pumpGoalReads(); });
  }
  function goalLoadStatus() {
    if (!overlayOpen() || goalsListHasFocus()) return;
    var left = _goalQueue.length + _goalWorkers;
    if (!left && !_goalFailed && !_goalReadRound) return;   // nothing read: leave other status alone
    setStatus(left ? "Fiches lezen… nog " + left : (_goalFailed ? _goalFailed + " fiche(s) konden niet gelezen worden." : ""));
  }
  // Goals and tag chips for the listed fiches (both list modes): cached versions fill at once,
  // the rest are read as their rows scroll into view.
  function loadFicheInfo(items) {
    _goalFailed = 0; _goalReadRound = 0;
    loadGoalCache().then(function () {
      if (!overlayOpen()) return;
      _goalQueue = [];
      var lazy = typeof IntersectionObserver === "function" && !!mgr.els.list;
      items.forEach(function (f) {
        var e = _goalCache[f.id];
        if (e) { applyCachedTags(f.id, e); if (mgr.rowFill[f.id]) mgr.rowFill[f.id](e); }
        if (!infoCached(f.id) && !lazy) queueGoalRead(f.id, false);
      });
      if (_goalObserver) _goalObserver.disconnect();
      if (lazy) {
        _goalObserver = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) { if (en.isIntersecting) queueGoalRead(en.target.getAttribute("data-fid"), true); });
        }, { rootMargin: "200px 0px" });
        var rows = mgr.els.list.querySelectorAll(".qwl-row[data-fid]");
        for (var i = 0; i < rows.length; i++) if (!infoCached(rows[i].getAttribute("data-fid"))) _goalObserver.observe(rows[i]);
      }
      pumpGoalReads();
    });
  }
  // The vendor's own lesdoelen, when the fiche sits on a methode template (read-only hint).
  function methodGoalsHint(edit) {
    var out = [];
    function walk(n) { if (!n) return; if (n.is_goal && n.description) out.push(S().goalText(n.description)); (n.children || []).forEach(walk); }
    ((edit && edit.fields) || []).forEach(function (f) { if (f.type === "methods") walk(f.content); });
    return out.join("\n");
  }
  function moveGoalFocus(cell, dir) {
    var col = cell.getAttribute("data-col"), table = cell.closest(".qwl-table"); if (!table) return;
    var cells = Array.prototype.slice.call(table.querySelectorAll('[data-col="' + col + '"]'));
    var nx = cells[cells.indexOf(cell) + dir]; if (nx) { nx.focus(); if (nx.select) nx.select(); }
  }
  function goalCellKeys(e) {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); moveGoalFocus(e.target, 1); }
  }
  function makeGoalsTable(items) {
    var table = h("div", { class: "qwl-table qwl-gtable" });
    table.appendChild(h("div", { class: "qwl-row qwl-grow qwl-thead" }, [
      h("div", { class: "qwl-cbcell" }),
      headCell("qwl-c-subject", "subject", "Titel"),
      h("div", { text: "Weet" }), h("div", { text: "Ken" }), h("div", { text: "Kan" })
    ]));
    items.forEach(function (f) { table.appendChild(goalRow(f)); });
    return table;
  }
  function goalRow(f) {
    var pend = mgr.pending[f.id];
    var cb = h("input", { class: "qwl-cb", type: "checkbox", tabindex: "-1" }); cb.checked = !!mgr.selected[f.id];
    cb.addEventListener("change", function () { if (cb.checked) mgr.selected[f.id] = true; else delete mgr.selected[f.id]; row.classList.toggle("sel", cb.checked); updateSidebar(); });
    var title = h("input", { class: "qwl-ginp qwl-gtitle", type: "text", "data-col": "0", value: (pend && pend.subject != null) ? pend.subject : ficheName(f) });
    var hint = h("span", { class: "qwl-ghint", text: "ⓘ" }); hint.style.display = "none";
    var cells = {};
    GOAL_KINDS.forEach(function (k, i) {
      var ta = h("textarea", { class: "qwl-ginp", rows: "2", "data-col": String(i + 1), placeholder: "laden…", disabled: "true" });
      ta.addEventListener("keydown", goalCellKeys);
      ta.addEventListener("change", function () {
        var entry = _goalCache && _goalCache[f.id]; if (!entry) return;
        var old = entry.g[k] || "", nv = ta.value.trim();
        var g = {}; g[k] = nv; var orig = {}; orig[k] = old;
        stagePending(f, null, { goals: g, goalsOrig: orig }, nv === old ? [] : [{ label: k.toUpperCase(), old: old, nw: nv }]);
        markRow();
      });
      cells[k] = ta;
    });
    title.addEventListener("keydown", goalCellKeys);
    title.addEventListener("change", function () {
      var nv = title.value, orig = ficheName(f);
      stagePending(f, null, { subject: nv }, nv === orig ? [] : [{ label: "Titel", old: orig, nw: nv }]);
      markRow();
    });
    var row = h("div", { class: "qwl-row qwl-grow" + (cb.checked ? " sel" : "") + (pend ? " pend" : ""), "data-fid": String(f.id) }, [
      h("label", { class: "qwl-cbcell" }, [cb]),
      h("div", { class: "qwl-gtitlecell" }, [title, hint]),
      cells.weet, cells.ken, cells.kan
    ]);
    function markRow() { row.classList.toggle("pend", !!mgr.pending[f.id]); updateSidebar(); }
    function fill(entry) {
      if (!entry) { GOAL_KINDS.forEach(function (k) { cells[k].placeholder = "niet gelezen"; }); return; }
      var p = mgr.pending[f.id];
      GOAL_KINDS.forEach(function (k) {
        var ta = cells[k];
        ta.value = (p && p.goals && Object.prototype.hasOwnProperty.call(p.goals, k)) ? p.goals[k] : (entry.g[k] || "");
        ta.placeholder = ""; ta.disabled = false;
      });
      if (entry.m) { hint.style.display = ""; hint.title = "Doelen van de methode:\n" + entry.m; }
    }
    mgr.rowFill[f.id] = fill;
    if (_goalCache && _goalCache[f.id]) fill(_goalCache[f.id]);
    return row;
  }
  // One-time move of the goals typed in the print preview (this browser, qwp_goals_v1) into the
  // fiches. Only fiches with no WEET/KEN/KAN yet; records of an older fiche version cannot match.
  function importLocalGoals() {
    var listed = mgr.filtered, missing = listed.filter(function (f) { return !infoCached(f.id); });
    if (missing.length) {
      missing.forEach(function (f) { queueGoalRead(f.id, false); });
      setStatus("Eerst alle " + missing.length + " fiches lezen — klik daarna opnieuw op 'Lokale doelen overnemen'.");
      return;
    }
    S().storeGet("qwp_goals_v1").then(function (store) {
      store = store || {};
      var staged = 0, skipped = 0, matched = 0;
      listed.forEach(function (f) {
        var rec = store["f:" + f.id]; if (!rec) return;
        var vals = {}; GOAL_KINDS.forEach(function (k) { var v = String(rec[k] || "").trim(); if (v) vals[k] = v; });
        if (!Object.keys(vals).length) return;
        matched++;
        var cur = _goalCache[f.id].g;
        if (GOAL_KINDS.some(function (k) { return cur[k]; })) { skipped++; return; }
        stagePending(f, null, { goals: vals, goalsOrig: cur }, Object.keys(vals).map(function (k) { return { label: k.toUpperCase(), old: "", nw: vals[k] }; }));
        staged++;
      });
      var total = Object.keys(store).filter(function (key) { var r = store[key]; return key.indexOf("f:") === 0 && r && GOAL_KINDS.some(function (k) { return String(r[k] || "").trim(); }); }).length;
      renderList();
      setStatus(staged + " fiche(s) klaargezet uit lokale doelen" + (skipped ? ", " + skipped + " overgeslagen (heeft al doelen)" : "")
        + ". " + (total - matched) + " lokale record(s) horen bij een andere tag of een oudere fiche-versie.");
    });
  }
  function renderList() {
    var wrap = mgr.els.list; if (!wrap) return; wrap.innerHTML = "";
    updateSidebar();
    if (mgr.loading) { wrap.appendChild(h("div", { class: "qwl-empty", text: "Laden…" })); return; }
    if (!mgr.filtered.length) { wrap.appendChild(h("div", { class: "qwl-empty", text: "Geen lesfiches." })); return; }
    mgr.rowFill = {};
    if (mgr.cols === 2 && !mgr.goalsMode) {
      var mid = Math.ceil(mgr.filtered.length / 2);
      wrap.appendChild(h("div", { class: "qwl-cols" }, [makeTable(mgr.filtered.slice(0, mid)), makeTable(mgr.filtered.slice(mid))]));
    } else {
      wrap.appendChild(makeTable(mgr.filtered));
    }
    loadFicheInfo(mgr.filtered);
  }

  function updateSidebar() {
    var n = selCount(), p = pendCount(), mounted = isMounted();
    var c = E("qwl-count"); if (c) c.textContent = mounted ? (" · " + mgr.filtered.length + " fiches") : (mgr.filtered.length + " fiches" + (n ? " · " + n + " geselecteerd" : ""));
    if (mounted) {
      var ti = E("qwl-title"); if (ti) ti.textContent = mgr.tagFilter != null ? (String(mgr.tagFilter) === "1" ? "Zonder tag" : tagName(mgr.tagFilter)) : "Lesfiches";
      var sc = E("qwl-selcount"); if (sc) sc.textContent = n + " geselecteerd";
      var seg = E("qwl-modeseg");
      if (seg) Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) { b.classList.toggle("active", (b.getAttribute("data-m") === "goals") === !!mgr.goalsMode); });
    }
    var tg = E("qwl-tags"), dl = E("qwl-del"), sa = E("qwl-selall"), rv = E("qwl-review"), cols = E("qwl-cols");
    if (tg) { tg.textContent = "Tags bewerken" + (n ? " (" + n + ")" : ""); tg.disabled = n ? null : "true"; }
    if (dl) { dl.textContent = "Verwijderen" + (n ? " (" + n + ")" : ""); dl.disabled = n ? null : "true"; }
    if (sa) sa.textContent = (n && n >= mgr.filtered.length && mgr.filtered.length) ? "Wis selectie" : "Alles selecteren";
    if (rv) { rv.textContent = "Wijzigingen controleren" + (p ? " (" + p + ")" : ""); rv.style.display = (mgr.pick || !p) ? "none" : ""; }
    if (cols) { cols.textContent = mgr.cols === 2 ? "1 kolom" : "2 kolommen"; cols.style.display = (mgr.goalsMode || mgr.pick) ? "none" : ""; }
    var gm = E("qwl-goalsmode"); if (gm && !mgr.pick) gm.textContent = mgr.goalsMode ? "Terug naar lijst" : "Lesdoelen invullen";
    var gi = E("qwl-goalsimport"); if (gi) gi.style.display = (mgr.goalsMode && !mgr.pick) ? "" : "none";
    var ok = E("qwl-pickok");
    if (ok && mgr.pick) { ok.textContent = "Selectie gebruiken" + (n ? " (" + n + ")" : ""); ok.disabled = n ? null : "true"; }
  }
  function toggleSelectAll() {
    var allSel = selCount() >= mgr.filtered.length && mgr.filtered.length;
    if (allSel) mgr.selected = {}; else mgr.filtered.forEach(function (f) { mgr.selected[f.id] = true; });
    if (mgr.pick) { if (allSel) mgr.pickStore = {}; else mgr.filtered.forEach(rememberPicked); }
    renderList();
  }

  // ========================================================================
  //  Modal plumbing
  // ========================================================================
  function modal(titleText, bodyEls, footerEls, cls) {
    var box = h("div", { class: "qwl-modal-box" + (cls ? " " + cls : "") }, [
      h("div", { class: "qwl-modal-hd" }, [h("span", { text: titleText })]),
      h("div", { class: "qwl-modal-bd" }, bodyEls),
      h("div", { class: "qwl-modal-ft" }, footerEls)
    ]);
    var back = h("div", { class: "qwl-modal" }, [box]);
    mgr.els.page.appendChild(back);
    back.close = function () { back.remove(); };
    return back;
  }

  // ------------------------------------------------------------------------
  //  Edit one fiche (title + text) — STAGES into pending, never writes here
  // ------------------------------------------------------------------------
  // Name of the gate that writes staged edits, as the active host shows it.
  function reviewName() { return isMounted() ? "Controleer" : "Wijzigingen controleren"; }
  // Mounted host: the editor is a side sheet next to the table (Lesfiches.dc.html); standalone: a modal.
  function openEditModal(f) {
    if (isMounted() && mgr.els.sheet) { openSheet(f); return; }
    var m = modal("Bewerk: " + ficheName(f), [h("div", { class: "qwl-loading", text: "Fiche laden…" })], [], "wide");
    fillEditor(f, m.querySelector(".qwl-modal-bd"), m.querySelector(".qwl-modal-ft"), m.close, function () { return !!m.parentNode; });
  }
  function openSheet(f) {
    var sh = mgr.els.sheet, token = ++mgr.sheetToken;
    mgr.sheetFid = f.id;
    sh.innerHTML = ""; sh.style.display = "";
    var top = (mgr.tagChips[f.id] || []).map(function (tid) { return S().topTagIdOf ? S().topTagIdOf(tid) : tid; })[0];
    var hd = h("div", { class: "qwl-sheet-hd", style: "border-top-color:" + (top != null ? tagHex(top) : "#c9d2d7") }, [
      h("div", { class: "qwl-sheet-kicker", text: (mgr.tagChips[f.id] || []).map(tagName).join(" · ") || "Lesfiche" }),
      h("div", { class: "qwl-sheet-title", text: (mgr.pending[f.id] && mgr.pending[f.id].subject != null) ? mgr.pending[f.id].subject : ficheName(f) })
    ]);
    var bd = h("div", { class: "qwl-sheet-bd" }, [h("div", { class: "qwl-loading", text: "Fiche laden…" })]);
    var ft = h("div", { class: "qwl-sheet-ft" });
    sh.appendChild(hd); sh.appendChild(bd); sh.appendChild(ft);
    markOpenRow();
    fillEditor(f, bd, ft, closeSheet, function () { return token === mgr.sheetToken; });
  }
  function closeSheet() {
    mgr.sheetToken++; mgr.sheetFid = null;
    var sh = mgr.elsMounted && mgr.elsMounted.sheet; if (sh) { sh.innerHTML = ""; sh.style.display = "none"; }
    markOpenRow();
  }
  function markOpenRow() {
    var l = mgr.els && mgr.els.list; if (!l) return;
    Array.prototype.forEach.call(l.querySelectorAll(".qwl-row[data-fid]"), function (r) { r.classList.toggle("open", String(r.getAttribute("data-fid")) === String(mgr.sheetFid)); });
  }
  // Build the full editor into bd/ft. `alive()` says whether that host still shows this fiche
  // (a modal closed, or the sheet moved on to another fiche, while the edit view was loading).
  function fillEditor(f, bd, ft, closeFn, alive) {
    readFicheEdit(f.id).then(function (edit) {
      if (!alive()) return;
      var pend = mgr.pending[f.id];
      var body = [];
      function section(label, els) { body.push(h("label", { class: "qwl-flabel", text: label })); (els || []).forEach(function (e) { body.push(e); }); }
      // --- Titel
      var subjInp = h("input", { class: "qwl-input", type: "text", value: (pend && pend.subject != null ? pend.subject : (edit.subject || "")) });
      section("Titel", [subjInp]);
      // --- Leerjaren + zichtbaarheid. Proef: Questi's create takes these keys, a PATCH with them was
      // never captured — writePending re-reads the fiche afterwards and says so if Questi ignored them.
      var origGrades = (edit.grades || []).slice().sort(), gradeSet = {};
      ((pend && pend.grades) ? pend.grades : origGrades).forEach(function (g) { gradeSet[g] = true; });
      var gradeBoxes = h("div", { class: "qwl-gradeboxes" }, GRADES.map(function (g) {
        var c = h("input", { type: "checkbox" }); c.checked = !!gradeSet[g];
        c.addEventListener("change", function () { if (c.checked) gradeSet[g] = true; else delete gradeSet[g]; });
        return h("label", { class: "qwl-gradebox" }, [c, h("span", { text: g })]);
      }));
      section("Leerjaren (proef)", [gradeBoxes]);
      var origVis = edit.visibility || "school", vis = (pend && pend.visibility) || origVis;
      var visRow = h("div", { class: "qwl-gradeboxes" }, [["private", "Privé"], ["school", "School"]].map(function (o) {
        var r = h("input", { type: "radio", name: "qwl-vis-" + f.id, value: o[0] }); r.checked = vis === o[0];
        r.addEventListener("change", function () { if (r.checked) vis = o[0]; });
        return h("label", { class: "qwl-gradebox" }, [r, h("span", { text: o[1] })]);
      }));
      section("Zichtbaarheid (proef)", [visRow]);
      // --- Tags: click a pill to switch it on/off. tags[] is a full replace, so the whole set is staged.
      var origTags = (edit.tags || []).map(function (t) { return String(t.id); });
      var tagSet = {}; ((pend && pend.tags) ? pend.tags.map(String) : origTags).forEach(function (id) { tagSet[id] = true; });
      var tagSummary = h("span", { class: "qwl-tagsum" });
      var tagPick = h("div", { class: "qwl-tagpick" });
      function tagPill(tg) {
        var on = !!tagSet[String(tg.id)];
        return h("button", { class: "qwl-pill" + (on ? " add" : ""), onclick: function () {
          if (tagSet[String(tg.id)]) delete tagSet[String(tg.id)]; else tagSet[String(tg.id)] = true;
          drawTags();
        } }, [h("span", { class: "qwl-dot", style: "background:" + (tg.color || "#c7ccd1") }), h("span", { text: (tg.title || "").trim() }), h("span", { class: "qwl-pill-mark", text: on ? "✓" : "" })]);
      }
      function drawTags() {
        renderTagGroups(tagPick, tagPill);
        tagSummary.innerHTML = "";
        var ids = Object.keys(tagSet);
        tagSummary.appendChild(ids.length ? chipRow(ids.map(Number)) : h("span", { class: "qwl-note", text: "geen tags" }));
      }
      drawTags();
      section("Tags", [h("details", { class: "qwl-tagdetails" }, [h("summary", {}, [tagSummary, h("span", { class: "qwl-tagedit", text: "wijzigen" })]), tagPick])]);
      // --- Text fields: the template's, then the fiche's own extra fields (WEET/KEN/KAN included).
      var textFields = (edit.fields || []).filter(function (x) { return x.type === "text"; });
      textFields.sort(function (a, b) { return (a.template_field_id == null) - (b.template_field_id == null); });
      var areas = {};
      textFields.forEach(function (fld) {
        var ta = h("textarea", { class: "qwl-textarea", rows: "4" });
        ta.value = (pend && pend.text && Object.prototype.hasOwnProperty.call(pend.text, fieldKey(fld))) ? pend.text[fieldKey(fld)] : (fld.content != null ? fld.content : "");
        areas[fieldKey(fld)] = ta;
        section((fld.title || "Tekst") + (fld.template_field_id == null ? "  · extra veld" : ""), [ta]);
      });
      // --- New extra text fields (Questi's "+ toevoegen → Tekst"), staged like everything else.
      var newRows = [], newWrap = h("div", { class: "qwl-newfields" });
      function addNewField(title, content) {
        var t = h("input", { class: "qwl-input", type: "text", placeholder: "titel van het veld", value: title || "" });
        var c = h("textarea", { class: "qwl-textarea", rows: "3", placeholder: "inhoud" }); c.value = content || "";
        var rowEl = h("div", { class: "qwl-newfield" }, [t, c]);
        newRows.push({ t: t, c: c }); newWrap.appendChild(rowEl);
      }
      ((pend && pend.newFields) || []).forEach(function (nf) { addNewField(nf.title, nf.content); });
      body.push(newWrap);
      body.push(h("button", { class: "qwl-btn qwl-ghost qwl-addfield", onclick: function () { addNewField("", ""); }, text: "+ Tekstveld toevoegen" }));
      // --- Read-only: what Questi holds but this editor cannot change.
      var ro = [];
      function roRow(k, v) { if (v) ro.push(h("div", { class: "qwl-ro-row" }, [h("span", { class: "qwl-ro-k", text: k }), h("span", { class: "qwl-ro-v", text: v })])); }
      roRow("Sjabloon", edit.template && edit.template.name);
      roRow("Eigenaar", edit.owner && ((edit.owner.firstname || "") + " " + (edit.owner.lastname || "")).trim());
      roRow("Laatst gebruikt", usedOf(edit));
      roRow("Bijlagen", (edit.attachments || []).map(function (a) { return a.title || a.name || (a.content && (a.content.name || a.content.title)) || "bijlage"; }).join(", "));
      (edit.fields || []).forEach(function (fld) {
        if (fld.type === "methods") roRow((fld.title || "Methode") + " (methode)", methodGoalsHint({ fields: [fld] }).replace(/\n/g, " · "));
        else if (fld.type === "goals") {
          var n = (fld.selected_goals || []).length || ((fld.content && fld.content.goals) || []).length;
          roRow((fld.title || "Leerplandoelen") + " (leerplan)", n ? n + " doel(en) gekozen — bewerk in Questi" : "bewerk in Questi");
        }
      });
      if (ro.length) section("Alleen lezen", [h("div", { class: "qwl-ro" }, ro)]);
      body.push(h("div", { class: "qwl-note", text: "Niets wordt geschreven tot je op '" + reviewName() + "' klikt en goedkeurt." }));
      bd.innerHTML = ""; body.forEach(function (e) { bd.appendChild(e); });
      ft.innerHTML = "";
      ft.appendChild(h("button", { class: "qwl-btn qwl-ghost", onclick: closeFn, text: isMounted() ? "Sluiten" : "Annuleer" }));
      if (mgr.pending[f.id]) ft.appendChild(h("button", { class: "qwl-btn qwl-ghost", onclick: function () { delete mgr.pending[f.id]; notifyPending(); closeFn(); renderList(); setStatus("Wijziging verworpen."); }, text: "Verwerpen" }));
      if (isMounted()) ft.appendChild(h("span", { class: "qwl-hspacer" }));
      ft.appendChild(h("button", { class: "qwl-btn", onclick: function () {
        var subject = subjInp.value, text = {}, changes = [];
        if ((subject || "") !== (edit.subject || "")) changes.push({ label: "Titel", old: edit.subject || "", nw: subject || "" });
        textFields.forEach(function (fld) {
          var nv = areas[fieldKey(fld)].value, ov = fld.content != null ? fld.content : "";
          text[fieldKey(fld)] = nv;
          if (nv !== ov) changes.push({ label: fld.title || "Tekst", old: ov, nw: nv });
        });
        var nextTags = Object.keys(tagSet), tagsChanged = nextTags.slice().sort().join() !== origTags.slice().sort().join();
        if (tagsChanged) changes.push({ label: "Tags", oldEl: chipRow(origTags.map(Number)), newEl: chipRow(nextTags.map(Number)) });
        var nextGrades = GRADES.filter(function (g) { return gradeSet[g]; }), gradesChanged = nextGrades.join() !== origGrades.join();
        if (gradesChanged) changes.push({ label: "Leerjaren", old: origGrades.join(", ") || "—", nw: nextGrades.join(", ") || "—" });
        var visChanged = vis !== origVis;
        if (visChanged) changes.push({ label: "Zichtbaarheid", old: origVis, nw: vis });
        var newFields = newRows.map(function (r) { return { title: r.t.value.trim(), content: r.c.value }; }).filter(function (x) { return x.title; });
        newFields.forEach(function (x) { changes.push({ label: "Nieuw veld: " + x.title, old: "", nw: x.content }); });
        stagePending(f, edit, {
          subject: subject, text: text, tags: tagsChanged ? nextTags : null,
          grades: gradesChanged ? nextGrades : null, visibility: visChanged ? vis : null, newFields: newFields
        }, changes);
        closeFn(); renderList();
        setStatus(pendCount() + " wijziging(en) klaargezet — druk '" + reviewName() + "'.");
      }, text: isMounted() ? "Klaarzetten" : "Bewaar wijziging" }));
    }).catch(function (e) {
      if (!alive()) return;
      bd.innerHTML = ""; bd.appendChild(h("div", { class: "qwl-note", text: "Laadfout: " + ((e && e.message) || e) }));
      ft.innerHTML = ""; ft.appendChild(h("button", { class: "qwl-btn qwl-ghost", onclick: closeFn, text: "Sluiten" }));
    });
  }
  // Merge a staged change into pending[id] (title/text and/or tags/createTags). `edit` may be
  // null (inline title edit) — writePending reads the edit snapshot lazily before writing.
  function stagePending(f, edit, opts, changes) {
    var e = mgr.pending[f.id] || { fiche: f, edit: null, changes: [] };
    e.fiche = f; if (edit) e.edit = edit;
    if (opts.subject !== undefined) e.subject = opts.subject;
    if (opts.text !== undefined) e.text = opts.text;
    if (opts.tags !== undefined) e.tags = opts.tags;
    if (opts.create_tags !== undefined) e.createTags = opts.create_tags;
    if (opts.grades !== undefined) e.grades = opts.grades;
    if (opts.visibility !== undefined) e.visibility = opts.visibility;
    if (opts.newFields !== undefined) e.newFields = (opts.newFields && opts.newFields.length) ? opts.newFields : null;
    // Goals (goals mode): one kind at a time; typing a kind back to its stored text unstages it.
    var dropLabels = [];
    if (opts.goals) {
      e.goals = e.goals || {};
      var gf = e.edit ? S().ficheGoalFields(e.edit) : {}, given = opts.goalsOrig || {};
      Object.keys(opts.goals).forEach(function (k) {
        // goalsOrig: the stored text as goals mode knows it (cache); else read it off the edit view.
        var orig = Object.prototype.hasOwnProperty.call(given, k) ? (given[k] || "") : (gf[k] ? S().goalText(gf[k].content) : "");
        if (opts.goals[k] === orig) { delete e.goals[k]; dropLabels.push(k.toUpperCase()); }
        else e.goals[k] = opts.goals[k];
      });
    }
    var origSubject = (e.edit && e.edit.subject != null) ? e.edit.subject : ficheName(f);
    if (opts.subject !== undefined && opts.subject === origSubject) { e.subject = null; dropLabels.push("Titel"); }
    if (opts.tags === null) dropLabels.push("Tags");
    if (opts.grades === null) dropLabels.push("Leerjaren");
    if (opts.visibility === null) dropLabels.push("Zichtbaarheid");
    var resetNew = opts.newFields !== undefined;   // the editor restates the whole list of new fields
    e.changes = (e.changes || []).filter(function (c) { return dropLabels.indexOf(c.label) < 0 && !(resetNew && c.label.indexOf("Nieuw veld: ") === 0) && changes.every(function (n) { return n.label !== c.label; }); }).concat(changes);
    var textChanged = e.text && e.edit && Object.keys(e.text).some(function (k) { var fld = (e.edit.fields || []).filter(function (x) { return fieldKey(x) === k; })[0]; return fld && (e.text[k] !== (fld.content != null ? fld.content : "")); });
    var goalsChanged = !!(e.goals && Object.keys(e.goals).length);
    var meaningful = (e.subject != null && e.subject !== origSubject) || (e.tags != null) || (e.createTags && e.createTags.length) || textChanged || goalsChanged
      || e.grades != null || e.visibility != null || !!(e.newFields && e.newFields.length);
    if (meaningful) mgr.pending[f.id] = e; else delete mgr.pending[f.id];
    notifyPending();
  }
  // The planner's Controleer badge, header count and launcher badge include these edits.
  function notifyPending() { try { if (S() && S().refreshStaged) S().refreshStaged(); } catch (e) {} }

  // Review ALL staged edits → approve → sequential write.
  function openReviewEdits() {
    var keys = Object.keys(mgr.pending); if (!keys.length) return;
    var body = [h("div", { class: "qwl-note", text: keys.length + " fiche(s) gewijzigd. Doelen en niet-gewijzigde tags blijven behouden; elke fiche krijgt een nieuw versie-id." })];
    keys.forEach(function (id) {
      var p = mgr.pending[id];
      body.push(h("div", { class: "qwl-review-head", text: ficheName(p.fiche) }));
      (p.changes || []).forEach(function (c) {
        body.push(h("div", { class: "qwl-diff" }, [
          h("div", { class: "qwl-diff-lbl", text: c.label }),
          h("div", { class: "qwl-diff-old" }, [c.oldEl || h("span", { text: (c.old || "—").slice(0, 240) })]),
          h("div", { class: "qwl-diff-new" }, [c.newEl || h("span", { text: (c.nw || "—").slice(0, 240) })])
        ]));
      });
    });
    var m = modal("Wijzigingen controleren — " + keys.length + " fiches", body, [], "wide");
    var ft = m.querySelector(".qwl-modal-ft");
    ft.appendChild(h("button", { class: "qwl-btn qwl-ghost", onclick: m.close, text: "Terug" }));
    ft.appendChild(h("button", { class: "qwl-btn qwl-ghost qwl-danger", onclick: function () { mgr.pending = {}; notifyPending(); m.close(); renderList(); setStatus("Alle wijzigingen verworpen."); }, text: "Alles verwerpen" }));
    var goalWrites = keys.filter(function (id) { return mgr.pending[id].goals && Object.keys(mgr.pending[id].goals).length; }).length;
    if (goalWrites >= GOAL_BACKUP_MIN) body.push(h("div", { class: "qwl-note", text: "Eerst wordt een back-up (JSON) gedownload van de " + keys.length + " fiches zoals ze nu zijn." }));
    ft.appendChild(h("button", { class: "qwl-btn", onclick: function () {
      m.close();
      if (goalWrites >= GOAL_BACKUP_MIN) backupPendingSnapshots(keys);
      writePending(keys.slice());
    }, text: "Wegschrijven (" + keys.length + ")" }));
  }
  // Bulk goal writes touch many fiches at once: download what they look like now (the edit
  // snapshots goals mode already read — no extra calls) so a bad write can be rebuilt by hand.
  var GOAL_BACKUP_MIN = 5;
  function backupPendingSnapshots(keys) {
    var data = keys.map(function (id) {
      var p = mgr.pending[id], e = p && p.edit;
      return e ? { id: e.id, subject: e.subject || "", grades: e.grades || [], tags: e.tags || [], fields: e.fields || [] }
               : { id: id, subject: ficheName(p && p.fiche), __backup_incomplete: true };
    });
    if (!downloadFichesBackup(data)) setStatus("Back-up downloaden mislukt — wegschrijven gaat toch door.");
  }
  // Standalone gate: write with the manager's own progress modal.
  function writePending(keys) {
    var prog = progressModal("Wijzigingen wegschrijven");
    writeFiches(keys, prog.update).then(function (res) {
      prog.done(res.fails.map(function (f) { return { error: f.title + ": " + f.error }; }), keys.length); renderList();
      if (res.trialMisses.length) setStatus("Niet overgenomen door Questi — " + res.trialMisses.join(" · "));
    });
  }
  // Write the staged fiche edits under `keys` (keys of mgr.pending), one by one. Every PATCH mints
  // a NEW fiche id, so the result maps each key to { oldId, newId, subject } — the shared Controleer
  // uses it to point agenda slots at the newest version. A failed key stays staged.
  // → Promise<{ map: { key: {oldId,newId,subject} }, fails: [{ key, title, error }], trialMisses: [] }>
  function writeFiches(keys, onProgress) {
    var trialMisses = [], map = {};
    return runSequential(keys, function (id) {
      var p = mgr.pending[id]; if (!p) return Promise.resolve();
      var opts = {}; if (p.subject != null) opts.subject = p.subject; if (p.text) opts.text = p.text; if (p.tags != null) opts.tags = p.tags; if (p.createTags && p.createTags.length) opts.create_tags = p.createTags;
      if (p.goals && Object.keys(p.goals).length) opts.goals = p.goals;
      if (p.grades) opts.grades = p.grades;
      if (p.visibility) opts.visibility = p.visibility;
      if (p.newFields && p.newFields.length) opts.newFields = p.newFields;
      // Inline title edits carry no edit snapshot — fetch it now (for field ids + current tags).
      var editP = p.edit ? Promise.resolve(p.edit) : readFicheEdit(p.fiche.id);
      return editP.then(function (edit) { p.edit = edit; return writePatch(p.fiche.id, buildPatch(p.fiche.id, edit, opts)); }).then(function (result) {
        var newId = result && result.id != null ? result.id : p.fiche.id, oldId = p.fiche.id;
        map[id] = { oldId: oldId, newId: newId, subject: (result && result.subject != null) ? result.subject : (p.subject != null ? p.subject : ficheName(p.fiche)) };
        if (p.edit && S().noteFicheThread) S().noteFicheThread({ thread: p.edit.thread, id: newId });
        p.fiche.id = newId; if (result && result.subject != null) p.fiche.subject = result.subject;
        if (p.tags != null) mgr.tagChips[newId] = p.tags.map(function (x) { return x; });
        else if (mgr.tagChips[oldId]) mgr.tagChips[newId] = mgr.tagChips[oldId];
        if (oldId !== newId) delete mgr.tagChips[oldId];
        if (mgr.selected[oldId]) { delete mgr.selected[oldId]; mgr.selected[newId] = true; }
        // The new version is a new id: goals mode reads it fresh, which also shows what landed.
        delete mgr.pending[id];
        if (!opts.grades && !opts.visibility) return;
        // Leerjaren/zichtbaarheid are a trial: read the new version back and say so if Questi ignored them.
        return readFicheEdit(newId).then(function (after) {
          if (opts.grades) {
            var got = (after.grades || []).slice().sort().join(), want = opts.grades.slice().sort().join();
            if (got === want) p.fiche.grades = after.grades; else trialMisses.push(ficheName(p.fiche) + ": leerjaren");
          }
          if (opts.visibility && after.visibility !== opts.visibility) trialMisses.push(ficheName(p.fiche) + ": zichtbaarheid");
        }).catch(function () { trialMisses.push(ficheName(p.fiche) + ": niet nagelezen"); });
      });
    }, onProgress).then(function (fails) {
      if (fails.length < keys.length) mgr.dirtyWrites = true;
      notifyPending();
      return {
        map: map, trialMisses: trialMisses,
        fails: fails.map(function (fl) { var p = mgr.pending[fl.item]; return { key: fl.item, title: p ? ficheName(p.fiche) : ("#" + fl.item), error: fl.error }; })
      };
    });
  }

  // ------------------------------------------------------------------------
  //  Shared-Controleer API (planner.js openReview). Tags to create and fiche
  //  edits are listed there next to the calendar changes, and written in order:
  //  tags → fiches → (planner remaps slots to the new fiche ids) → calendar.
  // ------------------------------------------------------------------------
  function pendingCount() { return Object.keys(mgr.pending).length + mgr.pendingTags.length; }
  // Rows for the review. oldEl/newEl (tag chips) are fresh clones, safe to append anywhere.
  function pendingSummary() {
    var tags = mgr.pendingTags.map(function (p) {
      var par = p.parent ? ownTagById(p.parent) : null;
      return { key: p.key, title: p.title, color: p.color, parentTitle: par ? (par.title || "").trim() : "" };
    });
    var fiches = Object.keys(mgr.pending).map(function (id) {
      var p = mgr.pending[id];
      return {
        key: id, ficheId: p.fiche.id, title: ficheName(p.fiche),
        hasGoals: !!(p.goals && Object.keys(p.goals).length),
        changes: (p.changes || []).map(function (c) {
          return { label: c.label, old: c.old, nw: c.nw, oldEl: c.oldEl ? c.oldEl.cloneNode(true) : null, newEl: c.newEl ? c.newEl.cloneNode(true) : null };
        })
      };
    });
    return { tags: tags, fiches: fiches };
  }
  // Backup of the fiches under `keys` as they are NOW: the edit snapshots already read, plus a read
  // (sequential, 150 ms apart) for those staged without one. → Promise<{ downloaded, missing }>
  function backupPending(keys) {
    var need = keys.filter(function (id) { return mgr.pending[id] && !mgr.pending[id].edit; }), missing = 0;
    return runSequential(need, function (id) {
      return readFicheEdit(mgr.pending[id].fiche.id).then(function (edit) { if (mgr.pending[id]) mgr.pending[id].edit = edit; });
    }).then(function (fails) {
      missing = fails.length;
      var data = keys.filter(function (id) { return mgr.pending[id]; }).map(function (id) {
        var p = mgr.pending[id], e = p.edit;
        return e ? { id: e.id, subject: e.subject || "", grades: e.grades || [], tags: e.tags || [], fields: e.fields || [] }
                 : { id: p.fiche.id, subject: ficheName(p.fiche), __backup_incomplete: true };
      });
      return { downloaded: data.length ? downloadFichesBackup(data) : false, missing: missing };
    });
  }
  // Create the staged tags under `keys`. A created tag joins mgr.ownTags; a failed one stays staged.
  // → Promise<{ created: [{ key, tag }], fails: [{ key, title, error }] }>
  function writeTags(keys, onProgress) {
    var created = [];
    var todo = mgr.pendingTags.filter(function (p) { return keys.indexOf(p.key) >= 0; });
    return runSequential(todo, function (p) {
      var body = { title: p.title, color: p.color || "#e0e0e0", schoolId: sid() };
      if (p.parent) body.parent = Number(p.parent);
      return createUserTag(body).then(function (tag) {
        mgr.pendingTags = mgr.pendingTags.filter(function (x) { return x.key !== p.key; });
        if (tag && tag.id != null) mgr.ownTags.push(tag);
        created.push({ key: p.key, tag: tag });
      });
    }, onProgress).then(function (fails) {
      if (created.length) { mgr.dirtyWrites = true; S().invalidateOwnTags(); renderTagBar(); }
      notifyPending();
      return { created: created, fails: fails.map(function (fl) { return { key: fl.item.key, title: fl.item.title, error: fl.error }; }) };
    });
  }
  // After the shared Controleer: redraw whatever host is active (new ids, cleared badges).
  function afterSharedWrite() { if (overlayOpen()) { renderTagBar(); applyFilter(); } }

  // ------------------------------------------------------------------------
  //  Mass-edit tags — tri-state picker + create-tag → STAGES into pending
  // ------------------------------------------------------------------------
  function chipRow(list) { return h("div", { class: "qwl-c-tags" }, list.map(function (tid) { return h("span", { class: "qwl-chip", style: "border-color:" + tagHex(tid) }, [h("span", { class: "qwl-dot", style: "background:" + tagHex(tid) }), h("span", { text: tagName(tid) })]); })); }
  function openTagsModal() {
    var ids = selectedIds(); if (!ids.length) return;
    var addSet = {}, remSet = {};
    var newTagInp = h("input", { class: "qwl-input", type: "text", placeholder: "naam van nieuwe tag (optioneel)" });
    var pickWrap = h("div", { class: "qwl-tagpick" });
    function pill(tg) {
      var st = addSet[tg.id] ? "add" : (remSet[tg.id] ? "rem" : "");
      return h("button", { class: "qwl-pill " + st, onclick: function () {
        if (addSet[tg.id]) { delete addSet[tg.id]; remSet[tg.id] = true; }
        else if (remSet[tg.id]) { delete remSet[tg.id]; }
        else { addSet[tg.id] = true; }
        renderPick();
      } }, [h("span", { class: "qwl-dot", style: "background:" + (tg.color || "#c7ccd1") }), h("span", { text: (tg.title || "").trim() }), h("span", { class: "qwl-pill-mark", text: addSet[tg.id] ? "＋" : (remSet[tg.id] ? "－" : "") })]);
    }
    function renderPick() { renderTagGroups(pickWrap, pill); }
    renderPick();
    var m = modal("Tags bewerken — " + ids.length + " fiches", [
      h("div", { class: "qwl-note", text: "Klik een tag: 1× toevoegen (＋), 2× verwijderen (－), 3× niets. Wijzigingen worden klaargezet; niets wordt geschreven tot '" + reviewName() + "'." }),
      pickWrap,
      h("label", { class: "qwl-flabel", text: "Nieuwe tag maken + toevoegen" }), newTagInp
    ], [], "wide");
    var ft = m.querySelector(".qwl-modal-ft");
    ft.appendChild(h("button", { class: "qwl-btn qwl-ghost", onclick: m.close, text: "Annuleer" }));
    ft.appendChild(h("button", { class: "qwl-btn", onclick: function () {
      var add = Object.keys(addSet), rem = Object.keys(remSet), newName = (newTagInp.value || "").trim();
      if (!add.length && !rem.length && !newName) { m.close(); return; }
      m.close(); stageTagChanges(ids, add, rem, newName);
    }, text: "Klaarzetten" }));
  }
  // Vak tags with their subtags indented beneath, one pill each (shared by both tag pickers).
  function renderTagGroups(wrap, pill) {
    wrap.innerHTML = "";
    var tops = S().topTagsForOwner(mgr.ownTags, ctx().ownerId).filter(function (t) { return !/alle.*lesfiches/i.test(t.title || ""); });
    tops.forEach(function (t) {
      var kids = mgr.ownTags.filter(function (k) { return String(k.parent) === String(t.id); }).sort(function (a, b) { return (a.title || "").localeCompare((b.title || ""), undefined, { numeric: true }); });
      var grp = h("div", { class: "qwl-pickgrp" }, [h("div", { class: "qwl-pickgrp-top" }, [pill(t)])]);
      if (kids.length) grp.appendChild(h("div", { class: "qwl-pickgrp-kids" }, kids.map(pill)));
      wrap.appendChild(grp);
    });
  }
  // Read each selected fiche → compute new tag set → stage into pending (no separate confirm).
  function stageTagChanges(ids, add, rem, newName) {
    var prog = progressModal("Tags klaarzetten");
    var createTags = newName ? [{ name: newName, color: "#e0e0e0" }] : [];
    runSequential(ids, function (id) {
      var f = fiskById(id); if (!f) return Promise.resolve();
      return readFicheEdit(id).then(function (edit) {
        var cur = (edit.tags || []).map(function (t) { return String(t.id); });
        var set = {}; cur.forEach(function (x) { set[x] = true; });
        add.forEach(function (x) { set[String(x)] = true; }); rem.forEach(function (x) { delete set[String(x)]; });
        var next = Object.keys(set);
        var change = { label: "Tags", oldEl: chipRow(cur.map(Number)), newEl: chipRow(next.map(Number)) };
        if (newName) change.newEl = h("div", {}, [chipRow(next.map(Number)), h("span", { class: "qwl-chip", text: "＋ " + newName })]);
        stagePending(f, edit, { tags: next, create_tags: createTags }, [change]);
      });
    }, prog.update).then(function (fails) { prog.done(fails, ids.length); renderList(); if (!fails.length) setStatus(pendCount() + " wijziging(en) klaargezet — druk '" + reviewName() + "'."); });
  }

  // ------------------------------------------------------------------------
  //  Tag-catalog management — create / delete standalone tags (immediate write,
  //  confirmed). Distinct from "Tags bewerken", which sets tags ON selected fiches.
  // ------------------------------------------------------------------------
  // Deletable tags = the user's real (non-default) tags. Default buckets (Alle / Zonder tag /
  // Samenwerk) are system-owned and must never be offered for delete/parent.
  function deletableTags() { return mgr.ownTags.filter(function (t) { return t.type !== "default"; }); }
  function tagPickLabel(t) {
    // Prefix subtags with their parent subject so the flat <select> stays readable.
    var p = (t.parent && String(t.parent) !== "0") ? ownTagById(t.parent) : null;
    return (p ? ((p.title || "").trim() + " › ") : "") + (t.title || "").trim();
  }
  function applyNewTag(tag, wantedParentId) {
    if (wantedParentId && (tag.parent == null || String(tag.parent) === "0")) {
      setStatus("Tag toegevoegd als hoofd-tag (subtag niet ondersteund door Questi).");
    } else {
      setStatus("Tag toegevoegd.");
    }
    mgr.ownTags.push(tag);
    mgr.dirtyWrites = true;
    S().invalidateOwnTags();
    renderTagBar();
  }
  function applyRemovedTag(id, action, secondTagId) {
    mgr.ownTags = mgr.ownTags.filter(function (t) { return String(t.id) !== String(id); });
    // Keep per-fiche tag chips coherent: drop the id everywhere, or remap it on a move.
    Object.keys(mgr.tagChips).forEach(function (fid) {
      var l = mgr.tagChips[fid];
      var next = [];
      l.forEach(function (x) {
        if (String(x) === String(id)) { if (action === "move" && secondTagId != null) next.push(Number(secondTagId)); }
        else next.push(x);
      });
      // dedupe (a move may collide with an existing membership)
      mgr.tagChips[fid] = next.filter(function (v, i) { return next.indexOf(v) === i; });
    });
    mgr.dirtyWrites = true;
    S().invalidateOwnTags();
    setStatus("Tag verwijderd.");
    if (String(mgr.tagFilter) === String(id)) { loadList(allOwnTagId()); }
    else { renderTagBar(); renderList(); }
  }
  function modalNote(m, msg) {
    var bd = m.querySelector(".qwl-modal-bd");
    var old = bd.querySelector(".qwl-note.qwl-warn.qwl-live"); if (old) old.remove();
    bd.appendChild(h("div", { class: "qwl-note qwl-warn qwl-live", text: msg }));
  }
  function openAddTagModal() {
    var nameInp = h("input", { class: "qwl-input", type: "text", placeholder: "naam van de tag" });
    var colorInp = h("input", { class: "qwl-color", type: "color", value: "#e0e0e0" });
    var subjects = S().topTagsForOwner(mgr.ownTags, ctx().ownerId).filter(isSubjectTop);
    var parentSel = h("select", { class: "qwl-gradesel" },
      [h("option", { value: "", text: "Hoofd-tag (geen vak)" })].concat(subjects.map(function (t) {
        return h("option", { value: String(t.id), text: (t.title || "").trim() });
      })));
    // Mounted (planner tab): the tag is STAGED and created by the shared Controleer, first of all.
    var staged = isMounted();
    var m = modal("Tag toevoegen", [
      h("label", { class: "qwl-flabel", text: "Naam" }), nameInp,
      h("label", { class: "qwl-flabel", text: "Kleur" }), colorInp,
      h("label", { class: "qwl-flabel", text: "Onder vak (optioneel)" }), parentSel,
      h("div", { class: "qwl-note", text: "Een subtag valt onder een vak; laat op 'Hoofd-tag' staan voor een nieuw vak." }),
      staged ? h("div", { class: "qwl-note", text: "De tag wordt klaargezet en pas aangemaakt bij Controleer. Fiches kun je er daarna aan toevoegen." }) : null
    ], [], "");
    var ft = m.querySelector(".qwl-modal-ft");
    ft.appendChild(h("button", { class: "qwl-btn qwl-ghost", onclick: m.close, text: "Annuleer" }));
    ft.appendChild(h("button", { class: "qwl-btn", onclick: function () {
      var title = (nameInp.value || "").trim();
      if (!title) { modalNote(m, "Geef een naam op."); return; }
      var parentId = parentSel.value || null;
      var dup = mgr.ownTags.concat(mgr.pendingTags).some(function (t) { return (t.title || "").trim().toLowerCase() === title.toLowerCase() && String(t.parent || "0") === String(parentId || "0"); });
      if (dup) { modalNote(m, "Die tag bestaat al (of staat al klaar)."); return; }
      if (staged) {
        mgr.pendingTags.push({ key: "t" + Date.now() + "_" + mgr.pendingTags.length, title: title, color: colorInp.value || "#e0e0e0", parent: parentId });
        if (parentId) mgr.expandedTop = parentId;
        m.close(); renderTagBar(); notifyPending();
        setStatus("Tag '" + title + "' klaargezet — wordt aangemaakt bij Controleer.");
        return;
      }
      var body = { title: title, color: colorInp.value || "#e0e0e0", schoolId: sid() };
      if (parentId) body.parent = Number(parentId);
      setStatus("Tag aanmaken…");
      createUserTag(body).then(function (tag) {
        m.close(); applyNewTag(tag, parentId);
      }).catch(function (e) { modalNote(m, "Aanmaken faalde: " + ((e && e.message) || e)); });
    }, text: staged ? "Klaarzetten" : "Toevoegen" }));
    setTimeout(function () { try { nameInp.focus(); } catch (e) {} }, 0);
  }
  function openRemoveTagModal() {
    var tags = deletableTags();
    if (!tags.length) {
      var mm = modal("Tag verwijderen", [h("div", { class: "qwl-note", text: "Je hebt geen eigen tags om te verwijderen." })], [], "");
      mm.querySelector(".qwl-modal-ft").appendChild(h("button", { class: "qwl-btn", onclick: mm.close, text: "OK" }));
      return;
    }
    tags = tags.slice().sort(function (a, b) { return tagPickLabel(a).localeCompare(tagPickLabel(b), undefined, { numeric: true }); });
    var tagSel = h("select", { class: "qwl-gradesel" }, tags.map(function (t) { return h("option", { value: String(t.id), text: tagPickLabel(t) }); }));
    // Second select (move target) — all deletable tags except the currently selected one.
    var moveSel = h("select", { class: "qwl-gradesel" });
    function fillMoveSel() {
      moveSel.innerHTML = "";
      tags.filter(function (t) { return String(t.id) !== String(tagSel.value); })
        .forEach(function (t) { moveSel.appendChild(h("option", { value: String(t.id), text: tagPickLabel(t) })); });
    }
    fillMoveSel();
    tagSel.addEventListener("change", fillMoveSel);
    var rUnlink = h("input", { type: "radio", name: "qwl-delmode", value: "unlink", checked: "true" });
    var rMove = h("input", { type: "radio", name: "qwl-delmode", value: "move" });
    var moveRow = h("div", { class: "qwl-delmove", style: "display:none" }, [
      h("label", { class: "qwl-flabel", text: "Verplaats fiches naar" }), moveSel
    ]);
    function syncMode() { moveRow.style.display = rMove.checked ? "" : "none"; }
    rUnlink.addEventListener("change", syncMode); rMove.addEventListener("change", syncMode);
    var m = modal("Tag verwijderen", [
      h("label", { class: "qwl-flabel", text: "Tag" }), tagSel,
      h("label", { class: "qwl-radio" }, [rUnlink, h("span", { text: " Verwijder tag — fiches blijven bestaan, verliezen enkel deze tag" })]),
      h("label", { class: "qwl-radio" }, [rMove, h("span", { text: " Verplaats fiches naar een andere tag, dan verwijder" })]),
      moveRow,
      h("div", { class: "qwl-note", text: "Er worden geen lesfiches verwijderd." })
    ], [], "");
    var ft = m.querySelector(".qwl-modal-ft");
    ft.appendChild(h("button", { class: "qwl-btn qwl-ghost", onclick: m.close, text: "Annuleer" }));
    ft.appendChild(h("button", { class: "qwl-btn qwl-danger", onclick: function () {
      var id = tagSel.value; if (!id) return;
      var action = rMove.checked ? "move" : "unlink";
      var second = action === "move" ? moveSel.value : null;
      if (action === "move" && !second) { modalNote(m, "Kies een tag om naartoe te verplaatsen."); return; }
      setStatus("Tag verwijderen…");
      deleteUserTag(id, action, second).then(function () {
        m.close(); applyRemovedTag(id, action, second);
      }).catch(function (e) { modalNote(m, "Verwijderen faalde: " + ((e && e.message) || e)); });
    }, text: "Verwijderen" }));
  }

  // ------------------------------------------------------------------------
  //  Backup-on-delete — dump full editable content to a JSON file before the
  //  irreversible DELETE, so deleted fiches (incl. ZILL/OPSTAP goals) can be rebuilt.
  // ------------------------------------------------------------------------
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function tsStamp() { var d = new Date(); return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()); }
  function downloadFichesBackup(data) {
    try {
      var payload = { tool: "Questi Lesfiche-manager", exported_at: new Date().toISOString(), count: data.length, fiches: data };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = h("a", { href: url, download: "questi-lesfiches-backup-" + tsStamp() + ".json", style: "display:none" });
      mgr.els.page.appendChild(a); a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 0);
      return true;
    } catch (e) { console.error("[QWL] backup-download faalde:", e); return false; }
  }
  // Read full content per id (best-effort, sequential), download whatever we captured,
  // and report which ids failed to read. Never deletes — that's the caller's decision.
  function backupBeforeDelete(ids, prog) {
    var captured = [];
    return runSequential(ids, function (id) {
      return readFicheEdit(id).then(function (edit) {
        var f = fiskById(id);
        captured.push({
          id: id,
          subject: (edit && edit.subject) || (f && f.subject) || "",
          grades: (edit && edit.grades) || (f && f.grades) || [],
          tags: (edit && edit.tags) || [],
          tagIds: mgr.tagChips[id] || [],
          fields: (edit && edit.fields) || []
        });
      });
    }, function (done, total) { if (prog) prog.update(done, total); }).then(function (fails) {
      // Record read-failures too, with whatever list-level data we still have.
      fails.forEach(function (fl) { var id = fl.item, f = fiskById(id); captured.push({ id: id, subject: (f && f.subject) || "", grades: (f && f.grades) || [], tagIds: mgr.tagChips[id] || [], fields: [], __backup_incomplete: true }); });
      var downloaded = downloadFichesBackup(captured);
      return { downloaded: downloaded, failed: fails };
    });
  }

  // ------------------------------------------------------------------------
  //  Bulk delete — typed confirm + test-one-first (irreversible)
  // ------------------------------------------------------------------------
  function openDeleteModal() {
    var ids = selectedIds(); if (!ids.length) return;
    var list = ids.map(function (id) { var f = fiskById(id); return h("div", { class: "qwl-delrow", text: (f ? ficheName(f) : ("#" + id)) + "  ·  #" + id }); });
    var typed = h("input", { class: "qwl-input", type: "text", placeholder: "typ VERWIJDER" });
    var m = modal("Verwijderen — " + ids.length + " fiches", [
      h("div", { class: "qwl-note qwl-warn", text: "Definitief en onomkeerbaar — geen server-undo. Typ VERWIJDER om te bevestigen." }),
      h("div", { class: "qwl-dellist" }, list), typed
    ], [], "wide");
    var ft = m.querySelector(".qwl-modal-ft");
    var btnTest = h("button", { class: "qwl-btn qwl-danger", disabled: "true", onclick: function () { doDelete(m, ids, true); }, text: "Verwijder 1 (test)" });
    var btnAll = h("button", { class: "qwl-btn qwl-danger", disabled: "true", onclick: function () { doDelete(m, ids, false); }, text: "Verwijder alle" });
    typed.addEventListener("input", function () { var ok = (typed.value || "").trim() === "VERWIJDER"; btnTest.disabled = ok ? null : "true"; btnAll.disabled = ok ? null : "true"; });
    ft.appendChild(h("button", { class: "qwl-btn qwl-ghost", onclick: m.close, text: "Annuleer" }));
    ft.appendChild(btnTest); ft.appendChild(btnAll);
  }
  function doDelete(m, ids, testOnly) {
    var batch = testOnly ? ids.slice(0, 1) : ids;
    m.close();
    var prog = progressModal(testOnly ? "Testverwijdering" : "Verwijderen");
    prog.update(0, batch.length);
    setStatus("Back-up maken vóór verwijderen…");
    // Irreversible: back up FULL content first, then delete. If the backup couldn't be fully
    // captured, make the user explicitly confirm deleting without a complete safety net.
    backupBeforeDelete(batch, prog).then(function (backup) {
      if (backup.failed.length && !window.confirm("Back-up mislukt voor " + backup.failed.length + " van " + batch.length + " fiche(s). Toch definitief verwijderen zonder volledige back-up?")) {
        prog.done([{ error: "Geannuleerd — geen volledige back-up." }], batch.length);
        return;
      }
      prog.update(0, batch.length);
      return deleteFiches(batch).then(function () {
        mgr.dirtyWrites = true;
        var gone = {}; batch.forEach(function (id) { gone[id] = true; delete mgr.selected[id]; delete mgr.tagChips[id]; delete mgr.pending[id]; });
        if (gone[mgr.sheetFid]) closeSheet();
        notifyPending();
        mgr.fiches = mgr.fiches.filter(function (f) { return !gone[f.id]; });
        prog.done([], batch.length); applyFilter();
        setStatus(testOnly ? "1 verwijderd (back-up gedownload) — controleer in Questi, verwijder daarna de rest." : (batch.length + " verwijderd — back-up gedownload."));
      });
    }).catch(function (e) { prog.done([{ error: (e && e.message) || String(e) }], batch.length); });
  }

  // ------------------------------------------------------------------------
  //  Progress modal
  // ------------------------------------------------------------------------
  function progressModal(title) {
    var bar = h("div", { class: "qwl-bar-fill" });
    var txt = h("div", { class: "qwl-prog-txt", text: "0 / ?" });
    var m = modal(title, [txt, h("div", { class: "qwl-bar" }, [bar])], [], "");
    return {
      update: function (done, total) { txt.textContent = done + " / " + total; bar.style.width = total ? Math.round(done / total * 100) + "%" : "0%"; },
      done: function (fails, total) {
        var ft = m.querySelector(".qwl-modal-ft");
        m.querySelector(".qwl-prog-txt").textContent = fails && fails.length ? (fails.length + " van " + total + " mislukt.") : ("Klaar — " + total + " verwerkt.");
        if (fails && fails.length) m.querySelector(".qwl-modal-bd").appendChild(h("div", { class: "qwl-note qwl-warn", text: fails.map(function (f) { return f.error; }).slice(0, 8).join(" · ") }));
        ft.innerHTML = ""; ft.appendChild(h("button", { class: "qwl-btn", onclick: m.close, text: "Sluiten" }));
      }
    };
  }

  // ========================================================================
  //  Import (Phase 2 — SCAFFOLD, gated by mgr.importEnabled; OPSTAP resolver stubbed)
  //  Barebones so August only needs resolveGoals() + a host permission + enabling the button.
  // ========================================================================
  var _templatesCache = null;
  function fetchTemplates() {
    if (_templatesCache) return Promise.resolve(_templatesCache);
    return jget(api() + "/lessons/templates?" + qs({ schoolId: sid() })).then(function (j) { _templatesCache = (j && j.result) || []; return _templatesCache; });
  }
  // Split pasted CSV/TSV into row objects. First line = header. No silent magic.
  function parseImport(text) {
    var lines = String(text || "").replace(/\r/g, "").split("\n").filter(function (l) { return l.trim() !== ""; });
    if (!lines.length) return [];
    var delim = lines[0].indexOf("\t") !== -1 ? "\t" : (lines[0].indexOf(";") !== -1 ? ";" : ",");
    var head = lines[0].split(delim).map(function (s) { return s.trim().toLowerCase(); });
    return lines.slice(1).map(function (ln) {
      var cells = ln.split(delim), row = {};
      head.forEach(function (col, i) { row[col] = (cells[i] || "").trim(); });
      return row;
    });
  }
  // TODO(OPSTAP): map leerplandoelen codes → ZILL numeric goal ids (via /lessons/goals/36).
  // Until then, return [] and flag every code as unresolved so nothing is silently wrong.
  function resolveGoals(codes) { return { selected_goals: [], unresolved: (codes || []).slice() }; }
  // Build a POST /cal/lessons body for one import row against a template's structure.
  function buildCreateBody(row, template, tagIds) {
    var fields = ((template && template.structure) || []).map(function (fld) {
      if (fld.type === "goals") { var g = resolveGoals((row.leerplandoelen || "").split(/[;,\s]+/).filter(Boolean)); return { field_type: "goals", template_field_id: fld.id, selected_goals: g.selected_goals }; }
      var map = { doelen: row.doelen, lesverloop: row.lesverloop, materiaal: row.materiaal };
      var content = map[(fld.title || "").toLowerCase()] != null ? map[(fld.title || "").toLowerCase()] : "";
      return { field_type: "text", template_field_id: fld.id, content: content };
    });
    return { schoolId: sid(), subject: row.titel || "", grades: row.leerjaar ? [row.leerjaar] : [], visibility: "school", tags: tagIds || [], create_tags: [], attachments: [], templateId: template && template.id, fields: fields };
  }
  function createFiche(body) {
    return fetch(api() + "/lessons?return_format=short", { method: "POST", credentials: "include", headers: S().writeHeaders(), body: JSON.stringify(body) }).then(resolveJson("POST lesson", body.subject, body));
  }
  // Minimal preview view — only reachable when importEnabled (dormant scaffold for now).
  function openImportView() {
    var ta = h("textarea", { class: "qwl-textarea", rows: "8", placeholder: "Plak hier je CSV/Excel-rijen (eerste regel = kopregel: titel;vak;leerjaar;doelen;leerplandoelen;lesverloop;materiaal)" });
    var preview = h("div", { class: "qwl-import-preview" });
    var m = modal("Importeren (bèta)", [
      h("div", { class: "qwl-note", text: "Scaffold — OPSTAP-doelen worden later toegevoegd. Niets wordt geschreven zonder dry-run + 'Test 1 fiche'." }),
      ta, h("button", { class: "qwl-btn qwl-ghost", onclick: function () { renderPreview(); }, text: "Voorbeeld tonen" }), preview
    ], [], "wide");
    function renderPreview() {
      preview.innerHTML = "";
      var rows = parseImport(ta.value);
      if (!rows.length) { preview.appendChild(h("div", { class: "qwl-note", text: "Geen rijen." })); return; }
      rows.slice(0, 50).forEach(function (r) { preview.appendChild(h("div", { class: "qwl-delrow", text: (r.titel || "(zonder titel)") + "  ·  " + (r.vak || "?") + "  ·  " + (r.leerjaar || "?") })); });
      preview.appendChild(h("div", { class: "qwl-note", text: rows.length + " rij(en). (Wegschrijven nog niet actief — OPSTAP volgt.)" }));
    }
    var ft = m.querySelector(".qwl-modal-ft"); ft.appendChild(h("button", { class: "qwl-btn", onclick: m.close, text: "Sluiten" }));
  }

  // ========================================================================
  //  Diagnose / Zelftest (read-only — never writes)
  // ========================================================================
  function diagGet(path) {
    return fetch(path, { credentials: "include", headers: { "Accept": "application/json" } }).then(function (r) {
      var ct = r.headers.get("content-type") || "";
      if (ct.indexOf("json") < 0) return { status: r.status, json: null, html: true };
      return r.json().then(function (j) { return { status: r.status, json: j, html: false }; }).catch(function () { return { status: r.status, json: null, html: false }; });
    }).catch(function () { return { status: 0, json: null }; });
  }
  function has(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null; }
  function openDiag() {
    var list = h("div", { class: "qwl-diag-list" }), rows = [];
    function pill(s) { return h("span", { class: "qwl-diag-pill " + s.toLowerCase(), text: s }); }
    function addRow(row) { rows.push(row); list.appendChild(h("div", { class: "qwl-diag-row" }, [h("div", { class: "qwl-diag-hd" }, [pill(row.status), h("span", { class: "qwl-diag-name", text: row.name })]), (row.detail ? h("div", { class: "qwl-diag-detail", text: row.detail }) : null), (row.status !== "OK" && row.next ? h("div", { class: "qwl-diag-next", text: "→ " + row.next }) : null)])); list.scrollTop = list.scrollHeight; }
    function copyReport() {
      var lines = ["Questi Lesfiche-manager — Zelftest", "", ]; rows.forEach(function (r) { lines.push("[" + r.status + "] " + r.name + (r.detail ? " — " + r.detail : "") + (r.status !== "OK" && r.next ? " — " + r.next : "")); });
      // The methode-fiche probe decides whether copying is possible at all, so the report
      // carries its raw shape — key names only, never the lesson content itself.
      if (lastProbe) {
        lines.push("", "--- Methodefiche-probe (ruw) ---");
        lines.push("methode: " + lastProbe.methodKey + " · les " + lastProbe.lessonId + " · \"" + (lastProbe.lessonSubject || "") + "\"");
        lines.push("lijstvelden: " + (lastProbe.listKeys || []).join(", "));
        lastProbe.tries.forEach(function (t) {
          lines.push("  " + (t.guess ? "[gok] " : "return_format=") + t.fmt + " → HTTP " + t.status + (t.err ? " · " + t.err : ""));
          if (t.result) {
            lines.push("    result keys: " + Object.keys(t.result).join(", "));
            (t.result.fields || []).forEach(function (f, i) {
              lines.push("    field[" + i + "] type=" + f.type + " tfid=" + f.template_field_id
                + " keys=" + Object.keys(f).join("/")
                + (f.type === "goals" && f.source && f.source.version ? " goalsVersion=" + f.source.version.id : ""));
            });
            (t.result.attachments || []).forEach(function (a, i) {
              lines.push("    attachment[" + i + "] keys=" + Object.keys(a).join("/") + " content keys=" + Object.keys(a.content || {}).join("/"));
            });
          }
        });
      }
      var text = lines.join("\n");
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { setStatus("Rapport gekopieerd."); }); else { var t = document.createElement("textarea"); t.value = text; mgr.els.page.appendChild(t); t.select(); try { document.execCommand("copy"); } catch (e) {} t.remove(); }
    }
    var m = modal("Zelftest — leest alleen, schrijft nooit", [h("div", { class: "qwl-note", text: "Controleert of de live Questi-API nog overeenkomt met wat de manager verwacht." }), list], [], "wide");
    var ft = m.querySelector(".qwl-modal-ft");
    ft.appendChild(h("button", { class: "qwl-btn qwl-ghost", onclick: copyReport, text: "Rapport kopiëren" }));
    ft.appendChild(h("button", { class: "qwl-btn", onclick: m.close, text: "Sluiten" }));
    runDiag(addRow);
  }
  // ------------------------------------------------------------------------
  //  Probe: can a METHODE fiche's content be read?
  //  Methode fiches are vendor content and reject the normal attachment endpoint
  //  (1235 "no access to lesson"). Whether /lessons/{id} also refuses them has never
  //  been observed — and the whole "copy a methode fiche into my own library" feature
  //  depends on the answer. Strictly read-only: three GETs, no writes.
  //  `mm.lastProbe` keeps the raw result so "Rapport kopiëren" can carry the details.
  // ------------------------------------------------------------------------
  var lastProbe = null;
  // Deepest is_goal:true nodes of a concordance tree. The tree marks several levels as goals
  // (the generic doel AND its leerlijn leaves); which level a create actually wants is still
  // unverified, so this reports the leaves and never writes anything.
  function leafGoalIds(nodes) {
    var out = [];
    (function walk(list) {
      (list || []).forEach(function (n) {
        var kids = n.children || [];
        if (kids.length) walk(kids);
        else if (n.is_goal && n.id != null) out.push(n.id);
      });
    })(nodes);
    return out;
  }
  function probeMethodLesson(addRow) {
    lastProbe = null;
    return diagGet(api() + "/manage/methods/" + sid()).then(function (r) {
      var methods = (r.json && r.json.result) || [];
      if (!methods.length) { addRow({ status: "SKIP", name: "Methodefiche — inhoud leesbaar?", detail: "school heeft geen methodes" }); return; }
      // Which methodes exist and which are actually available. The new-curriculum methodes
      // (Camino, rekenroute) are not published yet — this row is how you see them arrive.
      var avail = methods.filter(function (m) { return m.available; });
      addRow({
        status: "OK", name: "Methodes — beschikbaarheid",
        detail: avail.length + "/" + methods.length + " beschikbaar · "
          + methods.map(function (m) { return (m.name || m.id) + (m.available ? "" : " (niet beschikbaar)"); }).join(" · ")
      });
      // Prefer an available methode as the probe subject; an unavailable one proves nothing.
      var mth = avail[0] || methods[0];
      return diagGet(api() + "/methods/" + encodeURIComponent(mth.id) + "/lessons?" + qs({ is_cluster: !!mth.is_cluster, schoolId: sid() })).then(function (r2) {
        var lessons = (r2.json && r2.json.result) || [];
        if (!lessons.length) { addRow({ status: "SKIP", name: "Methodefiche — inhoud leesbaar?", detail: "geen lessen in " + mth.id }); return; }
        var lid = lessons[0].id;
        // CONFIRMED 2026-08-16: only the methode-scoped route returns content. /cal/lessons/{id}
        // answers 1235 for vendor content on every return_format — kept as a contract check so a
        // future Questi change that opens it up (or breaks the scoped route) is visible.
        var routes = [
          { fmt: "methods/{key}/lessons/{id}", url: api() + "/methods/" + encodeURIComponent(mth.id) + "/lessons/" + lid + "?" + qs({ schoolId: sid(), is_cluster: !!mth.is_cluster }) },
          { fmt: "lessons/{id}?return_format=edit", url: api() + "/lessons/" + lid + "?" + qs({ schoolId: sid(), return_format: "edit" }) }
        ];
        return routes.reduce(function (chain, g) {
          return chain.then(function (acc) {
            return diagGet(g.url).then(function (rr) {
              acc.push({ fmt: g.fmt, status: rr.status, err: (rr.json && rr.json.error_msg) || null, result: (rr.json && rr.json.result) || null });
              return acc;
            });
          });
        }, Promise.resolve([])).then(function (tries) {
          lastProbe = { methodKey: mth.id, methodName: mth.name, lessonId: lid, lessonSubject: lessons[0].subject, listKeys: Object.keys(lessons[0]), tries: tries };
          // What the LIST row itself carries is the floor of what a copy could ever use.
          addRow({ status: "OK", name: "Methodefiche — velden in de lijst", detail: Object.keys(lessons[0]).join(", ") });
          var win = tries.filter(function (t) { return t.status === 200 && t.result; })[0];
          if (!win) {
            addRow({
              status: "FAIL", name: "Methodefiche — inhoud leesbaar?",
              detail: tries.map(function (t) { return t.fmt + ":" + t.status + (t.err ? " (" + t.err + ")" : ""); }).join(" · "),
              next: "Geen enkele route geeft inhoud → volledige kopie onmogelijk. Vang de call op die Questi's eigen UI gebruikt om een methodefiche te tonen."
            });
            return;
          }
          var res = win.result, fields = res.fields || [];
          var methodsFld = fields.filter(function (f) { return f.type === "methods"; })[0];
          var textWithContent = fields.filter(function (f) { return f.type === "text" && f.content; }).length;
          // Count the leaf goals in the concordance — those numeric ids are what a create's
          // selected_goals needs, and they are the only curriculum data a copy can carry.
          var conc = (methodsFld && methodsFld.concordances && methodsFld.concordances[0]) || null;
          var goalIds = conc ? leafGoalIds(conc.content && conc.content.goals) : [];
          var goalsVersion = conc && conc.source && conc.source.version ? (conc.source.version.format_type + " v" + conc.source.version.id) : "geen";
          addRow({
            status: "OK",
            name: "Methodefiche — inhoud leesbaar (" + win.fmt + ")",
            detail: "velden:" + fields.length + " [" + fields.map(function (f) { return f.type; }).join(",") + "]"
              + " · tekstvelden met inhoud:" + textWithContent
              + " · concordantie:" + goalsVersion + " · doel-ids:" + goalIds.length
              + " · bijlagen:" + ((res.attachments || []).length)
              + " · template:" + (res.template == null ? "geen" : res.template)
          });
          // No prose to copy: a methode fiche is doelen + concordance. The Lesverloop/Materiaal
          // fields live in the school's own template and are the teacher's to fill.
          if (!textWithContent) {
            addRow({ status: "WARN", name: "Methodefiche — geen lesverloop/materiaal", detail: "vendor levert enkel doelen + concordantie", next: "Een kopie kan geen lestekst overnemen — die bestaat niet." });
          }
          // A copy needs a templateId. Match it exactly on the methode key, no guessing.
          return diagGet(api() + "/lessons/templates?" + qs({ schoolId: sid() })).then(function (rt) {
            var tpls = (rt.json && rt.json.result) || [];
            var match = tpls.filter(function (t) {
              return (t.structure || []).some(function (f) { return f.type === "methods" && f.method && String(f.method.id) === String(mth.id); });
            })[0];
            addRow({
              status: match ? "OK" : "WARN",
              name: "Methodefiche — passend template",
              detail: match ? ("\"" + match.name + "\" (#" + match.id + ") via method.id " + mth.id) : ("geen template verwijst naar " + mth.id),
              next: match ? null : "Kopie moet handmatig een template krijgen."
            });
            addRow({ status: "OK", name: "Methodefiche — proefobject", detail: mth.name + " · les " + lid + " · \"" + (lessons[0].subject || "") + "\"" });
          });
        });
      });
    });
  }

  function runDiag(addRow) {
    var sampleFicheId = null, userTag = mgr.ownTags.filter(function (t) { return t.type !== "default"; })[0];
    var checks = [
      function () { return diagGet(api() + "/lessons?" + qs({ schoolId: sid(), status: "active", num: 1, offset: 0, default_tagId: allOwnTagId() })).then(function (r) {
        if (r.html || r.status === 401 || r.status === 403) { addRow({ status: "FAIL", name: "Auth & connectiviteit", detail: "geen JSON / " + r.status, next: "Open Questi en log in." }); return "STOP"; }
        var arr = (r.json && r.json.result) || []; sampleFicheId = arr[0] && arr[0].id;
        addRow({ status: r.status === 200 ? "OK" : "WARN", name: "Auth & eigen-lijst", detail: "num_records " + (r.json && r.json.num_records) + ", velden " + (arr[0] ? Object.keys(arr[0]).filter(function (k) { return ["id", "subject", "grades"].indexOf(k) !== -1; }).join("/") : "—") });
      }); },
      function () { return diagGet(api() + "/lessons/tags?" + qs({ schoolId: sid(), filter: "own" })).then(function (r) {
        var arr = (r.json && r.json.result) || [], kids = arr.filter(function (t) { return String(t.parent) !== "0"; });
        addRow({ status: arr.length ? (kids.length ? "OK" : "WARN") : "FAIL", name: "Eigen tags (+ subtags)", detail: arr.length + " tags, " + kids.length + " subtags", next: kids.length ? null : "Geen subtags — vak-filters tonen niets onder de vakken." });
      }); },
      function () { if (!userTag) { addRow({ status: "SKIP", name: "Tag-parameter (user_tagId)", detail: "geen user-tag" }); return; } return diagGet(api() + "/lessons?" + qs({ schoolId: sid(), status: "active", num: 1, user_tagId: userTag.id })).then(function (r) {
        addRow({ status: r.status === 200 ? "OK" : "FAIL", name: "Tag-parameter (user_tagId)", detail: "HTTP " + r.status + " voor tag " + userTag.id, next: r.status === 200 ? null : "user_tagId werkt niet meer — controleer de tag-filter." });
      }); },
      function () { return diagGet(api() + "/lessons?" + qs({ schoolId: sid(), status: "active", num: 1, default_tagId: 1 })).then(function (r) { addRow({ status: r.status === 200 ? "OK" : "WARN", name: "Zonder tag (default_tagId=1)", detail: "HTTP " + r.status }); }); },
      function () { if (!sampleFicheId) { addRow({ status: "SKIP", name: "Fiche edit-contract", detail: "geen sample" }); return; } return diagGet(api() + "/lessons/" + sampleFicheId + "?" + qs({ schoolId: sid(), return_format: "edit" })).then(function (r) {
        // Judge a TEMPLATE field — an extra (per-fiche) field can come first and has template_field_id null.
        var res = r.json && r.json.result, fld = res && res.fields && (res.fields.filter(function (x) { return x && x.template_field_id != null; })[0] || res.fields[0]);
        addRow({ status: (res && res.fields && has(fld, "id") && has(fld, "template_field_id")) ? "OK" : "FAIL", name: "Fiche edit-contract", detail: "tags[" + ((res && res.tags) || []).length + "], fields[" + ((res && res.fields) || []).length + "]", next: (res && res.fields) ? null : "return_format=edit levert geen fields — bewerken kan breken." });
        // Lesdoelen live in per-fiche extra fields: { id, type:"text", title, content, template_field_id:null }.
        var extra = ((res && res.fields) || []).filter(function (x) { return x && x.template_field_id === null; });
        if (!extra.length) addRow({ status: "SKIP", name: "Extra velden (lesdoelen)", detail: "sample-fiche heeft geen extra velden" });
        else {
          var okShape = extra.every(function (x) { return has(x, "id") && has(x, "title") && has(x, "content"); });
          var gf = S().ficheGoalFields(res), kinds = ["weet", "ken", "kan"].filter(function (k) { return gf[k]; });
          addRow({ status: okShape ? "OK" : "FAIL", name: "Extra velden (lesdoelen)", detail: extra.length + " extra veld(en): " + extra.map(function (x) { return x.title; }).join(", ") + (kinds.length ? " · doelen: " + kinds.join("/").toUpperCase() : ""),
            next: okShape ? null : "Vorm van extra velden veranderd — lesdoelen lezen/schrijven kan breken." });
        }
      }); },
      function () { return diagGet(api() + "/lessons/templates?" + qs({ schoolId: sid() })).then(function (r) {
        var arr = (r.json && r.json.result) || [];
        addRow({ status: arr.length ? "OK" : "WARN", name: "Templates (import)", detail: arr.length + " templates", next: arr.length ? null : "Import nog niet klaar / geen templates." });
        if (!arr.length) return;
        // Which curriculum versions are in use, and which templates link to a vendor methode.
        // Old (ZILL) templates carry a `methods` field; the new Op.Stap ones so far do not —
        // that difference decides whether a methode-fiche copy is even possible per vak.
        var vers = {}, withMethod = 0;
        arr.forEach(function (t) {
          var hasM = false;
          (t.structure || []).forEach(function (f) {
            if (f.type === "methods") hasM = true;
            var v = f.source && f.source.version;
            if (v) vers[(v.format_type || "?") + " v" + v.id] = (vers[(v.format_type || "?") + " v" + v.id] || 0) + 1;
          });
          if (hasM) withMethod++;
        });
        addRow({
          status: "OK", name: "Templates — leerplan + methodekoppeling",
          detail: Object.keys(vers).map(function (k) { return k + "×" + vers[k]; }).join(" · ")
            + " · " + withMethod + "/" + arr.length + " templates met methode-veld"
        });
      }); },
      // ---- Methode-fiche leesbaarheid (probe voor "kopieer methodefiche") ----
      // Niets in de extensie heeft ooit de INHOUD van een methodefiche gelezen. Zonder dat is
      // kopiëren onmogelijk. Deze checks lezen alleen en beantwoorden de vraag definitief.
      function () { return probeMethodLesson(addRow); },
      function () { var t = S().xsrfToken(); addRow({ status: t ? "OK" : "WARN", name: "XSRF-token", detail: t ? "cookie leesbaar" : "leeg", next: t ? null : "Schrijfacties (PATCH/POST/DELETE) hebben x-xsrf-token nodig." }); }
    ];
    var i = 0;
    (function next() { if (i >= checks.length) return; var c = checks[i++]; Promise.resolve().then(c).then(function (r) { if (r === "STOP") return; setTimeout(next, 60); }).catch(function () { setTimeout(next, 60); }); })();
  }

  // ---------- Export ----------
  // createUserTag: settings.js creates a missing vak on import/setup — only after an explicit confirm.
  // mount/unmount: the planner's Lesfiches tab. pendingCount/pendingSummary/backupPending/writeTags/
  // writeFiches/afterSharedWrite: the planner's shared Controleer (tags → fiches → calendar).
  window.__QWP_LESSONS = {
    open: open, close: close, openPicker: openPicker, runSequential: runSequential, createUserTag: createUserTag,
    mount: mount, unmount: unmount, isMounted: isMounted,
    pendingCount: pendingCount, pendingSummary: pendingSummary, backupPending: backupPending,
    writeTags: writeTags, writeFiches: writeFiches, afterSharedWrite: afterSharedWrite
  };
})();
