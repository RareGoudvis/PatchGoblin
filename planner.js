/* Questi Week Planner (QWP) — planner.js
 * FULLSCREEN planning page for the Questi calendar.
 *
 * NO account-specific constants are baked in. schoolId, schoolyear, ownerId,
 * calendarId and groupId are all discovered at runtime by detectContext():
 *   - schoolId / schoolyear: scraped from the live Questi page (localStorage /
 *     sessionStorage / SPA globals / meta), then cross-checked/derived from the
 *     groups[].schoolId of the account's own agenda items.
 *   - calendarId / groupId: derived from the actually-loaded week items
 *     (id_calendar most common non-holiday calendar; groups[0]).
 *   - ownerId: from a tag with is_owner (or the owner.id of an own fiche).
 * If detection fails, the UI shows a clear error instead of silently loading 0.
 *
 * Layout (UnQuesti "Plannen"): fullscreen page; a 360px sidebar (tabs Plannen ·
 * Lesfiches · Afdrukken, vak chips, Ik/Collega, folding filter, ONE fiche list,
 * pinned Alles · Instellingen · Debug · Controleer); a main column with this week
 * and next week STACKED, cards in the Lesdoelen-print look, and a Plannen | Doelen
 * switch. Thema rows span the week; pauze/speeltijd gap bands; every cell clickable.
 *
 * Safety: single-occurrence writes (apply_to_next_items=false); mandatory
 * dry-run review; "Wegschrijven" locked until the diff is approved. Light only.
 */
(function () {
  "use strict";
  if (window.__QWP_PLANNER_LOADED) return;
  window.__QWP_PLANNER_LOADED = true;

  // Beta channel: a sideloaded copy whose manifest name contains "BETA" (see content.js). Only
  // labels the UI; the beta/stable coexistence rules live in content.js and background.js.
  var IS_BETA = (function () { try { return /BETA/.test(chrome.runtime.getManifest().name || ""); } catch (e) { return false; } })();
  var BETA_PILL_STYLE = "display:inline-block;padding:2px 7px;border-radius:8px;background:#FFB343;color:#1e2a33;font:700 11px/1.3 inherit;letter-spacing:.04em;vertical-align:middle;";
  function betaPill() { return IS_BETA ? h("span", { style: BETA_PILL_STYLE, title: "Testversie — schrijft naar je echte Questi-account", text: "BETA" }) : null; }

  // ---------- Fixed (non-account) config ----------
  var API = "/api/cal";
  var ALL_FICHES_TAG = 8; // universal "Alle lesfiches" bucket (brief §3)

  // Runtime-detected context. Everything account/school/year-specific lives here.
  var ctx = { schoolId: null, schoolyear: null, calendarId: null, groupId: null, ownerId: null, ownDefaultTagId: null, ownerName: null, school: null, calendars: [], ready: false };
  function myId() { return ctx.ownerId != null ? ctx.ownerId : "self"; }
  function writeGroups() { return [{ groupId: ctx.groupId, schoolId: ctx.schoolId }]; }

  // Vak taxonomy — NO hardcoded tag ids. `names` matches the live top-tag TITLE;
  // the numeric tag id is resolved at runtime into view.vakTagMap (buildVakTagMap).
  // `re` matches a fiche TITLE (slot-popup search). `thema` = WO/Godsdienst style.
  var VAKKEN = [
    { id: "wiskunde",        label: "Wiskunde",   thema: false, names: /wiskunde/i,     re: /\bblok\s*\d+|wisk|rekenen|meetkunde|getal|cijferen|maal|deel/i },
    { id: "taal",            label: "Taal",       thema: false, names: /^\s*taal\s*$/i,  re: /\bT\s*\d|taal|lezen|schrijven|spreken|luisteren|taalkanjer/i },
    { id: "spelling",        label: "Spelling",   thema: false, names: /spelling/i,     re: /\bTK\s*\d|spelling|dictee|controledictee/i },
    { id: "wereldorientatie", label: "WO",        thema: true,  names: /wereldori/i,    re: /wereldori|\bWO\b|thema/i },
    { id: "godsdienst",      label: "Godsdienst", thema: true,  names: /godsdienst/i,   re: /godsdienst/i },
    { id: "muvo",            label: "MUVO",       thema: false, names: /^\s*muvo\s*$|muzo/i, re: /muzo|muvo|beeld|dans|drama|muziek|media/i }
  ];
  function vakById(id) { for (var i = 0; i < VAKKEN.length; i++) if (VAKKEN[i].id === id) return VAKKEN[i]; return null; }
  // Live tag id for a vak (from the runtime title→id map).
  function vakTagId(vakId) { return view.vakTagMap[vakId] != null ? view.vakTagMap[vakId] : null; }
  // Build the vak→live-tag map by matching each VAKKEN.names to an own top tag.
  function buildVakTagMap() {
    var map = {}, tops = topTagsForOwner(ownTagsList(), ctx.ownerId);
    VAKKEN.forEach(function (v) {
      var hit = tops.filter(function (t) { return v.names.test((t.title || "").trim()); })[0];
      if (hit) map[v.id] = hit.id;
    });
    view.vakTagMap = map;
    console.log("[QWP] vak→tag map:", map);
  }
  // Instellingen used to store a VAKKEN string per slot ("taal"); it now stores a
  // live top-tag id. Convert any legacy values once the vak→tag map is built.
  function migrateSettingsToTagIds() {
    var changed = false;
    Object.keys(state.settings).forEach(function (k) {
      var v = state.settings[k];
      if (typeof v === "string" && vakById(v)) {
        var tid = vakTagId(v);
        if (tid != null) state.settings[k] = tid; else delete state.settings[k];
        changed = true;
      }
    });
    if (changed) saveState();
  }

  // ---------- Storage ----------
  var STORE_KEY = "qwp_state_v6";
  function mkPanel(vak, sort) { return { source: "self", sortDir: sort || "az", filterVak: vak || null, filterTagId: null, hideUsed: false, gradeFilter: null }; }
  var state = { colleagues: [], settings: {}, weeks: 1, panelCount: 2, pickerView: "list", splitRatio: 0.58, sideCollapsed: null, workingCalendarId: null, manualSchoolId: null, manualSchoolyear: null, manualOwnTagId: null, themaVak: {}, slotVak: {}, saveThrottleMs: 250, mainMode: "plan", filterOpen: false, doelenWeek: 0, panels: [mkPanel(null, "az"), mkPanel(null, "az"), mkPanel(null, "az")] };
  function loadState() {
    return new Promise(function (res) {
      try {
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get([STORE_KEY], function (o) { if (o && o[STORE_KEY]) { try { mergeState(o[STORE_KEY]); } catch (e) {} } res(state); });
        } else {
          try { var s = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); if (s) mergeState(s); } catch (e) {}
          res(state);
        }
      } catch (e) { res(state); }
    });
  }
  function mergeState(s) {
    if (s.colleagues) state.colleagues = s.colleagues;
    if (s.settings) state.settings = s.settings;
    if (s.weeks) state.weeks = s.weeks;
    if (s.manualSchoolId != null) state.manualSchoolId = s.manualSchoolId;
    if (s.manualSchoolyear != null) state.manualSchoolyear = s.manualSchoolyear;
    if (s.manualOwnTagId != null) state.manualOwnTagId = s.manualOwnTagId;
    if (s.themaVak) state.themaVak = s.themaVak;   // thema identity → vak, chosen by hand
    if (s.slotVak) state.slotVak = s.slotVak;      // lesuur itemId → vak, chosen by hand over its fiche
    if (s.panelCount) state.panelCount = s.panelCount;
    if (s.pickerView) state.pickerView = s.pickerView;
    if (s.splitRatio) state.splitRatio = s.splitRatio;
    if (s.sideCollapsed != null) state.sideCollapsed = s.sideCollapsed;
    if (s.workingCalendarId != null) state.workingCalendarId = s.workingCalendarId;
    if (s.mainMode) state.mainMode = s.mainMode;          // UnQuesti main view: "plan" | "doelen"
    if (s.filterOpen != null) state.filterOpen = !!s.filterOpen;
    if (s.doelenWeek != null) state.doelenWeek = s.doelenWeek;
    if (Array.isArray(s.panels) && s.panels.length) {
      state.panels = [0, 1, 2].map(function (i) { return Object.assign(mkPanel(), state.panels[i], s.panels[i] || {}); });
    }
    mergeUqSettings(s);
  }
  // ---- UnQuesti settings fields (UI lives in settings.js; kept here because the planner reads them) ----
  // vakTags:  top-tag ids that count as vakken, null = every own top tag (the pre-settings behaviour).
  // vakOrder: legend order of vak tag ids, null = alphabetical.
  // setupDone: the first-run wizard was shown (finished or dismissed) — it auto-opens only once.
  // writeVakDescription: write the vak into each item's description (Enderklas reads it there).
  //   Brand-new install → false (no stored state, the default below). Stored state WITHOUT the
  //   field = a user from before the setting existed → true, so their commits do not change.
  state.vakTags = null; state.vakOrder = null; state.setupDone = false; state.writeVakDescription = false;
  function mergeUqSettings(s) {
    if (Array.isArray(s.vakTags)) state.vakTags = s.vakTags;
    if (Array.isArray(s.vakOrder)) state.vakOrder = s.vakOrder;
    if (s.setupDone != null) state.setupDone = !!s.setupDone;
    if (s.saveThrottleMs != null) state.saveThrottleMs = s.saveThrottleMs;   // was saved but never restored
    // Sidebar/vak picker preferences (UnQuesti). Every field written to state must be restored
    // here too — mergeState copies by name, so a field missing from this list silently resets.
    if (s.vakView === "tiles" || s.vakView === "compact" || s.vakView === "select") state.vakView = s.vakView;
    if (s.vakAbbr && typeof s.vakAbbr === "object") state.vakAbbr = s.vakAbbr;
    if (typeof s.sideWidth === "number" && s.sideWidth > 0) state.sideWidth = s.sideWidth;
    if (s.weekFit === "fit" || s.weekFit === "scroll") state.weekFit = s.weekFit;
    state.writeVakDescription = s.writeVakDescription != null ? !!s.writeVakDescription : true;
  }
  function writesDescriptions() { return state.writeVakDescription !== false; }
  function saveState() {
    try {
      if (chrome && chrome.storage && chrome.storage.local) { var o = {}; o[STORE_KEY] = state; chrome.storage.local.set(o); }
      else localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {}
  }
  // Generic key/value store shared with the other modules — same chrome.storage.local
  // path as the planner's own state, with the same localStorage fallback.
  function storeGet(key) {
    return new Promise(function (res) {
      try {
        if (chrome && chrome.storage && chrome.storage.local) chrome.storage.local.get([key], function (o) { res((o && o[key]) || null); });
        else res(JSON.parse(localStorage.getItem(key) || "null"));
      } catch (e) { res(null); }
    });
  }
  function storeSet(key, val) {
    try {
      if (chrome && chrome.storage && chrome.storage.local) { var o = {}; o[key] = val; chrome.storage.local.set(o); }
      else localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {}
  }

  // ---------- Runtime context detection ----------
  function safeStorage(fn) { try { return fn(); } catch (e) { return null; } }
  function isNumericId(v) { if (v == null) return false; if (typeof v === "number") return v > 0 && v < 1e12; return /^\d{1,12}$/.test(String(v)); }
  function isYearLabel(v) { return typeof v === "string" && /20\d{2}\s*-\s*20\d{2}/.test(v); }
  function walkForKey(root, re, validate) {
    var stack = [root], seen = [], steps = 0;
    while (stack.length && steps < 40000) {
      steps++;
      var cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (seen.indexOf(cur) > -1) continue; if (seen.length < 5000) seen.push(cur);
      for (var k in cur) {
        var v; try { v = cur[k]; } catch (e) { continue; }
        if (re.test(k) && (!validate || validate(v))) return v;
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return undefined;
  }
  function scrapeContext() {
    var out = { schoolId: null, schoolyear: null };
    var pools = [], rawTexts = [];
    ["__INITIAL_STATE__", "__NUXT__", "__NEXT_DATA__", "APP_CONFIG", "appConfig", "config", "questi", "Questi", "__APP__", "store", "__store"].forEach(function (g) { try { if (window[g]) pools.push(window[g]); } catch (e) {} });
    [safeStorage(function () { return localStorage; }), safeStorage(function () { return sessionStorage; })].forEach(function (st) {
      if (!st) return;
      try { for (var i = 0; i < st.length; i++) { var key = st.key(i); var raw = st.getItem(key); if (raw == null) continue; rawTexts.push(raw); pools.push({ __key: key, __val: raw }); try { pools.push(JSON.parse(raw)); } catch (e) {} } } catch (e) {}
    });
    var SID = /^(schoolid|school_id|id_school|idschool|activeschoolid|currentschoolid|selectedschoolid)$/i;
    var SYR = /^(schoolyear|school_year|activeschoolyear|current_schoolyear|selectedschoolyear|schooljaar|schoolyearlabel)$/i;
    for (var i = 0; i < pools.length && (out.schoolId == null || out.schoolyear == null); i++) {
      if (out.schoolId == null) { var sid = walkForKey(pools[i], SID, isNumericId); if (sid != null) out.schoolId = +sid; }
      if (out.schoolyear == null) { var syr = walkForKey(pools[i], SYR, isYearLabel); if (syr != null) out.schoolyear = String(syr); }
    }
    if (out.schoolyear == null) { for (var j = 0; j < rawTexts.length; j++) { var m = String(rawTexts[j]).match(/\b(20\d{2})\s*-\s*(20\d{2})\b/); if (m) { out.schoolyear = m[1] + " - " + m[2]; break; } } }
    if (out.schoolId == null) { var meta = document.querySelector('meta[name*="school" i]'); if (meta && isNumericId(meta.getAttribute("content"))) out.schoolId = +meta.getAttribute("content"); }
    return out;
  }
  function defaultSchoolyear() { var d = new Date(); var y = d.getFullYear(); var start = (d.getMonth() >= 7) ? y : y - 1; return start + " - " + (start + 1); }
  // /api/schools current_schoolyear can be an object — pull out a display string.
  function extractSchoolyear(v) {
    if (v == null) return null;
    if (typeof v === "string" || typeof v === "number") return String(v);
    if (typeof v === "object") {
      var cand = v.schoolyear || v.label || v.name || v.title || v.id;
      if (cand != null && typeof cand !== "object") return String(cand);
      if (v.startdate && v.enddate) { var a = String(v.startdate).slice(0, 4), b = String(v.enddate).slice(0, 4); if (a && b) return a + " - " + b; }
    }
    return null;
  }
  function detectOwnerFromTags(tags) { for (var i = 0; i < (tags || []).length; i++) { var t = tags[i]; if (t && t.is_owner) { var o = t.owner; var id = o && (typeof o === "object" ? o.id : o); if (id != null) return id; } } return null; }
  function tagOwnerId(t) { var o = t && t.owner; return o == null ? null : (typeof o === "object" ? o.id : o); }

  // Own default_tagId is PER USER (Questi rejects tag 8 on own fetches with
  // 1203). Resolve it universally, first hit wins:
  //   1) sniff Questi's own /lessons request (exact, no shape guessing)
  //   2) /api/cal/lessons/possible-settings (documented per-user default_tag)
  //   3) the user's own top-level "Alle lesfiches" tag from the tags list
  //   4) persisted manual override
  function sniffOwnLessonTag() {
    var urls = [];
    try { (performance.getEntriesByType("resource") || []).forEach(function (e) { if (e && e.name) urls.push(e.name); }); } catch (e) {}
    for (var i = 0; i < urls.length; i++) {
      var u = urls[i];
      if (u.indexOf("/cal/lessons") < 0) continue;
      if (/[?&]shared_userId=/.test(u)) continue; // colleague fetch — skip
      var m = u.match(/[?&]default_tagId=(\d+)/);
      if (m) return +m[1];
    }
    return null;
  }
  function pickTagId(obj) {
    if (obj == null) return null;
    var keys = ["default_tagId", "default_tag", "defaultTag", "defaultTagId", "tag", "tagId"];
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] != null) { var v = obj[keys[i]]; return (typeof v === "object") ? (v.id != null ? v.id : null) : v; }
    }
    return null;
  }
  function bootPossibleSettings() {
    return jget(API + "/lessons/possible-settings?" + qs({ schoolId: ctx.schoolId })).then(function (j) {
      var r = (j && j.result) || j || {};
      return pickTagId(r) || pickTagId(r.settings) || null;
    }).catch(function () { return null; });
  }
  function resolveOwnDefaultTagFromTags(tags) {
    var owned = (tags || []).filter(function (t) { return t && String(tagOwnerId(t)) === String(ctx.ownerId); });
    var topLevel = owned.filter(function (t) { return t.parent == null || t.parent === 0; });
    var pool = topLevel.length ? topLevel : owned;
    // "Alle eigen lesfiches" (id 5, type default) — note the word between "alle" and "lesfiches".
    var byTitle = pool.filter(function (t) { return /alle.*lesfiches/i.test(t.title || ""); })[0];
    if (byTitle) return byTitle.id;
    var byDefault = pool.filter(function (t) { return t.type === "default"; })[0];
    if (byDefault) return byDefault.id;
    return pool.length ? pool[0].id : null;
  }
  function resolveOwnTag(tags) {
    var sniffed = sniffOwnLessonTag();
    if (sniffed != null) { ctx.ownDefaultTagId = sniffed; console.log("[QWP] own default tag →", sniffed, "(via sniff)"); return Promise.resolve(); }
    // Prefer the /lessons/tags?filter=own list — it cleanly carries the id-5 "Alle
    // eigen lesfiches" default tag. Fall back to possible-settings / unfiltered / manual.
    return fetchOwnTags().then(function (ownTags) {
      var fromOwn = resolveOwnDefaultTagFromTags(ownTags);
      if (fromOwn != null) { ctx.ownDefaultTagId = fromOwn; console.log("[QWP] own default tag →", fromOwn, "(via filter=own)"); return; }
      return bootPossibleSettings().then(function (ps) {
        if (ps != null) { ctx.ownDefaultTagId = ps; console.log("[QWP] own default tag →", ps, "(via possible-settings)"); return; }
        var fromTags = resolveOwnDefaultTagFromTags(tags);
        if (fromTags != null) { ctx.ownDefaultTagId = fromTags; console.log("[QWP] own default tag →", fromTags, "(via tags list)"); return; }
        if (state.manualOwnTagId != null) { ctx.ownDefaultTagId = state.manualOwnTagId; console.log("[QWP] own default tag →", state.manualOwnTagId, "(via manual)"); return; }
        console.error("[QWP] own default tag could NOT be resolved — fiches will not load. Set it manually.");
      });
    });
  }
  // First usable group id from a groups array — handles raw ids ([326]) OR objects
  // ([{groupId|id, schoolId}]); skips nulls. Live items use raw ids in detail.
  function firstGroupId(groups) {
    for (var i = 0; i < (groups || []).length; i++) {
      var g = groups[i];
      if (g == null) continue;
      var gid = (typeof g === "object") ? (g.groupId != null ? g.groupId : g.id) : g;
      if (gid != null) return gid;
    }
    return null;
  }
  function deriveFromItems(items) {
    var calCount = {}, best = null;
    (items || []).forEach(function (it) {
      var c = it.id_calendar;
      if (c && c !== "cal_holidays") calCount[c] = (calCount[c] || 0) + 1;
      if (it.groups && it.groups.length) {
        if (ctx.groupId == null) { var gid = firstGroupId(it.groups); if (gid != null) ctx.groupId = gid; }
        var g0 = it.groups[0];
        if (ctx.schoolId == null && g0 && typeof g0 === "object" && g0.schoolId != null) ctx.schoolId = g0.schoolId;
      }
    });
    Object.keys(calCount).forEach(function (c) { if (best == null || calCount[c] > calCount[best]) best = c; });
    if (best) ctx.calendarId = best;
  }
  function thisWeekRange() { var d = new Date(); var day = (d.getDay() + 6) % 7; var mon = new Date(d); mon.setDate(d.getDate() - day); var end = new Date(mon); end.setDate(mon.getDate() + 6); return { start: isoDate(mon), end: isoDate(end) }; }
  // Monday (ISO) of the week containing a given date string.
  function mondayOf(iso) { var d = addDays(iso, 0); if (!d) return null; return isoDate(addDays(iso, -((d.getDay() + 6) % 7))); }
  // The week the user is currently viewing in Questi — read from the most recent /cal/items request
  // Questi's own SPA fired (its `startdate` param = the viewed Monday). Locale/DOM-independent; falls
  // back to null when resource timing has nothing (→ callers use today's week).
  //
  // Three things this MUST NOT do, all of which it once did:
  //  1. Match /cal/items/count — Questi's MONTH query. `indexOf("/cal/items")` is a substring test,
  //     the count call fires after the week fetch so it won the "most recent" race, and mondayOf()
  //     then rolled its 1st-of-the-month startdate back into the previous month. A live August
  //     request produced a July week; that was the whole bug.
  //  2. Accept a range that isn't a week. The span check below is the structural guard — a future
  //     month/term-scoped endpoint cannot be mistaken for a week even if the path check slips.
  //  3. Read our OWN fetches. apiItems hits the same endpoint (detectContext even fires one before
  //     this runs), so they carry QWP_MARK and are skipped here.
  var QWP_MARK = "qwp=1";
  function detectViewedWeekStart() {
    try {
      var best = null, bt = -1, es = performance.getEntriesByType("resource");
      var todayMon = mondayOf(isoDate(new Date()));
      for (var i = 0; i < es.length; i++) {
        var n = es[i].name || "";
        if (!/\/cal\/items\?/.test(n)) continue;          // the week endpoint only — not /count, not /{id}
        if (n.indexOf(QWP_MARK) > -1) continue;             // our own request, not Questi's
        var ms = /[?&]startdate=(\d{4}-\d{2}-\d{2})/.exec(n); if (!ms) continue;
        var me = /[?&]enddate=(\d{4}-\d{2}-\d{2})/.exec(n);
        // A viewed week spans at most 7 days (the planner itself may load 2 → allow 14).
        if (me) {
          var a = addDays(ms[1], 0), b = addDays(me[1], 0);
          if (!a || !b) continue;
          var days = Math.round((b - a) / 86400000);
          if (days < 0 || days > 14) continue;
        }
        if (es[i].startTime > bt) { bt = es[i].startTime; best = ms[1]; }
      }
      if (!best) return null;
      var mon = mondayOf(best);
      // Sanity: a viewed week a year away is not a view, it is a misread. Fall back to today.
      if (mon && todayMon) {
        var off = Math.round((addDays(mon, 0) - addDays(todayMon, 0)) / 604800000);
        if (!isFinite(off) || Math.abs(off) > 60) return null;
      }
      return mon;
    } catch (e) { return null; }
  }
  // One resolved answer for BOTH the planner and print, so they can never open on different weeks.
  // Returns { start, fromQuesti } — callers surface which rule fired instead of guessing silently.
  function resolveOpenWeek() {
    var vs = detectViewedWeekStart();
    if (vs) return { start: vs, fromQuesti: true };
    return { start: thisWeekRange().start, fromQuesti: false };
  }

  // Break the chicken-egg: Questi's own page already fired
  // /api/...?schoolId=NNNN&schoolyear=YYYY requests. Their URLs live in the
  // Performance resource timeline — read the real ids straight off them.
  // This needs no login-specific globals and no hardcoding.
  function sniffFromRequests() {
    var out = { schoolId: null, schoolyear: null, calendarId: null };
    var urls = [];
    try { (performance.getEntriesByType("resource") || []).forEach(function (e) { if (e && e.name) urls.push(e.name); }); } catch (e) {}
    try { urls.push(location.href); } catch (e) {}
    // Also sweep any anchor/script/link that carries the params.
    try { Array.prototype.forEach.call(document.querySelectorAll("[href],[src]"), function (n) { var u = n.getAttribute("href") || n.getAttribute("src"); if (u && u.indexOf("schoolId") > -1) urls.push(u); }); } catch (e) {}
    for (var i = 0; i < urls.length; i++) {
      var u = urls[i];
      if (out.schoolId == null) { var ms = u.match(/[?&]schoolId=(\d{1,12})/); if (ms) out.schoolId = +ms[1]; }
      if (out.schoolyear == null) { var my = u.match(/[?&]schoolyear=([^&#]+)/); if (my) { try { out.schoolyear = decodeURIComponent(my[1]); } catch (e) { out.schoolyear = my[1]; } } }
      if (out.calendarId == null) { var mc = u.match(/(cal_\d{2,})/); if (mc && mc[1] !== "cal_holidays") out.calendarId = mc[1]; }
      if (out.schoolId != null && out.schoolyear != null && out.calendarId != null) break;
    }
    return out;
  }
  function sniffCookies() {
    var out = { schoolId: null, schoolyear: null };
    try {
      String(document.cookie || "").split(";").forEach(function (kv) {
        var m = kv.split("="); var k = (m[0] || "").trim(); var v = decodeURIComponent((m[1] || "").trim());
        if (out.schoolId == null && /school.?id/i.test(k) && isNumericId(v)) out.schoolId = +v;
        if (out.schoolyear == null && /schoolyear|schooljaar/i.test(k) && isYearLabel(v)) out.schoolyear = v;
      });
    } catch (e) {}
    return out;
  }

  // Authoritative bootstrap (per live Questi app):
  //   GET /api/users/me   → result.id  = own user id (ownerId)
  //   GET /api/schools    → result[].id = schoolId, .current_schoolyear = year
  //   GET /api/cal/calendars?schoolId → calendar ids for the calendars[] filter
  var API_ROOT = "/api";
  function bootUsersMe() { return jget(API_ROOT + "/users/me").then(function (j) { var r = (j && j.result) || j; if (r) { var nm = ((r.firstname || "") + " " + (r.lastname || "")).trim(); if (nm) ctx.ownerName = nm; } return r && (r.id != null ? r.id : null); }).catch(function () { return null; }); }
  function bootSchools() { return jget(API_ROOT + "/schools").then(function (j) { var r = (j && j.result) || []; return Array.isArray(r) ? r : []; }).catch(function () { return []; }); }
  function bootCalendars() { return jget(API + "/calendars?" + qs({ schoolId: ctx.schoolId })).then(function (j) { var r = (j && j.result) || []; return Array.isArray(r) ? r : []; }).catch(function () { return []; }); }
  function pickSchool(schools, preferId) {
    if (!schools.length) return null;
    if (preferId != null) { for (var i = 0; i < schools.length; i++) if (String(schools[i].id) === String(preferId)) return schools[i]; }
    return schools[0];
  }
  function calIdOf(c) { return c && (c.id != null ? c.id : (c.calendarId != null ? c.calendarId : c.id_calendar)); }

  // Detected context per Questi user, saved under qwp_ctx_v1: { "<user id>": { schoolId, schoolyear,
  // school, calendars, calendarId, groupId, ownDefaultTagId, savedAt } }. School, calendar, class and
  // own tag barely ever change, yet detecting them is a chain of 5–6 dependent requests. So a known
  // user starts from the saved context after ONE request (/users/me) and the full detection runs in
  // the background; if it finds something different the context is corrected and the status says so.
  // Keyed by user id, so another teacher logging in on the same browser never inherits a context.
  var CTX_KEY = "qwp_ctx_v1";
  var CTX_FIELDS = ["schoolId", "schoolyear", "school", "calendars", "calendarId", "groupId", "ownDefaultTagId"];
  function ctxSnapshot() { var o = {}; CTX_FIELDS.forEach(function (k) { o[k] = ctx[k]; }); return o; }
  function saveCtxCache(userId) {
    if (userId == null || ctx.schoolId == null) return;
    storeGet(CTX_KEY).then(function (all) {
      all = all || {}; var snap = ctxSnapshot(); snap.savedAt = Date.now(); all[String(userId)] = snap;
      storeSet(CTX_KEY, all);
    });
  }
  // The fields that change behaviour if they differ (school name/calendar list are cosmetic).
  function ctxKey(o) { return [o.schoolId, JSON.stringify(o.schoolyear), o.calendarId, o.groupId, o.ownDefaultTagId].join("|"); }
  function detectContext() {
    return Promise.all([bootUsersMe(), storeGet(CTX_KEY)]).then(function (r) {
      var me = r[0], cached = me != null && r[1] ? r[1][String(me)] : null;
      if (!cached || cached.schoolId == null || cached.calendarId == null) {
        return detectContextFull().then(function (c) { saveCtxCache(ctx.ownerId); return c; });
      }
      ctx.ownerId = me;
      CTX_FIELDS.forEach(function (k) { if (cached[k] !== undefined) ctx[k] = cached[k]; });
      if (state.workingCalendarId != null && (ctx.calendars || []).some(function (c) { return String(c.id) === String(state.workingCalendarId); })) ctx.calendarId = state.workingCalendarId;
      ctx.ready = true;
      ctx.fromCache = true;
      console.log("[QWP] context from cache (user " + me + ") — verifying in the background:", ctxSnapshot());
      var before = ctxKey(cached);
      detectContextFull().then(function () {
        ctx.fromCache = false;
        saveCtxCache(ctx.ownerId);
        if (ctxKey(ctxSnapshot()) !== before) {
          console.warn("[QWP] cached context was stale → corrected:", ctxSnapshot());
          setStatus("Let op: je Questi-context is gewijzigd (school, agenda of klas). Herlaad de week voor je wegschrijft.");
        }
      });
      return ctx;
    });
  }
  function detectContextFull() {
    // Fallback hints (used only if the bootstrap calls come up empty).
    var net = sniffFromRequests(), scr = scrapeContext(), cook = sniffCookies();
    var hintSchoolId = net.schoolId != null ? net.schoolId : (scr.schoolId != null ? scr.schoolId : (cook.schoolId != null ? cook.schoolId : state.manualSchoolId));
    if (net.calendarId) ctx.calendarId = net.calendarId;

    return Promise.all([bootUsersMe(), bootSchools()]).then(function (r) {
      var me = r[0], schools = r[1];
      if (me != null) ctx.ownerId = me;
      var school = pickSchool(schools, hintSchoolId);
      if (school) { ctx.schoolId = school.id; ctx.school = { name: school.name || "", address: school.address || "", zip: school.zip || "", city: school.city || "" }; var sy = extractSchoolyear(school.current_schoolyear); if (sy) ctx.schoolyear = sy; console.log("[QWP] current_schoolyear raw:", school.current_schoolyear, "→", sy); }
      else if (hintSchoolId != null) ctx.schoolId = hintSchoolId;
      if (!ctx.schoolyear) ctx.schoolyear = net.schoolyear || scr.schoolyear || cook.schoolyear || state.manualSchoolyear || defaultSchoolyear();
      console.log("[QWP] bootstrap → users/me id:", me, "| schools:", schools.length, "chosen schoolId:", ctx.schoolId, "schoolyear:", ctx.schoolyear);
      if (ctx.schoolId == null) { console.error("[QWP] schoolId null after /api/schools — use manual field."); return null; }
      return bootCalendars();
    }).then(function (cals) {
      if (!cals) return null;
      var ids = cals.map(calIdOf).filter(function (x) { return x && x !== "cal_holidays"; });
      // Retain full calendar objects (id + name + colour) for the print picker (Feature 4) and the
      // working-calendar picker (Feature 5). Field names are best-effort — read defensively.
      ctx.calendars = (cals || []).map(function (c) { return { id: calIdOf(c), name: c.name || c.title || String(calIdOf(c)), color: c.color || c.colour || c.hex || null }; })
        .filter(function (c) { return c.id && c.id !== "cal_holidays"; });
      console.log("[QWP] /cal/calendars →", ids);
      if (!ctx.calendarId && ids.length) ctx.calendarId = ids[0];
      var wr = thisWeekRange();
      var calList = (ids.length ? ids : (ctx.calendarId ? [ctx.calendarId] : [])).concat(["cal_holidays"]);
      return apiItems(wr.start, wr.end, calList.length ? calList : null);
    }).then(function (items) {
      if (items == null) return;
      deriveFromItems(items || []);
      // Feature 5: an explicit working-calendar pick overrides the busiest-calendar heuristic —
      // makes the tool portable (multiple own calendars / colleague calendars), not name-dependent.
      if (state.workingCalendarId != null && (ctx.calendars || []).some(function (c) { return String(c.id) === String(state.workingCalendarId); })) {
        ctx.calendarId = state.workingCalendarId;
        console.log("[QWP] working calendar override →", ctx.calendarId);
      }
      console.log("[QWP] derived from " + ((items || []).length) + " agenda items →", { schoolId: ctx.schoolId, calendarId: ctx.calendarId, groupId: ctx.groupId });
      // List items carry empty groups; the real group id lives in item DETAIL. If not
      // yet known, fetch one editable item's detail to resolve it (writes need it).
      var groupProm = Promise.resolve();
      if (ctx.groupId == null) {
        var sample = (items || []).filter(function (x) { return x && x.id_calendar !== "cal_holidays" && x.is_editable !== false; })[0] || (items || [])[0];
        if (sample) groupProm = fetchItemDetail(sample.id).then(function (d) { if (d && d.groups && d.groups.length) { ctx.groupId = firstGroupId(d.groups); console.log("[QWP] groupId resolved from detail →", ctx.groupId); } }).catch(function () {});
      }
      return groupProm.then(function () {
        return fetchTags().then(function (tags) {
          if (ctx.ownerId == null) ctx.ownerId = detectOwnerFromTags(tags);
          return resolveOwnTag(tags);
        });
      });
    }).then(function () {
      ctx.ready = !!ctx.schoolId;
      console.log("[QWP] DETECTED CONTEXT:", { schoolId: ctx.schoolId, schoolyear: ctx.schoolyear, ownerId: ctx.ownerId, calendarId: ctx.calendarId, groupId: ctx.groupId });
      return ctx;
    }).catch(function (e) { console.error("[QWP] detectContext error:", e); return ctx; });
  }

  // ---------- API ----------
  function jget(url) { return fetch(url, { credentials: "include", headers: { "Accept": "application/json" } }).then(function (r) { return r.json(); }); }
  // Questi validates a double-submit CSRF token on writes: the XSRF-TOKEN cookie value
  // must be echoed in the x-xsrf-token header (POST/PATCH/DELETE). GET needs neither.
  function xsrfToken() { var m = /(?:^|;\s*)XSRF-TOKEN=([^;]+)/.exec(document.cookie || ""); return m ? decodeURIComponent(m[1]) : ""; }
  function writeHeaders() { var hd = { "Content-Type": "application/json", "Accept": "application/json" }; var t = xsrfToken(); if (t) hd["x-xsrf-token"] = t; return hd; }
  function qs(obj) {
    var p = [];
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (Array.isArray(v)) { v.forEach(function (x) { p.push(encodeURIComponent(k) + "[]=" + encodeURIComponent(x)); }); }
      else if (v !== undefined && v !== null) { p.push(encodeURIComponent(k) + "=" + encodeURIComponent(v)); }
    });
    return p.join("&");
  }

  function apiItems(startISO, endISO, calendars) {
    // No schoolyear param — the live app omits it for calendar reads, and a
    // non-primitive value (current_schoolyear can be an object) 500s the call.
    // qwp:1 marks this as OUR read, so detectViewedWeekStart skips it and only ever sees
    // requests Questi's own SPA fired. Questi ignores the unknown param.
    var q = { schoolId: ctx.schoolId, startdate: startISO, enddate: endISO, qwp: 1 };
    if (calendars && calendars.length) q.calendars = calendars;
    return jget(API + "/items?" + qs(q)).then(function (j) { return (j && j.result) || []; });
  }
  function fetchItems(startISO, endISO) { return apiItems(startISO, endISO, ctx.calendarId ? [ctx.calendarId, "cal_holidays"] : null); }
  function fetchItemDetail(id) { return jget(API + "/items/" + id + "?" + qs({ schoolId: ctx.schoolId })).then(function (j) { return (j && j.result) || j; }); }
  // Pick the lesfiche attachment (id_type 1). Falls back to the first attachment, so behavior is
  // identical to the old attachments[0] whenever the lesfiche is the only/first one — but stays
  // correct if Questi ever adds a sibling attachment of another type ahead of it (additive change).
  function ficheAttachment(list) {
    var a = (list && list.length) ? list : [];
    return a.filter(function (x) { return x && (x.id_type === 1 || x.id_type === "1"); })[0] || a[0] || null;
  }

  function isOwnSource(ownerId) { return ownerId == null || ownerId === "self" || (ctx.ownerId != null && String(ownerId) === String(ctx.ownerId)); }
  function lessonsGet(params) {
    var url = API + "/lessons?" + qs(params);
    return fetch(url, { credentials: "include", headers: { "Accept": "application/json" } }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j, url: url }; }).catch(function () { return { status: r.status, j: null, url: url }; });
    }).catch(function (err) { return { status: 0, j: null, url: url, err: err }; });
  }
  function lessonsResult(res) {
    var j = res.j;
    var items = (j && (j.result || j.records || j.data || j.lessons)) || [];
    if (!Array.isArray(items)) items = [];
    var total = (j && (j.num_records != null ? j.num_records : (j.total != null ? j.total : j.count)));
    if (total == null) total = items.length;
    return { items: items, total: total };
  }
  // ---------- Methode-fiches (vendor libraries, read-only) ----------
  // A methode is loaded as a pseudo-colleague with id "method:<KEY>" so it flows through
  // the same owner → panel → search plumbing. Its fiches come from a DIFFERENT endpoint
  // (/methods/{key}/lessons) and carry no tags, so we route them before the tag logic.
  var METHOD_PREFIX = "method:";
  function isMethodOwner(ownerId) { return typeof ownerId === "string" && ownerId.indexOf(METHOD_PREFIX) === 0; }
  function methodKeyOf(ownerId) { return String(ownerId).slice(METHOD_PREFIX.length); }
  function methodEntry(ownerId) { return state.colleagues.filter(function (c) { return String(c.id) === String(ownerId); })[0] || null; }
  function fetchMethods() { return jget(API + "/manage/methods/" + ctx.schoolId).then(function (j) { return (j && j.result) || []; }).catch(function () { return []; }); }
  // Method endpoint returns the full list in one shot (no server paging) → only the
  // offset-0 call fetches; later "pages" resolve empty so the paging loops just no-op.
  function fetchMethodFiches(ownerId, offset) {
    if (offset && offset > 0) return Promise.resolve({ items: [], total: 0 });
    var c = methodEntry(ownerId), key = methodKeyOf(ownerId);
    var url = API + "/methods/" + encodeURIComponent(key) + "/lessons?" + qs({ is_cluster: (c && c.isCluster) ? true : false, schoolId: ctx.schoolId });
    return jget(url).then(function (j) {
      var items = ((j && j.result) || []).map(function (f) { f.__method = true; f.__methodOwner = ownerId; view.methodFicheIds[String(f.id)] = true; return f; });
      return { items: items, total: items.length };
    }).catch(function (err) { console.error("[QWP] /methods lessons failed:", err); return { items: [], total: 0 }; });
  }

  // Same endpoint as fetchMethodFiches, but addressed by key instead of by a pseudo-colleague
  // entry — the Methodes panel tracks a methode without loading it as a picker source.
  function fetchMethodLessons(key, isCluster) {
    var url = API + "/methods/" + encodeURIComponent(key) + "/lessons?" + qs({ is_cluster: !!isCluster, schoolId: ctx.schoolId });
    return jget(url).then(function (j) { return (j && j.result) || []; })
      .catch(function (err) { console.error("[QWP] /methods lessons failed:", err); return []; });
  }

  function fetchFiches(ownerId, offset, num) {
    if (isMethodOwner(ownerId)) return fetchMethodFiches(ownerId, offset);
    var own = isOwnSource(ownerId);
    var params = { schoolId: ctx.schoolId, sorting: "new_items", status: "active", num: num || 100, offset: offset || 0 };
    if (own) {
      // Own fetch requires the user's PERSONAL default tag (tag 8 is only valid
      // for shared_userId fetches → 1203). Never fire a guaranteed-400 call.
      if (ctx.ownDefaultTagId == null) { setStatus("Kon je eigen lesfiche-tag niet bepalen — vul die handmatig in via 'Vernieuwen' bij de context-fout."); console.error("[QWP] fetchFiches(own) aborted — ctx.ownDefaultTagId is null."); return Promise.resolve({ items: [], total: 0 }); }
      params.default_tagId = ctx.ownDefaultTagId;
    } else {
      // Prefer the colleague's own top tag; fall back to the universal bucket (8).
      params.shared_userId = ownerId; params.default_tagId = colleagueDefaultTag(ownerId);
    }
    return lessonsGet(params).then(function (res) {
      if (res.status < 400) { var r = lessonsResult(res); console.log("[QWP] /lessons ok:", res.url, "→", r.items.length, "of", r.total); return r; }
      console.error("[QWP] /lessons HTTP " + res.status + " URL:", res.url, "body:", JSON.stringify(res.j));
      noteApiError("GET lessons", ownerId, res.status, (res.j && (res.j.error_msg || res.j.message)) || ("HTTP " + res.status));
      return { items: [], total: 0 };
    }).catch(function (err) { console.error("[QWP] /lessons failed:", err); return { items: [], total: 0 }; });
  }
  function fetchAllFiches(ownerId) {
    return fetchFiches(ownerId, 0, 100).then(function (first) {
      var total = first.total, items = first.items.slice(), pages = Math.ceil(total / 100), chain = Promise.resolve();
      for (var p = 1; p < pages; p++) { (function (pg) { chain = chain.then(function () { return fetchFiches(ownerId, pg * 100, 100).then(function (r) { items = items.concat(r.items); }); }); })(p); }
      return chain.then(function () { return { items: items, total: total }; });
    });
  }
  // Server-side tag filtering: questi returns exactly the fiches under a tag.
  // A "default" bucket tag (Alle eigen lesfiches / zonder tag / samenwerk / universal)
  // uses default_tagId; a real category (type "user") uses user_tagId (per capture).
  function isDefaultBucketTag(ownerId, tagId) {
    var pool = tagPoolFor(ownerId);
    for (var i = 0; i < pool.length; i++) if (String(pool[i].id) === String(tagId)) return pool[i].type === "default";
    return String(tagId) === String(ALL_FICHES_TAG) || String(tagId) === String(ctx.ownDefaultTagId);
  }
  function fetchFichesByTag(ownerId, tagId, offset, num) {
    if (isMethodOwner(ownerId)) return fetchMethodFiches(ownerId, offset); // methods carry no tags
    var own = isOwnSource(ownerId);
    var params = { schoolId: ctx.schoolId, sorting: "new_items", status: "active", num: num || 100, offset: offset || 0 };
    if (!own) params.shared_userId = ownerId;
    if (isDefaultBucketTag(ownerId, tagId)) params.default_tagId = tagId; else params.user_tagId = tagId;
    return lessonsGet(params).then(function (res) {
      if (res.status < 400) return lessonsResult(res);
      console.error("[QWP] /lessons(tag " + tagId + ") HTTP " + res.status + " URL:", res.url, "body:", JSON.stringify(res.j));
      noteApiError("GET lessons(tag)", tagId, res.status, (res.j && (res.j.error_msg || res.j.message)) || ("HTTP " + res.status));
      return { items: [], total: 0 };
    }).catch(function (err) { console.error("[QWP] /lessons(tag) failed:", err); return { items: [], total: 0 }; });
  }
  function fetchAllFichesByTag(ownerId, tagId) {
    return fetchFichesByTag(ownerId, tagId, 0, 100).then(function (first) {
      var total = first.total, items = first.items.slice(), pages = Math.ceil(total / 100), chain = Promise.resolve();
      for (var p = 1; p < pages; p++) { (function (pg) { chain = chain.then(function () { return fetchFichesByTag(ownerId, tagId, pg * 100, 100).then(function (r) { items = items.concat(r.items); }); }); })(p); }
      return chain.then(function () { return { items: items, total: total }; });
    });
  }
  function cacheKey(ownerId, tagId) { return String(ownerId) + "|" + String(tagId); }
  function unionKey(ownerId, parentTagId) { return "union|" + String(ownerId) + "|" + String(parentTagId); }
  // Ensure fiches for (owner, tag) are cached; returns a promise of the item array.
  function ensureFiches(ownerId, tagId) {
    if (tagId == null) return Promise.resolve([]);
    var k = cacheKey(ownerId, tagId);
    if (view.ficheCache[k]) return Promise.resolve(view.ficheCache[k]);
    return fetchAllFichesByTag(ownerId, tagId).then(function (r) { view.ficheCache[k] = r.items; return r.items; });
  }
  // "Alle" = the union of the parent tag + all its child tags (server filters by a
  // single tag at a time, so a parent fetch alone misses fiches tagged only under
  // a child). Fetch each and merge/dedupe by fiche id.
  function ensureFichesUnion(ownerId, parentTagId, childIds) {
    if (parentTagId == null) return Promise.resolve([]);
    var k = unionKey(ownerId, parentTagId);
    if (view.ficheCache[k]) return Promise.resolve(view.ficheCache[k]);
    var ids = [parentTagId].concat(childIds || []);
    var lists = [];
    return mapLimit(ids.map(function (id, i) { return i; }), 4, function (i) {
      return ensureFiches(ownerId, ids[i]).then(function (arr) { lists[i] = arr; });
    }).then(function () {
      var seen = {}, merged = [];
      lists.forEach(function (arr) { (arr || []).forEach(function (f) { if (f && !seen[f.id]) { seen[f.id] = true; merged.push(f); } }); });
      view.ficheCache[k] = merged; return merged;
    });
  }
  // Which cache key a panel currently reads: the union when in "Alle" mode, else
  // the single selected tag.
  function panelCacheKey(p) { return p.unionMode ? unionKey(p.source, p.filterVak) : cacheKey(p.source, p.filterTagId); }

  var _tagsCache = null, _ownTagsCache = null, _sharedTagsCache = null;
  function fetchTags() { if (_tagsCache) return Promise.resolve(_tagsCache); return jget(API + "/lessons/tags?" + qs({ schoolId: ctx.schoolId })).then(function (j) { _tagsCache = (j && j.result) || []; return _tagsCache; }); }
  // filter=own → the user's own tag hierarchy (small, clean); filter=shared → colleagues' tags.
  function fetchOwnTags() { if (_ownTagsCache) return Promise.resolve(_ownTagsCache); return jget(API + "/lessons/tags?" + qs({ schoolId: ctx.schoolId, filter: "own" })).then(function (j) { _ownTagsCache = (j && j.result) || []; return _ownTagsCache; }).catch(function () { return []; }); }
  // Drop the cached own-tag list so the next fetchOwnTags() re-reads from the server. Called
  // after the Lesfiche-manager creates/deletes a tag, so planner + manager don't show stale tags.
  function invalidateOwnTags() { _ownTagsCache = null; }
  function fetchSharedTags() { if (_sharedTagsCache) return Promise.resolve(_sharedTagsCache); return jget(API + "/lessons/tags?" + qs({ schoolId: ctx.schoolId, filter: "shared", active_users: true })).then(function (j) { _sharedTagsCache = (j && j.result) || []; return _sharedTagsCache; }).catch(function () { return []; }); }
  var SYSTEM_TAG_IDS = { 1: true, 2: true }; // "zonder tag" + "samenwerk" — hide from vak pills (keep 5 = Alle).
  function isTopLevel(t) { return t && (t.parent == null || t.parent === 0); }
  // Top-level vak pills for a given owner: the "Alle" bucket (id 5) first, then subject roots, A→Z.
  function topTagsForOwner(tags, ownerId) {
    var mine = (tags || []).filter(function (t) { return isTopLevel(t) && String(tagOwnerId(t)) === String(ownerId); });
    var alle = mine.filter(function (t) { return t.type === "default" && /alle.*lesfiches/i.test(t.title || ""); });
    var subjects = mine.filter(function (t) { return !SYSTEM_TAG_IDS[t.id] && !(t.type === "default" && /alle.*lesfiches/i.test(t.title || "")); })
      .sort(function (a, b) { return (a.title || "").trim().localeCompare((b.title || "").trim(), undefined, { numeric: true }); });
    return alle.concat(subjects);
  }
  function fetchPeople() { return jget(API + "/items/shares/possible-participants?" + qs({ schoolId: ctx.schoolId })).then(function (j) { return ((j && j.result) || []).map(function (p) { return { id: p.id, name: ((p.firstname || "") + " " + (p.lastname || "")).trim() }; }); }).catch(function () { return []; }); }

  // Last ~20 API errors, in memory only, for the Zelftest "Opslaan als .json" report. Holds the
  // call kind, id, HTTP status and Questi's error text — never a request body, cookie or token.
  var _apiErrors = [];
  function noteApiError(kind, id, status, msg) {
    try {
      _apiErrors.push({ at: new Date().toISOString(), kind: String(kind || ""), id: id == null ? null : String(id).slice(0, 80), status: status || 0, msg: String(msg == null ? "" : msg).slice(0, 300) });
      if (_apiErrors.length > 20) _apiErrors.shift();
    } catch (e) { /* never let diagnostics break a caller */ }
  }
  function recentApiErrors() { return _apiErrors.slice(); }
  // Resolve a JSON response and throw the server's error_msg on any failure, so the
  // real code (e.g. "1234 - …") reaches the UI instead of a silent/opaque abort.
  function resolveWrite(kind, id, r, sent) {
    return r.json().catch(function () { return null; }).then(function (j) {
      if (r.ok && !(j && j.status === "error")) return j;
      var msg = (j && (j.error_msg || j.message)) || ("HTTP " + r.status);
      // Gateway timeouts are expected + handled (doCommit re-verifies via verifyLanded), so log
      // them as a warning — a red console.error clutters chrome://extensions "Fouten" and alarms
      // non-technical users for something the tool already recovers from. Real errors stay red.
      var gw = (r.status === 502 || r.status === 503 || r.status === 504 || r.status === 408 || r.status === 524 || r.status === 0);
      (gw ? console.warn : console.error)("[QWP] " + kind + " " + id + (gw ? " gateway-timeout (wordt geverifieerd):" : " failed:"), msg, "| body:", JSON.stringify(j), "| sent:", JSON.stringify(sent));
      noteApiError(kind, id, r.status, msg);
      var err = new Error(msg); err.httpStatus = r.status; throw err;
    });
  }
  // Gateway timeouts (nginx 504 etc.) mean Questi was slow to answer — the write usually STILL
  // lands (confirmed). Treat these as "verify, don't fail".
  function isGatewayError(e) { var s = e && e.httpStatus; return s === 502 || s === 503 || s === 504 || s === 408 || s === 524 || s === 0; }
  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  // Single write path for PATCH/POST. Retries on HTTP 429 (rate limit) with capped backoff
  // (1s → 2s → 4s, max 3 retries), then rethrows so doCommit's existing gateway/verify handling
  // stays in charge of every other error. Behaviorally identical to a plain fetch when no 429.
  function doWrite(kind, id, url, method, bodyObj) {
    var attempt = 0;
    function go() {
      return fetch(url, { method: method, credentials: "include", headers: writeHeaders(), body: JSON.stringify(bodyObj) })
        .then(function (r) { return resolveWrite(kind, id, r, bodyObj); })
        .catch(function (e) {
          if (e && e.httpStatus === 429 && attempt < 3) { attempt++; return sleep(1000 * Math.pow(2, attempt - 1)).then(go); }
          throw e;
        });
    }
    return go();
  }
  // Recurring lesuren need the occurrence window (range_startdate/enddate) so the edit
  // hits ONLY this week's occurrence, never the whole series (apply_to_next_items=false).
  function patchItem(id, body, range) {
    var q = { schoolId: ctx.schoolId, schoolyear: ctx.schoolyear, apply_to_next_items: false };
    if (range && range.start && range.end) { q.range_startdate = range.start; q.range_enddate = range.end; }
    return doWrite("PATCH item", id, API + "/items/" + id + "?" + qs(q), "PATCH", body);
  }
  // PATCH item.groups are OBJECTS [{groupId,schoolId}]; the attachment POST wants RAW ids
  // ([326]). Both tolerate a read shape that uses `id` instead of `groupId`.
  function writeGroupObjs(groups) {
    var out = ((groups && groups.length) ? groups : []).map(function (g) {
      if (g == null) return null;
      if (typeof g !== "object") return { groupId: g, schoolId: ctx.schoolId };
      var gid = (g.groupId != null ? g.groupId : g.id);
      return gid == null ? null : { groupId: gid, schoolId: (g.schoolId != null ? g.schoolId : ctx.schoolId) };
    }).filter(Boolean);
    // Fall back to the detected class group; NEVER emit {groupId:null} (SQL rejects it).
    if (!out.length && ctx.groupId != null) out = [{ groupId: ctx.groupId, schoolId: ctx.schoolId }];
    return out;
  }
  function groupIds(groups) {
    return (groups && groups.length ? groups : writeGroups()).map(function (g) { return (g && typeof g === "object") ? (g.groupId != null ? g.groupId : g.id) : g; }).filter(function (x) { return x != null; });
  }
  function postAttachment(id, lessonContentId, groups) {
    var payload = { attachments: [{ schoolId: ctx.schoolId, visible_parents: false, visible_students: false, students: [], groups: groupIds(groups), id: lessonContentId, typeId: 1 }] };
    return doWrite("POST attachment", id, API + "/items/" + id + "/attachments?" + qs({ schoolId: ctx.schoolId, schoolyear: ctx.schoolyear }), "POST", payload);
  }
  // Methode-fiches are vendor content and are NOT attachable via the normal endpoint
  // (that 1235s "no access to lesson"). Questi links them through a dedicated route:
  // POST /items/{id}/attachments/methodlesson — same body but NO typeId. `id` = the
  // methode-fiche id (from /methods/{key}/lessons). Response carries the decorated title.
  function postMethodAttachment(id, lessonId, groups) {
    var payload = { schoolId: ctx.schoolId, visible_parents: false, visible_students: false, students: [], groups: groupIds(groups), id: lessonId };
    return doWrite("POST methodlesson", id, API + "/items/" + id + "/attachments/methodlesson?" + qs({ schoolId: ctx.schoolId, schoolyear: ctx.schoolyear }), "POST", payload);
  }

  // ---------- Domain helpers ----------
  // Must also match the title the planner itself writes for a gym lesuur ("Lichamelijke
  // opvoeding"), or hydrate re-reads that slot as NON-gym and the flag is lost on every reload.
  // "L.O." needs its own alternative WITHOUT a trailing \b: a word boundary after "." requires a
  // word character next, so /\bL\.O\.\b/ never matches "L.O." at the end of a title.
  var GYM_RE = /\b(LO|zwemmen|gym|turnen)\b|\bL\.\s?O\.|lichamelijke/i;
  var THEMA_RE = /\b(WO|wereldori|godsdienst)\b/i;
  function isGymTitle(t) { return GYM_RE.test(t || ""); }
  // BOOTSTRAP HEURISTIC ONLY — never a live rule. It must be applied to a title the USER cannot
  // edit (origTitle at hydrate) or to a TAG title, never to slot.title. Three bugs came from
  // ignoring that: thema rows collapsing, collapsing again after commit, and a lesuur vanishing
  // from the grid entirely once someone typed "Godsdienst - Les 1" into the Titel field.
  // Classification at render/interaction time uses isThemaSlot(s) / s.themaFiche.
  function isThemaTitle(t) { return THEMA_RE.test(t || ""); }
  // Whether a slot's vak makes it a "refer to the themafiche" lesson, judged on the TAG title.
  function isThemaVak(tagId) {
    if (tagId == null || tagId === "") return false;
    var top = topTagIdOf(tagId);
    return top != null && THEMA_RE.test((anyTagTitle(top) || "").trim());
  }
  // The two titles a gym lesuur can carry. This account has no "Lichamelijke opvoeding" TAG, so
  // the trigger is the gym checkbox in the slot popup — never the Vak dropdown.
  var LO_TITLES = ["Lichamelijke opvoeding", "Zwemmen"];

  // ---------- Thema identity ----------
  // A whole-week thema item (WO, Godsdienst, …) needs an identity that SURVIVES assigning a
  // fiche, because assignFiche overwrites slot.title with the fiche title. Deriving the row
  // from the live title is what made a second themafiche swallow the first: once "Godsdienst"
  // became "Camino 3 - Thema 'Vriendschap'" it no longer looked like Godsdienst.
  // So: stamp a key ONCE, from origTitle (never mutated), resolved against the teacher's live
  // top-level tags. Rows then follow the tags — a third thema needs no code change.
  function normTitle(s) { return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim(); }
  // Separator for the committed "<Thema> — <fiche>" title. An em dash with spaces: rare enough
  // in fiche titles that a false split is unlikely, and the parse below is VALIDATED against the
  // live tag list anyway, so a stray dash can never invent a thema.
  var THEMA_SEP = " — ";
  // Abbreviations that don't share a substring with the full tag title. Deliberately TIGHT:
  // the old fallback reused VAKKEN[].re, whose wereldorientatie entry contains "thema" — so any
  // fiche called "Thema 5 …" or "… Thema 'Vriendschap'" resolved to WO and two themafiches
  // collapsed onto one row. That single word was the entire bug. Never widen this to a search regex.
  // `re` matches the ITEM title, `tag` matches the teacher's own TAG title. Resolving straight
  // against the live tags (instead of via a VAKKEN id) means a vak with no VAKKEN entry —
  // lichamelijke opvoeding — resolves too, and a new vak needs no table entry.
  var THEMA_ALIAS = [
    { re: /\b(wero|wo)\b/i, tag: /wereldori/i },
    { re: /\bgodsdienst\b/i, tag: /godsdienst/i },
    { re: /\b(muvo|muzo)\b/i, tag: /muzische|muvo|muzo/i },
    { re: /\b(l\.?o\.?|turnen|zwemmen)\b/i, tag: /lichamelijke|turnen/i }
  ];
  function topTagById(id) {
    var tops = topTagsForOwner(ownTagsList(), ctx.ownerId) || [];
    for (var i = 0; i < tops.length; i++) if (String(tops[i].id) === String(id)) return tops[i];
    return null;
  }
  // A committed thema title starts with its tag title + separator. Only accept a prefix that
  // matches a tag we actually know — never a blind split on the separator.
  function themaTagFromPrefix(title) {
    var t = normTitle(title); if (!t) return null;
    var tops = topTagsForOwner(ownTagsList(), ctx.ownerId) || [];
    // NB: normTitle() trims, which would strip the separator's spaces and never match.
    // Collapse whitespace WITHOUT trimming so " — " stays " — ".
    var sep = String(THEMA_SEP).toLowerCase().replace(/\s+/g, " ");
    var best = null, bestLen = -1;
    tops.forEach(function (tag) {
      var n = normTitle(tag.title); if (!n) return;
      if (t.indexOf(n + sep) !== 0) return;
      if (n.length > bestLen) { best = tag; bestLen = n.length; }
    });
    return best;
  }
  function themaTagFor(origTitle) {
    var t = normTitle(origTitle); if (!t) return null;
    // 1. An explicit "<Thema> — <fiche>" prefix we wrote ourselves on a previous commit.
    var pre = themaTagFromPrefix(origTitle); if (pre) return pre;
    var tops = topTagsForOwner(ownTagsList(), ctx.ownerId) || [];
    // 2. Containment either way, so "Godsdienst - hele week" matches the tag "Godsdienst".
    //    Longest tag title wins, so a short tag never shadows a more specific one.
    var best = null, bestLen = -1;
    tops.forEach(function (tag) {
      var n = normTitle(tag.title); if (!n) return;
      if (t.indexOf(n) < 0 && n.indexOf(t) < 0) return;
      if (n.length > bestLen) { best = tag; bestLen = n.length; }
    });
    if (best) return best;
    // 3. Tight aliases for abbreviations ("WO" → Wereldoriëntatie).
    for (var i = 0; i < THEMA_ALIAS.length; i++) {
      var a = THEMA_ALIAS[i];
      if (!a.re.test(origTitle || "")) continue;
      var hit = null;
      for (var k = 0; k < tops.length; k++) if (a.tag.test((tops[k].title || "").trim())) { hit = tops[k]; break; }
      if (hit) return hit;
    }
    return null;
  }
  // The fiche part of a committed thema title, i.e. everything after "<Thema> — ".
  function stripThemaPrefix(title) {
    var tag = themaTagFromPrefix(title); if (!tag) return title || "";
    // The prefix is already validated, so the first em dash after it IS the separator.
    var str = String(title || ""), cut = str.indexOf("—");
    return cut > -1 ? str.slice(cut + 1).replace(/^\s+/, "") : str;
  }
  // Build the title to COMMIT for a thema slot. Idempotent — re-committing never doubles the
  // prefix, because the incoming title is stripped of any prefix we already wrote.
  function themaTitleFor(tagId, body) {
    var label = tagId != null ? (anyTagTitle(tagId) || "").trim() : "";
    body = stripThemaPrefix(body || "");
    if (!label) return body;
    if (!body) return label;
    return label + THEMA_SEP + body;
  }
  function themaCommitTitle(s, ficheTitle) { return themaTitleFor(s.themaTagId, ficheTitle || s.title || ""); }
  // A whole-week item's stable identity for the manual vak override: the recurring-series id when
  // there is one, else its (normalised) original title. Same two signals stampThemaKey trusts.
  function themaIdentity(s) {
    if (!s) return null;
    if (s.repeatId) return "rep:" + s.repeatId;
    var t = normTitle(s.origTitle || s.title);
    return t ? "title:" + t : null;
  }
  function themaVakOverride(s) {
    var id = themaIdentity(s); if (!id) return null;
    var v = (state.themaVak || {})[id];
    return v != null ? v : null;
  }
  function setThemaVakOverride(s, tagId) {
    var id = themaIdentity(s); if (!id) return;
    if (!state.themaVak) state.themaVak = {};
    if (tagId == null) delete state.themaVak[id]; else state.themaVak[id] = tagId;
    saveState();
  }
  // A lesuur's vak follows its fiche, unless the teacher picked another Vak in the popup AFTER the
  // fiche was placed. Keyed by itemId — calendar writes are single-occurrence, so the id is stable.
  function slotVakOverride(s) {
    var v = s && s.itemId != null ? (state.slotVak || {})[s.itemId] : null;
    return v != null ? v : null;
  }
  function setSlotVakOverride(s, tagId) {
    if (!s || s.itemId == null) return;
    if (!state.slotVak) state.slotVak = {};
    var had = s.itemId in state.slotVak;
    if (tagId == null) { if (!had) return; delete state.slotVak[s.itemId]; } else state.slotVak[s.itemId] = tagId;
    saveState();
  }
  // Stamp themaKey/themaTagId on a full-day slot. Idempotent; safe to call again after a reload.
  // Priority: the recurring-series id (survives ANY rename) → tag resolved from origTitle
  // (prefix, containment, alias) → the normalised title itself.
  function stampThemaKey(s) {
    if (!s || !s.isFullday || s.idCalendar === "cal_holidays") return s;
    // An explicit choice from the popup beats prefix/tag/alias — it is the one signal that is
    // not a guess, and it is how an unmatched row gets named without a code change.
    var ov = themaVakOverride(s);
    var tag = ov != null ? topTagById(ov) : themaTagFor(s.origTitle || s.title);
    s.themaTagId = tag ? tag.id : (ov != null ? ov : null);
    // A recurring whole-week thema keeps one id_repeat across every week, and Questi never
    // rewrites it — so it identifies the series even after the title became a fiche title.
    if (s.repeatId) { s.themaKey = "rep:" + s.repeatId; return s; }
    if (tag) { s.themaKey = "tag:" + tag.id; return s; }
    // No tag, no series (e.g. a schooluitstap): its own row, keyed and labelled by its title,
    // rather than silently taking over another row.
    s.themaKey = "title:" + (normTitle(s.origTitle || s.title) || "?");
    return s;
  }
  // Boot fires fetchOwnTags() and reloadWeek() in parallel, so hydrate may stamp before the tag
  // list exists — then every key falls back to "title:". Re-stamping is pure (origTitle never
  // changes) and idempotent, so run it before each render and the keys heal once tags arrive.
  function ensureThemaKeys(slots) {
    (slots || []).forEach(function (s) {
      if (!s.isFullday || s.idCalendar === "cal_holidays") return;
      var hadTag = s.themaTagId != null;
      stampThemaKey(s);
      if (!hadTag && s.themaTagId != null && !s.vak) s.vak = s.themaTagId;
    });
    return slots;
  }
  function themaLabel(key, slots) {
    if (key && key.indexOf("tag:") === 0) {
      var id = key.slice(4), t = (anyTagTitle(id) || "").trim();
      if (t) return t;
    }
    // "rep:" keys carry no tag in the key itself — read it off any slot in that row.
    for (var i = 0; i < (slots || []).length; i++) {
      var s2 = slots[i]; if (s2.themaKey !== key) continue;
      if (s2.themaTagId != null) { var tt = (anyTagTitle(s2.themaTagId) || "").trim(); if (tt) return tt; }
      var ot = stripQuestiDecoration(s2.origTitle);
      return (stripThemaPrefix(ot) || ot || "").trim() || "Thema";
    }
    return "Thema";
  }
  // Distinct thema keys across the given slots, ordered by the teacher's own tag order first
  // (so WO/Godsdienst keep their familiar sequence), untagged ones alphabetically after.
  function themaKeysOf(slots) {
    var seen = {}, tagged = [], plain = [];
    (slots || []).forEach(function (s) {
      if (!s.isFullday || s.idCalendar === "cal_holidays" || !s.themaKey || seen[s.themaKey]) return;
      seen[s.themaKey] = true;
      (s.themaKey.indexOf("tag:") === 0 ? tagged : plain).push(s.themaKey);
    });
    var order = {}; (topTagsForOwner(ownTagsList(), ctx.ownerId) || []).forEach(function (t, i) { order["tag:" + t.id] = i; });
    tagged.sort(function (a, b) { return (order[a] == null ? 1e6 : order[a]) - (order[b] == null ? 1e6 : order[b]); });
    plain.sort(function (a, b) { return a.localeCompare(b, "nl"); });
    return tagged.concat(plain);
  }
  // Commit rule (for the external reader): item title = plain fiche title (set on assign; Questi's
  // "* … (1)" attach title is never adopted); item description = the top-level vak (subject) name.
  // The week's themafiche title for a lesuur's vak, without its "<Thema> — " prefix.
  // `slots` defaults to the planner week; print passes its own pv.slots.
  function themaFicheTitleFor(slot, slots) {
    if (!slot || slot.isFullday) return "";
    var top = topTagIdOf(slot.vak); if (top == null) return "";
    var hit = (slots || view.slots).filter(function (x) {
      return x.isFullday && x.weekIdx === slot.weekIdx && x.idCalendar !== "cal_holidays" &&
        x.themaTagId != null && String(x.themaTagId) === String(top) && x.ficheTitle;
    })[0];
    return hit ? (stripThemaPrefix(hit.ficheTitle) || "").trim() : "";
  }
  // "Zie themafiche." is shown ONLY on a thema lesuur without its own fiche, in a week that really
  // has a themafiche for its vak. A band shows its fiche or its own title; a lesuur with its own
  // fiche shows that fiche; with no themafiche that week the literal would point at nothing.
  // Shared by grid, print and review so the three can never disagree again.
  function themaShowsLiteral(s, slots) {
    if (!s || isThemaSlot(s) || !s.themaFiche) return false;
    if (s.ficheContentId && s.ficheTitle) return false;
    // Normally applyThemaLesuurTitles already put the themafiche name in the title; the literal
    // is only left for a lesuur still showing its "Lesuur N" placeholder (e.g. not editable).
    if (!isLesuurPlaceholder(s.title)) return false;
    return !!themaFicheTitleFor(s, slots);
  }
  // A fiche-less WO/Godsdienst lesuur TITLE = the week's themafiche name; its description stays the
  // vak (Enderklas reads the vak from the description, the lesson from the title). Only a
  // "Lesuur N" placeholder, a title we set ourselves, or last version's themafiche name is replaced
  // — never a title the teacher typed. No themafiche any more → our title goes back to origTitle.
  // Idempotent; returns how many titles changed.
  function applyThemaLesuurTitles(slots) {
    var n = 0, all = slots || [];
    function clean(t) { return stripQuestiDecoration(stripThemaPrefix(t || "") || t || "").trim(); }
    // Any themafiche name in that week (current or as loaded): a title equal to one was written by us.
    function themaNamesOf(weekIdx) {
      var names = {};
      all.forEach(function (x) {
        if (!x.isFullday || x.weekIdx !== weekIdx || x.idCalendar === "cal_holidays") return;
        [x.ficheTitle, x.origFicheTitle].forEach(function (t) { var c = clean(t); if (c) names[c] = true; });
      });
      return names;
    }
    all.forEach(function (s) {
      if (!s || s.isFullday || s.isGym || s.ficheContentId || !s.isEditable || s.idCalendar === "cal_holidays") return;
      if (!s.themaFiche) return;
      // Stored title not read yet — or the week's bars are still loading, so their themafiche is unknown.
      if (isUnhydrated(s) || all.some(function (x) { return x.isFullday && x._pending && x.weekIdx === s.weekIdx; })) return;
      var top = topTagIdOf(s.vak);
      var bar = top == null ? null : all.filter(function (x) {
        return x.isFullday && x.weekIdx === s.weekIdx && x.idCalendar !== "cal_holidays" &&
          x.themaTagId != null && String(x.themaTagId) === String(top) && x.ficheTitle;
      })[0];
      var tf = bar ? clean(bar.ficheTitle) : "";
      var ours = s.autoThemaTitle || isLesuurPlaceholder(s.title) || !!themaNamesOf(s.weekIdx)[String(s.title || "").trim()];
      if (tf) {
        if (ours && s.title !== tf) { s.title = tf; n++; }
        if (ours) s.autoThemaTitle = true;
      } else if (ours && !isLesuurPlaceholder(s.title)) {
        // No themafiche for this vak (any more): give back the placeholder, never another vak's name.
        var back = (s.origTitle && !themaNamesOf(s.weekIdx)[clean(s.origTitle)]) ? s.origTitle : placeholderTitleFor(s, all);
        if (back && s.title !== back) { s.title = back; n++; }
        s.autoThemaTitle = false;
      }
    });
    return n;
  }
  // Rebuild "Lesuur N" for a lesuur whose stored title was overwritten: N = its position among the
  // recurring lesuren of the same calendar that day (Questi's own numbering). "" if it can't tell.
  function placeholderTitleFor(s, slots) {
    if (!s.repeatId) return "";
    var day = (slots || []).filter(function (x) {
      return !x.isFullday && x.weekIdx === s.weekIdx && x.dayIdx === s.dayIdx &&
        x.idCalendar === s.idCalendar && x.repeatId && x.time;
    }).map(function (x) { return x.time; });
    var uniq = day.filter(function (t, i) { return day.indexOf(t) === i; }).sort();
    var i = uniq.indexOf(s.time);
    return i > -1 ? ("Lesuur " + (i + 1)) : "";
  }
  // Instellingen win again for the loaded week(s): drop every hand-picked vak and the vak read back
  // from stored descriptions. A lesuur with a fiche gets the fiche's vak (when known), any other the
  // timeslot setting. Staged like any edit — the review shows each description/title change.
  function resetVakkenToDefault() {
    if (busyLoading()) return;
    var cand = view.slots.filter(function (s) {
      return s.isEditable && !s.isFullday && !s.isGym && s.idCalendar !== "cal_holidays";
    });
    if (!cand.length) { setStatus("Geen lesuren in de geladen week."); return; }
    pushUndo("vakken herstellen");
    var touched = false;
    cand.forEach(function (s) {
      if (state.slotVak && s.itemId in state.slotVak) { delete state.slotVak[s.itemId]; touched = true; }
      s.vakReset = true;
      var fv = s.ficheContentId ? _ficheVakCache[s.ficheContentId] : null;
      var target = fv != null ? fv : (state.settings[slotKeyStd(s.dayIdx, s.time)] || "");
      if (target === "" || target == null) return;
      s.vak = target;
      s.themaFiche = isThemaVak(s.vak);
    });
    if (touched) saveState();
    renderTimetable();
    var n = cand.filter(computeDirty).length;
    setStatus(n ? (n + " lesuur/lesuren aangepast naar de standaard (fiche of Instellingen) — controleer bij Wijzigingen.") : "Alle lesuren volgen al de standaard.");
  }
  // Questi's week list decorates titles of items with a fiche as "* <fiche> (n)". Display-only strip.
  var DECORATED_RE = /^\*\s*(.+?)\s*\(\d+\)\s*$/;
  function stripQuestiDecoration(t) {
    var m = String(t == null ? "" : t).match(DECORATED_RE);
    return m ? m[1] : String(t == null ? "" : t);
  }
  function descFor(slot) {
    if (slot.isGym) return null;
    // A whole-week bar keeps the literal; it already names its fiche in its title.
    if (slot.isFullday && slot.themaFiche) return "Zie themafiche.";
    // A thema lesuur's description is its vak like any other: Enderklas reads the vak from here.
    // The themafiche's NAME goes into the title instead (applyThemaLesuurTitles).
    // Description = the LIVE top-level tag ("vak") the fiche was filtered/picked under. No
    // title-guessing: downstream tooling reads this to disambiguate same-titled fiches
    // (e.g. "Thema 5 - Les …"), so it must be the real tag, never a heuristic from the title.
    var top = topTagIdOf(slot.vak);
    return top != null ? ((anyTagTitle(top) || "").trim()) : "";
  }
  function toHtmlDesc(t) { if (t == null) return ""; return String(t).replace(/\n/g, "<br />"); }
  function stripHtml(s) { return String(s == null ? "" : s).replace(/<br \/>/g, "").replace(/<[^>]*>/g, "").trim(); }
  function weekdayIdx(iso) { if (!iso) return -1; var d = new Date(iso); if (isNaN(d.getTime())) return -1; return (d.getDay() + 6) % 7; }
  function timeFromISO(iso) { if (!iso) return ""; var m = String(iso).match(/[T ](\d{2}:\d{2})/); return m ? m[1] : ""; }
  function isoDate(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function addDays(iso, n) { var d = new Date(String(iso) + "T00:00:00"); if (isNaN(d.getTime())) return null; d.setDate(d.getDate() + n); return d; }
  function ddmm(iso, offset) { var d = addDays(iso, offset || 0); return d ? String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") : ""; }
  function slotKeyStd(dayIdx, time) { return dayIdx + "|" + time; }

  function computeDirty(s) {
    // Its stored title/description/fiche are not known yet (or could not be read): never a change.
    if (isUnhydrated(s)) return false;
    // "Vak als beschrijving schrijven" off → a description difference is never a reason to write.
    var descChanged = writesDescriptions() && toHtmlDesc(descFor(s)) !== (s.origDescription || "");
    var titleChanged = (s.title || "") !== (s.origTitle || "");
    var ficheChanged = (s.ficheContentId || null) !== (s.origFicheContentId || null);
    return descChanged || titleChanged || ficheChanged;
  }

  // Current school-year window: Sep 1 (start year) → Aug 31 (start year + 1).
  function schoolYearBounds() {
    var sy = String(ctx.schoolyear || ""), m = sy.match(/(20\d{2})\s*-\s*(20\d{2})/), startY;
    if (m) startY = +m[1];
    else { var d = new Date(); startY = (d.getMonth() >= 7) ? d.getFullYear() : d.getFullYear() - 1; }
    return { start: new Date(startY, 8, 1), end: new Date(startY + 1, 7, 31, 23, 59, 59) };
  }
  // "Gebruikt" only counts when the fiche was last used within THIS school year.
  function usedThisYear(f) {
    var d = f && f.last_used_date; if (!d) return false;
    var s = String(d); if (s.length <= 4 || s.indexOf("0000") === 0) return false;
    var dt = new Date(s.replace(" ", "T")); if (isNaN(dt.getTime())) return false;
    var b = schoolYearBounds();
    return dt >= b.start && dt <= b.end;
  }
  // "gebruikt 12/10" chip for picker rows; full date on hover. Only reached when usedThisYear
  // already validated the date, so the slice is safe.
  function usedChip(f) {
    if (!usedThisYear(f)) return null;
    var iso = String(f.last_used_date).slice(0, 10);
    return h("span", { class: "qwp-used", title: "Laatst gebruikt op " + iso.split("-").reverse().join("/"), text: "gebruikt " + ddmm(iso, 0) });
  }

  // ---------- Hydrate ----------
  // Two stages. The /cal/items LIST alone gives every slot its day, time, settings vak and thema
  // identity, so the grid can paint at once; each lesuur's DETAIL (stored title, description, fiche,
  // groups) follows through mapLimit(…, 4). hydrateRangeLive resolves at the list stage with
  // { slots, done, total } — `done` settles when every detail has answered (never rejects) — and
  // calls onDetail(slot) after each one. Until its detail is in, a slot carries `_pending`; a failed
  // read leaves `_detailFailed`. Both make isUnhydrated() true: such a slot is never dirty, never
  // re-vakked or re-titled, cannot be edited, and Controleer waits for `_pending` to clear.
  // hydrateRange (print, settings) still resolves only once everything is read.
  function hydrateRange(startISO, endISO) { return hydrateRangeLive(startISO, endISO).then(function (r) { return r.done; }); }
  function isUnhydrated(s) { return !!(s && (s._pending || s._detailFailed)); }
  function hydrateRangeLive(startISO, endISO, onDetail, skip) {
    return fetchItems(startISO, endISO).then(function (items) {
      var slots = items.map(function (it) {
        var day = weekdayIdx(it.startdate);
        var wk = view.weekStart ? Math.floor(((addDays(String(it.startdate).slice(0, 10), 0) || new Date()) - (addDays(view.weekStart, 0) || new Date())) / 86400000 / 7) : 0;
        return {
          itemId: it.id, title: it.title || "", origTitle: it.title || "",
          startdate: it.startdate, enddate: it.enddate,
          idCalendar: it.id_calendar, isFullday: !!it.is_fullday_item,
          // Recurring-series id: stable across weeks AND across renames, so it is the strongest
          // thema identity available. Questi returns it on /cal/items; we simply never kept it.
          repeatId: it.id_repeat || null,
          dayIdx: day, weekIdx: (wk < 0 ? 0 : wk), time: timeFromISO(it.startdate),
          groups: (it.groups && it.groups.length) ? it.groups : writeGroups(),
          hasAtt: !!it.has_attachments, isEditable: it.is_editable !== false,
          // Title-based only for a whole-week item (its title is the thema's own). A lesuur's
          // themaFiche comes from its VAK below — a typed title must never reclassify it.
          isGym: isGymTitle(it.title), themaFiche: it.is_fullday_item ? isThemaTitle(it.title) : false,
          // Full-day items have no start time, so slotKeyStd() would give every one of them on
          // a weekday the SAME settings key ("<day>|") — WO and Godsdienst would share a vak.
          // Their vak comes from the resolved thema tag instead (set by stampThemaKey below).
          vak: it.is_fullday_item ? "" : (state.settings[slotKeyStd(day, timeFromISO(it.startdate))] || ""),
          themaKey: null, themaTagId: null,
          description: "", origDescription: "",
          ficheContentId: null, ficheTitle: "", origFicheContentId: null, origFicheTitle: "",
          starttime: "", endtime: "", _hydrated: false,
          // The week window this slot was read in = its occurrence window when written (patchItem's
          // range_*), kept per slot so a staged change from another week still hits ITS occurrence.
          _range: { start: startISO, end: endISO }
        };
      });
      // Stamp thema identity before anything can overwrite a title.
      slots.forEach(function (s) {
        stampThemaKey(s);
        if (s.isFullday && s.themaTagId != null) s.vak = s.themaTagId;
        else if (!s.isFullday && isThemaVak(s.vak)) s.themaFiche = true;
      });
      var need = slots.filter(function (s) { return s.idCalendar !== "cal_holidays" && (s.hasAtt || !/^Lesuur\s*\d+$/.test(s.title)) && !(skip && skip(s)); });
      // One detail read per lesuur — the boot's biggest cost. Four at a time (never a burst; see
      // mapLimit) instead of strictly one after another; each slot only touches its own fields.
      need.forEach(function (s) { s._pending = true; });
      var done = mapLimit(need, 4, function (s) {
          return readSlotDetail(s).then(function () { s._pending = false; if (onDetail) onDetail(s); });
      }).then(function () { return slots; });
      return { slots: slots, done: done, total: need.length };
    });
  }
  // One lesuur's detail read. A failed read is retried quietly after ~1 s and again after ~3 s; it
  // keeps its mapLimit place while it waits, so retries never put more requests in flight. Only
  // when all three tries fail does the slot become `_detailFailed` — "niet geladen" on the card,
  // with a manual retry there and in the sidebar (retryFailedDetails). Never rejects.
  var DETAIL_RETRY_MS = [1000, 3000];
  function readSlotDetail(s, attempt) {
    attempt = attempt || 0;
    return fetchItemDetail(s.itemId).then(function (d) {
      if (!d) throw new Error("leeg antwoord");
      applySlotDetail(s, d);
    }).catch(function () {
      if (attempt >= DETAIL_RETRY_MS.length) { s._detailFailed = true; return; }
      return new Promise(function (res) { setTimeout(res, DETAIL_RETRY_MS[attempt]); })
        .then(function () { return readSlotDetail(s, attempt + 1); });
    });
  }
  function applySlotDetail(s, d) {
    s._detailFailed = false;
    s.origDescription = d.description || ""; s.description = s.origDescription;
    // Since ~2026-10 the LIST endpoint reports a computed `title_lessons` ("* <fiche> (1)") in
    // `title` for any item with a fiche; the detail keeps the real stored title. Use that, or
    // the next commit would write the decoration into the stored title.
    if (typeof d.title === "string" && d.title) { s.origTitle = d.title; s.title = d.title; }
    var att = ficheAttachment(d.attachments);
    if (att && att.content) { s.origFicheContentId = att.content.id; s.ficheContentId = att.content.id; s.origFicheTitle = att.content.subject || ""; s.ficheTitle = s.origFicheTitle; }
    // The authoritative group id lives here (list groups are always empty); keep it.
    if (d.groups && d.groups.length) { s.groups = d.groups; if (ctx.groupId == null) ctx.groupId = firstGroupId(d.groups); }
    if (stripHtml(s.origDescription) === "Zie themafiche.") s.themaFiche = true;
    if (d.starttime) { s.starttime = d.starttime; if (!s.time) s.time = String(d.starttime).slice(0, 5); }
    s.endtime = d.endtime || ""; s._hydrated = true;
  }

  function buildCommitPlan(slots) {
    // Occurrence window = the loaded week window (same range used to GET /cal/items).
    var range = currentWeekRange();
    return slots.filter(function (s) { return s.isEditable && s.idCalendar !== "cal_holidays" && computeDirty(s); }).map(function (s) {
      var nd = descFor(s);
      var grps = writeGroupObjs(s.groups);
      // Questi rejects an empty title — keep a safe fallback for emptied slots.
      var title = s.title || "Lesuur";
      // A whole-week thema commits as "<Thema> — <fiche>" so its identity survives in Questi
      // itself, instead of being inferred from a title the fiche just overwrote.
      if (isThemaSlot(s) && s.themaTagId != null) title = themaCommitTitle(s, s.title);
      var startDay = s.startdate ? String(s.startdate).slice(0, 10) : undefined;
      var hasFiche = !s.isGym && !!s.ficheContentId;
      var body;
      if (s.isFullday) {
        // Full-day/thema item: is_fullday_item TRUE, keep the date span, NO times.
        body = {
          calendarId: s.idCalendar || ctx.calendarId, title: title, description: toHtmlDesc(nd), is_fullday_item: true,
          startdate: startDay, enddate: s.enddate ? String(s.enddate).slice(0, 10) : startDay,
          is_published_students: false, is_published_parents: false, groups: grps, participants: []
        };
      } else {
        // Normal lesuur: single day (start==end) + start/end times.
        var st = s.starttime || (timeFromISO(s.startdate) ? timeFromISO(s.startdate) + ":00" : undefined);
        var et = s.endtime || (timeFromISO(s.enddate) ? timeFromISO(s.enddate) + ":00" : undefined);
        body = {
          calendarId: s.idCalendar || ctx.calendarId, title: title, description: toHtmlDesc(nd), is_fullday_item: false,
          startdate: startDay, enddate: startDay,
          starttime: st, endtime: et,
          is_published_students: false, is_published_parents: false, groups: grps, participants: []
        };
      }
      // No fiche (emptied slot or gym) → send attachments:[] to DETACH any existing fiche
      // (otherwise the fiche keeps overriding the title). With a fiche, omit the key so the
      // separate POST /attachments survives.
      if (!hasFiche) body.attachments = [];
      // "Vak als beschrijving schrijven" off (state.writeVakDescription): the description is left
      // exactly as stored — the vak AND the whole-week bar's "Zie themafiche." alike, because both
      // are the planner writing into a field the teacher may use for something else. The PATCH
      // still carries `description` (the captured body always does; omitting it is untested), so
      // it echoes the stored value. A slot hydrate skipped (placeholder "Lesuur N", no fiche) never
      // read it: doCommit reads the item first (descEcho) rather than blanking it with "".
      var descEcho = false;
      if (!writesDescriptions()) {
        nd = null;
        if (s._hydrated) body.description = s.origDescription || "";
        else { body.description = ""; descEcho = true; }
      }
      return {
        itemId: s.itemId, label: (s.title || "lesuur") + " (" + DAY_ABBR[s.dayIdx] + " " + (s.time || "") + ", wk " + (s.weekIdx + 1) + ")",
        old: { title: s.origTitle, desc: s.origDescription, fiche: s.origFicheTitle || "(geen)" },
        neu: { title: s.title, desc: writesDescriptions() ? toHtmlDesc(nd) : (s.origDescription || ""), fiche: (s.isGym ? "(geen — gym)" : (s.ficheTitle || "(geen)")) },
        descEcho: descEcho,
        patchBody: body, range: s._range || range,
        themaTagId: (isThemaSlot(s) && s.themaTagId != null) ? s.themaTagId : null,
        // Only re-POST the attachment when the fiche actually CHANGED. A description- or title-only
        // edit is a plain PATCH: omitting `attachments` keeps the existing one. Re-POSTing an
        // unchanged fiche once rewrote every old lesuur's title to Questi's "* … (1)".
        fiche: (hasFiche && String(s.ficheContentId) !== String(s.origFicheContentId || "")) ? { contentId: s.ficheContentId, groups: grps, isMethod: !!s.ficheIsMethod } : null,
        keepsFiche: hasFiche && String(s.ficheContentId) === String(s.origFicheContentId || "")
      };
    });
  }

  // ---------- UI state ----------
  var els = {};
  var DAY_NAMES = ["Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag"];
  var DAY_ABBR = ["ma", "di", "wo", "do", "vr"];
  // Time rows, break bands, and no-school cells are all derived from live data
  // (see computeTimeRows / breakLabelAfter / isNoSchool) — no hardcoded clock.
  function mkViewPanel() { return { source: "self", sortDir: "az", filterVak: null, filterTagId: null, unionMode: true, subTagId: null, picked: {}, search: "", loading: false, hideUsed: false, gradeFilter: null }; }
  var view = {
    weekStart: null, weeks: 2, weekOffset: 0,   // always this week + next (stacked)
    slots: [], timeRows: [], rowMeta: {}, presence: {}, ficheGroups: [], tags: [], ownTags: [], people: [],
    ownTopTags: [], ficheCache: {}, targetSlots: [], vakTagMap: {},
    selectedSlotId: null, undoStack: [], dragVakTag: null, allByOwner: {},
    methodFicheIds: {}, // ids seen from any /methods/{key}/lessons fetch → attach via methodlesson
    panels: [mkViewPanel(), mkViewPanel(), mkViewPanel()]
  };

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k === "style") e.setAttribute("style", attrs[k]);
      else if (k.slice(0, 2) === "on" && typeof attrs[k] === "function") e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function elId(id) { return document.getElementById(id); }
  function setStatus(t) { var s = elId("qwp-status"); if (s) s.textContent = t; }
  function groupFor(ownerId) { return view.ficheGroups.filter(function (g) { return String(g.ownerId) === String(ownerId); })[0]; }
  function ownerName(id) { if (String(id) === String(myId())) return "Ik"; var c = state.colleagues.filter(function (x) { return String(x.id) === String(id); })[0]; if (c && c.isMethod) return "Methode: " + c.name; return c ? c.name : ("#" + id); }

  // ---------- Shell ----------
  // UnQuesti "Plannen" layout. Left: a wide sidebar — section tabs, vak chips, an Ik/Collega
  // switch, a folding filter, ONE fiche list, and four action buttons pinned to the bottom.
  // Right: a week header and this week + next week stacked. Every action of the old narrow
  // sidebar lives on in the "Alles" menu (openAlles), so nothing was dropped with it.
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ICONS = {
    filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"></path>',
    alles: '<circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"></path>',
    inst: '<rect x="3" y="4" width="18" height="17" rx="2"></rect><path d="M3 9h18M8 2v4M16 2v4"></path>',
    debug: '<path d="M8 2l1.5 2M16 2l-1.5 2M9 7h6a3 3 0 0 1 3 3v4a6 6 0 0 1-12 0v-4a3 3 0 0 1 3-3zM12 11v9M6 12H2M22 12h-4M6 17l-3 2M18 17l3 2"></path>',
    check: '<path d="M20 6L9 17l-5-5"></path>'
  };
  // Constant markup only (never data), parsed in the SVG namespace.
  function svgIcon(name, size, stroke) {
    var s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("width", size); s.setAttribute("height", size); s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", stroke || "1.8");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
    s.innerHTML = ICONS[name] || "";
    return s;
  }
  function actBtn(id, icon, label, onclick, extraCls, title) {
    // Compact bar: Alles/Instellingen/Debug are icon buttons (name in the tooltip and for screen
    // readers); only the primary Controleer shows its label (CSS hides the others' text).
    return h("button", { class: "qwp-actbtn" + (extraCls ? " " + extraCls : ""), id: id, title: title || label, "aria-label": label, onclick: onclick }, [svgIcon(icon, 18, icon === "check" ? "2" : "1.8"), h("span", { class: "qwp-actlbl", text: label })]);
  }
  // The three tabs, drawn at the top of whichever sidebar is showing (Plannen's or Afdrukken's).
  // Plannen and Afdrukken swap the window's two columns (showTab); Lesfiches opens the manager.
  function openLesfichesTab() { goTab("lesfiches"); }
  function tabsNav(active) {
    function tab(id, label, title, fn) {
      var on = id === active;
      return h("button", { class: "qwp-tab" + (on ? " active" : ""), "data-tab": id, "aria-current": on ? "page" : null, title: on ? null : title, text: label, onclick: fn });
    }
    return h("nav", { class: "qwp-tabs", "aria-label": "Onderdelen" }, [
      tab("plan", "Plannen", "Terug naar de weekplanning", function () { goTab("plan"); }),
      tab("lesfiches", "Lesfiches", "Lesfiche-manager openen", function () { goTab("lesfiches"); }),
      tab("print", "Afdrukken", "Afdrukken: de opgeslagen planning van een week", function () { goTab("print"); })
    ]);
  }
  function buildShell() {
    var tabs = tabsNav("plan");
    var sortSel = h("select", { class: "qwp-fsel", id: "qwp-sort-0", onchange: function (e) {
      var p = view.panels[0]; p.sortDir = e.target.value === "za" ? "za" : "az"; state.panels[0].sortDir = p.sortDir; saveState(); renderPickList(0);
    } }, [h("option", { value: "az", text: "Titel A → Z" }), h("option", { value: "za", text: "Titel Z → A" })]);
    var hideChk = h("input", { type: "checkbox", id: "qwp-hideused-0", onchange: function (e) {
      var p = view.panels[0]; p.hideUsed = !!e.target.checked; state.panels[0].hideUsed = p.hideUsed; saveState(); renderPickList(0);
    } });
    var filter = h("div", { class: "qwp-filter qwp-plan-only", id: "qwp-filter" }, [
      h("label", { class: "qwp-flbl" }, ["Leerjaar", h("select", { class: "qwp-fsel", id: "qwp-grade-0", onchange: function (e) {
        var p = view.panels[0]; p.gradeFilter = e.target.value || null; state.panels[0].gradeFilter = p.gradeFilter; saveState(); renderPickList(0);
      } })]),
      h("label", { class: "qwp-flbl" }, ["Sorteren", sortSel]),
      h("label", { class: "qwp-fchk wide" }, [hideChk, h("span", { text: "Verberg al gebruikt dit schooljaar" })])
    ]);
    var filterBtn = h("button", { class: "qwp-filterbtn", id: "qwp-filterbtn", "aria-expanded": "false", "aria-label": "Filter: leerjaar, sorteren, verberg gebruikt", onclick: toggleFilter }, [svgIcon("filter", 15, "2"), h("span", { class: "qwp-filterdot", id: "qwp-filterbtn-t" })]);
    // One row under the vakken: owner · Alle (all own fiches) · text search · filter icon.
    var allBtn = h("button", { class: "qwp-allbtn", id: "qwp-allbtn-0", type: "button", title: "Alle eigen lesfiches, elk vak", text: "Alle" });
    var searchInp = h("input", { class: "qwp-finp qwp-rowsearch", id: "qwp-search-0", type: "search", placeholder: "Zoek…", "aria-label": "Zoek in de titels", oninput: function (e) { view.panels[0].search = e.target.value; renderPickList(0); } });
    var side = h("aside", { class: "qwp-side", id: "qwp-side" }, [
      h("div", { class: "qwp-side-top" }, [
        tabs,
        h("div", { class: "qwp-vaktoggle qwp-plan-only", id: "qwp-vaktoggle-0" }),
        // Subtags of the chosen vak (blok 1, blok 2 …): always in view, never folded into Filter.
        h("div", { class: "qwp-subcats qwp-plan-only", id: "qwp-subcats-0", role: "group", "aria-label": "Subtags" }),
        h("div", { class: "qwp-ownerrow qwp-plan-only" }, [h("div", { class: "qwp-ownerseg", id: "qwp-source-0", role: "group", "aria-label": "Eigenaar" }), allBtn, searchInp, filterBtn]),
        filter
      ]),
      // Lesfiches tab: lessons.js mounts its tag tree here (setTab → __QWP_LESSONS.mount).
      h("div", { class: "qwp-lf-side qwp-lf-only", id: "qwp-lf-side" }),
      h("div", { class: "qwp-picker qwp-plan-only", id: "qwp-picker-0" }, [
        h("div", { class: "qwp-picker-list", id: "qwp-picker-list-0" }),
        h("div", { class: "qwp-selbar", id: "qwp-selbar", style: "display:none" }, [
          h("span", { class: "qwp-pick-count", id: "qwp-pick-count-0", text: "0 geselecteerd" }),
          h("span", { class: "qwp-spacer" }),
          h("button", { class: "qwp-btn qwp-ghost qwp-sm", id: "qwp-clearsel-0", onclick: function () { view.panels[0].picked = {}; renderPickList(0); }, text: "Wis" }),
          h("button", { class: "qwp-btn qwp-sm", id: "qwp-addsel-0", title: "Zet de aangevinkte fiches in lege lesuren (eerst de gekozen doel-lesuren)", onclick: function () { openMassAdd(0); }, text: "Toevoegen aan rooster" })
        ])
      ]),
      h("nav", { class: "qwp-actions", "aria-label": "Acties" }, [
        actBtn("qwp-alles", "alles", "Alles", function (e) { openAlles(e.currentTarget); }, null, "Alle hulpmiddelen"),
        actBtn("qwp-inst", "inst", "Instellingen", openSettings, null, "Instellingen"),
        actBtn("qwp-debug", "debug", "Debug", openDiagnose, null, "Zelftest voor ontwikkelaars"),
        (function () {
          var b = actBtn("qwp-review", "check", "Controleer", openReview, "primary", "Controleer de wijzigingen en schrijf ze weg");
          b.appendChild(h("span", { class: "qwp-actbadge", id: "qwp-review-n", style: "display:none" }));
          return b;
        })(),
        // Hidden arming target kept for doCommit's lock/unlock bookkeeping.
        h("button", { class: "qwp-btn qwp-commit", id: "qwp-commit", disabled: "true", onclick: doCommit, text: "Wegschrijven", style: "display:none" })
      ])
    ]);
    side.querySelector("#qwp-alles").setAttribute("data-menu", "qwp-allesmenu");

    var header = h("header", { class: "qwp-mhdr" }, [
      h("button", { class: "qwp-navarrow", "aria-label": "Vorige week", title: "Een week terug", onclick: prevWeek, text: "←" }),
      h("div", { class: "qwp-range", id: "qwp-range" }),
      h("button", { class: "qwp-navarrow", "aria-label": "Volgende week", title: "Een week verder", onclick: nextWeek, text: "→" }),
      h("button", { class: "qwp-navbtn", onclick: thisWeek, title: "Deze week en volgende week", text: "Vandaag" }),
      h("span", { class: "qwp-spacer" }),
      h("span", { class: "qwp-goalcount", id: "qwp-goalcount", style: "display:none" }),
      h("div", { class: "qwp-modeseg", id: "qwp-modeseg", role: "group", "aria-label": "Modus" }, [
        h("button", { "data-m": "plan", onclick: function () { setMainMode("plan"); }, text: "Plannen" }),
        h("button", { "data-m": "doelen", onclick: function () { setMainMode("doelen"); }, title: "Lesdoelen per lesuur (alleen lezen)", text: "Doelen" })
      ]),
      h("div", { class: "qwp-fitseg", id: "qwp-fitseg", role: "group", "aria-label": "Weergave" }, [
        h("button", { "data-f": "fit", onclick: function () { setWeekFit("fit"); }, title: "Beide weken passend op het scherm (verkleint indien nodig)", text: "Passend" }),
        h("button", { "data-f": "scroll", onclick: function () { setWeekFit("scroll"); }, title: "Ware grootte, met een schuifbalk als het niet past", text: "Ruim" })
      ]),
      h("button", { class: "qwp-staged", id: "qwp-staged", style: "display:none", title: "Nog niet weggeschreven — klik om te controleren", onclick: openReview }),
      betaPill(),
      h("button", { class: "qwp-topx", onclick: hide, title: "Sluiten", text: "✕" })
    ]);
    var content = h("main", { class: "qwp-content qwp-plan-only" }, [header, h("div", { class: "qwp-ttwrap", id: "qwp-ttwrap" })]);
    // Lesfiches tab: lessons.js mounts its header, table and side sheet here.
    var lfMain = h("main", { class: "qwp-lf-main qwp-lf-only", id: "qwp-lf-main" });

    var pp = buildPrintPanel();
    // Status strip: one thin line under whichever main column is showing (all three tabs), so the
    // sidebar keeps its height for the fiche list. Keeps the qwp-side-status class (retry button).
    var statusStrip = h("div", { class: "qwp-side-status qwp-statusbar", role: "status" }, [
      h("div", { class: "qwp-side-note", id: "qwp-side-note", text: "" }),
      h("div", { class: "qwp-status", id: "qwp-status", text: "Laden…" })
    ]);
    var right = h("div", { class: "qwp-right" }, [content, lfMain, pp.main, statusStrip]);
    side.appendChild(sideResizer()); pp.side.appendChild(sideResizer());
    var main = h("div", { class: "qwp-main", id: "qwp-mainwrap" }, [side, pp.side, right]);

    var page = h("div", { class: "qwp-page", id: "qwp-page" }, [main]);
    var overlay = h("div", { class: "qwp-overlay", id: "qwp-overlay" }, [page]);
    els.root = overlay; els.page = page;
    // Menus close on any press outside them (their own opener toggles instead) and on Escape.
    document.addEventListener("mousedown", function (e) {
      ["qwp-allesmenu", "qwp-srcmenu"].forEach(function (id) {
        var m = elId(id); if (!m || m.contains(e.target)) return;
        if (e.target && e.target.closest && e.target.closest('[data-menu="' + id + '"]')) return;
        m.remove();
      });
    }, true);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeMenu("qwp-allesmenu"); closeMenu("qwp-srcmenu"); } });
    return overlay;
  }
  // The single tab switch. Plannen and Lesfiches share the Plannen column pair (setTab mounts the
  // Lesfiche-manager into it); Afdrukken swaps in its own column pair (showTab). Going to one tab
  // always leaves the other mode first, so no tab bar is ever out of step.
  function goTab(name) {
    if (name === "print") { if (_tab === "lesfiches") setTab("plan"); showTab("print"); return; }
    if (view.tab === "print") showTab("plan");
    setTab(name === "lesfiches" ? "lesfiches" : "plan");
  }
  // Plannen | Afdrukken: one window, two column pairs; only the visible pair is shown.
  function showTab(name) {
    view.tab = name === "print" ? "print" : "plan";
    var m = elId("qwp-mainwrap"); if (m) m.classList.toggle("tab-print", view.tab === "print");
    closeMenu("qwp-allesmenu"); closeMenu("qwp-srcmenu");
    var pop = elId("qwp-pop"); if (pop) pop.remove();
    if (view.tab === "print") enterPrintTab();
    else refreshStaged();
  }

  // Resolve any tag id (own OR colleague) up to its top-level subject tag id.
  function topTagIdOf(tagId) {
    if (tagId == null || tagId === "") return null;
    var pool = anyTagsList(), byId = {};
    pool.forEach(function (t) { byId[t.id] = t; });
    var cur = byId[tagId], guard = 0;
    while (cur && cur.parent && String(cur.parent) !== "0" && byId[cur.parent] && guard++ < 20) cur = byId[cur.parent];
    return cur ? cur.id : tagId;
  }
  // Per-subject (top-level tag) filled-slot tally + planned/empty totals.
  function renderBalance() {
    var el = elId("qwp-balance"); if (!el) return; el.innerHTML = "";
    var counts = {}, filled = 0, empty = 0;
    view.slots.forEach(function (s) {
      if (s.idCalendar === "cal_holidays" || s.isFullday) return;
      if (isNoSchool(s.dayIdx, s.time)) return;
      if (s.ficheContentId || s.isGym) {
        filled++;
        // Subject = the slot's live top-level tag (same source as the written description).
        // A gym slot uses its vak too when it has one, so an LO lesuur reads "Lichamelijke
        // opvoeding" rather than the generic "Gym".
        var label, color = null;
        var top = topTagIdOf(s.vak);
        if (top != null) { label = (anyTagTitle(top) || "").trim() || "Overig"; color = anyTagColor(top); }
        else label = s.isGym ? "Gym" : "Overig";
        if (!counts[label]) counts[label] = { n: 0, color: color };
        counts[label].n++;
      } else if (isTargetable(s)) empty++;
    });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b].n - counts[a].n || a.localeCompare(b); });
    if (!keys.length && !empty) { el.appendChild(h("div", { class: "qwp-balance-empty", text: "Nog niets gepland." })); return; }
    keys.forEach(function (k) {
      // Colour the label by the subject's questi tag colour.
      var vak = h("span", { class: "qwp-balance-vak", text: k });
      if (counts[k].color) vak.style.color = counts[k].color;
      el.appendChild(h("div", { class: "qwp-balance-row" }, [vak, h("span", { class: "qwp-balance-n", text: String(counts[k].n) })]));
    });
    el.appendChild(h("div", { class: "qwp-side-sep" }));
    el.appendChild(h("div", { class: "qwp-balance-tot", text: "Gepland " + filled + " · Leeg " + empty }));
  }

  // ---------- Modes, filter fold, staged count ----------
  // Plannen = both loaded weeks stacked; Doelen = one week with WEET/KEN/KAN per card, the other
  // week folded to a bar. The choice and the filter fold live in qwp_state_v6 (mainMode, filterOpen).
  function mainMode() { return state.mainMode === "doelen" ? "doelen" : "plan"; }
  function doelenWeek() { return Math.max(0, Math.min(view.weeks - 1, +state.doelenWeek || 0)); }
  function setMainMode(m) {
    state.mainMode = m === "doelen" ? "doelen" : "plan"; saveState();
    renderTimetable();
  }
  // ---- Sidebar width + week fit (state.sideWidth px | null, state.weekFit "fit" | "scroll") ----
  // The sidebar is dragged wider/narrower by its right edge (double-click = back to default); the
  // width lives in --qwp-side-w on the overlay, so Plannen, Lesfiches and Afdrukken share it.
  var SIDE_MIN = 260, SIDE_MAX = 760;
  function applySideWidth() {
    if (!els.root) return;
    if (state.sideWidth) els.root.style.setProperty("--qwp-side-w", state.sideWidth + "px");
    else els.root.style.removeProperty("--qwp-side-w");
  }
  function sideResizer() {
    var hd = h("div", { class: "qwp-sizer", role: "separator", "aria-orientation": "vertical", "aria-label": "Breedte zijbalk", title: "Sleep om de zijbalk breder of smaller te maken · dubbelklik = standaard" });
    hd.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var left = hd.parentNode.getBoundingClientRect().left, w = null;
      els.root.classList.add("qwp-resizing");
      function move(ev) {
        w = Math.round(Math.max(SIDE_MIN, Math.min(Math.min(SIDE_MAX, window.innerWidth * 0.6), ev.clientX - left)));
        els.root.style.setProperty("--qwp-side-w", w + "px");
      }
      function up() {
        document.removeEventListener("mousemove", move, true); document.removeEventListener("mouseup", up, true);
        els.root.classList.remove("qwp-resizing");
        if (w != null) { state.sideWidth = w; saveState(); }
        fitWeeks(); if (view.tab === "print") fitPrintFrame();
      }
      document.addEventListener("mousemove", move, true); document.addEventListener("mouseup", up, true);
    });
    hd.addEventListener("dblclick", function () { state.sideWidth = null; saveState(); applySideWidth(); fitWeeks(); if (view.tab === "print") fitPrintFrame(); });
    return hd;
  }
  // Passend: scale the weeks down (never up) until they fit the visible height — on a big screen
  // nothing changes; on a laptop both weeks stay in view. Ruim: true size plus a scroll bar.
  function weekFit() { return state.weekFit === "scroll" ? "scroll" : "fit"; }
  function setWeekFit(v) { state.weekFit = v; saveState(); syncFitSeg(); fitWeeks(); }
  function syncFitSeg() {
    var seg = elId("qwp-fitseg"); if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) { b.classList.toggle("active", b.getAttribute("data-f") === weekFit()); });
  }
  function fitWeeks() {
    var wrap = elId("qwp-ttwrap"), inner = elId("qwp-ttinner"); if (!wrap || !inner) return;
    inner.style.zoom = "";
    syncFitSeg();
    if (weekFit() !== "fit") return;
    var cs = getComputedStyle(wrap), avail = wrap.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
    var need = inner.scrollHeight;
    if (avail > 0 && need > avail + 1) inner.style.zoom = String(Math.max(0.5, avail / need).toFixed(3));
  }
  window.addEventListener("resize", function () { fitWeeks(); });
  function syncModeSeg() {
    var seg = elId("qwp-modeseg"); if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) { b.classList.toggle("active", b.getAttribute("data-m") === mainMode()); });
  }
  function toggleFilter() { state.filterOpen = !state.filterOpen; saveState(); applyFilterFold(); }
  // A folded filter that still hides fiches must say so on its button — never a silently short list.
  function filterActive(p) {
    return !!(p.gradeFilter || p.hideUsed);
  }
  function applyFilterFold() {
    var f = elId("qwp-filter"), b = elId("qwp-filterbtn"), t = elId("qwp-filterbtn-t"); if (!f || !b) return;
    var open = !!state.filterOpen, on = filterActive(view.panels[0]);
    f.style.display = open ? "" : "none";
    b.classList.toggle("open", open); b.classList.toggle("on", on && !open);
    b.setAttribute("aria-expanded", open ? "true" : "false");
    if (t) t.style.display = on && !open ? "" : "none";
    b.title = on ? "Er staat een filter aan (leerjaar of verberg gebruikt) — niet alle fiches worden getoond" : "Leerjaar, sorteren, verberg gebruikt";
  }
  // Same selection buildCommitPlan writes, without building the bodies.
  function stagedCount() {
    return view.slots.filter(function (s) { return s.isEditable && s.idCalendar !== "cal_holidays" && computeDirty(s); }).length + offscreenStaged().length;
  }
  // ---- Staged changes survive week navigation (plan a month, write once) ----
  // Leaving a week puts its changed lesuren aside in view.stash, whole (edits + the stored values
  // they are compared with + their own occurrence window, _range). Coming back puts the same objects
  // back instead of the freshly read ones, so the edits are still there; Controleer and the counts
  // include the ones in other weeks. Keyed by item id + date: a recurring series could share an id.
  // In memory only, like every staged change — a page reload drops them.
  function slotKey(s) { return String(s.itemId) + "|" + String(s.startdate || "").slice(0, 10); }
  function stashCurrent() {
    if (!view.stash) view.stash = {};
    (view.slots || []).forEach(function (s) {
      var k = slotKey(s);
      if (s.isEditable && s.idCalendar !== "cal_holidays" && computeDirty(s)) view.stash[k] = s;
      else delete view.stash[k];
    });
  }
  function offscreenStaged() {
    if (!view.stash) return [];
    var here = {}; (view.slots || []).forEach(function (s) { here[slotKey(s)] = true; });
    return Object.keys(view.stash).filter(function (k) { return !here[k]; }).map(function (k) { return view.stash[k]; })
      .filter(function (s) { return computeDirty(s); });
  }
  // What Controleer writes: the loaded weeks plus other weeks' staged slots. The review and the write
  // match rows by item id, so an other-week slot whose id is also in use here (only possible if
  // Questi gave a series one id) is held back — said in the review — rather than risk the wrong week.
  function commitSlots() {
    var used = {}, out = (view.slots || []).slice(), held = [];
    out.forEach(function (s) { used[String(s.itemId)] = true; });
    offscreenStaged().forEach(function (s) {
      if (used[String(s.itemId)]) { held.push(s); return; }
      used[String(s.itemId)] = true; out.push(s);
    });
    return { slots: out, held: held };
  }
  // Everything the ONE Controleer writes: calendar changes plus the Lesfiche-manager's staged fiche
  // edits and tags to create. The launcher badge (__QWP_PENDING_COUNT), the Controleer badge and the
  // header count all use this. Week navigation keeps using stagedCount — only calendar edits are
  // lost on a week reload; staged fiche edits live in lessons.js and survive it.
  function lessonsApi() { var L = window.__QWP_LESSONS; return (L && typeof L.pendingSummary === "function") ? L : null; }
  function totalStagedCount() {
    var n = stagedCount(), L = lessonsApi();
    if (L) { try { n += L.pendingCount() || 0; } catch (e) {} }
    return n;
  }
  function refreshStaged() {
    var n = totalStagedCount();
    var badge = elId("qwp-review-n"); if (badge) { badge.textContent = String(n); badge.style.display = n ? "" : "none"; }
    // Controleer waits until every lesuur's detail is in (see hydrateRangeLive) — and says why.
    var nLoad = hydratePending(), rv = elId("qwp-review");
    if (rv) {
      rv.classList.toggle("qwp-wait", nLoad > 0);
      rv.title = nLoad ? loadingReason(nLoad) : "Controleer de wijzigingen en schrijf ze weg";
    }
    var st = elId("qwp-staged"); if (!st) return;
    st.style.display = n ? "" : "none"; st.innerHTML = "";
    st.appendChild(h("span", { class: "qwp-staged-dot" }));
    var away = offscreenStaged().length;
    st.appendChild(document.createTextNode(n + (n === 1 ? " wijziging" : " wijzigingen") + (away ? " (" + away + " in andere weken)" : "")));
  }

  // ---------- Week navigation ----------
  // Steps ONE week, so "this week + next" can roll forward. Staged changes are kept (view.stash, see
  // stashCurrent), so a month can be planned and written in one Controleer.
  function prevWeek() { view.weekOffset -= 1; reloadAndRender(); }
  function nextWeek() { view.weekOffset += 1; reloadAndRender(); }
  function thisWeek() { view.weekOffset = 0; reloadAndRender(); }
  function refreshWeeks() { reloadAndRender(); }
  var MONTH_NL_SHORT = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  // "26 – 30 okt" / "26 okt – 6 nov" for Monday of week a … Friday of week b (week indexes).
  // `base` = another Monday than the planner's (the Afdrukken tab browses weeks on its own).
  function shortRange(wa, wb, base) {
    base = base || view.weekStart;
    var a = addDays(base, wa * 7), b = addDays(base, wb * 7 + 4); if (!a || !b) return "";
    if (a.getMonth() === b.getMonth()) return a.getDate() + " – " + b.getDate() + " " + MONTH_NL_SHORT[b.getMonth()];
    return a.getDate() + " " + MONTH_NL_SHORT[a.getMonth()] + " – " + b.getDate() + " " + MONTH_NL_SHORT[b.getMonth()];
  }
  function weekNoOf(w) { var d = addDays(view.weekStart, w * 7); return d ? isoWeekNo(isoDate(d)) : ""; }
  function renderRange() {
    var el = elId("qwp-range"); if (!el || !view.weekStart) return;
    var doel = mainMode() === "doelen", wa = doel ? doelenWeek() : 0, wb = doel ? wa : view.weeks - 1;
    el.innerHTML = "";
    el.appendChild(document.createTextNode("Week " + weekNoOf(wa) + (wb !== wa ? " – " + weekNoOf(wb) : "")));
    el.appendChild(h("span", { class: "qwp-range-sub", text: " · " + shortRange(wa, wb) }));
  }

  // ---------- Menus (Alles, Collega) ----------
  function closeMenu(id) { var m = elId(id); if (m) { m.remove(); return true; } return false; }
  // A fixed-position menu next to its opener (above it when the opener sits low on the screen).
  function showMenu(id, anchor, kids, cls) {
    closeMenu(id);
    var m = h("div", { class: "qwp-menu" + (cls ? " " + cls : ""), id: id, role: "menu" }, kids);
    var r = anchor.getBoundingClientRect();
    if (r.top > window.innerHeight / 2) { m.style.bottom = Math.round(window.innerHeight - r.top + 8) + "px"; m.style.left = "12px"; }
    else { m.style.top = Math.round(r.bottom + 6) + "px"; m.style.left = Math.round(r.left) + "px"; }
    els.page.appendChild(m);
    return m;
  }
  function menuItem(ico, name, desc, tag, fn, disabled) {
    var write = tag === "via Controleer";
    return h("button", { class: "qwp-mi" + (disabled ? " off" : ""), role: "menuitem", disabled: disabled ? "true" : null, onclick: function () { closeMenu("qwp-allesmenu"); closeMenu("qwp-srcmenu"); fn(); } }, [
      ico != null ? h("span", { class: "qwp-mi-ico", text: ico }) : null,
      h("span", { class: "qwp-mi-txt" }, [h("span", { class: "qwp-mi-n", text: name }), desc ? h("span", { class: "qwp-mi-d", text: desc }) : null]),
      tag ? h("span", { class: "qwp-mi-tag" + (write ? " write" : ""), title: write ? "Wordt pas weggeschreven na Controleer" : null, text: tag }) : null
    ]);
  }
  // Open one of the planner's popovers fresh (the old ones toggle, which would just close another).
  function freshPop(fn) { var ex = elId("qwp-pop"); if (ex) ex.remove(); fn(); }
  function openAlles(anchor) {
    if (closeMenu("qwp-allesmenu")) return;
    var nUndo = view.undoStack.length, ver = "";
    try { ver = chrome.runtime.getManifest().version || ""; } catch (e) {}
    function grp(t) { return h("div", { class: "qwp-mgrp", text: t }); }
    showMenu("qwp-allesmenu", anchor, [
      grp("Deze weken"),
      menuItem("⧉", "Kopieer vorige week", "fiches van vorige week in deze week zetten", "via Controleer", openCopyPrevWeek),
      menuItem("T", "Titels opschonen", "verwijdert Questi’s “* … (1)” uit titels", "via Controleer", cleanDecoratedTitles),
      menuItem("↺", "Vakken herstellen", "elk lesuur terug naar fiche-vak of lesrooster", "via Controleer", resetVakkenToDefault),
      menuItem("↶", "Ongedaan maken" + (nUndo ? " (" + nUndo + ")" : ""), "laatste planningsactie terugdraaien (Ctrl+Z)", "", doUndo, !nUndo),
      menuItem("⟳", "Vernieuwen", "deze weken opnieuw uit Questi laden", "", refreshWeeks),
      menuItem("▥", "Balans", "aantal lesuren per vak in deze weken", "", function () { freshPop(openBalancePop); }),
      grp("Lesfiches"),
      menuItem("⌕", "Zoek in alle lesfiches", "ik, collega’s en methodes tegelijk", "", function () { freshPop(openGlobalSearchPop); }),
      menuItem("↧", "Eigen lesfiches herladen", "je volledige lijst opnieuw ophalen", "", loadAllFiches),
      menuItem("C", "Lesfiches van collega’s", "kiezen wiens fiches je in de lijst ziet", "", function () { freshPop(openColleaguePopover); }),
      menuItem("▤", "Methodes", "Questi-methodebibliotheken tonen", "", function () { freshPop(openMethodesPopover); }),
      grp("Overzicht"),
      menuItem("▦", "Methodevoortgang", "welke lessen van een methode al gegeven zijn", "", function () { if (window.__QWP_METHODES) window.__QWP_METHODES.open(); else setStatus("Methodevoortgang is niet geladen."); }),
      h("div", { class: "qwp-mfoot" }, [h("span", { text: "UnQuesti" + (ver ? " v" + ver : "") }), betaPill()])
    ], "qwp-alles-menu");
  }
  function openSourceMenu(pi, anchor) {
    if (closeMenu("qwp-srcmenu")) return;
    var kids = state.colleagues.map(function (c) {
      return menuItem(null, ownerName(c.id), c.isMethod ? "methode (alleen lezen)" : "collega", "", function () { setPanelSource(pi, c.id); });
    });
    if (!kids.length) kids.push(h("div", { class: "qwp-menu-empty", text: "Nog geen collega’s of methodes gekozen." }));
    kids.push(h("div", { class: "qwp-msep" }));
    kids.push(menuItem(null, "Collega’s kiezen…", "", "", function () { freshPop(openColleaguePopover); }));
    kids.push(menuItem(null, "Methodes kiezen…", "", "", function () { freshPop(openMethodesPopover); }));
    showMenu("qwp-srcmenu", anchor, kids, "qwp-src-menu");
  }
  // Small titled popover in the same slot as the colleague/methode pickers.
  function simplePop(title, body) {
    var pop = h("div", { class: "qwp-pop qwp-pop-wide", id: "qwp-pop" }, [
      h("div", { class: "qwp-pop-hd" }, [h("span", { text: title }), h("button", { class: "qwp-pop-x", title: "Sluiten", text: "×", onclick: function () { pop.remove(); } })]),
      body
    ]);
    els.page.appendChild(pop);
    return pop;
  }
  function openBalancePop() {
    simplePop("Balans deze weken", h("div", { class: "qwp-pop-body" }, [h("div", { class: "qwp-balance", id: "qwp-balance" })]));
    renderBalance();
  }
  function openGlobalSearchPop() {
    simplePop("Zoek in alle lesfiches", h("div", { class: "qwp-pop-body" }, [buildGlobalSearch()]));
    renderGlobalOwners();
    var inp = elId("qwp-gsearch-inp"); if (inp) setTimeout(function () { inp.focus(); }, 0);
  }
  // Instellingen belong to the shared settings module when it is loaded; the planner's own
  // modal stays as the fallback so nothing is lost while that module is absent.
  function openSettings() {
    if (window.__UQ_SETTINGS && typeof window.__UQ_SETTINGS.open === "function") { window.__UQ_SETTINGS.open(); return; }
    openInstellingen();
  }
  // ---------- Custom print: a branded, time-aligned week (own window) ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function isLesuurPlaceholder(t) { return /^Lesuur\s*\d+$/i.test((t || "").trim()); }
  // ---- All print rendering runs on an explicit print-view (pv), never the global `view`,
  //      so print works headless (no planner overlay) and never disturbs the live grid.
  //      pv = { slots, weekStart, weeks, timeRows, rowMeta, presence }.
  // "5 – 9 januari 2026" — used for the window/tab title + the dialog range label.
  function weekTitleFor(pv, weekIdx) {
    var a = addDays(pv.weekStart, weekIdx * 7), b = addDays(pv.weekStart, weekIdx * 7 + 4);
    if (!a || !b) return "";
    var sameM = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    if (sameM) return a.getDate() + " – " + b.getDate() + " " + MONTH_NL[b.getMonth()] + " " + b.getFullYear();
    var sameY = a.getFullYear() === b.getFullYear();
    return a.getDate() + " " + MONTH_NL[a.getMonth()] + (sameY ? "" : (" " + a.getFullYear())) +
      " – " + b.getDate() + " " + MONTH_NL[b.getMonth()] + " " + b.getFullYear();
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  // Day-header cell: full name on line 1, dd-mm-jjjj muted on line 2.
  function dayHeadHtml(pv, offset) {
    var d = addDays(pv.weekStart, offset); if (!d) return '<th class="pday"></th>';
    var nm = DAY_FULL_NL[(d.getDay() + 6) % 7];
    var dt = pad2(d.getDate()) + "-" + pad2(d.getMonth() + 1) + "-" + d.getFullYear();
    return '<th class="pday">' + esc(nm) + '<span class="dd">' + dt + "</span></th>";
  }
  function minToHHMM(m) { if (m == null || m < 0) m = 0; return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60); }
  // ISO-8601 week number of the Monday-start week containing dateStr.
  function isoWeekNo(dateStr) {
    var d = addDays(dateStr, 0); if (!d) return "";
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);       // Thursday of this week
    var firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
    return 1 + Math.round((t - firstThu) / 604800000);
  }
  function todayDDMMYYYY() { var d = new Date(); return pad2(d.getDate()) + "-" + pad2(d.getMonth() + 1) + "-" + d.getFullYear(); }
  // Most common lesuur duration (minutes) → fallback for rows whose end time is unknown.
  function commonDurationMin(pv) {
    var counts = {}, best = 50, bestN = 0;
    pv.timeRows.forEach(function (t) {
      var m = pv.rowMeta && pv.rowMeta[t]; if (!m || !m.end) return;
      var dur = hhmmToMin(m.end) - hhmmToMin(m.start);
      if (dur > 0) { counts[dur] = (counts[dur] || 0) + 1; if (counts[dur] > bestN) { bestN = counts[dur]; best = dur; } }
    });
    return best;
  }
  // pv-based cell/thema lookups (mirror slotAt/weekThemaSlot/themaRowKeys but on pv).
  function pvSlotAt(pv, weekIdx, dayIdx, time) {
    return pv.slots.filter(function (s) {
      return s.weekIdx === weekIdx && s.dayIdx === dayIdx && s.idCalendar !== "cal_holidays" &&
        !s.isFullday &&
        (s.time || (s.starttime ? String(s.starttime).slice(0, 5) : "")) === time;
    })[0] || null;
  }
  // Same stamped-key rule as the planner grid — print must not re-derive from the title either.
  function pvWeekThemaSlot(pv, weekIdx, key) {
    return pv.slots.filter(function (s) {
      return s.weekIdx === weekIdx && s.idCalendar !== "cal_holidays" && s.isFullday && s.themaKey === key;
    })[0] || null;
  }
  function pvThemaKeys(pv) { return themaKeysOf(ensureThemaKeys(pv.slots)); }
  // Single main title per cell: fiche title, else the item title unless it's a "Lesuur N"
  // placeholder (then blank). Colour precedence: the fiche's OWN tag colour (pv.ficheColor,
  // built by buildFicheColors) → the slot's settings/vak top-tag colour → neutral.
  function printCellParts(pv, s) {
    if (!s) return null;
    // A thema band or lesuur prints the fiche it carries — "Zie themafiche." is the item
    // description, useless on paper. Only a fiche-less thema slot falls back to it.
    var main = themaShowsLiteral(s, pv && pv.slots) ? "Zie themafiche."
      : (stripThemaPrefix(s.ficheTitle || "") || (isLesuurPlaceholder(s.title) ? "" : stripThemaPrefix(s.title || "")));
    var top = topTagIdOf(s.vak);
    var vak = top != null ? ((anyTagTitle(top) || "").trim()) : "";
    // Carry the same warning onto paper — a mismatch you can only see on screen is half a warning.
    var mm = vakMismatch(s);
    if (mm) vak = (vak || "?") + " ≠ " + (mm.ficheVak || "?");
    var color = (pv && pv.ficheColor && s.ficheContentId && pv.ficheColor[s.ficheContentId]) ||
      (top != null ? (anyTagColor(top) || "") : "");
    return { vak: vak, main: main, color: color };
  }
  function printCellHtml(pv, s, extraHtml) {
    var chips = extraHtml || "";
    var p = printCellParts(pv, s);
    if (!p) return '<td class="pc">' + chips + "</td>";
    var stripe = p.color ? (' style="box-shadow:inset 4px 0 0 ' + esc(p.color) + '"') : "";
    var vakHtml = p.vak ? ('<div class="pc-vak"' + (p.color ? (' style="color:' + esc(p.color) + '"') : "") + ">" + esc(p.vak) + "</div>") : "";
    var inner = vakHtml + (p.main ? ('<div class="pc-title">' + esc(p.main) + "</div>") : "");
    return '<td class="pc filled"' + stripe + ">" + inner + chips + "</td>";
  }
  // ---- extras placement model ----
  // Every selected other-agenda item is either COVERED (a lesson time-row's [start,end) contains
  // its start → ⓘ pill inside that day cell) or UNCOVERED (no lesson at that time → its own
  // injected time-row with the real time in the left column). All-day items pin to the day's
  // first lesson row as a pill (no meaningful time → no own row).
  // fetchPrintExtras returns { <week>: { cells:{"day|HH:MM":html}, inject:{"HH:MM":{end,days:{d:html}}} } }.
  // Other-agenda chip: flat pill, leading coloured ⓘ (⇔ another agenda), optional muted clock time.
  function extraChip(color, title, time) {
    var tm = time ? (' <span class="pc-tm">' + esc(time) + "</span>") : "";
    return '<span class="pc-extra"><span class="pc-ico" style="color:' + esc(color || "#888") + '">ⓘ</span>' + esc(title || "") + tm + "</span>";
  }
  // Merge a base row set with a week's injected rows → sorted effective rows + per-row meta.
  function effectiveRows(pv, exWeek) {
    var rows = pv.timeRows.slice(), meta = {}, injected = {};
    pv.timeRows.forEach(function (t) { meta[t] = pv.rowMeta[t]; });
    var inj = (exWeek && exWeek.inject) || {};
    Object.keys(inj).forEach(function (k) {
      if (rows.indexOf(k) === -1) { rows.push(k); meta[k] = { start: k, end: inj[k].end }; injected[k] = true; }
    });
    rows.sort();
    return { rows: rows, meta: meta, injected: injected, inj: inj };
  }
  function rowDurEff(meta, t, fb) { var m = meta[t]; if (m && m.end) { var d = hhmmToMin(m.end) - hhmmToMin(t); if (d > 0) return d; } return fb; }
  // Pauze/speeltijd gap between consecutive effective rows.
  function breakAfterEff(er, idx) {
    var rows = er.rows; if (idx >= rows.length - 1) return null;
    var m = er.meta[rows[idx]];
    var end = hhmmToMin(m && m.end ? m.end : rows[idx]), next = hhmmToMin(rows[idx + 1]);
    if (end == null || next == null) return null;
    var gap = next - end; if (gap < 10) return null;
    return gap >= 40 ? "middagpauze" : "speeltijd";
  }
  // Fit-to-one-page: scale rows (weighted by duration) to fill the usable A4-landscape height minus
  // fixed chrome (header, theme bands, break spacers, meta line, notes block). Clamped for sanity —
  // toggling notes/date off frees budget so the blocks grow; on shrinks them, still one page.
  var PRINT_PAGE_PX = 718;   // 210mm − 2×10mm margins @96dpi
  function fitPxPerMin(er, nBands, nBreaks, opts) {
    var fb = 50, totalMin = 0;
    er.rows.forEach(function (t) { totalMin += rowDurEff(er.meta, t, fb); });
    var chrome = 34 + nBands * 26 + nBreaks * 9 + 5 * (er.rows.length + nBands + nBreaks + 2) +
      (opts.showMeta ? 22 : 0) + (opts.showNotes ? 104 : 0);
    var ppm = (PRINT_PAGE_PX - chrome) / Math.max(30, totalMin);
    return Math.max(0.6, Math.min(1.7, ppm));
  }
  // Slim right-aligned meta line (week no. + print date) — toggle.
  function metaHtml(pv, weekIdx, opts) {
    if (!opts.showMeta) return "";
    var wk = isoWeekNo(isoDate(addDays(pv.weekStart, weekIdx * 7)));
    return '<div class="pmeta"><span>Week <b>' + esc(wk) + "</b></span><span>afgedrukt <b>" + esc(todayDDMMYYYY()) + "</b></span></div>";
  }
  // Opmerking / notities under a divider — toggle; prints the typed text, else blank ruled lines.
  function notesHtml(opts) {
    if (!opts.showNotes) return "";
    var txt = (opts.comment || "").trim();
    var inner = txt ? ('<div class="pnote-txt">' + esc(txt) + "</div>") : '<div class="pnote-lines"></div>';
    return '<div class="pfoot"><div class="pfoot-rule"></div><div class="pfoot-lbl">Opmerking / notities</div>' + inner + "</div>";
  }
  // Each week → .psheet-scale > .psheet (fixed one-page box) > .psheet-inner (JS-scaled to fit).
  function printWeekTableHtml(pv, weekIdx, exWeek, opts) {
    exWeek = exWeek || { cells: {}, inject: {} };
    var cells = exWeek.cells || {};
    var er = effectiveRows(pv, exWeek);
    var fb = commonDurationMin(pv);
    var themaKeys = pvThemaKeys(pv);
    var nBands = themaKeys.length;
    var nBreaks = 0; er.rows.forEach(function (t, idx) { if (breakAfterEff(er, idx)) nBreaks++; });
    var ppm = fitPxPerMin(er, nBands, nBreaks, opts);
    var head = '<tr><th class="ptime"></th>';
    for (var d = 0; d < 5; d++) head += dayHeadHtml(pv, weekIdx * 7 + d);
    head += "</tr>";
    var rows = "";
    // Compact full-width theme band(s) (WO / Godsdienst): no time label, no "hele dag" wording.
    // Skip a band whose title is empty or a "Lesuur"-placeholder (a bare full-day filler item).
    themaKeys.forEach(function (key) {
      var s = pvWeekThemaSlot(pv, weekIdx, key);
      var p = s ? printCellParts(pv, s) : null;
      var txt = p ? (p.main || p.vak || "") : "";
      if (!txt || isLesuurPlaceholder(txt)) return;
      // Skip the label when it IS the text (an untagged row is labelled by its own title) —
      // otherwise the band prints the same string twice.
      var lbl = themaLabel(key, pv.slots);
      var same = normTitle(lbl) === normTitle(txt);
      rows += '<tr class="pthemarow"><td class="pc pthema" colspan="6">' +
        (same ? "" : '<span class="pthema-k">' + esc(lbl) + "</span>") + esc(txt) + "</td></tr>";
    });
    er.rows.forEach(function (t, idx) {
      var m = er.meta[t], endL = (m && m.end) ? m.end : "";
      var hpx = Math.max(15, Math.round(rowDurEff(er.meta, t, fb) * ppm));
      var isInj = er.injected[t];
      var timeCell = '<th class="ptime"><span class="pt-start">' + esc(t) + "</span>" +
        (endL ? ('<span class="pt-end">' + esc(endL) + "</span>") : "") + "</th>";
      var body = "";
      for (var dd = 0; dd < 5; dd++) {
        if (isInj) body += '<td class="pc xcell">' + ((er.inj[t] && er.inj[t].days[dd]) || "") + "</td>";
        else body += printCellHtml(pv, pvSlotAt(pv, weekIdx, dd, t), cells[dd + "|" + t] || "");
      }
      rows += '<tr class="' + (isInj ? "xrow" : "lrow") + '" style="height:' + hpx + 'px">' + timeCell + body + "</tr>";
      if (breakAfterEff(er, idx)) rows += '<tr class="pbreak"><td colspan="6"></td></tr>';
    });
    // Empty week (holiday etc.): show a friendly state, not a bare grid of empty cells.
    var tbody = rows ? ('<tbody>' + rows + '</tbody>') : "";
    var empty = er.rows.length ? "" : '<div class="pempty">Geen lesitems deze week.</div>';
    var inner = metaHtml(pv, weekIdx, opts) +
      '<table class="pweek"><thead>' + head + "</thead>" + tbody + "</table>" +
      empty + notesHtml(opts);
    // .psheet-scale = screen-only fit-to-pane wrapper · .psheet = one fixed A4-landscape page
    // (overflow-hidden) · .psheet-inner = content, JS-scaled to guarantee it fits the page.
    return '<div class="psheet-scale"><div class="psheet"><div class="psheet-inner">' + inner + "</div></div></div>";
  }
  var PRINT_CSS =
    '@page { size: A4 landscape; margin: 10mm; }' +
    '* { box-sizing: border-box; }' +
    'body { font: 11.5px/1.4 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1e2a33; margin: 0; }' +
    // One page = one .psheet, fixed to the A4-landscape printable area (277×190mm ≈ 1047×718px@96dpi).
    // overflow:hidden + the JS scale on .psheet-inner mean content can never spill to a 2nd page.
    '.psheet-scale { page-break-after: always; }' +
    '.psheet-scale:last-child { page-break-after: auto; }' +
    '.psheet { width: 1040px; height: 712px; overflow: hidden; background: #fff; }' +
    '.psheet-inner { width: 1040px; transform-origin: top left; padding: 6px 2px; }' +
    '.pempty { text-align: center; color: #93a0a7; font-size: 13px; padding: 60px 0; }' +
    '.pmeta { display: flex; justify-content: flex-end; gap: 14px; font-size: 10px; color: #93a0a7; letter-spacing: .03em; margin: 0 2px 8px; }' +
    '.pmeta b { color: #5c6b73; }' +
    '.pweek { width: 100%; border-collapse: separate; border-spacing: 6px; table-layout: fixed; }' +
    'th.ptime { width: 56px; background: transparent; border: none; text-align: left; vertical-align: top; padding: 6px 4px 0 0; white-space: nowrap; }' +
    '.ptime .pt-start { display: block; font-weight: 700; font-size: 11px; color: #5c6b73; }' +
    '.ptime .pt-end { display: block; font-size: 10px; color: #93a0a7; font-weight: 400; }' +
    '.pweek thead th.pday { background: #2f6d6b; color: #fff; text-align: center; font-size: 11.5px; font-weight: 600; padding: 9px 6px; border-radius: 8px; }' +
    '.pday .dd { display: block; font-weight: 400; font-size: 10px; opacity: .85; margin-top: 1px; }' +
    'td.pc { background: #fbfcfc; border: 1px solid #dfe6ea; border-radius: 8px; vertical-align: top; padding: 8px 11px; }' +
    'td.filled { background: #fff; border-color: #e3e9ec; padding-left: 12px; }' +
    '.pc-vak { font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #8a949b; }' +
    '.pc-title { font-weight: 600; line-height: 1.3; color: #1e2a33; }' +
    'tr.pthemarow td.pthema { background: #f4f3e8; color: #5a5836; border: 1px solid #e6e3c8; border-radius: 8px; padding: 9px 12px; font-size: 12px; font-weight: 700; }' +
    '.pthema-k { font-weight: 800; text-transform: uppercase; font-size: 9.5px; letter-spacing: .08em; opacity: .7; margin-right: 8px; }' +
    'tr.pbreak td { border: none; height: 7px; padding: 0; background: transparent; }' +
    'tr.xrow td.xcell { background: repeating-linear-gradient(135deg,#fffaf0,#fffaf0 8px,#fff6e6 8px,#fff6e6 16px); border: 1px dashed #e7cf94; border-radius: 8px; }' +
    'tr.xrow .pt-start { color: #b7891a; }' +
    '.pc-extra { display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; font-weight: 600; background: #f3f5f6; border-radius: 999px; padding: 2px 9px 2px 7px; margin: 4px 5px 0 0; color: #3c4a52; }' +
    '.pc-ico { font-size: 11px; line-height: 1; }' +
    '.pc-tm { color: #8a949b; font-weight: 500; }' +
    '.pfoot { margin-top: 12px; page-break-inside: avoid; }' +
    '.pfoot-rule { border-top: 1px solid #d3dadf; margin: 0 2px 8px; }' +
    '.pfoot-lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; color: #7a868d; font-weight: 700; margin: 0 2px 6px; }' +
    '.pnote-txt { white-space: pre-wrap; }' +
    '.pnote-lines { height: 60px; border-radius: 8px; border: 1px solid #e3e9ec; background-image: repeating-linear-gradient(#fff,#fff 21px,#e7edf0 21px,#e7edf0 22px); }';
  // Screen-only: the fixed 1047px sheet is scaled to the preview pane via `zoom` (var --ss set by
  // the fit script). @media screen so print ignores it and uses the true A4 page. The .psheet-inner
  // transform (inline) applies in BOTH media — that's the one-page guarantee.
  var PRINT_SCREEN_CSS =
    '@media screen {' +
    '  body { background: #e6eaec; padding: 20px; }' +
    '  .psheet-scale { zoom: var(--ss, 1); margin: 0 auto 18px; width: 1040px; }' +
    '  .psheet { border-radius: 12px; box-shadow: 0 4px 22px rgba(20,40,60,.16); }' +
    '}';
  // One-page fit — run from the extension (isolated world) on the iframe's own DOM, NOT as an inline
  // <script> in the doc (questi.com's CSP would block that). Measures each sheet's natural content
  // height and shrinks .psheet-inner (scale ≤ 1) to the printable height; also scales the fixed sheet
  // to the preview pane (screen only, via the --ss zoom var). Idempotent → safe to re-run on resize.
  var PRINT_FIT_W = 1040, PRINT_FIT_H = 700;
  function fitPrintDoc(doc, win) {
    if (!doc) return;
    var wr = doc.querySelectorAll(".psheet-scale"), j;
    for (j = 0; j < wr.length; j++) wr[j].style.setProperty("--ss", 1);   // neutralise zoom before measuring
    var inners = doc.querySelectorAll(".psheet-inner");
    for (var i = 0; i < inners.length; i++) {
      var el = inners[i];
      el.style.width = PRINT_FIT_W + "px"; el.style.transform = "none";
      var s = Math.min(1, PRINT_FIT_H / (el.scrollHeight || PRINT_FIT_H));
      // Fit HEIGHT only, keep width full: widen the inner to W/s so the scaled width lands back at
      // the full page width (a wider inner wraps shorter, so scaled height still stays ≤ budget).
      if (s < 1) el.style.width = Math.round(PRINT_FIT_W / s) + "px";
      el.style.transform = "scale(" + s + ")";
    }
    var vw = (win && win.innerWidth) || PRINT_FIT_W;
    var vh = (win && win.innerHeight) || 800;
    var ss = Math.min((vw - 72) / PRINT_FIT_W, (vh - 72) / 712);   // fill the pane with a little margin
    for (j = 0; j < wr.length; j++) wr[j].style.setProperty("--ss", ss > 0 ? ss : 1);
  }
  // Full print document HTML (used for BOTH the preview iframe and printing — one source).
  function printDocHtml(pv, extraByWeek, opts) {
    extraByWeek = extraByWeek || {};
    var body = "";
    for (var w = 0; w < pv.weeks; w++) body += printWeekTableHtml(pv, w, extraByWeek[w] || { cells: {}, inject: {} }, opts);
    return "<!doctype html><html lang=\"nl\"><head><meta charset=\"utf-8\"><title>" +
      esc("Weekplanning " + weekTitleFor(pv, 0)) + "</title><style>" + PRINT_CSS + PRINT_SCREEN_CSS + "</style></head><body>" +
      body + "</body></html>";
  }
  // ---- Lesdoelen print (WEET / KEN / KAN) ----
  // Two extra print layouts, picked with the "Versie" choice in the print window; the layout above is
  // untouched. "goals1": one A4-landscape page per week (6mm margins). "goals2": two pages per week
  // (front/back of one sheet) — the first half of the lesuren on the front, the rest on the back —
  // with 8 write lines per card instead of 3. Every lesuur gets an equal-height card, bordered in its colour, with
  // icon-led write lines. No time column (start time sits in the card) and no vak label (a colour legend
  // replaces it). The free Wednesday afternoon holds week/date, thema(s) and the legend; with no free
  // afternoon they go in a band above the grid (on the back page for goals2).
  // Fits by construction — fixed row heights, clamped titles, a box whose type size follows its line
  // count — so there is no .psheet-inner here: fitPrintDoc only applies the screen zoom.
  var GOALS_PAGE_H = 746;                        // 198mm (210 − 2×6) @96dpi
  var GOALS_XROW_H = 22, GOALS_BAND_H = 52, GOALS_BOX_MIN = 120;
  var GOALS_KINDS = [
    { key: "weet", label: "weet", ico: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8a4.2 4.2 0 0 0-2.5 7.6c.5.4.8.9.8 1.5v.6h3.4v-.6c0-.6.3-1.1.8-1.5A4.2 4.2 0 0 0 8 1.8z"/><path d="M6.5 13.6h3"/></svg>' },
    { key: "ken", label: "ken", ico: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 3.2c2-.6 4.2-.4 6.2.9 2-1.3 4.2-1.5 6.2-.9v9.4c-2-.6-4.2-.4-6.2.9-2-1.3-4.2-1.5-6.2-.9z"/><path d="M8 4.1v9.4"/></svg>' },
    { key: "kan", label: "kan", ico: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.2 2.2a3.2 3.2 0 0 0-3.9 4.1L2 10.6a1.4 1.4 0 0 0 2 2l4.3-4.3a3.2 3.2 0 0 0 4.1-3.9l-2 2-1.8-.4-.4-1.8z"/></svg>' }
  ];
  // Goals stored IN the fiche: three per-fiche extra text fields titled WEET, KEN, KAN (Questi's
  // "+ toevoegen → Tekst" fields, which have no template_field_id). The value is `content`;
  // `description` is the field's ⓘ helper text. Matched by title, never by id — every fiche
  // version mints new field ids. Shapes: reference/questi-api-samples.md (2026-10-25).
  function ficheGoalFields(edit) {
    var out = { weet: null, ken: null, kan: null };
    ((edit && edit.fields) || []).forEach(function (f) {
      if (!f || f.template_field_id != null || f.type !== "text") return;
      var k = String(f.title || "").trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(out, k) && !out[k]) out[k] = f;
    });
    return out;
  }
  // Field HTML → plain text (Questi's editor may wrap a value in <p>). DOMParser runs no handlers.
  function goalText(html) {
    var s = String(html == null ? "" : html);
    if (s.indexOf("<") < 0 && s.indexOf("&") < 0) return s.trim();
    s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n");
    var doc = new DOMParser().parseFromString(s, "text/html");
    return (doc.body.textContent || "").replace(/\n{2,}/g, "\n").trim();
  }
  // Local goals, saved in this browser under qwp_goals_v1: { "f:<fiche id>" | "i:<item id>": {weet, ken, kan, hide} }.
  // Since goals live in the fiche (WEET/KEN/KAN fields), this store keeps only: the per-fiche hide
  // flags, goals for fiche-less lesuren and methode fiches (nowhere else to put them), and goals typed
  // before — shown read-only on an own fiche until "Lokale doelen overnemen" moves them in.
  var GOALS_STORE_KEY = "qwp_goals_v1", _goals = {}, _goalsSaveT = null;
  var _goalsTab = "word";   // tab label: "word" (WEET/KEN/KAN, vertical) or "icon"; set per render
  var _goalsLegendOn = true; // vak legend in the Wednesday box; set per render
  // Other-agenda items hidden from the Lesdoelen print, saved under qwp_xhide_v1:
  // { "<calendar id>|r<id_repeat>" | "<calendar id>|i<item id>": true }. Keyed by the series when the
  // item recurs, so hiding a weekly moment for another class hides it in every week.
  var XHIDE_KEY = "qwp_xhide_v1", _xHide = {}, _xShowHidden = false;
  storeGet(XHIDE_KEY).then(function (v) { _xHide = v || {}; });
  function goalsXKey(it) { return it.cal + "|" + (it.rep ? "r" + it.rep : "i" + it.id); }
  var GOALS_DAY_ABBR = ["MA", "DI", "WO", "DO", "VR"];
  storeGet(GOALS_STORE_KEY).then(function (v) { _goals = v || {}; });
  function goalsKeyFor(s) {
    if (!s) return "";
    if (s.ficheContentId) return "f:" + s.ficheContentId;
    return s.itemId ? "i:" + s.itemId : "";
  }
  // Only a card with no own fiche behind it is typed in the preview; an own fiche is edited in the
  // Lesfiche-manager (goals mode), so the fiche stays the one source.
  function isMethodSlot(s) { return !!(s && s.ficheContentId && (s.ficheIsMethod || view.methodFicheIds[String(s.ficheContentId)])); }
  function goalsEditableFor(s) { return !!s && (!s.ficheContentId || isMethodSlot(s)); }
  // Goals read from the attached fiche for print. A planned lesuur keeps the fiche VERSION it was
  // planned with, so goals typed afterwards live on a newer version: when the attached one has none,
  // take the newest own fiche with the same title (read-only) and mark the card. Reset per print window.
  var _printFicheGoals = {};    // ficheContentId -> { goals: {weet,ken,kan}|null, src: "fiche"|"newer"|"none" }
  var _ownFicheByTitle = null;  // normalised subject -> id of the current own fiche with that title
  function resetPrintFicheGoals() { _printFicheGoals = {}; _ownFicheByTitle = null; }
  function normSubject(t) { return String(t || "").replace(/\s+/g, " ").trim().toLowerCase(); }
  function fetchFicheEdit(id) {
    return jget(API + "/lessons/" + id + "?" + qs({ schoolId: ctx.schoolId, return_format: "edit" })).then(function (j) { return (j && j.result) || j; });
  }
  function goalsOfEdit(edit) {
    var gf = ficheGoalFields(edit), out = {}, any = false;
    GOALS_KINDS.forEach(function (k) { var v = gf[k.key] ? goalText(gf[k.key].content) : ""; if (v) { out[k.key] = v; any = true; } });
    return any ? out : null;
  }
  function ownFicheByTitle() {
    if (_ownFicheByTitle) return Promise.resolve(_ownFicheByTitle);
    if (ctx.ownDefaultTagId == null) return Promise.resolve({});
    return fetchAllFichesByTag(ctx.ownerId, ctx.ownDefaultTagId).then(function (r) {
      var map = {};
      (r.items || []).forEach(function (f) { var k = normSubject(f.subject); if (k && (!map[k] || Number(f.id) > Number(map[k]))) map[k] = f.id; });
      _ownFicheByTitle = map; return map;
    }).catch(function () { return {}; });
  }
  // Fiche lineage, saved under qwp_threads_v1: { "<thread>": newest fiche id seen }. Every version of
  // a fiche shares its edit view's `thread` (captured 2026-10-25), but the fiche LIST does not carry
  // it — so the newest version is learned from every edit view read or written here (goals mode reads
  // each fiche it shows). Lets print follow a fiche through renames; another browser falls back to title.
  var THREADS_KEY = "qwp_threads_v1", _threads = {}, _threadsSaveT = null;
  storeGet(THREADS_KEY).then(function (v) { _threads = Object.assign(v || {}, _threads); });
  function noteFicheThread(edit) {
    if (!edit || edit.thread == null || edit.id == null) return;
    var k = String(edit.thread), cur = _threads[k];
    if (cur != null && Number(cur) >= Number(edit.id)) return;
    _threads[k] = edit.id;
    clearTimeout(_threadsSaveT);
    _threadsSaveT = setTimeout(function () { storeSet(THREADS_KEY, _threads); }, 500);
  }
  // A newer version's goals for `edit` (the attached, goal-less version): via its thread first, then
  // the newest own fiche with the same title. Resolves goals or null.
  function newerVersionGoals(edit) {
    var id = edit && edit.id;
    function tryId(nid) {
      if (!nid || String(nid) === String(id)) return Promise.resolve(null);
      return fetchFicheEdit(nid).then(function (e2) { noteFicheThread(e2); return goalsOfEdit(e2); }).catch(function () { return null; });
    }
    var viaThread = edit && edit.thread != null ? _threads[String(edit.thread)] : null;
    return tryId(viaThread).then(function (g) {
      if (g) return g;
      return ownFicheByTitle().then(function (map) {
        var byTitle = map[normSubject(edit && edit.subject)];
        return String(byTitle) === String(viaThread) ? null : tryId(byTitle);
      });
    });
  }
  // Read the goals of every own fiche on the sheet; resolves true when something new arrived.
  function loadPrintFicheGoals(pv) {
    var ids = {};
    (pv.slots || []).forEach(function (s) {
      if (!s || !s.ficheContentId || s.isGym || isMethodSlot(s)) return;
      if (!(s.ficheContentId in _printFicheGoals)) ids[s.ficheContentId] = true;
    });
    var list = Object.keys(ids);
    if (!list.length) return Promise.resolve(false);
    list.forEach(function (id) { _printFicheGoals[id] = { goals: null, src: "loading" }; });
    // At most 4 reads at a time, and a version the Lesfiche-manager already read (qwp_goalcache_v1 —
    // a fiche id never changes content) costs none — keeps print from bursting Questi.
    return storeGet("qwp_goalcache_v1").then(function (cache) {
      cache = cache || {};
      return mapLimit(list, 4, function (id) {
        var hit = cache[id] && cache[id].g, hg = {};
        if (hit) GOALS_KINDS.forEach(function (k) { if (hit[k.key]) hg[k.key] = hit[k.key]; });
        if (Object.keys(hg).length) { _printFicheGoals[id] = { goals: hg, src: "fiche" }; return Promise.resolve(); }
        return fetchFicheEdit(id).then(function (edit) {
          noteFicheThread(edit);
          var g = goalsOfEdit(edit);
          if (g) { _printFicheGoals[id] = { goals: g, src: "fiche" }; return; }
          return newerVersionGoals(edit).then(function (g2) {
            _printFicheGoals[id] = g2 ? { goals: g2, src: "newer" } : { goals: null, src: "none" };
          });
        }).catch(function () { _printFicheGoals[id] = { goals: null, src: "none" }; });
      });
    }).then(function () { return true; });
  }
  // Run fn over items with at most `n` promises in flight; resolves when all settle.
  function mapLimit(items, n, fn) {
    var i = 0;
    function worker() { if (i >= items.length) return Promise.resolve(); var it = items[i++]; return Promise.resolve().then(function () { return fn(it); }).catch(function () {}).then(worker); }
    var ws = []; for (var k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
    return Promise.all(ws);
  }
  // What a card shows: the fiche's goals when it has any, else the local record (fiche-less lesuren,
  // methode fiches, older typed goals). Hide flags always come from the local record.
  function goalsRecFor(gk) {
    var local = (gk && _goals[gk]) || {};
    var fg = (gk && gk.indexOf("f:") === 0) ? _printFicheGoals[gk.slice(2)] : null;
    if (!fg || !fg.goals) return local;
    var rec = {}; if (local.hide) rec.hide = local.hide;
    GOALS_KINDS.forEach(function (k) { if (fg.goals[k.key]) rec[k.key] = fg.goals[k.key]; });
    return rec;
  }
  // Ruled lines per card: `n` (3 on one page, 8 on two — both ≈7mm). Visible kinds share them as
  // evenly as whole lines allow; leftover lines go to the lowest kinds (8 over 3 → 2/3/3). With fewer
  // than 2 lines each (3 lines, 2 kinds) the pitch shrinks instead, so both get 2. Kinds can be hidden
  // per fiche (rec.hide), all three included (LO, zwemmen …).
  // Returns { k: lines in the block, m: { weet, ken, kan } }.
  function goalsLayout(rec, n) {
    var hide = (rec && rec.hide) || {}, m = {};
    var vis = GOALS_KINDS.filter(function (k) { return !hide[k.key]; });
    GOALS_KINDS.forEach(function (k) { m[k.key] = 0; });
    if (!vis.length) return { k: 1, m: m };
    var per = Math.floor(n / vis.length), rem = n - per * vis.length;
    if (per < 2 && rem) {
      vis.forEach(function (k) { m[k.key] = per + 1; });
      return { k: (per + 1) * vis.length, m: m };
    }
    vis.forEach(function (k, i) { m[k.key] = per + (i >= vis.length - rem ? 1 : 0); });
    return { k: n, m: m };
  }
  // Screen-only card controls (shown on hover): bring back a hidden kind, hide all, or show all again.
  function goalsCtlHtml(rec) {
    var hide = (rec && rec.hide) || {};
    var hidden = GOALS_KINDS.filter(function (k) { return hide[k.key]; });
    if (hidden.length === GOALS_KINDS.length) return '<span class="gc-ctl-b" data-act="showall" title="Doellijnen terug tonen">+ doelen</span>';
    return hidden.map(function (k) {
      return '<span class="gc-ctl-b" data-restore="' + k.key + '" title="' + esc(k.label) + ' terug tonen">+' + k.ico + "</span>";
    }).join("") + '<span class="gc-ctl-b" data-act="hideall" title="Alle doellijnen verbergen">×</span>';
  }
  // The write lines, prefilled with any typed goals for `gk`; editable in the preview (wireGoalsEditor).
  // The block shares whatever height the title leaves (flex), so a wrapped title shortens the lines a
  // bit instead of being cut off, and every card keeps the same outer height. Pitch = block height ÷ k
  // (container query units), so every kind sits on the same ruling.
  // `editable`: typed here (no own fiche behind the card); otherwise the text is the fiche's, read-only.
  function goalsLinesHtml(gk, n, editable) {
    var rec = goalsRecFor(gk), lay = goalsLayout(rec, n);
    return '<div class="gl" data-n="' + n + '" style="--k:' + lay.k + '">' + GOALS_KINDS.map(function (k) {
      var m = lay.m[k.key];
      return '<div class="gl-row' + (m ? "" : " gl-off") + '" data-kind="' + k.key + '" style="--m:' + m + '">' +
        '<span class="gl-ico"' + (gk ? ' title="' + esc(k.label) + ' verbergen"' : "") + ">" +
          (_goalsTab === "icon" ? k.ico : '<span class="gl-vw">' + esc(k.label.toUpperCase()) + "</span>") + "</span>" +
        (gk ? '<div class="gl-txt"' + (editable ? ' contenteditable="true" spellcheck="false"' : ' title="Bewerk dit doel in Lesfiches → Lesdoelen invullen"') + ' data-kind="' + k.key + '">' + esc(rec[k.key] || "") + "</div>" : "") +
        "</div>";
    }).join("") + "</div>";
  }
  // Live editing inside the preview iframe (same-origin, so listeners attach from here — an inline
  // <script> would be blocked by Questi's CSP). Click a line and type; Shift+Enter breaks the line,
  // Enter/Escape leave it, Tab moves on. Click an icon to hide that kind for this fiche; the hover
  // controls top right bring kinds back or hide/show all lines. The same fiche twice in one week shares
  // its goals, so its other cards follow along. Text that no longer fits its lines is flagged on screen
  // (red edge), never silently cut.
  function wireGoalsEditor(doc, rerender) {
    if (!doc || !doc.body) return;
    function isTxt(t) { return t && t.classList && t.classList.contains("gl-txt"); }
    function cardOf(el) { return el && el.closest ? el.closest(".gc-in[data-gk]") : null; }
    function flush() { clearTimeout(_goalsSaveT); _goalsSaveT = null; storeSet(GOALS_STORE_KEY, _goals); }
    function later() { clearTimeout(_goalsSaveT); _goalsSaveT = setTimeout(flush, 300); }
    function markOver(t) { t.classList.toggle("gl-over", t.scrollHeight > t.clientHeight + 1); }
    // Keep typed line breaks; tidy spaces inside each line and drop empty lines at either end.
    function textOf(el) {
      return String(el.innerText || "").replace(/\r/g, "").split("\n")
        .map(function (l) { return l.replace(/[ \t ]+/g, " ").trim(); }).join("\n")
        .replace(/^\n+|\n+$/g, "");
    }
    function twins(gk) {
      var all = doc.querySelectorAll(".gc-in[data-gk]"), out = [];
      for (var i = 0; i < all.length; i++) if (all[i].getAttribute("data-gk") === gk) out.push(all[i]);
      return out;
    }
    function store(gk, rec) {
      var keep = GOALS_KINDS.some(function (k) { return rec[k.key]; }) || (rec.hide && Object.keys(rec.hide).length);
      if (keep) _goals[gk] = rec; else delete _goals[gk];
    }
    // Re-apply the layout + controls (and, on twin cards, the text) to every card of `gk`.
    function relayout(gk, except) {
      var rec = goalsRecFor(gk);
      twins(gk).forEach(function (card) {
        var gl = card.querySelector(".gl"); if (!gl) return;
        var lay = goalsLayout(rec, +gl.getAttribute("data-n") || 3);
        gl.style.setProperty("--k", lay.k);
        GOALS_KINDS.forEach(function (k) {
          var row = gl.querySelector('.gl-row[data-kind="' + k.key + '"]'); if (!row) return;
          row.style.setProperty("--m", lay.m[k.key]);
          row.classList.toggle("gl-off", !lay.m[k.key]);
          var t = row.querySelector(".gl-txt");
          if (t && t !== except && textOf(t) !== (rec[k.key] || "")) t.textContent = rec[k.key] || "";
          if (t) markOver(t);
        });
        var ctl = card.querySelector(".gc-ctl"); if (ctl) ctl.innerHTML = goalsCtlHtml(rec);
      });
    }
    function save(el) {
      var card = cardOf(el), gk = card && card.getAttribute("data-gk"), kind = el.getAttribute("data-kind");
      if (!gk || !kind) return;
      var v = textOf(el), rec = _goals[gk] || {};
      if (v) rec[kind] = v; else delete rec[kind];
      store(gk, rec);
      relayout(gk, el);
      later();
    }
    // kinds: the keys to change; on = hide them, off = show them.
    function setHidden(gk, kinds, on) {
      var rec = _goals[gk] || {}, hide = rec.hide || {};
      kinds.forEach(function (k) { if (on) hide[k] = true; else delete hide[k]; });
      if (Object.keys(hide).length) rec.hide = hide; else delete rec.hide;
      store(gk, rec);
      relayout(gk, null);
      flush();
    }
    var ALL = GOALS_KINDS.map(function (k) { return k.key; });
    doc.addEventListener("input", function (e) { if (isTxt(e.target)) save(e.target); });
    doc.addEventListener("focusout", function (e) { if (isTxt(e.target)) { save(e.target); flush(); } });
    doc.addEventListener("keydown", function (e) {
      if (!isTxt(e.target)) return;
      if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); doc.execCommand("insertLineBreak"); return; }
      if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); e.target.blur(); }
    });
    // Paste as plain text; pasted line breaks become spaces (use Shift+Enter for a break).
    doc.addEventListener("paste", function (e) {
      if (!isTxt(e.target)) return;
      e.preventDefault();
      var txt = ((e.clipboardData && e.clipboardData.getData("text/plain")) || "").replace(/\s+/g, " ");
      doc.execCommand("insertText", false, txt);
    });
    doc.addEventListener("mousedown", function (e) {
      var tg = e.target && e.target.closest ? e.target : null; if (!tg) return;
      // Other-agenda list in the Wednesday box: hide/show an item, or fold the hidden ones open.
      var xr = tg.closest(".xl-r");
      if (xr) {
        e.preventDefault();
        var ek = xr.getAttribute("data-ek");
        if (_xHide[ek]) delete _xHide[ek]; else _xHide[ek] = true;
        storeSet(XHIDE_KEY, _xHide);
        if (rerender) rerender();
        return;
      }
      if (tg.closest(".xl-more")) { e.preventDefault(); _xShowHidden = !_xShowHidden; if (rerender) rerender(); return; }
      var card = cardOf(tg), gk = card && card.getAttribute("data-gk"); if (!gk) return;
      var b = tg.closest(".gc-ctl-b");
      if (b) {
        e.preventDefault();
        var act = b.getAttribute("data-act");
        if (act === "hideall") setHidden(gk, ALL, true);
        else if (act === "showall") setHidden(gk, ALL, false);
        else setHidden(gk, [b.getAttribute("data-restore")], false);
        return;
      }
      var row = tg.closest(".gl-row"); if (!row) return;
      if (tg.closest(".gl-ico")) { e.preventDefault(); setHidden(gk, [row.getAttribute("data-kind")], true); return; }
      if (tg.closest(".gl-txt")) return;
      // Clicking anywhere else on a line edits it, with the caret at the end.
      var t = row.querySelector(".gl-txt"); if (!t) return;
      e.preventDefault(); t.focus();
      var sel = doc.getSelection && doc.getSelection();
      if (sel) { var r = doc.createRange(); r.selectNodeContents(t); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    });
    var txts = doc.querySelectorAll(".gl-txt");
    for (var i = 0; i < txts.length; i++) markOver(txts[i]);
  }
  function goalsDayHeadHtml(pv, offset, noDate) {
    var d = addDays(pv.weekStart, offset); if (!d) return '<th class="gday"></th>';
    var nm = DAY_FULL_NL[(d.getDay() + 6) % 7].slice(0, 2).toUpperCase();
    var dt = pad2(d.getDate()) + "-" + pad2(d.getMonth() + 1) + "-" + d.getFullYear();
    return '<th class="gday"><span class="gday-n">' + esc(nm) + "</span>" + (noDate ? "" : '<span class="gday-d">' + dt + "</span>") + "</th>";
  }
  // Legend = the vakken actually printed this week, in the teacher's tag order, with the colour the
  // card border uses (so legend and cards always agree).
  function goalsLegend(pv, weekIdx) {
    // Ranked by the vak order from Instellingen; a top tag that is not ticked as vak still shows
    // when a lesuur uses it (after the vakken), so the legend never hides a colour on the page.
    var tops = vakTops(), rank = {}, seen = {}, out = [];
    tops.forEach(function (t, i) { rank[String(t.id)] = i; });
    pv.slots.forEach(function (s) {
      if (s.weekIdx !== weekIdx || s.isFullday || s.idCalendar === "cal_holidays") return;
      var top = topTagIdOf(s.vak); if (top == null) return;
      var p = printCellParts(pv, s); if (!p || !p.color) return;
      var name = (anyTagTitle(top) || "").trim(); if (!name) return;
      var k = name + "|" + p.color; if (seen[k]) return; seen[k] = true;
      out.push({ name: name, color: p.color, rank: rank[String(top)] != null ? rank[String(top)] : 999 });
    });
    out.sort(function (a, b) { return a.rank - b.rank || a.name.localeCompare(b.name); });
    return out;
  }
  // Trailing run of empty Wednesday rows (lesson AND other-agenda) → the info box. null = none.
  function goalsFreeWedRows(pv, weekIdx, er, cells, rows) {
    var run = [];
    for (var i = rows.length - 1; i >= 0; i--) {
      var t = rows[i];
      var busy = er.injected[t] ? !!(er.inj[t] && er.inj[t].days[2]) : (!!pvSlotAt(pv, weekIdx, 2, t) || !!cells["2|" + t]);
      if (busy) break;
      run.unshift(t);
    }
    return run.length ? run : null;
  }
  // Info block (box or band): week/date, thema name(s) in their vak colour, typed note, legend.
  function goalsInfoParts(pv, weekIdx, opts) {
    var parts = { meta: "", themas: [], note: "", legend: _goalsLegendOn ? goalsLegend(pv, weekIdx) : [], extras: [] };
    if (opts.showMeta) parts.meta = "Week <b>" + esc(isoWeekNo(isoDate(addDays(pv.weekStart, weekIdx * 7)))) + "</b> · afgedrukt <b>" + esc(todayDDMMYYYY()) + "</b>";
    pvThemaKeys(pv).forEach(function (key) {
      var s = pvWeekThemaSlot(pv, weekIdx, key);
      var p = s ? printCellParts(pv, s) : null;
      var txt = p ? (p.main || p.vak || "") : "";
      if (!txt || isLesuurPlaceholder(txt)) return;
      parts.themas.push({ txt: txt, color: p.color || "" });
    });
    if (opts.showNotes) parts.note = (opts.comment || "").trim();
    return parts;
  }
  function goalsThemaHtml(t, tag) {
    return "<" + tag + ' class="gi-th"' + (t.color ? (' style="color:' + esc(t.color) + '"') : "") + ">" + esc(t.txt) + "</" + tag + ">";
  }
  function goalsLegendHtml(legend) {
    return legend.map(function (v) { return '<span class="gi-vak"><i style="background:' + esc(v.color) + '"></i>' + esc(v.name) + "</span>"; }).join("");
  }
  // Other agendas in the Wednesday box: one group per agenda, rows "MA 09:50 title", sorted by day and
  // time. Click a row to hide it (and its green time in the card); hidden rows never print, and on
  // screen fold into "+ N verborgen", which unfolds them so they can be clicked back.
  function goalsXListHtml(items) {
    var groups = {}, order = [], html = "", lines = 0;
    items.slice().sort(function (a, b) { return a.day - b.day || String(a.start).localeCompare(String(b.start)); }).forEach(function (it) {
      if (!groups[it.cal]) {
        var cal = (ctx.calendars || []).filter(function (c) { return String(c.id) === String(it.cal); })[0];
        groups[it.cal] = { name: (cal && cal.name) || "Andere agenda", color: it.color, list: [] };
        order.push(it.cal);
      }
      groups[it.cal].list.push(it);
    });
    function row(it, off) {
      return '<div class="xl-r' + (off ? " xl-off" : "") + '" data-ek="' + esc(goalsXKey(it)) + '" title="' +
        (off ? "Klik om weer te tonen" : "Klik om te verbergen (een terugkerend item: in elke week)") + '"><b>' +
        GOALS_DAY_ABBR[it.day] + "</b><span>" + esc(it.start || "dag") + "</span><span>" + esc(it.title) + "</span></div>";
    }
    order.forEach(function (cal) {
      var g = groups[cal];
      var vis = g.list.filter(function (it) { return !_xHide[goalsXKey(it)]; });
      var hid = g.list.filter(function (it) { return _xHide[goalsXKey(it)]; });
      html += '<div class="xl-h"><i style="background:' + esc(g.color) + '"></i>' + esc(g.name) + "</div>" +
        vis.map(function (it) { return row(it, false); }).join("") +
        (_xShowHidden ? hid.map(function (it) { return row(it, true); }).join("") : "") +
        (hid.length ? '<div class="xl-more">' + (_xShowHidden ? "verborgen items inklappen" : "+ " + hid.length + " verborgen") + "</div>" : "");
      lines += 1 + vis.length + (_xShowHidden ? hid.length : 0) + (hid.length ? 1 : 0);
    });
    return { html: html, lines: lines };
  }
  // Visible timed items → the lesuur card they fall in ("day|row"), shown as a time under its own.
  function goalsExtraMarks(pv, items) {
    var m = {};
    items.forEach(function (it) {
      if (!it.start || _xHide[goalsXKey(it)]) return;
      var row = matchTimeRow(pv, it.start); if (row == null) return;
      (m[it.day + "|" + row] = m[it.day + "|" + row] || []).push(it);
    });
    Object.keys(m).forEach(function (k) { m[k].sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); }); });
    return m;
  }
  // Wednesday box: type size follows the line count so 13 vakken + 2 themas still fit. A thema name
  // may wrap, so it is budgeted at 2 lines. The legend sits at the bottom.
  function goalsBoxHtml(parts, boxH, rowspan) {
    var noteLines = parts.note ? parts.note.split("\n").reduce(function (n, l) { return n + Math.max(1, Math.ceil(l.length / 34)); }, 0) : 0;
    var xl = goalsXListHtml(parts.extras);
    var lines = (parts.meta ? 1 : 0) + parts.themas.length * 2 + noteLines + xl.lines + parts.legend.length + 1;
    var lh = Math.max(7, Math.min(13, Math.floor((boxH - 24) / Math.max(1, lines))));
    var fs = Math.round(lh * 0.78 * 10) / 10;
    var html = (parts.meta ? '<div class="gi-meta">' + parts.meta + "</div>" : "") +
      parts.themas.map(function (t) { return goalsThemaHtml(t, "div"); }).join("") +
      (parts.note ? '<div class="gi-note">' + esc(parts.note) + "</div>" : "") +
      xl.html +
      (parts.legend.length ? '<div class="gi-legend">' + goalsLegendHtml(parts.legend) + "</div>" : "");
    // inner height = box minus border (3) and padding (14)
    return '<td class="gc gbox" rowspan="' + rowspan + '" style="font-size:' + fs + "px;line-height:" + lh + 'px"><div class="gbox-in" style="height:' + (boxH - 17) + 'px">' + html + "</div></td>";
  }
  // Fallback when Wednesday afternoon is not free: the same info as one band above the grid.
  function goalsBandHtml(parts) {
    var bits = [];
    if (parts.meta) bits.push('<span class="gi-meta">' + parts.meta + "</span>");
    parts.themas.forEach(function (t) { bits.push(goalsThemaHtml(t, "span")); });
    if (parts.note) bits.push('<span class="gi-note">' + esc(parts.note) + "</span>");
    parts.extras.forEach(function (it) {
      if (_xHide[goalsXKey(it)]) return;
      bits.push('<span class="gi-x"><b style="color:' + esc(it.color) + '">' + GOALS_DAY_ABBR[it.day] + " " + esc(it.start || "") + "</b> " + esc(it.title) + "</span>");
    });
    bits.push(goalsLegendHtml(parts.legend));
    return '<tr class="gbandrow" style="height:' + GOALS_BAND_H + 'px"><td class="gc gband" colspan="5">' + bits.join("") + "</td></tr>";
  }
  // Readable text on a vak-coloured header bar: dark ink on light colours (taal yellow), white on dark.
  function goalsInkOn(color) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || "").trim());
    if (!m) return "#1e2a33";
    var hx = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    var r = parseInt(hx.slice(0, 2), 16), g = parseInt(hx.slice(2, 4), 16), b = parseInt(hx.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? "#1e2a33" : "#fff";
  }
  function goalsCellHtml(pv, s, xs, time, innerH, n) {
    var p = printCellParts(pv, s);
    if (!p) return '<td class="gc gempty"></td>';
    // Another agenda's moment in this lesuur (zorgjuf …): its start time under the card's own, in the
    // agenda's colour; "+1" when there are more. The details are in the Wednesday list.
    var xt = (xs && xs.length) ? '<span class="gc-xt" style="color:' + esc(xs[0].color) + '">' + esc(xs[0].start) +
      (xs.length > 1 ? " +" + (xs.length - 1) : "") + "</span>" : "";
    // The vak label is gone from the card, so the fiche-vs-vak mismatch needs its own mark.
    var mm = vakMismatch(s), gk = goalsKeyFor(s), fg = s.ficheContentId ? _printFicheGoals[s.ficheContentId] : null;
    // Screen-only mark: these goals come from a newer version than the one this lesuur points at.
    var src = (fg && fg.src === "newer") ? '<span class="gc-src" title="Doelen uit een nieuwere versie van deze fiche — dit agenda-item verwijst nog naar de oude versie.">nieuwere versie</span>' : "";
    var bar = p.color ? (' style="background:' + esc(p.color) + ";color:" + goalsInkOn(p.color) + '"') : "";
    var top = '<div class="gc-top"' + bar + '><span class="gc-title">' + esc(p.main || "") + "</span>" +
      (mm ? '<span class="gc-mm">≠ ' + esc(mm.ficheVak || "?") + "</span>" : "") +
      '<span class="gc-times"><span class="gc-time">' + esc(time) + "</span>" + xt + "</span></div>";
    return '<td class="gc gfilled"><div class="gc-in"' + (gk ? ' data-gk="' + esc(gk) + '"' : "") + ' style="height:' + innerH + 'px">' +
      top + goalsLinesHtml(gk, n, goalsEditableFor(s)) + src + (gk ? '<div class="gc-ctl">' + goalsCtlHtml(goalsRecFor(gk)) + "</div>" : "") + "</div></td>";
  }
  // One printed page holding `rows` (a slice of the week's effective rows). `info` = this page carries
  // the week info (Wednesday box, else a band); `n` = ruled lines per card.
  function goalsPageHtml(pv, weekIdx, er, rows, marks, parts, head, info, n) {
    var nInj = 0; rows.forEach(function (t) { if (er.injected[t]) nInj++; });
    var nLes = rows.length - nInj;
    // Row height: page minus padding (8), header (21), 2px row gaps, injected rows (and the band).
    function rowHFor(band) {
      var nTr = 1 + rows.length + (band ? 1 : 0);
      var free = GOALS_PAGE_H - 8 - 21 - (nTr + 1) * 2 - nInj * GOALS_XROW_H - (band ? GOALS_BAND_H : 0);
      return Math.floor(free / Math.max(1, nLes));
    }
    var wed = info ? goalsFreeWedRows(pv, weekIdx, er, {}, rows) : null, rowH = rowHFor(false), boxH = 0;
    if (wed) {
      wed.forEach(function (t) { boxH += er.injected[t] ? GOALS_XROW_H : rowH; });
      boxH += (wed.length - 1) * 2;
      if (boxH < GOALS_BOX_MIN) wed = null;
    }
    var band = info && !wed;
    if (band) rowH = rowHFor(true);
    var innerH = rowH - 2;   // card chrome: border 1 × 2 (no padding: the header bar runs edge to edge)
    var html = band ? goalsBandHtml(parts) : "";
    rows.forEach(function (t) {
      var isInj = er.injected[t];
      html += '<tr style="height:' + (isInj ? GOALS_XROW_H : rowH) + 'px">';
      for (var dd = 0; dd < 5; dd++) {
        if (dd === 2 && wed && wed.indexOf(t) >= 0) {
          if (wed[0] === t) html += goalsBoxHtml(parts, boxH, wed.length);
          continue;
        }
        if (isInj) {
          var x = (er.inj[t] && er.inj[t].days[dd]) || "";
          html += x ? ('<td class="gc gxcell"><span class="gc-time">' + esc(t) + "</span>" + x + "</td>") : '<td class="gc gxcell gx-empty"></td>';
        } else {
          html += goalsCellHtml(pv, pvSlotAt(pv, weekIdx, dd, t), marks[dd + "|" + t] || null, t, innerH, n);
        }
      }
      html += "</tr>";
    });
    return '<div class="psheet-scale"><div class="gsheet"><table class="gweek"><thead>' + head + "</thead><tbody>" + html + "</tbody></table></div></div>";
  }
  // mode "goals1" = one page per week, 3 lines per card; "goals2" = front + back, 8 lines per card.
  function printGoalsWeekHtml(pv, weekIdx, exWeek, opts, mode) {
    // Other agendas never enter the grid here (no chips, no extra rows): they become the Wednesday list
    // plus a time in the lesuur card they fall in.
    var xitems = (exWeek && exWeek.items) || [];
    var er = effectiveRows(pv, { cells: {}, inject: {} });
    var marks = goalsExtraMarks(pv, xitems);
    var parts = goalsInfoParts(pv, weekIdx, opts);
    parts.extras = xitems;
    var head = "<tr>", headBack = "<tr>";
    for (var d = 0; d < 5; d++) { head += goalsDayHeadHtml(pv, weekIdx * 7 + d); headBack += goalsDayHeadHtml(pv, weekIdx * 7 + d, true); }
    head += "</tr>"; headBack += "</tr>";
    if (!er.rows.length) {
      return '<div class="psheet-scale"><div class="gsheet"><table class="gweek"><thead>' + head + '</thead></table><div class="gnone">Geen lesitems deze week.</div></div></div>';
    }
    var nLes = er.rows.filter(function (t) { return !er.injected[t]; }).length;
    if (mode !== "goals2" || nLes < 2) return goalsPageHtml(pv, weekIdx, er, er.rows, marks, parts, head, true, 3);
    // Front = rows up to and including the ceil(n/2)-th lesuur; back = the rest (+ the week info).
    var want = Math.ceil(nLes / 2), seen = 0, cutAt = er.rows.length;
    for (var i = 0; i < er.rows.length; i++) {
      if (!er.injected[er.rows[i]] && ++seen === want) { cutAt = i + 1; break; }
    }
    // The back page repeats the day names but not the dates.
    return goalsPageHtml(pv, weekIdx, er, er.rows.slice(0, cutAt), marks, parts, head, false, 8) +
      goalsPageHtml(pv, weekIdx, er, er.rows.slice(cutAt), marks, parts, headBack, true, 8);
  }
  var PRINT_GOALS_CSS =
    '@page { size: A4 landscape; margin: 6mm; }' +
    '* { box-sizing: border-box; }' +
    'body { font: 11px/1.4 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1e2a33; margin: 0; }' +
    '.psheet-scale { page-break-after: always; }' +
    '.psheet-scale:last-child { page-break-after: auto; }' +
    '.gsheet { width: 1076px; height: ' + GOALS_PAGE_H + 'px; overflow: hidden; background: #fff; padding: 4px 3px; }' +
    '.gnone { text-align: center; color: #93a0a7; font-size: 13px; padding: 60px 0; }' +
    '.gweek { width: 100%; border-collapse: separate; border-spacing: 5px 2px; table-layout: fixed; }' +
    '.gweek thead th.gday { height: 21px; background: #111; color: #fff; border: 1px solid #111; text-align: center; font-size: 11px; line-height: 14px; font-weight: 600; padding: 2px 5px; white-space: nowrap; }' +
    '.gday-n { font-weight: 800; letter-spacing: .04em; margin-right: 5px; }' +
    '.gday-d { font-weight: 500; color: #fff; }' +
    'td.gc { vertical-align: top; padding: 3px 8px 2px 9px; overflow: hidden; }' +
    'td.gempty { background: #fafbfb; border: 1px dashed #e3e9ec; }' +
    // Thin black outline, straight corners; the vak colour fills the header bar (title + time).
    'td.gfilled { background: #fff; border: 1px solid #111; padding: 0; }' +
    '.gc-in { position: relative; display: flex; flex-direction: column; overflow: hidden; }' +
    // The header is always 2 title lines tall, so every card's write lines start at the same height.
    '.gc-top { flex: none; display: flex; align-items: flex-start; gap: 6px; line-height: 14px; height: 33px; padding: 2px 8px 3px 9px; background: #eef2f4; color: #1e2a33; }' +
    '.gc-title { flex: 1 1 auto; min-width: 0; font-weight: 600; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }' +
    '.gc-x { flex: 0 1 auto; min-width: 0; max-width: 60%; overflow: hidden; display: flex; gap: 3px; }' +
    '.gc-mm { flex: none; font-size: 9px; font-weight: 700; color: #b3261e; background: #fff; padding: 0 3px; }' +
    '.gc-time { flex: none; font-size: 9.5px; font-weight: 700; color: #93a0a7; }' +
    '.gc-times { flex: none; display: flex; flex-direction: column; align-items: flex-end; }' +
    '.gc-xt { font-size: 9px; font-weight: 800; line-height: 12px; background: #fff; padding: 0 3px; margin-top: 1px; }' +
    '.xl-h { display: flex; align-items: center; gap: 4px; font-weight: 800; margin: 5px 0 1px; }' +
    '.xl-h i { flex: none; width: 7px; height: 7px; }' +
    '.xl-r { display: grid; grid-template-columns: 2.1em 3em 1fr; color: #1e2a33; }' +
    '.xl-r b { font-weight: 800; }' +
    '.xl-r span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
    '.xl-off, .xl-more { display: none; }' +
    '.gi-x { white-space: nowrap; }' +
    '.gc-top .gc-time { color: inherit; opacity: .8; }' +
    // One ruled line = the .gl block (cqh) ÷ --k; a row spans --m lines. The rule sits just under each
    // line of text.
    '.gl { flex: 1 1 auto; min-height: 0; position: relative; container-type: size; margin: 0 8px 2px 0; }' +
    '.gl-row { position: relative; overflow: hidden; height: calc(100cqh * var(--m) / var(--k)); }' +
    '.gl-off { display: none; }' +
    // Each kind gets a light grey strip on the card's left edge, spanning its section, label centred.
    '.gl-ico { position: absolute; left: 0; top: 1px; bottom: 1px; width: 18px; display: flex; align-items: center; justify-content: center; background: #eeeeee; color: #666; line-height: 0; }' +
    '.gl-vw { writing-mode: vertical-rl; transform: rotate(180deg); font: 800 7.5px/1 "Segoe UI", Roboto, Arial, sans-serif; letter-spacing: .06em; white-space: nowrap; }' +
    '.gl[data-n="3"] .gl-vw { font-size: 6.5px; letter-spacing: .02em; }' +   // 1 A4: a 1-line tab is only ~6mm tall
    '.gl-txt { height: 100%; margin-left: 26px; background-image: repeating-linear-gradient(to bottom, transparent 0 calc(100cqh / var(--k) / 2 + 5px), #bdbdbd calc(100cqh / var(--k) / 2 + 5px) calc(100cqh / var(--k) / 2 + 6px), transparent calc(100cqh / var(--k) / 2 + 6px) calc(100cqh / var(--k))); font-size: 9.5px; line-height: calc(100cqh / var(--k)); color: #1e2a33; white-space: pre-wrap; overflow: hidden; overflow-wrap: anywhere; outline: none; cursor: text; }' +
    '.gc-ctl { display: none; }' +
    '.gc-src { display: none; }' +
    'td.gxcell { background: repeating-linear-gradient(135deg,#fffaf0,#fffaf0 8px,#fff6e6 8px,#fff6e6 16px); border: 1px dashed #e7cf94; padding: 2px 6px; white-space: nowrap; }' +
    'td.gx-empty { background: transparent; border: none; }' +
    'td.gxcell .gc-time { color: #b7891a; margin-right: 4px; }' +
    '.pc-extra { display: inline-flex; align-items: center; gap: 4px; font-size: 9px; font-weight: 600; background: #f3f5f6; padding: 0 7px 0 5px; margin-right: 3px; color: #3c4a52; white-space: nowrap; }' +
    '.pc-ico { font-size: 10px; line-height: 1; }' +
    '.pc-tm { color: #8a949b; font-weight: 500; }' +
    'td.gbox { background: #f4f3e8; border: 1.5px solid #e6e3c8; color: #5a5836; padding: 7px 9px; }' +
    'td.gband { background: #f4f3e8; border: 1.5px solid #e6e3c8; color: #5a5836; padding: 4px 9px; font-size: 10px; line-height: 13px; }' +
    'td.gband > * { display: inline-flex; margin-right: 12px; vertical-align: middle; }' +
    '.gi-meta { color: #8a8660; margin-bottom: 2px; }' +
    '.gi-meta b { color: #5a5836; }' +
    '.gbox-in { display: flex; flex-direction: column; overflow: hidden; }' +
    '.gi-th { font-weight: 700; margin-bottom: 3px; }' +
    '.gi-legend { margin-top: auto; padding-top: 4px; border-top: 1px solid #e6e3c8; }' +
    '.gi-note { white-space: pre-wrap; font-style: italic; margin-bottom: 3px; }' +
    '.gi-vak { display: flex; align-items: center; gap: 4px; font-weight: 600; color: #3c4a52; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
    'td.gband .gi-vak { display: inline-flex; margin-right: 8px; }' +
    '.gi-vak i { flex: none; width: 7px; height: 7px; }';
  // Screen-only frame, mirroring PRINT_SCREEN_CSS (fitPrintDoc sets --ss on .psheet-scale).
  var PRINT_GOALS_SCREEN_CSS =
    '@media screen {' +
    '  body { background: #e6eaec; padding: 20px; }' +
    '  .psheet-scale { zoom: var(--ss, 1); margin: 0 auto 18px; width: 1076px; }' +
    // fitPrintDoc's --ss zoom assumes the 1040×712 sheet; this page is 1076×746, so shrink 5% more.
    '  .gsheet { border-radius: 12px; box-shadow: 0 4px 22px rgba(20,40,60,.16); zoom: .95; }' +
    '  .gl-row { cursor: text; }' +
    '  .gl-row:hover .gl-txt { background-color: rgba(47,109,107,.05); }' +
    '  .gl-row:focus-within .gl-txt { background-color: rgba(47,109,107,.10); }' +
    '  .gl-ico { cursor: pointer; }' +
    '  .gl-ico:hover { color: #b3261e; }' +
    '  .gl-txt.gl-over { box-shadow: inset -3px 0 0 #b3261e; }' +
    '  .xl-r { cursor: pointer; }' +
    '  .xl-r:hover { text-decoration: line-through; color: #b3261e; }' +
    '  .xl-off { display: grid; opacity: .45; text-decoration: line-through; }' +
    '  .xl-off:hover { opacity: 1; text-decoration: none; color: #137a3a; }' +
    '  .xl-more { display: block; cursor: pointer; color: #7a868d; font-style: italic; }' +
    '  .xl-more:hover { color: #2f6d6b; }' +
    '  .gc-src { display: block; position: absolute; right: 3px; bottom: 2px; font-size: 8.5px; font-weight: 700; color: #8a5a00; background: #fff4d6; border-radius: 999px; padding: 0 5px; line-height: 13px; cursor: help; }' +
    '  td.gfilled:hover .gc-ctl { display: flex; gap: 3px; position: absolute; right: 4px; top: 2px; background: #fff; border-radius: 999px; padding: 1px; }' +
    '  .gc-ctl-b { display: inline-flex; align-items: center; font-size: 9.5px; font-weight: 700; color: #7a868d; background: #eef2f4; border-radius: 999px; padding: 0 5px; cursor: pointer; line-height: 14px; }' +
    '  .gc-ctl-b:hover { color: #2f6d6b; background: #dcebea; }' +
    '  .gc-ctl-b svg { width: 9px; height: 9px; }' +
    '}';
  // prefs: { tabs: "word" | "icon", legend: bool } from the print window.
  function printGoalsDocHtml(pv, extraByWeek, opts, mode, prefs) {
    extraByWeek = extraByWeek || {}; prefs = prefs || {};
    _goalsTab = prefs.tabs === "icon" ? "icon" : "word";
    _goalsLegendOn = prefs.legend !== false;
    var body = "";
    for (var w = 0; w < pv.weeks; w++) body += printGoalsWeekHtml(pv, w, extraByWeek[w] || { cells: {}, inject: {} }, opts, mode);
    return "<!doctype html><html lang=\"nl\"><head><meta charset=\"utf-8\"><title>" +
      esc("Lesdoelen " + weekTitleFor(pv, 0)) + "</title><style>" + PRINT_GOALS_CSS + PRINT_GOALS_SCREEN_CSS + "</style></head><body>" +
      body + "</body></html>";
  }
  // Extra calendars for print (Feature 4). Own calendars minus the primary lesson calendar.
  function extraPrintCalendars() {
    return (ctx.calendars || []).filter(function (c) { return c.id && String(c.id) !== String(ctx.calendarId) && c.id !== "cal_holidays"; });
  }
  // Find the lesuur time-row whose [start,end) contains a given HH:MM; else null (→ inject a row).
  function matchTimeRow(pv, startHHMM) {
    var mins = hhmmToMin(startHHMM); if (mins == null) return null;
    var fb = commonDurationMin(pv), found = null;
    pv.timeRows.forEach(function (t) {
      if (found != null) return;
      var s = hhmmToMin(t), m = pv.rowMeta && pv.rowMeta[t];
      var e = (m && m.end) ? hhmmToMin(m.end) : (s + fb);
      if (mins >= s && mins < e) found = t;
    });
    return found;
  }
  // Fetch the selected extra calendars for pv's range → per-week { cells, inject } (see model above).
  function fetchPrintExtras(pv, calIds) {
    if (!calIds || !calIds.length || !pv.weekStart) return Promise.resolve({});
    var startISO = pv.weekStart;
    var endD = addDays(pv.weekStart, 7 * pv.weeks - 1);
    var endISO = endD ? isoDate(endD) : pv.weekStart;
    var colorById = {}; (ctx.calendars || []).forEach(function (c) { colorById[c.id] = c.color || "#888"; });
    var fb = commonDurationMin(pv);
    return apiItems(startISO, endISO, calIds).then(function (items) {
      var out = {}, base = addDays(pv.weekStart, 0);
      (items || []).forEach(function (it) {
        if (!it || it.id_calendar === "cal_holidays") return;
        var day = weekdayIdx(it.startdate); if (day < 0 || day > 4) return;
        var d0 = addDays(String(it.startdate).slice(0, 10), 0);
        var wk = (d0 && base) ? Math.floor((d0 - base) / 86400000 / 7) : 0;
        if (wk < 0) wk = 0; if (wk >= pv.weeks) return;
        var w = (out[wk] = out[wk] || { cells: {}, inject: {} });
        var color = colorById[it.id_calendar];
        // Raw list for the Lesdoelen print, which shows other agendas as a list + a time in the card.
        (w.items = w.items || []).push({ id: it.id, rep: it.id_repeat || null, cal: it.id_calendar, day: day,
          start: it.is_fullday_item ? "" : timeFromISO(it.startdate), end: it.is_fullday_item ? "" : timeFromISO(it.enddate),
          title: it.title || "", color: color || "#888" });
        if (it.is_fullday_item) {
          var t0 = pv.timeRows[0]; if (!t0) return;
          var k0 = day + "|" + t0; w.cells[k0] = (w.cells[k0] || "") + extraChip(color, it.title, "");
          return;
        }
        var startHHMM = timeFromISO(it.startdate);
        var startMin = hhmmToMin(startHHMM); if (startMin == null) return;
        var covered = matchTimeRow(pv, startHHMM);
        if (covered != null) {
          var k = day + "|" + covered; w.cells[k] = (w.cells[k] || "") + extraChip(color, it.title, startHHMM);
        } else {
          var endHHMM = timeFromISO(it.enddate) || minToHHMM(startMin + fb);
          var rec = (w.inject[startHHMM] = w.inject[startHHMM] || { end: endHHMM, days: {} });
          if (hhmmToMin(endHHMM) > hhmmToMin(rec.end)) rec.end = endHHMM;
          rec.days[day] = (rec.days[day] || "") + extraChip(color, it.title, "");
        }
      });
      return out;
    }).catch(function () { return {}; });
  }
  // Resolve each printed fiche's OWN subject colour (its tag's set colour) → pv.ficheColor map.
  // Own fiches via /lessons/{id}?return_format=edit → tags[]; colleague/method/gym → neutral.
  var _ficheColorCache = {};   // contentId → "#hex" | "" (cached across nav to avoid refetch)
  // contentId → top-tag id | null (= known to have no resolvable vak) | undefined (= not looked up).
  // Separate from the colour cache on purpose: colorFromTagList drops tags that have no colour set,
  // which would silently discard a perfectly valid vak.
  var _ficheVakCache = {};
  function vakFromTagList(tags) {
    for (var i = 0; i < (tags || []).length; i++) {
      var t = tags[i], tid = (t && t.id != null) ? t.id : t;
      var top = topTagIdOf(tid);
      if (top != null) return top;
    }
    return null;
  }
  // Fill _ficheVakCache for every attached fiche in `slots`, then run `done`. Deliberately fired
  // AFTER the grid paints, so a week never waits on it — the flags just appear a beat later.
  function resolveFicheVakken(slots, done) {
    var todo = {};
    (slots || []).forEach(function (s2) {
      if (!s2.ficheContentId || s2.isGym) return;
      // Methode fiches answer 1235 "no access to lesson" — proven by the Zelftest probe. Their vak
      // is unknowable, so mark them null and never spend a request (or show a false mismatch).
      if (s2.ficheIsMethod || view.methodFicheIds[String(s2.ficheContentId)]) { _ficheVakCache[s2.ficheContentId] = null; return; }
      if (s2.ficheContentId in _ficheVakCache) return;
      todo[s2.ficheContentId] = true;
    });
    var ids = Object.keys(todo);
    if (!ids.length) { if (done) done(false); return Promise.resolve(false); }
    // At most 4 reads in flight — a full week is ~30 fiches, never fire them all at once.
    return mapLimit(ids, 4, function (id) {
      return ficheEditTags(id)
        .then(function (tags) { _ficheVakCache[id] = vakFromTagList(tags); })
        // A colleague fiche we may not read is "unknown", never a mismatch.
        .catch(function () { _ficheVakCache[id] = null; });
    }).then(function () { if (done) done(true); return true; });
  }
  // null = cannot say (unknown fiche vak, or no vak set on the slot). Only a definite
  // disagreement between two KNOWN vakken counts — no crying wolf.
  function vakMismatch(s2) {
    if (!s2 || !s2.ficheContentId || s2.isGym) return null;
    var fv = _ficheVakCache[s2.ficheContentId];
    if (fv == null) return null;
    var sv = topTagIdOf(s2.vak);
    if (sv == null || String(sv) === String(fv)) return null;
    return { ficheVak: (anyTagTitle(fv) || "").trim(), slotVak: (anyTagTitle(sv) || "").trim() };
  }
  // LOAD rule for a lesuur whose fiche (or lack of one) is unchanged since load: manual override →
  // the fiche's OWN vak (once _ficheVakCache knows it) → the top tag whose title equals the stored
  // description → settings. The stored description is what WE wrote, so a vak chosen by hand for one
  // lesuur (WO and Godsdienst swapped that week) survives a reload, on another device and in print —
  // instead of snapping back to the timeslot setting. A lesuur whose stored vak disagrees with its
  // fiche becomes a description-only change, shown in review. Safe only because a commit no longer
  // re-POSTs an unchanged fiche nor writes the list title. Returns the count changed.
  function applyStoredVakken(slots) {
    var tops = null, n = 0;
    (slots || []).forEach(function (s2) {
      if (!s2 || s2.isFullday || s2.isGym || s2.idCalendar === "cal_holidays") return;
      if (s2.vakReset) return;   // "Vakken herstellen" chose the default on purpose this session
      if (isUnhydrated(s2)) return;   // stored description/fiche not read yet
      if (String(s2.ficheContentId || "") !== String(s2.origFicheContentId || "")) return;   // changed in the planner
      var target = slotVakOverride(s2);
      if (target == null && s2.ficheContentId) target = _ficheVakCache[s2.ficheContentId];
      if (target == null) {
        var d = stripHtml(s2.origDescription).toLowerCase(); if (!d) return;
        if (!tops) tops = topTagsForOwner(ownTagsList(), ctx.ownerId) || [];
        var hit = tops.filter(function (t) { return (t.title || "").trim().toLowerCase() === d; })[0];
        if (!hit) return;
        target = hit.id;
      }
      var cur = topTagIdOf(s2.vak), want = topTagIdOf(target);
      if (cur != null && want != null && String(cur) === String(want)) return;
      s2.vak = target;
      s2.themaFiche = isThemaVak(s2.vak);
      n++;
    });
    return n;
  }
  // ASSIGN rule: a fiche just placed in the planner takes its OWN vak (from _ficheVakCache), or the
  // teacher's manual override. Unknown fiche vak (methode, unreadable colleague fiche) → left as is.
  // Only ever called on slots the teacher just filled (syncFicheVakken) — never on load.
  function applyFicheVakken(slots) {
    var n = 0;
    (slots || []).forEach(function (s2) {
      if (!s2 || s2.isFullday || s2.isGym || !s2.ficheContentId || s2.idCalendar === "cal_holidays") return;
      var ov = slotVakOverride(s2);
      var target = ov != null ? ov : _ficheVakCache[s2.ficheContentId];
      if (target == null) return;
      var cur = topTagIdOf(s2.vak), want = topTagIdOf(target);
      if (cur != null && want != null && String(cur) === String(want)) return;   // keeps a subtag
      s2.vak = target;
      s2.themaFiche = isThemaVak(s2.vak);
      n++;
    });
    return n;
  }
  // After placing fiche(s): learn their vak and relabel a beat later, without waiting for a reload.
  function syncFicheVakken(slots) {
    resolveFicheVakken(slots, function () { if (applyFicheVakken(slots)) renderTimetable(); });
  }
  // Memoised per fiche id: an id is one immutable version, and the vak check and the print colours
  // both ask for the same fiches — one read each, not two. Failures are not remembered.
  var _ficheTagsP = {};
  function ficheEditTags(id) {
    if (_ficheTagsP[id]) return _ficheTagsP[id];
    var p = jget(API + "/lessons/" + id + "?" + qs({ schoolId: ctx.schoolId, return_format: "edit" }))
      .then(function (j) { var r = (j && j.result) || j; return (r && r.tags) || []; });
    _ficheTagsP[id] = p;
    return p.catch(function () { delete _ficheTagsP[id]; return []; });
  }
  function colorFromTagList(tags) {
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i], tid = (t && t.id != null) ? t.id : t;
      var top = topTagIdOf(tid), c = top != null ? anyTagColor(top) : null;
      if (c) return c;
    }
    return "";
  }
  function buildFicheColors(pv) {
    var idset = {};
    (pv.slots || []).forEach(function (s) {
      if (!s.ficheContentId || s.isGym || s.themaFiche) return;
      idset[s.ficheContentId] = true;
    });
    function collect() { var m = {}; Object.keys(idset).forEach(function (id) { m[id] = _ficheColorCache[id] || ""; }); pv.ficheColor = m; return pv; }
    var todo = Object.keys(idset).filter(function (id) { return !(id in _ficheColorCache); });
    if (!todo.length) return Promise.resolve(collect());
    return mapLimit(todo, 4, function (id) {
      return ficheEditTags(id).then(function (tags) { _ficheColorCache[id] = colorFromTagList(tags); });
    }).then(collect);
  }

  // ---- Headless print plumbing (no planner overlay needed) ----
  // Pure row computation — shared by the on-screen grid (computeTimeRows) and headless print.
  function computeRowsFrom(slots) {
    var set = {}, endAt = {}, presence = {};
    (slots || []).forEach(function (s) {
      if (s.idCalendar === "cal_holidays") return;
      if (s.isFullday) return;
      var t = s.time || (s.starttime ? String(s.starttime).slice(0, 5) : "");
      if (!t) return;
      set[t] = true; presence[s.dayIdx + "|" + t] = true;
      var e = (s.endtime ? String(s.endtime).slice(0, 5) : timeFromISO(s.enddate));
      if (e) { (endAt[t] = endAt[t] || {}); endAt[t][e] = (endAt[t][e] || 0) + 1; }
    });
    var timeRows = Object.keys(set).sort(), rowMeta = {};
    timeRows.forEach(function (t) {
      var best = null, bestN = 0, m = endAt[t] || {};
      Object.keys(m).forEach(function (e) { if (m[e] > bestN) { bestN = m[e]; best = e; } });
      rowMeta[t] = { start: t, end: best };
    });
    return { timeRows: timeRows, rowMeta: rowMeta, presence: presence };
  }
  // A print-view (pv) from hydrated slots — never touches `view`. weekIdx is recomputed against
  // startISO (hydrate counts from view.weekStart). Fiche vakken and colours are resolved first: print
  // must show the same mismatch warnings the grid does, and it renders once with no later repaint.
  function printViewFrom(slots, startISO, weeks) {
    var base = addDays(startISO, 0);
    (slots || []).forEach(function (s) {
      var d0 = addDays(String(s.startdate).slice(0, 10), 0);
      s.weekIdx = (d0 && base) ? Math.max(0, Math.floor((d0 - base) / 86400000 / 7)) : 0;
    });
    var r = computeRowsFrom(slots);
    var pv = { slots: slots, weekStart: startISO, weeks: weeks, timeRows: r.timeRows, rowMeta: r.rowMeta, presence: r.presence, ficheColor: {} };
    return resolveFicheVakken(pv.slots).then(function () { applyStoredVakken(pv.slots); applyThemaLesuurTitles(pv.slots); return buildFicheColors(pv); });
  }
  // Fetch a week's slots (items + every detail) into a standalone pv.
  function fetchPrintView(startISO, weeks) {
    var endD = addDays(startISO, 7 * weeks - 1), endISO = endD ? isoDate(endD) : startISO;
    return hydrateRange(startISO, endISO).then(function (slots) { return printViewFrom(slots, startISO, weeks); });
  }
  // The planner already holds exactly these weeks, every detail read and nothing staged: its slots ARE
  // the stored planning, so print works on copies of them instead of reading every item a second time.
  // Anything else (another week, staged edits, a detail still loading or failed) → null, fetch instead.
  function plannerPrintView(startISO, weeks) {
    // slotsStart, not weekStart: reloadWeek moves weekStart before the new list has arrived.
    if (!view.slotsStart || startISO !== view.slotsStart || weeks > view.weeks || !view.slots.length) return null;
    if (hydratePending() || hydrateFailed() || stagedCount()) return null;
    var copies = view.slots.filter(function (s) { return s.weekIdx < weeks; }).map(function (s) { return Object.assign({}, s); });
    return printViewFrom(copies, startISO, weeks);
  }

  // ---------- Afdrukken tab: print settings in the sidebar, live A4 preview in the main column ----------
  // The former standalone print window, re-mounted as the planner's third tab (one copy of the logic).
  // It prints the STORED planning of the chosen week(s) — staged edits are not on Questi yet, and the
  // sidebar says so. The preview iframe holds the very document that gets printed; the Voorkant /
  // Achterkant switch only hides pages on screen (@media screen), printing always sends every page.
  var _pp = null;
  var PRINT_VERSIONS = [
    { v: "plain", t: "Gewoon", d: "het weekrooster, één blad per week" },
    { v: "goals1", t: "Lesdoelen · 1 A4", d: "één blad per week, 3 lijnen per les" },
    { v: "goals2", t: "Lesdoelen · 2 A4", d: "voor- en achterkant, 8 lijnen per les" }
  ];
  function ppLbl(t) { return h("div", { class: "qpp-lbl", text: t }); }
  function buildPrintPanel() {
    var P = _pp = { pv: null, start: null, weeks: 1, extras: {}, gen: 0, page: "front", pages: 0, plannerWeek: null, prefsLoaded: false,
      prefs: { mode: "plain", tabs: "word", legend: true, meta: true }, calBoxes: [], verCards: [], tabBtns: [], pageBtns: [] };
    P.frame = h("iframe", { class: "qpp-frame", title: "Afdrukvoorbeeld" });
    P.msg = h("div", { class: "qpp-msg", style: "display:none" });
    P.range = h("span", { class: "qpp-wk-lbl", text: "…" });
    P.ta = h("textarea", { class: "qpp-ta", rows: "3", placeholder: "bv. donderdag schoolfotograaf" });
    P.ta.addEventListener("input", renderPrintPreview);
    P.notesChk = h("input", { type: "checkbox" });
    P.notesChk.addEventListener("change", renderPrintPreview);
    P.metaChk = h("input", { type: "checkbox" }); P.metaChk.checked = true;
    P.metaChk.addEventListener("change", function () { P.prefs.meta = P.metaChk.checked; savePrintPrefs(); renderPrintPreview(); });
    P.legendChk = h("input", { type: "checkbox" }); P.legendChk.checked = true;
    P.legendChk.addEventListener("change", function () { P.prefs.legend = P.legendChk.checked; savePrintPrefs(); renderPrintPreview(); });
    var verList = PRINT_VERSIONS.map(function (x) {
      var r = h("input", { type: "radio", name: "qpp-mode", value: x.v });
      r.addEventListener("change", function () { if (r.checked) { P.prefs.mode = x.v; savePrintPrefs(); renderPrintPreview(); } });
      var card = h("label", { class: "qpp-ver" }, [r, h("span", { class: "qpp-ver-tx" }, [h("span", { class: "qpp-ver-t", text: x.t }), h("span", { class: "qpp-ver-d", text: x.d })])]);
      P.verCards.push({ v: x.v, r: r, el: card });
      return card;
    });
    function tabBtn(v, label) {
      var b = h("button", { type: "button", text: label, onclick: function () { P.prefs.tabs = v; savePrintPrefs(); renderPrintPreview(); } });
      P.tabBtns.push({ v: v, el: b }); return b;
    }
    // Only meaningful for the Lesdoelen versions; hidden for Gewoon.
    P.goalsOnly = [
      h("div", { class: "qpp-seg", role: "group", "aria-label": "Labels op de kaart" }, [tabBtn("word", "WEET / KEN / KAN"), tabBtn("icon", "Icoontjes")]),
      h("label", { class: "qpp-check" }, [P.legendChk, h("span", { text: "Vakkenlegende in het woensdagvak" })])
    ];
    // Only meaningful for Gewoon: its note block prints ruled lines when no text was typed.
    P.notesRow = h("label", { class: "qpp-check" }, [P.notesChk, h("span", { text: "Lege notitieregels als er geen opmerking is" })]);
    P.cals = h("div", { class: "qpp-sec", style: "display:none" });
    P.staged = h("div", { class: "qpp-note", style: "display:none" });
    P.warn = h("div", { class: "qpp-warn", style: "display:none" });
    P.hint = h("div", { class: "qpp-hint" });
    var body = h("div", { class: "qpp-body" }, [
      h("div", { class: "qpp-sec" }, [
        ppLbl("Week"),
        h("div", { class: "qpp-wk" }, [
          h("button", { type: "button", class: "qpp-arrow", "aria-label": "Vorige week", title: "Vorige week", text: "←", onclick: function () { stepPrintWeek(-1); } }),
          P.range,
          h("button", { type: "button", class: "qpp-arrow", "aria-label": "Volgende week", title: "Volgende week", text: "→", onclick: function () { stepPrintWeek(1); } })
        ])
      ]),
      h("fieldset", { class: "qpp-sec qpp-vers" }, [h("legend", { class: "qpp-lbl", text: "Versie" })].concat(verList)),
      h("div", { class: "qpp-sec" }, [ppLbl("Op het blad")].concat(P.goalsOnly).concat([
        h("label", { class: "qpp-check" }, [P.metaChk, h("span", { text: "Weeknummer en afdrukdatum" })])
      ])),
      P.cals,
      h("div", { class: "qpp-sec" }, [h("label", { class: "qpp-lbl", text: "Opmerking voor deze week" }), P.ta, P.notesRow]),
      P.staged,
      P.warn
    ]);
    var foot = h("div", { class: "qpp-foot" }, [
      h("button", { type: "button", class: "qpp-btn", text: "Bewaar als PDF", title: "Opent het afdrukvenster — kies daar ‘Opslaan als PDF’", onclick: function () { doPrintPanel(true); } }),
      h("button", { type: "button", class: "qpp-btn primary", text: "Afdrukken", onclick: function () { doPrintPanel(false); } })
    ]);
    P.side = h("aside", { class: "qpp-side", id: "qwp-pside" }, [h("div", { class: "qpp-top" }, [tabsNav("print")]), body, P.hint, foot]);
    function pageBtn(v, label) {
      var b = h("button", { type: "button", text: label, onclick: function () { P.page = v; applyPrintPage(); } });
      P.pageBtns.push({ v: v, el: b }); return b;
    }
    P.pageSeg = h("div", { class: "qpp-seg qpp-pageseg", role: "group", "aria-label": "Pagina" }, [pageBtn("front", "Voorkant"), pageBtn("back", "Achterkant")]);
    P.sub = h("span", { class: "qpp-sub" });
    P.main = h("main", { class: "qpp-main", id: "qwp-pmain" }, [
      h("header", { class: "qwp-mhdr qpp-hdr" }, [
        h("div", { class: "qpp-title", text: "Voorbeeld" }), P.sub, h("span", { class: "qwp-spacer" }), P.pageSeg,
        betaPill(), h("button", { class: "qwp-topx", onclick: hide, title: "Sluiten", text: "✕" })
      ]),
      h("div", { class: "qpp-preview" }, [P.frame, P.msg])
    ]);
    window.addEventListener("resize", function () { if (view.tab === "print") fitPrintFrame(); });
    return P;
  }
  // qwp_print_v1 = { mode, tabs, legend, meta } — shared with the Afdrukken section in settings.js.
  function savePrintPrefs() { storeSet("qwp_print_v1", _pp.prefs); }
  function loadPrintPrefs() {
    return storeGet("qwp_print_v1").then(function (v) {
      var p = _pp.prefs; v = v || {};
      if (PRINT_VERSIONS.some(function (x) { return x.v === v.mode; })) p.mode = v.mode;
      if (v.tabs === "word" || v.tabs === "icon") p.tabs = v.tabs;
      if (typeof v.legend === "boolean") p.legend = v.legend;
      if (typeof v.meta === "boolean") p.meta = v.meta;
      _pp.legendChk.checked = p.legend; _pp.metaChk.checked = p.meta;
    }).catch(function () {});
  }
  function ppOpts() {
    var P = _pp, txt = P.ta.value || "";
    return { comment: txt, showNotes: !!txt.trim() || (P.prefs.mode === "plain" && P.notesChk.checked), showMeta: P.metaChk.checked };
  }
  function syncPrintControls() {
    var P = _pp, goals = P.prefs.mode !== "plain";
    P.verCards.forEach(function (c) { c.r.checked = c.v === P.prefs.mode; c.el.classList.toggle("on", c.r.checked); });
    P.tabBtns.forEach(function (b) { b.el.classList.toggle("active", b.v === P.prefs.tabs); });
    P.goalsOnly.forEach(function (el) { el.style.display = goals ? "" : "none"; });
    P.notesRow.style.display = goals ? "none" : "";
    P.pageSeg.style.display = goals ? "" : "none";
    P.sub.textContent = goals ? "A4 liggend · klik een vak-tab om die soort doel op deze fiche te verbergen" : "A4 liggend · één pagina per week";
  }
  // Status line over the preview: "Week laden…", or an error with one way out.
  function ppMsg(text, isErr, action) {
    var m = _pp.msg; m.innerHTML = "";
    m.className = "qpp-msg" + (isErr ? " err" : "");
    if (!text) { m.style.display = "none"; return; }
    m.style.display = "";
    m.appendChild(h("span", { text: text }));
    if (action) m.appendChild(h("button", { type: "button", class: "qpp-msg-btn", text: action.label, onclick: action.fn }));
  }
  function printRangeLabel(start, weeks) {
    var a = isoWeekNo(start), b = isoWeekNo(isoDate(addDays(start, (weeks - 1) * 7)));
    return "Week " + a + (b !== a ? " – " + b : "") + " · " + shortRange(0, weeks - 1, start);
  }
  function fitPrintFrame() { var P = _pp; if (P && P.frame.contentDocument) fitPrintDoc(P.frame.contentDocument, P.frame.contentWindow); }
  function renderPrintPreview() {
    var P = _pp; if (!P) return;
    syncPrintControls(); syncPrintNotes();
    if (!P.pv) return;
    var doc = P.frame.contentDocument || (P.frame.contentWindow && P.frame.contentWindow.document); if (!doc) return;
    var goals = P.prefs.mode !== "plain";
    doc.open(); doc.write(goals ? printGoalsDocHtml(P.pv, P.extras, ppOpts(), P.prefs.mode, P.prefs) : printDocHtml(P.pv, P.extras, ppOpts())); doc.close();
    applyPrintPage();
    if (goals) {
      wireGoalsEditor(doc, renderPrintPreview);
      // Goals live in the fiches: read them (max 4 in flight, goal cache first), then paint once more.
      var pv = P.pv;
      loadPrintFicheGoals(pv).then(function (changed) { if (P.pv !== pv) return; if (changed) renderPrintPreview(); else syncPrintWarn(); });
    }
    syncPrintWarn();
    // scale-to-fit after layout settles (two frames)
    requestAnimationFrame(function () { requestAnimationFrame(fitPrintFrame); });
  }
  // Voorkant / Achterkant: on screen show every other page (front = 1st, 3rd…; back = 2nd, 4th…).
  function applyPrintPage() {
    var P = _pp, doc = P.frame.contentDocument; if (!doc || !doc.head) return;
    var goals = P.prefs.mode !== "plain";
    P.pages = doc.querySelectorAll(".psheet-scale").length;
    if (P.pages < 2) P.page = "front";
    var st = doc.getElementById("qpp-page");
    if (!st) { st = doc.createElement("style"); st.id = "qpp-page"; doc.head.appendChild(st); }
    st.textContent = (goals && P.pages > 1) ? ("@media screen { .psheet-scale:nth-of-type(" + (P.page === "back" ? "odd" : "even") + ") { display: none; } }") : "";
    P.pageBtns.forEach(function (b) {
      b.el.classList.toggle("active", b.v === P.page);
      if (b.v === "back") { b.el.disabled = P.pages < 2; b.el.title = P.pages < 2 ? "Deze versie heeft maar één pagina" : ""; }
    });
    requestAnimationFrame(fitPrintFrame);
  }
  // Cards the Lesdoelen print would leave without goals. Own fiches are fixed in the fiche (Lesfiches);
  // a methode card has no fiche of ours, so its goals are typed straight into the preview.
  function printGoalsMissing(pv) {
    var c = { own: 0, meth: 0, loading: 0 };
    ((pv && pv.slots) || []).forEach(function (s) {
      if (s.isFullday || s.idCalendar === "cal_holidays") return;
      var g = goalsStateOf(s);
      if (g === "loading") c.loading++;
      else if (g === "missing") { if (isMethodSlot(s)) c.meth++; else c.own++; }
    });
    return c;
  }
  function syncPrintWarn() {
    var P = _pp, w = P.warn; w.innerHTML = "";
    var c = (P.prefs.mode !== "plain" && P.pv) ? printGoalsMissing(P.pv) : null;
    if (!c || (!c.own && !c.meth && !c.loading)) { w.style.display = "none"; return; }
    w.style.display = "";
    var kids = [];
    if (c.loading) kids.push(h("span", { text: "doelen laden…" }));
    if (c.own) kids.push(h("span", null, [c.own + (c.own === 1 ? " kaart" : " kaarten") + " zonder doelen · ",
      h("a", { href: "#", text: "nu invullen", onclick: function (e) { e.preventDefault(); openGoalsFix(); } })]));
    if (c.meth) kids.push(h("span", { text: c.meth + (c.meth === 1 ? " methodekaart" : " methodekaarten") + " zonder doelen — typ ze in het voorbeeld" }));
    w.appendChild(h("span", { class: "qpp-warn-i", "aria-hidden": "true", text: "!" }));
    w.appendChild(h("span", { class: "qpp-warn-t" }, kids));
  }
  // "nu invullen": goals live in the fiche, so the Lesfiches tab is where they are typed. Without that
  // module, the planner's Doelen mode at least shows which lesuren still miss them.
  function openGoalsFix() {
    if (window.__QWP_LESSONS && window.__QWP_LESSONS.open) { openLesfichesTab(); return; }
    var P = _pp, w = (P.start && view.weekStart) ? Math.round((addDays(P.start, 0) - addDays(view.weekStart, 0)) / 604800000) : -1;
    if (w >= 0 && w < view.weeks) state.doelenWeek = w;
    goTab("plan"); setMainMode("doelen");
    if (w < 0 || w >= view.weeks) setStatus("Doelen toont de weken die in Plannen geladen zijn — de afgedrukte week staat daar niet bij.");
  }
  function syncPrintNotes() {
    var P = _pp, n = stagedCount(), msgs = [];
    var f = P.pv ? P.pv.slots.filter(function (s) { return s._detailFailed; }).length : 0;
    if (n) msgs.push(n + (n === 1 ? " wijziging is" : " wijzigingen zijn") + " nog niet weggeschreven — het voorbeeld toont de planning zoals ze in Questi staat.");
    if (f) msgs.push(f + (f === 1 ? " lesuur kon" : " lesuren konden") + " niet volledig gelezen worden; die staan er met Questi’s lijsttitel.");
    P.staged.textContent = msgs.join(" "); P.staged.style.display = msgs.length ? "" : "none";
  }
  // Other own calendars (e.g. the zorgjuf's), rebuilt per visit — the werkagenda may have changed —
  // keeping whatever was ticked.
  function buildPrintCals() {
    var P = _pp, was = {};
    P.calBoxes.forEach(function (b) { if (b.cb.checked) was[String(b.id)] = true; });
    P.calBoxes = []; P.cals.innerHTML = "";
    var cals = extraPrintCalendars();
    P.cals.style.display = cals.length ? "" : "none";
    if (!cals.length) return;
    P.cals.appendChild(ppLbl("Andere agenda’s meeprinten"));
    cals.forEach(function (c) {
      var cb = h("input", { type: "checkbox", value: String(c.id) });
      cb.checked = !!was[String(c.id)];
      cb.addEventListener("change", refreshPrintExtras);
      P.calBoxes.push({ cb: cb, id: c.id });
      P.cals.appendChild(h("label", { class: "qpp-check" }, [cb, h("span", { class: "qpp-cal-dot", style: "background:" + (c.color || "#888") }), h("span", { text: c.name })]));
    });
  }
  function refreshPrintExtras() {
    var P = _pp, pv = P.pv; if (!pv) return Promise.resolve();
    var ids = P.calBoxes.filter(function (b) { return b.cb.checked; }).map(function (b) { return b.id; });
    return fetchPrintExtras(pv, ids).then(function (ex) { if (P.pv !== pv) return; P.extras = ex; renderPrintPreview(); });
  }
  function loadPrintWeek(start) {
    var P = _pp, gen = ++P.gen;
    P.start = start; P.weeks = Math.max(1, +state.weeks || 1);
    P.range.textContent = printRangeLabel(start, P.weeks);
    ppMsg("Week laden…");
    return (plannerPrintView(start, P.weeks) || fetchPrintView(start, P.weeks)).then(function (pv) {
      if (gen !== P.gen) return;
      P.pv = pv; P.extras = {}; ppMsg("");
      return refreshPrintExtras();
    }).catch(function (e) {
      if (gen !== P.gen) return;
      console.error("[QWP] print:", e);
      ppMsg("Deze week kon niet geladen worden.", true, { label: "Opnieuw", fn: function () { loadPrintWeek(start); } });
    });
  }
  function stepPrintWeek(d) { var P = _pp; if (!P.start) return; loadPrintWeek(isoDate(addDays(P.start, d * 7 * P.weeks))); }
  // Entering the tab: wait for context + tags (plannerReady) and for the planner's own week reads to
  // finish (never two hydrations bursting Questi at once), then load. Follows the planner's week,
  // unless this tab was stepped to another week since the planner last changed its own.
  function enterPrintTab() {
    var P = _pp; if (!P) return;
    syncPrintControls(); syncPrintNotes();
    requestAnimationFrame(fitPrintFrame);
    if (!P.pv) ppMsg("Laden…");
    var prefsP = P.prefsLoaded ? Promise.resolve() : loadPrintPrefs().then(function () { P.prefsLoaded = true; syncPrintControls(); });
    return prefsP.then(plannerReady).then(function () { return view.hydrateP; }).then(function () {
      if (view.tab !== "print") return;
      buildPrintCals();
      var start = (P.start && P.plannerWeek === view.weekStart) ? P.start : (view.weekStart || resolveOpenWeek().start);
      P.plannerWeek = view.weekStart;
      resetPrintFicheGoals();   // goals may have been edited in the manager since the last visit
      return loadPrintWeek(start);
    }, function () {
      ppMsg("Afdrukken kan pas als de planner geladen is.", true, { label: "Naar Plannen", fn: function () { goTab("plan"); } });
    });
  }
  // "Bewaar als PDF" is the same browser print dialog with a pointer to its PDF destination — said
  // out loud rather than pretending to save a file itself.
  function doPrintPanel(pdf) {
    var P = _pp;
    if (!P.pv) { ppMsg("Het voorbeeld is nog niet klaar.", true); return; }
    P.hint.textContent = pdf ? "Kies in het afdrukvenster bij ‘Bestemming’: Opslaan als PDF." : "";
    setTimeout(function () {
      try { fitPrintFrame(); P.frame.contentWindow.focus(); P.frame.contentWindow.print(); }
      catch (e) { ppMsg("Afdrukken mislukt — probeer opnieuw.", true); }
    }, pdf ? 60 : 0);
  }
  // Toolbar "Afdrukken deze week" (window.__QWP_PRINT): the planner, opened on its Afdrukken tab.
  function openPrintTab() {
    if (!els.root) { boot("print"); return; }
    show(); goTab("print");
  }

  // ---------- Timetable (single side-by-side matrix, fits viewport) ----------
  function hhmmToMin(s) { var m = /^(\d{1,2}):(\d{2})/.exec(s || ""); return m ? (+m[1] * 60 + +m[2]) : null; }
  // Derive time rows, per-row end times, and a (day|time) presence set from the
  // live items — nothing about the schedule is hardcoded.
  function computeTimeRows() {
    var r = computeRowsFrom(view.slots);
    view.timeRows = r.timeRows; view.rowMeta = r.rowMeta; view.presence = r.presence;
  }
  // Pauze/speeltijd after row index: a gap between this row's end and the next
  // row's start. Big gap = middagpauze, smaller = speeltijd. No hardcoded clock.
  function breakLabelAfter(idx) {
    var rows = view.timeRows; if (idx >= rows.length - 1) return null;
    var meta = view.rowMeta && view.rowMeta[rows[idx]];
    var end = hhmmToMin(meta && meta.end ? meta.end : rows[idx]);
    var nextStart = hhmmToMin(rows[idx + 1]);
    if (end == null || nextStart == null) return null;
    var gap = nextStart - end;
    if (gap < 10) return null;
    return gap >= 40 ? "middagpauze" : "speeltijd";
  }
  function slotAt(weekIdx, dayIdx, time) {
    // Only a WHOLE-WEEK item belongs to a thema row; a normal lesuur always belongs in the grid,
    // whatever it happens to be called. Testing s.title here made a typed title erase the cell.
    return view.slots.filter(function (s) { return s.weekIdx === weekIdx && s.dayIdx === dayIdx && s.idCalendar !== "cal_holidays" && !s.isFullday && (s.time || (s.starttime ? String(s.starttime).slice(0, 5) : "")) === time; })[0] || null;
  }
  // Whole-week theme slot (WO bucket vs Godsdienst bucket). Only a REAL all-day
  // item counts (is_fullday_item) — the theme rows exist only when Questi actually
  // carries such a multi-day field, never as an empty placeholder.
  // Matched on the STAMPED key, never on the live title — that is the whole fix.
  function weekThemaSlots(weekIdx, key) {
    return view.slots.filter(function (s) {
      return s.weekIdx === weekIdx && s.idCalendar !== "cal_holidays" && s.isFullday && s.themaKey === key;
    });
  }
  function weekThemaSlot(weekIdx, key) { return weekThemaSlots(weekIdx, key)[0] || null; }
  // Every thema row to render, in tag order. One row per distinct key that actually has an item.
  function themaRowKeys() { return themaKeysOf(ensureThemaKeys(view.slots)); }
  // A cell is "geen school" when no item exists for that weekday+time anywhere in
  // the loaded weeks (e.g. a half-day) — distinct from a schedulable empty slot,
  // which has a placeholder item. Data-driven, adapts to any timetable.
  function isNoSchool(dayIdx, timeLabel) {
    if (!/^\d{2}:\d{2}$/.test(timeLabel)) return false;
    if (!view.presence || !Object.keys(view.presence).length) return false;
    return !view.presence[dayIdx + "|" + timeLabel];
  }

  // Full Dutch date label, e.g. "zaterdag 4 juli 2026".
  var DAY_FULL_NL = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
  var MONTH_NL = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
  function fullDateLabel(offsetDays) {
    var d = addDays(view.weekStart, offsetDays); if (!d) return "";
    return DAY_FULL_NL[(d.getDay() + 6) % 7] + " " + d.getDate() + " " + MONTH_NL[d.getMonth()] + " " + d.getFullYear();
  }

  // Both loaded weeks, STACKED: one section per week, each its own 5-day grid. In Doelen mode only
  // one week is expanded (taller cards with goal lines); the other folds into a bar that swaps.
  var DAY_SHORT = ["Ma", "Di", "Wo", "Do", "Vr"];
  function renderTimetable() {
    var wrap = elId("qwp-ttwrap"); if (!wrap) return;
    var keepScroll = wrap.scrollTop;
    wrap.innerHTML = "";
    // Re-run each paint: boot fetches tags and the week in parallel (same reason as ensureThemaKeys).
    applyStoredVakken(view.slots);
    applyThemaLesuurTitles(view.slots);   // follows a themafiche placed/changed on a bar this session
    computeTimeRows();
    renderRange(); syncModeSeg();
    var doel = mainMode() === "doelen";
    wrap.classList.toggle("qwp-doelen", doel);
    var keys = themaRowKeys(), inner = h("div", { class: "qwp-ttinner", id: "qwp-ttinner" });
    wrap.appendChild(inner);
    for (var w = 0; w < view.weeks; w++) {
      if (doel && w !== doelenWeek()) inner.appendChild(weekBar(w));
      else inner.appendChild(weekSection(w, keys, doel));
    }
    fitWeeks();
    wrap.scrollTop = keepScroll;
    renderBalance();
    refreshUndoBtn();
    refreshStaged();
    renderGoalCount();
    refreshPlannedInList();
    if (doel && !hydratePending()) setTimeout(loadDoelenGoals, 0);   // after the item details: one 4-wide stream at a time
  }
  function weekSection(w, keys, doel) {
    var grid = h("div", { class: "qwp-tt qwp-wkgrid" });
    grid.style.gridTemplateColumns = "52px repeat(5, minmax(0, 1fr))";
    grid.appendChild(h("div", { class: "qwp-tt-wklbl", text: "Wk " + weekNoOf(w) }));
    var today = isoDate(new Date());
    for (var d = 0; d < 5; d++) {
      var dt = addDays(view.weekStart, w * 7 + d);
      grid.appendChild(h("div", { class: "qwp-tt-dayhd" + (dt && isoDate(dt) === today ? " today" : ""), title: fullDateLabel(w * 7 + d), text: DAY_SHORT[d] + (dt ? " " + dt.getDate() + "/" + (dt.getMonth() + 1) : "") }));
    }
    // Theme rows: one per whole-week item present in the loaded weeks, labelled by its live tag.
    keys.forEach(function (key) { appendThemaRow(grid, themaLabel(key, view.slots), key, w); });
    // Lesuur rows with pauze/speeltijd gap bands (both derived from live times).
    view.timeRows.forEach(function (t, idx) {
      grid.appendChild(h("div", { class: "qwp-tt-timelbl", text: t }));
      for (var dd = 0; dd < 5; dd++) {
        if (isNoSchool(dd, t)) grid.appendChild(noSchoolCell(dd, w));
        else grid.appendChild(cellFor(slotAt(w, dd, t), w, dd, t, doel));
      }
      var brk = breakLabelAfter(idx);
      if (brk) {
        var band = h("div", { class: "qwp-tt-break" }, [h("span", { text: brk })]);
        band.style.gridColumn = "1 / -1";
        grid.appendChild(band);
      }
    });
    if (!view.timeRows.length) {
      var none = h("div", { class: "qwp-wk-empty", text: "Geen lesuren in deze week." });
      none.style.gridColumn = "1 / -1"; grid.appendChild(none);
    }
    return h("section", { class: "qwp-wk" + (doel ? " doelen" : "") }, [grid]);
  }
  // Doelen mode: the week that is not expanded, as one bar. Clicking swaps the two.
  function weekBar(w) {
    var st = doelenStats(w);
    var sub = shortRange(w, w) + " · " + st.planned + (st.planned === 1 ? " lesuur" : " lesuren") + " gepland" +
      (st.known ? " · " + st.missing + " zonder doelen" : "");
    return h("button", { class: "qwp-wkbar", onclick: function () { state.doelenWeek = w; saveState(); renderTimetable(); } }, [
      h("span", { class: "qwp-wkbar-t", text: "Week " + weekNoOf(w) }),
      h("span", { class: "qwp-wkbar-s", text: sub }),
      h("span", { class: "qwp-spacer" }),
      h("span", { class: "qwp-wkbar-go", text: "Toon deze week ▾" })
    ]);
  }

  function appendThemaRow(grid, label, key, w) {
    // Deliberately EMPTY: the 52px time column. The name lives in the band itself.
    grid.appendChild(h("div", { class: "qwp-tt-themalbl", title: label }));
    var all = weekThemaSlots(w, key), s = all[0];
    var cell;
    if (s) { cell = cellFor(s, w, 0, "thema", false); }
    else { cell = h("div", { class: "qwp-cell empty thema-span", title: label + " — geen item deze week" }, [h("span", { class: "qwp-band-vak", text: label }), h("span", { class: "qwp-cell-empty-hint", text: "—" })]); }
    // Two whole-week items under the same tag in one week is ambiguous — show the first, but
    // say so rather than silently dropping the rest (which is what the old [0] did).
    if (all.length > 1) cell.appendChild(h("span", { class: "qwp-thema-more", title: all.slice(1).map(function (x) { return x.origTitle; }).join(" · "), text: "+" + (all.length - 1) + " meer" }));
    cell.classList.add("thema-span");
    cell.style.gridColumn = "span 5";
    grid.appendChild(cell);
  }

  // No lesson-start here this day → a quiet blank cell (the shared time-axis means
  // a longer block on another day leaves a hole; don't shout "geen school").
  function noSchoolCell(dayIdx, weekIdx) {
    return h("div", { class: "qwp-cell blank" });
  }

  // ---------- Doelen mode (read-only goals per card) ----------
  // One lesuur's goal state: "none" (no own fiche, gym, or every kind hidden → nothing to ask),
  // "loading", "has", "missing". Same sources as the Lesdoelen print (goalsRecFor).
  function goalsStateOf(s) {
    if (!s || s.isFullday || s.isGym || !s.ficheContentId || s.idCalendar === "cal_holidays") return "none";
    var rec = goalsRecFor(goalsKeyFor(s)), hide = rec.hide || {};
    if (GOALS_KINDS.every(function (k) { return hide[k.key]; })) return "none";
    if (GOALS_KINDS.some(function (k) { return rec[k.key]; })) return "has";
    if (isMethodSlot(s)) return "missing";
    var fg = _printFicheGoals[s.ficheContentId];
    return (!fg || fg.src === "loading") ? "loading" : "missing";
  }
  function doelenStats(w) {
    var planned = 0, missing = 0, loading = 0;
    view.slots.forEach(function (s) {
      if (s.weekIdx !== w || s.isFullday || s.idCalendar === "cal_holidays" || isNoSchool(s.dayIdx, s.time)) return;
      if (s.ficheContentId || s.isGym) planned++;
      var g = goalsStateOf(s);
      if (g === "missing") missing++; else if (g === "loading") loading++;
    });
    return { planned: planned, missing: missing, known: loading === 0 };
  }
  function renderGoalCount() {
    var el = elId("qwp-goalcount"); if (!el) return;
    if (mainMode() !== "doelen" || !view.slots.length) { el.style.display = "none"; return; }
    var st = doelenStats(doelenWeek());
    el.style.display = "";
    el.classList.toggle("ok", st.known && !st.missing);
    el.textContent = !st.known ? "Doelen laden…" : (st.missing ? st.missing + (st.missing === 1 ? " lesuur" : " lesuren") + " zonder doelen" : "Alle lesuren hebben doelen");
  }
  // Reads only the expanded week's fiches, through the print's own loader: at most 4 in flight,
  // goal cache first, each fiche version once per session (resetPrintFicheGoals clears it).
  function loadDoelenGoals() {
    if (mainMode() !== "doelen" || !view.slots.length) return;
    var w = doelenWeek();
    loadPrintFicheGoals({ slots: view.slots.filter(function (s) { return s.weekIdx === w; }) })
      .then(function (got) { if (got && mainMode() === "doelen") renderTimetable(); })
      .catch(function (e) { console.warn("[QWP] doelen laden:", e); });
  }
  function goalsBlockFor(s) {
    var gk = goalsKeyFor(s), rec = goalsRecFor(gk), hide = rec.hide || {}, st = goalsStateOf(s);
    var fg = s.ficheContentId ? _printFicheGoals[s.ficheContentId] : null;
    var first = true;
    var kids = GOALS_KINDS.filter(function (k) { return !hide[k.key]; }).map(function (k) {
      var t = rec[k.key] || "", ph = "";
      if (!t && first) ph = st === "loading" ? "doelen laden…" : (st === "missing" ? "nog geen doelen" : "");
      first = false;
      return h("div", { class: "qwp-gl-row" + (t ? "" : " empty") }, [
        h("span", { class: "qwp-gl-k", text: k.label.toUpperCase() }),
        h("span", { class: "qwp-gl-t" + (ph ? " ph" : ""), text: t || ph })
      ]);
    });
    if (fg && fg.src === "newer") kids.push(h("div", { class: "qwp-gl-src", title: "Doelen uit een nieuwere versie van deze fiche — dit lesuur verwijst nog naar de oude versie.", text: "nieuwere versie" }));
    return h("div", { class: "qwp-gl", title: goalsEditableFor(s) ? "Doelen voor een lesuur zonder eigen fiche typ je in Afdrukken → Lesdoelen." : "Doelen bewerk je in Lesfiches → Lesdoelen invullen." }, kids);
  }

  // A targetable slot = an editable, empty (no fiche/gym/thema) lesuur — the only
  // kind you can drop a fiche onto or mark as a mass-add target.
  // A WO/Godsdienst lesuur refers to the week's themafiche by default, but may still receive its
  // own fiche — so themaFiche no longer blocks targeting, and the title is never consulted.
  function isTargetable(s) { return s && s.isEditable && !isUnhydrated(s) && s.idCalendar !== "cal_holidays" && !s.isFullday && !s.ficheContentId && !s.isGym; }
  function isTarget(itemId) { return view.targetSlots.indexOf(itemId) > -1; }
  function toggleTarget(itemId) {
    var i = view.targetSlots.indexOf(itemId);
    if (i > -1) view.targetSlots.splice(i, 1); else view.targetSlots.push(itemId);
    renderTimetable(); updateTargetHint();
  }
  function clearTargets() { view.targetSlots = []; }
  function updateTargetHint() {
    var el = elId("qwp-side-note"); if (!el) return;
    var n = view.targetSlots.length;
    el.textContent = n ? (n + " doel-lesu" + (n === 1 ? "ur" : "ren") + " gekozen — vink fiches aan in de lijst en klik 'Toevoegen aan rooster'.") : "";
  }
  // Drag affordance: highlight every valid empty slot while a card is dragged, and
  // give slots whose Instellingen vak matches the dragged tag a stronger highlight.
  function startDragTargets(tagId) {
    if (!els.root) return;
    els.root.classList.add("qwp-dragging");
    view.dragVakTag = (tagId != null && tagId !== "") ? String(tagId) : null;
    if (view.dragVakTag) {
      Array.prototype.forEach.call(els.root.querySelectorAll(".qwp-cell.slot-empty"), function (c) {
        if (c.getAttribute("data-vak") === view.dragVakTag) c.classList.add("vak-match");
      });
    }
  }
  function endDragTargets() {
    if (!els.root) return;
    els.root.classList.remove("qwp-dragging");
    view.dragVakTag = null;
    Array.prototype.forEach.call(els.root.querySelectorAll(".qwp-cell.vak-match"), function (c) { c.classList.remove("vak-match"); });
  }

  // A lesuur card in the Lesdoelen-print look: a top bar in the vak's own tag colour (auto ink),
  // the title below. Changed = green border + "gewijzigd"; a not-yet-planned lesuur is dashed.
  // `doel` (Doelen mode) adds the WEET/KEN/KAN lines under the title. All interactions — click
  // popup, target toggle, drop, move/swap — are the same in both modes.
  function cellFor(s, weekIdx, dayIdx, timeLabel, doel) {
    if (!s) {
      return h("div", {
        class: "qwp-cell empty",
        title: "Geen lesitem op dit tijdslot",
        onclick: function () { setStatus("Geen lesitem op " + DAY_NAMES[dayIdx] + " " + (timeLabel === "thema" ? "(thema)" : timeLabel) + " in week " + (weekIdx + 1) + " — niets te bewerken."); }
      }, [h("div", { class: "qwp-cell-empty-hint", text: "leeg" })]);
    }
    var dirty = computeDirty(s);
    // Painted from the /cal/items LIST, detail not in yet (or failed): Questi's decorated list title,
    // shown stripped, and no interaction until the stored title/fiche are known.
    var unread = isUnhydrated(s);
    var shownTitle = unread ? stripQuestiDecoration(s.title) : s.title;
    var thema = s.themaFiche || isThemaSlot(s);
    var targetable = isTargetable(s);
    var themaBand = isThemaSlot(s);
    // "Planned" decides the solid vs dashed look only: a fiche, gym, or a real (typed/thema) title.
    var planned = !!(s.ficheContentId || s.isGym || themaBand || (s.title && !isLesuurPlaceholder(s.title)));
    var cls = "qwp-cell";
    if (view.selectedSlotId === s.itemId) cls += " sel";
    if (dirty) cls += " dirty";
    if (s.origFicheContentId) cls += " hasexisting";
    if (s.isGym) cls += " isgym";
    if (thema) cls += " isthema";
    if (targetable) cls += " slot-empty";
    if (targetable && isTarget(s.itemId)) cls += " target";
    if (!planned) cls += " unplanned";
    if (s._pending) cls += " loading"; else if (s._detailFailed) cls += " loadfail";
    var gstate = (doel && !themaBand) ? goalsStateOf(s) : "none";
    if (gstate === "missing") cls += " nogoals";

    // Vak = the slot's live top-level tag (what the description will say); a band shows its thema tag.
    var top = topTagIdOf(themaBand ? s.themaTagId : s.vak);
    var vakLbl = top != null ? ((anyTagTitle(top) || "").trim()) : (s.vak ? ((tagTitle("self", s.vak) || "").trim()) : "");
    var color = top != null ? anyTagColor(top) : null;
    var themaUntagged = themaBand && !vakLbl;
    // The fiche belongs to another vak than this lesuur — say so instead of showing the wrong subject.
    var mism = vakMismatch(s);
    if (mism) cls += " vakmismatch";
    var mark = dirty ? h("span", { class: "qwp-cell-mark", title: "Nog niet weggeschreven — zie Controleer", text: "gewijzigd" }) : null;
    if (unread) mark = s._pending
      ? h("span", { class: "qwp-cell-load", title: "Titel, omschrijving en fiche van dit lesuur worden nog gelezen", text: "laden…" })
      : h("button", { class: "qwp-cell-load fail", type: "button", title: "Dit lesuur kon niet gelezen worden en blijft ongewijzigd — klik om opnieuw te proberen", text: "niet geladen · opnieuw",
          onclick: function (e) { e.stopPropagation(); e.preventDefault(); retryFailedDetails([s]); } });
    var warn = mism ? h("span", {
      class: "qwp-vakwarn",
      title: "Fiche hoort bij " + (mism.ficheVak || "?") + " · dit lesuur staat ingesteld als " + (mism.slotVak || "?"),
      text: "≠ " + (mism.ficheVak || "?")
    }) : null;

    // Targetable empty slot: single click toggles it as a mass-add target;
    // double click opens the popup. Filled/gym/thema: single click opens popup.
    var onclick = targetable ? function () { toggleTarget(s.itemId); } : function () { openSlotPopup(s); };
    var ondbl = targetable ? function () { openSlotPopup(s); } : null;
    if (unread) {
      onclick = function () { setStatus(s._pending ? "Dit lesuur wordt nog geladen — even geduld." : "Dit lesuur kon niet gelezen worden en blijft ongewijzigd. Vernieuwen (Alles) probeert opnieuw."); };
      ondbl = null;
    }

    var kids;
    if (themaBand) {
      var dot = h("span", { class: "qwp-band-dot" }); if (color) dot.style.background = color;
      kids = [
        dot,
        h("span", { class: "qwp-band-vak", text: vakLbl }),
        themaUntagged ? h("span", { class: "qwp-thema-untagged", title: "Klik deze balk en kies een Vak om de rij te benoemen.", text: "geen vaktag" }) : null,
        h("span", { class: "qwp-band-t", text: stripQuestiDecoration(stripThemaPrefix(shownTitle) || shownTitle) || "(leeg)" }),
        mark
      ];
    } else {
      var bar = h("div", { class: "qwp-cell-bar" }, [
        h("span", { class: "qwp-cell-vak", text: vakLbl || (s.isGym ? "Gym" : "") }),
        warn, mark
      ]);
      if (planned && color) { bar.style.background = color; bar.style.color = goalsInkOn(color); }
      // Second line: what the old (hidden) fiche line said, only when it adds something.
      var sub = (!planned && targetable) ? "sleep een fiche"
        : themaShowsLiteral(s) ? "Zie themafiche."
        : (!s.ficheContentId && !s.isGym && s.origFicheTitle) ? ("was: " + s.origFicheTitle)
        : (s.ficheContentId && s.ficheTitle && normTitle(stripThemaPrefix(s.ficheTitle)) !== normTitle(s.title)) ? ("fiche: " + stripThemaPrefix(s.ficheTitle))
        : "";
      kids = [
        bar,
        h("div", { class: "qwp-cell-body" }, [
          h("div", { class: "qwp-cell-title", text: shownTitle || "(leeg)" }),
          sub ? h("div", { class: "qwp-cell-sub", text: sub }) : null
        ]),
        (doel && planned) ? goalsBlockFor(s) : null
      ];
    }

    var cell = h("div", {
      class: cls, title: targetable ? "Klik = doel voor 'Toevoegen aan rooster' · dubbelklik = handmatig kiezen" : (shownTitle || ""),
      "data-vak": (state.settings[slotKeyStd(s.dayIdx, s.time)] || ""),
      onclick: onclick, ondblclick: ondbl,
      ondragover: function (e) { e.preventDefault(); cell.classList.add("drop"); },
      ondragleave: function () { cell.classList.remove("drop"); },
      ondrop: function (e) {
        e.preventDefault(); cell.classList.remove("drop"); endDragTargets();
        if (unread) { onclick(); return; }   // same reason as a click
        try {
          var dd = JSON.parse(e.dataTransfer.getData("text/plain"));
          if (dd && dd.kind === "slot") {
            var src = slotById(dd.itemId); if (!src || src === s) return;
            pushUndo("lesuur verplaatsen"); moveOrSwap(src, s);
          } else {
            pushUndo("fiche slepen"); assignFiche(s, { id: dd.id, subject: dd.subject || dd.title, isMethod: dd.isMethod }); if (dd.tagId != null) s.vak = dd.tagId;
            syncFicheVakken([s]);
          }
          renderTimetable();
        } catch (err) {}
      }
    }, kids);
    if (themaBand) cell.classList.add("thema-span");
    // Filled (non-thema) slots are draggable → move/swap onto another slot.
    var movable = !!(s.ficheContentId || s.isGym) && !thema;
    if (movable) {
      cell.setAttribute("draggable", "true");
      cell.classList.add("movable");
      cell.ondragstart = function (e) { e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "slot", itemId: s.itemId })); startDragTargets(s.vak ? (+s.vak) : null); };
      cell.ondragend = function () { endDragTargets(); };
    }
    return cell;
  }

  // Assigning a fiche fully replaces the lesson: the slot title BECOMES the fiche
  // title (so a drop/replace visibly + on-commit renames the lesuur).
  // A whole-week thema item KEEPS themaFiche when it receives a fiche — its description must
  // stay "Zie themafiche." (brief.md). Clearing it made descFor write the vak tag name instead,
  // and since neither re-detection rule fires afterwards the flag never came back.
  function isThemaSlot(s) { return !!(s && s.isFullday && s.themaKey); }
  // A newly placed fiche brings its own vak, so any earlier manual vak override no longer applies.
  function assignFiche(slot, f) { setSlotVakOverride(slot, null); slot.autoThemaTitle = false; var t = f.subject || f.title || ""; slot.ficheContentId = f.id; slot.ficheTitle = t; slot.ficheIsMethod = !!(f.__method || f.isMethod); if (t) slot.title = t; slot.isGym = false; slot.themaFiche = isThemaSlot(slot); }
  // Move / swap a fiche between two slots (drag one filled cell onto another) — the
  // title (and methode-flag) travels with the fiche.
  function slotPayload(s) { return { title: s.title, ficheContentId: s.ficheContentId, ficheTitle: s.ficheTitle, ficheIsMethod: s.ficheIsMethod, isGym: s.isGym, vak: s.vak }; }
  function applySlotPayload(s, p) { s.title = p.title; s.ficheContentId = p.ficheContentId; s.ficheTitle = p.ficheTitle; s.ficheIsMethod = p.ficheIsMethod; s.isGym = p.isGym; s.themaFiche = isThemaSlot(s); s.vak = p.vak; }
  // Restoring a thema slot: its vak is the thema tag, never state.settings — full-day items all
  // share the settings key "<day>|" (no start time), so WO and Godsdienst would collide there.
  function clearSlotContent(s) { setSlotVakOverride(s, null); s.autoThemaTitle = false; s.title = s.origTitle; s.ficheContentId = null; s.ficheTitle = ""; s.ficheIsMethod = false; s.isGym = false; s.vak = isThemaSlot(s) ? (s.themaTagId || "") : (state.settings[slotKeyStd(s.dayIdx, s.time)] || ""); s.themaFiche = isThemaSlot(s) || (!s.isFullday && isThemaVak(s.vak)); }
  // Fully empty a slot: drop the fiche AND wipe title/description (commit writes it blank).
  function emptySlot(s) { setSlotVakOverride(s, null); s.title = ""; s.description = ""; s.ficheContentId = null; s.ficheTitle = ""; s.ficheIsMethod = false; s.isGym = false; s.themaFiche = false; s.vak = ""; }
  function moveOrSwap(src, dst) {
    var a = slotPayload(src), b = slotPayload(dst);
    var dstFilled = !!(dst.ficheContentId || dst.isGym);
    applySlotPayload(dst, a);
    if (dstFilled) applySlotPayload(src, b); else clearSlotContent(src);
  }

  // ---------- Slot popup ----------
  function openSlotPopup(s) {
    view.selectedSlotId = s.itemId; renderTimetable();
    var old = elId("qwp-modal"); if (old) old.remove();

    // Vak dropdown = the user's LIVE top tags (server-side fetch by tag), so the
    // search only ever shows fiches actually under that tag — no title-regex leak.
    var tops = panelTopTags("self");
    // s.vak holds a live top-tag id; if unset, no vak is pre-selected (no title-guessing —
    // the vak must come from a real tag pick so the written description stays authoritative).
    var curTagId = (s.vak ? (+s.vak) : null);
    // A slot whose tag is no longer ticked as vak keeps it as an option, so opening the popup never
    // silently changes its vak.
    if (curTagId != null && !tops.some(function (t) { return String(t.id) === String(curTagId); })) {
      var curTag = anyTagById(curTagId); if (curTag) tops = tops.concat([curTag]);
    }
    var vakSel = h("select", { class: "qwp-input", id: "qwp-pop-vak" },
      [h("option", { value: "", text: "— kies vak —" })].concat(tops.map(function (t) { return h("option", { value: t.id, text: (t.title || "").trim(), selected: (String(curTagId) === String(t.id) ? "selected" : null) }); })));
    var searchInp = h("input", { class: "qwp-input", id: "qwp-pop-search", placeholder: "Zoek in eigen lesfiches…", value: (s.ficheTitle || "") });

    // Editable title — for things that must be planned in but need no fiche (toets, uitstap).
    // computeDirty/buildCommitPlan/doCommit already handle a title-only change: it becomes a single
    // PATCH with no attachment. `title` is in the undo snapshot, so Ctrl+Z works for free.
    var titleOrig = s.title || "";
    var titleInp = h("input", { class: "qwp-input", id: "qwp-pop-title", placeholder: "Titel van dit lesuur", value: titleOrig });
    var titleNote = h("div", { class: "qwp-pop-note" });
    function refreshTitleNote() {
      // Questi's attachment POST answers with its OWN decorated fiche title, and doCommit adopts
      // it — so on a slot WITH a fiche a hand-typed title does not survive the write. Say so
      // rather than let it silently vanish.
      var hasFiche = !s.isGym && !!s.ficheContentId;
      titleNote.textContent = hasFiche
        ? "Let op: deze les heeft een lesfiche — bij het wegschrijven zet Questi de fichetitel terug."
        : "";
      titleNote.style.display = hasFiche ? "" : "none";
    }
    var titleDirty = false;
    function applyTitle() {
      var nv = titleInp.value;
      if (nv === (s.title || "")) return;
      if (!titleDirty) { pushUndo("titel"); titleDirty = true; }
      s.title = nv; s.autoThemaTitle = false;   // typed by the teacher → never auto-replaced
      refreshLoRow();
      renderTimetable();
    }
    titleInp.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") { applyTitle(); titleInp.blur(); }
      else if (e.key === "Escape") { titleInp.value = titleOrig; applyTitle(); titleInp.blur(); }
    });
    titleInp.addEventListener("blur", applyTitle);

    var loRow = h("div", { class: "qwp-lorow" });
    var results = h("div", { class: "qwp-results", id: "qwp-pop-results" });
    var gymChk = h("input", { type: "checkbox" }); if (s.isGym) gymChk.checked = true;

    // A gym lesuur is "title only, no fiche", so its title IS the lesson. Offer both titles as one
    // click instead of retyping them weekly. Declared AFTER gymChk, which setLoTitle touches.
    function setLoTitle(t) {
      if (!titleDirty) { pushUndo("lesuur titel"); titleDirty = true; }
      s.title = t; titleInp.value = t; titleOrig = t;   // keep Escape from reverting behind us
      refreshTitleNote(); refreshLoRow(); renderTimetable();
    }
    function refreshLoRow() {
      loRow.innerHTML = "";
      // Any gym slot, including one Questi already flagged by its title at hydrate.
      if (!s.isGym || s.isFullday) { loRow.style.display = "none"; return; }
      loRow.style.display = "";
      LO_TITLES.forEach(function (t) {
        loRow.appendChild(h("button", {
          class: "qwp-lobtn" + ((s.title || "") === t ? " on" : ""),
          text: t, onclick: function () { setLoTitle(t); }
        }));
      });
    }

    function renderResults() {
      results.innerHTML = "";
      var noVak = (curTagId == null);
      // No vak → search the full own library (loaded via tag 5); else the tag's fiches.
      var items = (noVak ? ((groupFor(myId()) || { items: [] }).items || []) : (view.ficheCache[cacheKey("self", curTagId)] || [])).slice();
      var term = searchInp.value.trim().toLowerCase();
      if (noVak && !term) { results.appendChild(h("div", { class: "qwp-result", text: "Typ om in al je lesfiches te zoeken, of kies een vak." })); return; }
      if (term) items = items.filter(function (f) { return (f.subject || "").toLowerCase().indexOf(term) > -1; });
      items.sort(function (a, b) { return (a.subject || "").localeCompare(b.subject || "", undefined, { numeric: true }); });
      items.slice(0, 300).forEach(function (f) {
        results.appendChild(h("div", {
          class: "qwp-result", onclick: function () {
            pushUndo("fiche toewijzen"); assignFiche(s, f); s.vak = (curTagId != null ? curTagId : (s.vak || ""));
            syncFicheVakken([s]);
            searchInp.value = f.subject || "";
            // assignFiche rewrote the title — keep the visible field truthful.
            titleInp.value = s.title || ""; titleOrig = s.title || ""; titleDirty = false; refreshTitleNote();
            renderTimetable(); setStatus("Toegewezen: " + (f.subject || ""));
          }
        }, [h("span", { class: "qwp-result-t", text: f.subject || "(zonder titel)" }), usedChip(f)]));
      });
      if (!items.length) results.appendChild(h("div", { class: "qwp-result", text: noVak ? "Geen fiches gevonden." : "Geen fiches in dit vak." }));
    }
    function refresh() {
      if (curTagId == null) { renderResults(); return; }
      if (view.ficheCache[cacheKey("self", curTagId)]) { renderResults(); return; }
      results.innerHTML = ""; results.appendChild(h("div", { class: "qwp-result", text: "Laden…" }));
      ensureFiches("self", curTagId).then(renderResults);
    }
    vakSel.onchange = function () {
      curTagId = vakSel.value ? (+vakSel.value) : null;
      s.vak = curTagId != null ? curTagId : "";
      // On a whole-week item the Vak dropdown names the THEMA: it labels the row straight away,
      // is remembered locally (so it survives a reload), and becomes the "<Thema> — " title
      // prefix on the next commit.
      if (s.isFullday) {
        setThemaVakOverride(s, curTagId);
        s.themaTagId = curTagId;
        s.themaFiche = true;                       // a whole-week band always writes "Zie themafiche."
        ensureThemaKeys(view.slots);
        renderTimetable();
      } else {
        s.themaFiche = isThemaVak(curTagId);
        // A deliberate vak for THIS lesuur (e.g. WO and Godsdienst swapped this week): keep it across
        // reloads, with or without a fiche. Placing a fiche afterwards clears it (assignFiche).
        setSlotVakOverride(s, curTagId);
        // Tagging a lesuur as Lichamelijke opvoeding titles it — it needs no fiche, so the title
        // IS the lesson. Defaults to the first of LO_TITLES; the buttons switch to Zwemmen.
      }
      refresh();
    };
    searchInp.oninput = renderResults;
    refreshTitleNote(); refreshLoRow();
    // Remembered so unticking undoes exactly what ticking did. Blanking outright would commit the
    // "Lesuur" fallback (Questi rejects an empty title) and silently rename e.g. "M3".
    var titleBeforeGym = null;
    gymChk.onchange = function () {
      pushUndo("gym");
      s.isGym = gymChk.checked;
      if (s.isGym) {
        s.ficheContentId = null; s.ficheTitle = ""; searchInp.value = "";
        if (LO_TITLES.indexOf(s.title || "") < 0) { titleBeforeGym = s.title || ""; setLoTitle(LO_TITLES[0]); }
      } else if (LO_TITLES.indexOf(s.title || "") > -1) {
        // Only take back a title WE wrote; anything hand-typed stays.
        s.title = titleBeforeGym != null ? titleBeforeGym : "";
        titleInp.value = s.title; titleOrig = s.title; titleBeforeGym = null;
      }
      refreshTitleNote(); refreshLoRow(); renderTimetable();
    };

    var modal = h("div", { class: "qwp-modal", id: "qwp-modal" }, [
      h("div", { class: "qwp-modal-box" }, [
        h("div", { class: "qwp-modal-hd", text: (s.title || "Lesuur") + " · " + DAY_NAMES[s.dayIdx] + " " + (s.time || "") + " · week " + (s.weekIdx + 1) }),
        h("div", { class: "qwp-modal-body" }, [
          h("div", { class: "qwp-field" }, [h("label", { text: "Titel" }), titleInp, loRow, titleNote]),
          h("div", { class: "qwp-field" }, [h("label", { text: "Vak" }), vakSel]),
          h("div", { class: "qwp-field" }, [h("label", { text: "Lesfiche (titel / zoeken)" }), searchInp]),
          h("div", { class: "qwp-field" }, [results]),
          h("div", { class: "qwp-field" }, [h("label", { class: "qwp-check" }, [gymChk, h("span", { text: "Lichamelijke opvoeding / zwemmen (enkel titel, geen fiche)" })])])
        ]),
        h("div", { class: "qwp-modal-ft" }, [
          h("button", { class: "qwp-btn qwp-ghost", text: "Leegmaken", title: "Verwijder fiche + titel + omschrijving", onclick: function () { pushUndo("lesuur leegmaken"); emptySlot(s); modal.remove(); renderTimetable(); } }),
          h("button", { class: "qwp-btn", text: "Klaar", onclick: function () { modal.remove(); renderTimetable(); } })
        ])
      ])
    ]);
    els.page.appendChild(modal);
    setTimeout(function () { searchInp.focus(); }, 0);
    refresh();
  }

  // ---------- Bottom filter panels (1-3, list/card, real-tag pills) ----------
  function ownTagsList() { return _ownTagsCache || []; }
  function sharedTagsList() { return _sharedTagsCache || []; }
  function tagPoolFor(source) { return isOwnSource(source) ? ownTagsList() : sharedTagsList(); }
  // A colleague's own top "Alle" tag (for their /lessons fetch); 8 = last resort.
  function colleagueDefaultTag(ownerId) { var t = topTagsForOwner(sharedTagsList(), ownerId); return t.length ? t[0].id : ALL_FICHES_TAG; }
  // Own top tags that count as vakken (Instellingen → Vakken: state.vakTags, null = all) in legend
  // order (state.vakOrder, rest as topTagsForOwner sorts). Used wherever the user PICKS a vak or
  // browses by vak. Resolving an existing slot's vak still accepts any top tag, so a lesuur that was
  // given a tag before it was un-ticked keeps it (the vak popup adds it back as an option).
  // Questi's own buckets ("Alle eigen lesfiches", "Zonder tag", …) are never a vak.
  function isSubjectTag(t) { return !!t && t.type !== "default" && !/alle.*lesfiches/i.test(t.title || ""); }
  function vakTops() {
    var tops = (topTagsForOwner(ownTagsList(), ctx.ownerId) || []).filter(isSubjectTag), list = state.vakTags, order = state.vakOrder || [];
    if (Array.isArray(list)) tops = tops.filter(function (t) { return list.some(function (x) { return String(x) === String(t.id); }); });
    function rank(t) { for (var i = 0; i < order.length; i++) if (String(order[i]) === String(t.id)) return i; return 1e6; }
    return tops.map(function (t, i) { return { t: t, i: i }; })
      .sort(function (a, b) { return (rank(a.t) - rank(b.t)) || (a.i - b.i); })
      .map(function (x) { return x.t; });
  }
  function panelTopTags(source) {
    if (isOwnSource(source)) return vakTops();
    var t = topTagsForOwner(sharedTagsList(), source);
    // Universal "Alle" fallback for a colleague with no own top tag exposed.
    if (!t.length) t = [{ id: ALL_FICHES_TAG, title: "Alle lesfiches", type: "default", parent: 0 }];
    return t;
  }
  function childTags(parentId, source) {
    return tagPoolFor(source).filter(function (t) { return String(t.parent) === String(parentId); })
      .sort(function (a, b) { return (a.title || "").trim().localeCompare((b.title || "").trim(), undefined, { numeric: true }); });
  }
  function tagTitle(source, tagId) { var p = tagPoolFor(source); for (var i = 0; i < p.length; i++) if (String(p[i].id) === String(tagId)) return p[i].title; return ""; }
  // Questi tag color (hex) — used for drawer accent, pill dots, modal subject dots.
  function tagColor(source, tagId) { var p = tagPoolFor(source); for (var i = 0; i < p.length; i++) if (String(p[i].id) === String(tagId)) return p[i].color || null; return null; }
  // Owner-agnostic tag lookups over the COMBINED pool (own + all colleagues). Used where a slot's
  // vak may be a colleague's tag id (a colleague fiche planned into your agenda) — the written
  // description must still name the vak. Tag ids are globally unique DB keys, so concat is safe.
  function anyTagsList() { return ownTagsList().concat(sharedTagsList()); }
  function anyTagById(id) { var p = anyTagsList(); for (var i = 0; i < p.length; i++) if (String(p[i].id) === String(id)) return p[i]; return null; }
  function anyTagTitle(id) { var t = anyTagById(id); return t ? (t.title || "") : ""; }
  function anyTagColor(id) { var t = anyTagById(id); return t ? (t.color || null) : null; }
  function defaultTopTagId(source) { var t = panelTopTags(source); return t.length ? t[0].id : null; }

  // ---------- Global cross-owner search bar ----------
  function buildGlobalSearch() {
    return h("div", { class: "qwp-gsearch", id: "qwp-globalsearch" }, [
      h("input", { class: "qwp-gsearch-inp", id: "qwp-gsearch-inp", placeholder: "Zoek in alle lesfiches (ik + collega's)…", oninput: runGlobalSearch }),
      h("select", { class: "qwp-select qwp-gsearch-owner", id: "qwp-gsearch-owner", onchange: runGlobalSearch }),
      h("span", { class: "qwp-gsearch-hint", text: "sleep resultaat op een lesuur" }),
      h("div", { class: "qwp-gsearch-results", id: "qwp-gsearch-results" })
    ]);
  }
  function renderGlobalOwners() {
    var sel = elId("qwp-gsearch-owner"); if (!sel) return;
    var cur = sel.value || "all"; sel.innerHTML = "";
    sel.appendChild(h("option", { value: "all", text: "Iedereen" }));
    sel.appendChild(h("option", { value: String(myId()), text: "Ik" }));
    state.colleagues.forEach(function (c) { sel.appendChild(h("option", { value: String(c.id), text: ownerName(c.id) })); });
    sel.value = cur;
  }
  // Full fiche list per owner, fetched once on demand and cached.
  function ensureAllFiches(ownerId) {
    var key = String(ownerId);
    if (view.allByOwner[key]) return Promise.resolve(view.allByOwner[key]);
    return fetchAllFiches(ownerId).then(function (r) { view.allByOwner[key] = r.items; return r.items; });
  }
  function closeGlobalResults() { var r = elId("qwp-gsearch-results"); if (r) { r.innerHTML = ""; r.classList.remove("open"); } }
  function runGlobalSearch() {
    var inp = elId("qwp-gsearch-inp"), res = elId("qwp-gsearch-results"); if (!inp || !res) return;
    var term = inp.value.trim().toLowerCase();
    if (term.length < 2) { closeGlobalResults(); return; }
    var ownerSel = (elId("qwp-gsearch-owner") || {}).value || "all";
    var owners = [];
    if (ownerSel === "all" || ownerSel === String(myId())) owners.push(myId());
    state.colleagues.forEach(function (c) { if (ownerSel === "all" || ownerSel === String(c.id)) owners.push(c.id); });
    res.classList.add("open"); res.innerHTML = ""; res.appendChild(h("div", { class: "qwp-gsearch-msg", text: "Zoeken…" }));
    Promise.all(owners.map(ensureAllFiches)).then(function (lists) {
      // Guard against a stale async result if the term changed meanwhile.
      if (inp.value.trim().toLowerCase() !== term) return;
      var rows = [];
      owners.forEach(function (oid, i) { (lists[i] || []).forEach(function (f) { if ((f.subject || "").toLowerCase().indexOf(term) > -1) rows.push({ f: f, owner: oid }); }); });
      rows.sort(function (a, b) { return (a.f.subject || "").localeCompare(b.f.subject || "", undefined, { numeric: true }); });
      res.innerHTML = "";
      if (!rows.length) { res.appendChild(h("div", { class: "qwp-gsearch-msg", text: "Geen resultaten." })); return; }
      rows.slice(0, 60).forEach(function (r) {
        // Global search spans all vakken/owners → no single reliable tag; leave the vak unset
        // (the target slot keeps its Instellingen-preset vak, if any). No title-guessing.
        var pickData = { id: r.f.id, subject: r.f.subject, tagId: null, owner: r.owner, isMethod: !!r.f.__method };
        var row = h("div", {
          class: "qwp-gsearch-row", draggable: "true", title: r.f.subject || "",
          ondragstart: function (e) { e.dataTransfer.setData("text/plain", JSON.stringify(pickData)); startDragTargets(pickData.tagId); },
          ondragend: function () { endDragTargets(); },
          onclick: function () { assignFromGlobal(r.f); }
        }, [
          h("span", { class: "qwp-gsearch-t", text: r.f.subject || "(zonder titel)" }),
          (r.f.__method || view.methodFicheIds[String(r.f.id)]) ? h("span", { class: "qwp-mbadge", text: "methode" }) : null,
          h("span", { class: "qwp-gsearch-badge" + ((r.f.__method || view.methodFicheIds[String(r.f.id)]) ? " method" : ""), text: ownerName(r.owner) })
        ]);
        res.appendChild(row);
      });
      if (rows.length > 60) res.appendChild(h("div", { class: "qwp-gsearch-msg", text: rows.length + " resultaten — verfijn je zoekterm (eerste 60 getoond)." }));
    }).catch(function () { res.innerHTML = ""; res.appendChild(h("div", { class: "qwp-gsearch-msg", text: "Zoeken mislukt." })); });
  }
  function assignFromGlobal(f) {
    var s = view.selectedSlotId ? slotById(view.selectedSlotId) : null;
    if (!s || !isTargetable(s)) { setStatus("Sleep de fiche op een leeg lesuur (of open eerst een lesuur)."); return; }
    pushUndo("fiche toewijzen (zoek)");
    assignFiche(s, { id: f.id, subject: f.subject, isMethod: !!f.__method });
    // Global search has no reliable tag (no title-guess): keep the preset vak until the fiche's own
    // tags have been read, then follow those.
    renderTimetable(); setStatus("Toegewezen: " + (f.subject || ""));
    syncFicheVakken([s]);
  }

  // ---------- Sidebar fiche list (was: 1-3 bottom filter panels) ----------
  // One list now, driven by panel 0's state (view.panels[0] / state.panels[0]) so every existing
  // panel helper — vak toggle, subtags, union fetch, grade filter, mass-add — keeps working as is.
  function renderPanel(pi) { renderVakToggle(pi); renderSource(pi); renderSubcats(pi); applyPanelAccent(pi); loadAndRenderList(pi); }
  function renderAllPanels() { renderPanel(0); }

  // Tint the drawer with the active vak's tag color.
  function applyPanelAccent(pi) {
    var el = elId("qwp-picker-" + pi); if (!el) return;
    var p = view.panels[pi]; var c = tagColor(p.source, p.filterVak);
    el.style.setProperty("--vak-accent", c || "var(--line)");
  }
  // Vak filter: a two-column grid of equal tiles (colour bar + name). For your own fiches an
  // "Alle vakken" tile on top browses Questi's own all-fiches bucket; which tags show is chosen in
  // Instellingen → Vakken ("Tonen"), linked right under the grid with the number hidden.
  function capFirst(t) { t = (t || "").trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
  // Short label for a vak: the user's own (state.vakAbbr[id], Instellingen → Vakken) or a default
  // from a small table of common Flemish vakken, else the first three letters in capitals.
  var VAK_ABBR_DEFAULT = [
    [/^wereld/i, "WO"], [/^wisk|^reken/i, "WIS"], [/^nederl|^taal/i, "TAAL"], [/^spel/i, "SPE"], [/^schrift|^schrijf/i, "SCHR"],
    [/^godsd|^rk|^religie/i, "GOD"], [/^lichamelijk|^lo$|^gym|^bewegings/i, "LO"], [/^muzi|^muvo|^muzo/i, "MUVO"], [/^frans/i, "FR"],
    [/^engels/i, "EN"], [/^media/i, "MED"], [/^lezen/i, "LEZ"], [/^zwem/i, "ZWEM"], [/^techniek/i, "TECH"], [/^verkeer/i, "VERK"]
  ];
  function vakAbbr(t) {
    if (!t) return "";
    var own = state.vakAbbr && state.vakAbbr[String(t.id)]; if (own) return own;
    var title = (t.title || "").trim();
    for (var i = 0; i < VAK_ABBR_DEFAULT.length; i++) if (VAK_ABBR_DEFAULT[i][0].test(title)) return VAK_ABBR_DEFAULT[i][1];
    return title.length <= 4 ? title.toUpperCase() : title.slice(0, 3).toUpperCase();
  }
  // How the vak picker looks (state.vakView): "tiles" (default, 2 columns, full names), "compact"
  // (small chips with abbreviations, full name on hover) or "select" (one dropdown).
  function vakView() { var v = state.vakView; return v === "compact" || v === "select" ? v : "tiles"; }
  function setVakView(v) { state.vakView = v; saveState(); renderVakToggle(0); }
  function renderVakToggle(pi) {
    var wrap = elId("qwp-vaktoggle-" + pi); if (!wrap) return; wrap.innerHTML = "";
    var p = view.panels[pi], own = isOwnSource(p.source);
    var tops = panelTopTags(p.source);
    var allId = own && ctx.ownDefaultTagId != null ? ctx.ownDefaultTagId : null;
    if (p.filterVak == null) {
      var first = allId != null ? allId : (tops.length ? tops[0].id : null);
      if (first != null) { p.filterVak = first; p.filterTagId = first; p.unionMode = true; }
    }
    function pick(id) {
      p.filterVak = id; p.filterTagId = id; p.unionMode = true; p.autoBlock = true; state.panels[pi].filterVak = id; saveState();
      renderVakToggle(pi); renderSubcats(pi); applyPanelAccent(pi); loadAndRenderList(pi);
    }
    function tile(id, label, color, extra) {
      var on = String(p.filterVak) === String(id);
      var b = h("button", { class: "qwp-vakbtn" + (on ? " active" : "") + (extra || ""), type: "button", "aria-pressed": on ? "true" : "false", title: label, onclick: function () { pick(id); } },
        [h("span", { class: "qwp-vakname", text: label })]);
      // The tag colour IS the tile: full border, filled when chosen (ink picked for contrast).
      if (color) {
        b.style.borderColor = color;
        if (on) { b.style.background = color; b.style.color = goalsInkOn(color); }
      }
      return b;
    }
    var mode = vakView();
    wrap.className = "qwp-vaktoggle qwp-plan-only vv-" + mode;
    var ab = elId("qwp-allbtn-" + pi);
    if (ab) {
      ab.style.display = allId != null ? "" : "none";
      var allOn = allId != null && String(p.filterVak) === String(allId);
      ab.classList.toggle("active", allOn); ab.setAttribute("aria-pressed", allOn ? "true" : "false");
      ab.onclick = function () { if (allId != null) pick(allId); };
    }
    if (mode === "select") {
      var sel = h("select", { class: "qwp-fsel qwp-vaksel", "aria-label": "Vak" },
        (allId != null ? [h("option", { value: String(allId), text: "Alle vakken" })] : []).concat(tops.map(function (t) { return h("option", { value: String(t.id), text: capFirst(t.title) }); })));
      sel.value = p.filterVak != null ? String(p.filterVak) : "";
      sel.addEventListener("change", function () { pick(sel.value); });
      var cur = tops.filter(function (t) { return String(t.id) === String(p.filterVak); })[0];
      var swatch = h("span", { class: "qwp-vaksw" }); if (cur && cur.color) swatch.style.background = cur.color;
      wrap.appendChild(h("div", { class: "qwp-vakselrow" }, [swatch, sel]));
    } else {
      tops.forEach(function (t) {
        var b = tile(t.id, mode === "compact" ? vakAbbr(t) : capFirst(t.title), t.color, "");
        if (mode === "compact") b.title = capFirst(t.title);
        wrap.appendChild(b);
      });
    }
    // View (Tegels · Compact · Lijst) and which tags show are chosen in Instellingen → Vakken.
  }
  // "Ik | Collega ▾": Ik = own fiches; the second half names the chosen colleague/methode and
  // opens a menu of the owners picked under Alles (state.colleagues, methodes included).
  function renderSource(pi) {
    var wrap = elId("qwp-source-" + pi); if (!wrap) return; wrap.innerHTML = "";
    var p = view.panels[pi], mine = isOwnSource(p.source);
    wrap.appendChild(h("button", { class: mine ? "active" : "", text: "Ik", onclick: function () { if (!mine) setPanelSource(pi, myId()); } }));
    var other = h("button", { class: "qwp-owner-other" + (mine ? "" : " active"), "data-menu": "qwp-srcmenu", title: "Lesfiches van een collega of methode", onclick: function (e) { openSourceMenu(pi, e.currentTarget); } }, [
      h("span", { class: "qwp-owner-name", text: mine ? "Collega" : ownerName(p.source) }), h("span", { text: " ▾" })
    ]);
    wrap.appendChild(other);
  }
  function setPanelSource(pi, v) {
    var p = view.panels[pi]; p.source = v; state.panels[pi].source = v;
    p.filterVak = defaultTopTagId(v); p.filterTagId = p.filterVak; p.unionMode = true; state.panels[pi].filterVak = p.filterVak; saveState();
    renderPanel(pi);
  }
  // Tag with a slash: "fiches with no subtag".
  function NOTAG_ICON() {
    var sp = h("span", { class: "qwp-notag" });
    sp.innerHTML = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.2"/><path d="M3 21 21 3"/></svg>';
    return sp;
  }
  function renderSubcats(pi) {
    var wrap = elId("qwp-subcats-" + pi); if (!wrap) return; wrap.innerHTML = "";
    var p = view.panels[pi];
    var subs = childTags(p.filterVak, p.source);
    if (!subs.length) { p.unionMode = false; p.filterTagId = p.filterVak; return; }
    // "Alle" = union (parent + all children); "Geen subtag" = parent-only; then each child.
    wrap.appendChild(h("button", { class: "qwp-subchip" + (p.unionMode ? " active" : ""), onclick: function () { p.unionMode = true; renderSubcats(pi); loadAndRenderList(pi); }, text: "Alle" }));
    wrap.appendChild(h("button", { class: "qwp-subchip" + ((!p.unionMode && String(p.filterTagId) === String(p.filterVak)) ? " active" : ""), onclick: function () { p.unionMode = false; p.filterTagId = p.filterVak; renderSubcats(pi); loadAndRenderList(pi); }, title: "Zonder subtag", "aria-label": "Zonder subtag" }, [NOTAG_ICON()]));
    subs.forEach(function (t) { wrap.appendChild(h("button", { class: "qwp-subchip" + ((!p.unionMode && String(p.filterTagId) === String(t.id)) ? " active" : ""), onclick: function () { p.unionMode = false; p.filterTagId = t.id; renderSubcats(pi); loadAndRenderList(pi); }, text: (t.title || "").trim() })); });
  }
  // Ensure the (source, tag) fiches are fetched, then render — with a loading state.
  function loadAndRenderList(pi) {
    var p = view.panels[pi];
    if (p.filterVak == null) { renderPickList(pi); return; }
    function ready() { if (p.autoBlock) { p.autoBlock = false; autoPickBlock(pi); } renderPickList(pi); }
    if (view.ficheCache[panelCacheKey(p)]) { ready(); return; }
    p.loading = true; renderPickList(pi);
    var prom = p.unionMode
      ? ensureFichesUnion(p.source, p.filterVak, childTags(p.filterVak, p.source).map(function (t) { return t.id; }))
      : ensureFiches(p.source, p.filterTagId);
    prom.then(function () { p.loading = false; ready(); });
  }
  // Right after a vak is picked: open on the subtag where you ARE in the methode. That is the
  // subtag of the most recently touched fiche — planned in the loaded weeks beats any use, else the
  // latest last_used_date within this school year — since lessons get skipped, "first block with
  // something left" would land too early. If that subtag has nothing open (unused and unplanned),
  // the next subtag in order that does is chosen; with nothing used yet, the first open one. The
  // chosen chip shows it and the status line says why; "Alle" brings back the whole vak. Uses the
  // lists the union load already cached — no requests.
  function autoPickBlock(pi) {
    var p = view.panels[pi]; if (!p.unionMode) return;
    var kids = childTags(p.filterVak, p.source); if (!kids.length) return;
    var planned = plannedFicheDates();
    function lists(k) { return view.ficheCache[cacheKey(p.source, k.id)] || []; }
    function isOpen(f) { var c = ficheDateInfo(f, planned).cls; return c === "never" || c === "old"; }
    // Recency key: "2" + date for planned, "1" + date for used this school year, "" otherwise.
    function touched(f) {
      var pd = planned[String(f.id)]; if (pd) return "2" + pd;
      return usedThisYear(f) ? "1" + String(f.last_used_date).slice(0, 10) : "";
    }
    var latestIdx = -1, latestKey = "";
    kids.forEach(function (k, i) {
      lists(k).forEach(function (f) { var t = touched(f); if (t && t > latestKey) { latestKey = t; latestIdx = i; } });
    });
    var start = latestIdx < 0 ? 0 : latestIdx;
    for (var i = start; i < kids.length; i++) {
      if (!lists(kids[i]).some(isOpen)) continue;
      p.unionMode = false; p.filterTagId = kids[i].id;
      renderSubcats(pi);
      var name = (kids[i].title || "").trim();
      setStatus("“" + name + "” gekozen: " + (latestIdx < 0 ? "hier begint het vak" : (i === latestIdx ? "hier gaf je het laatst les" : "het blok na waar je het laatst les gaf")) + ". Kies ‘Alle’ voor het hele vak.");
      return;
    }
  }
  function ficheGrades(f) { var g = f && f.grades; return Array.isArray(g) ? g : []; }
  function panelGradeOptions(pi) {
    var p = view.panels[pi];
    var set = {};
    (view.ficheCache[panelCacheKey(p)] || []).forEach(function (f) { ficheGrades(f).forEach(function (g) { if (g) set[g] = true; }); });
    return Object.keys(set).sort();
  }
  function renderGradeSelect(pi) {
    var sel = elId("qwp-grade-" + pi); if (!sel) return;
    var p = view.panels[pi], opts = panelGradeOptions(pi);
    sel.innerHTML = "";
    sel.appendChild(h("option", { value: "", text: "Alle leerjaren", selected: (p.gradeFilter ? null : "selected") }));
    opts.forEach(function (g) { sel.appendChild(h("option", { value: g, text: g, selected: (p.gradeFilter === g ? "selected" : null) })); });
  }
  function pickListItems(pi) {
    var p = view.panels[pi];
    var items = (view.ficheCache[panelCacheKey(p)] || []).slice();
    if (p.hideUsed) items = items.filter(function (f) { return !usedThisYear(f); });
    if (p.gradeFilter) items = items.filter(function (f) { return ficheGrades(f).indexOf(p.gradeFilter) > -1; });
    var term = p.search.trim().toLowerCase();
    if (term) items = items.filter(function (f) { return (f.subject || "").toLowerCase().indexOf(term) > -1; });
    items.sort(function (a, b) { var r = (a.subject || "").localeCompare(b.subject || "", undefined, { numeric: true }); return p.sortDir === "az" ? r : -r; });
    return items;
  }
  // Fiche id → first date it is planned in the loaded weeks (current, staged state included).
  // Matched on the fiche id only: a lesuur planned with an older version of an edited fiche does
  // not show as "gepland" here — never a title guess.
  function plannedFicheDates() {
    var m = {};
    view.slots.forEach(function (s) {
      if (!s.ficheContentId || s.isGym || s.idCalendar === "cal_holidays") return;
      var k = String(s.ficheContentId), d = String(s.startdate || "").slice(0, 10);
      if (!m[k] || d < m[k]) m[k] = d;
    });
    return m;
  }
  var _plannedSig = "";
  function plannedSig(m) { return Object.keys(m).sort().join(","); }
  // Repaint the list only when the set of planned fiches changed (every grid paint asks).
  function refreshPlannedInList() { if (plannedSig(plannedFicheDates()) !== _plannedSig) renderPickList(0); }
  function dm(iso) { var d = addDays(iso, 0); return d ? d.getDate() + "/" + (d.getMonth() + 1) : ""; }
  // Right-hand date of a list row: planned in these weeks → green; used this school year → muted ✓;
  // used before → plain date; never → "nooit". A bare year (Questi sometimes sends one) shows as is.
  function ficheDateInfo(f, planned) {
    var pd = planned[String(f.id)];
    if (pd) return { text: dm(pd) + " gepland", cls: "plan", title: "Gepland in de geladen weken" };
    var raw = f.last_used_date, s = String(raw == null ? "" : raw);
    if (!raw || s.indexOf("0000") === 0) return { text: "nooit", cls: "never", title: "Nog nooit gebruikt" };
    if (/^\d{4}$/.test(s)) return { text: "—", cls: "old", title: "Niet dit schooljaar (laatst in " + s + ")" };
    var dt = new Date(s.replace(" ", "T")); if (isNaN(dt.getTime())) return { text: "?", cls: "never", title: "Onbekende datum: " + s };
    var iso = s.slice(0, 10), full = iso.split("-").reverse().join("/");
    if (usedThisYear(f)) return { text: dm(iso) + " ✓", cls: "used", title: "Gebruikt dit schooljaar op " + full };
    // Only this school year counts as "used"; an older date is shown on hover only.
    return { text: "—", cls: "old", title: "Niet dit schooljaar (laatst op " + full + ")" };
  }
  // No header line above the list (space): the count lives in the search field's placeholder.
  function renderListHead(pi, n) {
    var el = elId("qwp-search-" + pi); if (!el) return;
    el.placeholder = n != null ? "Zoek in " + n + " fiche" + (n === 1 ? "" : "s") + "…" : "Zoek…";
  }
  function syncFilterControls(pi) {
    var p = view.panels[pi];
    var so = elId("qwp-sort-" + pi); if (so) so.value = p.sortDir === "za" ? "za" : "az";
    var hu = elId("qwp-hideused-" + pi); if (hu) hu.checked = !!p.hideUsed;
    renderGradeSelect(pi);
    applyFilterFold();
  }
  function renderPickList(pi) {
    var p = view.panels[pi];
    syncFilterControls(pi);
    var list = elId("qwp-picker-list-" + pi); if (!list) return;
    var keep = list.scrollTop;
    list.innerHTML = "";
    var planned = plannedFicheDates(); _plannedSig = plannedSig(planned);
    if (p.loading) { renderListHead(pi, null); list.appendChild(h("div", { class: "qwp-empty", text: "Laden…" })); updatePickCount(pi); return; }
    var items = pickListItems(pi);
    renderListHead(pi, items.length);
    if (!items.length) {
      list.appendChild(h("div", { class: "qwp-empty", text: (filterActive(p) || (p.search && p.search.trim())) ? "Geen lesfiches voor dit filter of deze zoekterm." : "Geen lesfiches in dit vak." }));
      updatePickCount(pi); return;
    }
    var col = tagColor(p.source, p.filterVak);
    items.forEach(function (f) {
      var chk = h("input", { type: "checkbox", title: "Aanvinken om meerdere fiches tegelijk in te plannen" }); if (p.picked[f.id]) chk.checked = true;
      var pickData = { id: f.id, subject: f.subject, tagId: p.filterVak, color: col, isMethod: !!f.__method };
      var di = ficheDateInfo(f, planned);
      var isMeth = !!(f.__method || view.methodFicheIds[String(f.id)]);
      var sq = h("span", { class: "qwp-pfiche-sq" }); if (col) sq.style.background = col;
      var row = h("label", {
        class: "qwp-pfiche d-" + di.cls + (p.picked[f.id] ? " picked" : ""), draggable: "true", title: (f.subject || "") + " — sleep op een lesuur",
        ondragstart: function (e) { e.dataTransfer.setData("text/plain", JSON.stringify(pickData)); startDragTargets(pickData.tagId); },
        ondragend: function () { endDragTargets(); }
      }, [
        h("span", { class: "qwp-pfiche-pick" }, [sq, chk]),
        h("span", { class: "qwp-pfiche-main" }, [
          h("span", { class: "qwp-pfiche-t", text: f.subject || "(zonder titel)" }),
          isMeth ? h("span", { class: "qwp-pfiche-sub" }, [h("span", { class: "qwp-mbadge", text: "methode" })]) : null
        ]),
        h("span", { class: "qwp-pfiche-date", title: di.title || null, text: di.text })
      ]);
      chk.onchange = function () { if (chk.checked) { p.picked[f.id] = pickData; } else { delete p.picked[f.id]; } row.classList.toggle("picked", chk.checked); updatePickCount(pi); };
      list.appendChild(row);
    });
    list.scrollTop = keep;
    updatePickCount(pi);
  }
  function updatePickCount(pi) {
    var n = Object.keys(view.panels[pi].picked).length;
    var el = elId("qwp-pick-count-" + pi); if (el) el.textContent = n + " geselecteerd";
    var bar = elId("qwp-selbar"); if (bar) bar.style.display = n ? "" : "none";
    var list = elId("qwp-picker-list-" + pi); if (list) list.classList.toggle("picking", n > 0);
  }

  // ---------- Mass-add (per panel) ----------
  // vakTagId here is a live top-tag id (matches the Instellingen slot→tag map).
  function emptySlotsForVak(vakTagIdArg) {
    return view.slots.filter(function (s) {
      if (!s.isEditable || s.idCalendar === "cal_holidays" || isUnhydrated(s)) return false;
      if (s.ficheContentId || s.isGym) return false;
      if (isNoSchool(s.dayIdx, s.time)) return false;
      var stdVak = state.settings[slotKeyStd(s.dayIdx, s.time)];
      return stdVak ? String(stdVak) === String(vakTagIdArg) : true;
    }).sort(function (a, b) { return (a.weekIdx - b.weekIdx) || (a.dayIdx - b.dayIdx) || String(a.time).localeCompare(String(b.time)); });
  }
  function allEmptySlots() {
    return view.slots.filter(function (s) { return s.isEditable && !isUnhydrated(s) && s.idCalendar !== "cal_holidays" && !s.isFullday && !s.ficheContentId && !s.isGym && !isNoSchool(s.dayIdx, s.time); })
      .sort(function (a, b) { return (a.weekIdx - b.weekIdx) || (a.dayIdx - b.dayIdx) || String(a.time).localeCompare(String(b.time)); });
  }
  function slotLabel(s) { return "(wk " + (s.weekIdx + 1) + ") - " + DAY_NAMES[s.dayIdx].toLowerCase() + " - " + (s.time || ""); }

  function slotById(itemId) { return view.slots.filter(function (x) { return x.itemId === itemId; })[0] || null; }
  // Ordered pool of empty slots to auto-assign into: user-chosen targets first
  // (in click order), then Instellingen-vak matches, then chronological empties.
  function targetPool(pickTagId) {
    var seen = {}, pool = [];
    view.targetSlots.forEach(function (id) { var s = slotById(id); if (s && isTargetable(s) && !seen[id]) { seen[id] = true; pool.push(s); } });
    emptySlotsForVak(pickTagId).forEach(function (s) { if (!seen[s.itemId]) { seen[s.itemId] = true; pool.push(s); } });
    allEmptySlots().forEach(function (s) { if (!seen[s.itemId]) { seen[s.itemId] = true; pool.push(s); } });
    return pool;
  }

  function openMassAdd(pi) {
    if (busyLoading()) return;
    var picks = Object.keys(view.panels[pi].picked).map(function (k) { return view.panels[pi].picked[k]; });
    if (!picks.length) { setStatus("Niets aangevinkt in de lijst."); return; }
    var old = elId("qwp-modal"); if (old) old.remove();
    var usingTargets = view.targetSlots.length > 0;

    var taken = {}, assign = [];
    picks.forEach(function (p) {
      var pool = targetPool(p.tagId), chosen = null;
      for (var i = 0; i < pool.length; i++) { if (!taken[pool[i].itemId]) { chosen = pool[i]; break; } }
      if (chosen) taken[chosen.itemId] = true;
      assign.push({ pick: p, slotId: chosen ? chosen.itemId : null });
    });

    var body = h("div", { class: "qwp-modal-body" });
    var addBtn;
    function slotOptions(currentId) {
      var opts = [h("option", { value: "", text: "— geen slot —", selected: (currentId ? null : "selected") })];
      allEmptySlots().forEach(function (s) {
        if (taken[s.itemId] && s.itemId !== currentId) return;
        opts.push(h("option", { value: s.itemId, text: slotLabel(s), selected: (s.itemId === currentId ? "selected" : null) }));
      });
      return opts;
    }
    // Duplicate-slot ids (two rows → same slot) for conflict highlighting.
    function dupeSlotIds() {
      var count = {}, dupes = {};
      assign.forEach(function (a) { if (a.slotId) count[a.slotId] = (count[a.slotId] || 0) + 1; });
      Object.keys(count).forEach(function (k) { if (count[k] > 1) dupes[k] = true; });
      return dupes;
    }
    function refreshState() {
      var dupes = dupeSlotIds();
      var miss = assign.filter(function (a) { return !a.slotId; }).length;
      var hasDupe = Object.keys(dupes).length > 0;
      Array.prototype.forEach.call(body.querySelectorAll(".qwp-ma-row"), function (row, idx) {
        var a = assign[idx]; if (!a) return;
        var sel = row.querySelector(".qwp-ma-slot");
        if (sel) sel.classList.toggle("dupe", !!(a.slotId && dupes[a.slotId]));
        row.classList.toggle("missing", !a.slotId);
      });
      if (addBtn) { addBtn.disabled = hasDupe; addBtn.classList.toggle("qwp-disabled", hasDupe); }
      var w = elId("qwp-ma-warn");
      if (w) w.textContent = hasDupe ? "Twee lessen wijzen naar hetzelfde lesuur (rood) — los op om te bewaren."
        : (miss ? (miss + " les(sen) hebben geen leeg lesuur gevonden.") : "");
    }
    function subjectDot(a) { var d = h("span", { class: "qwp-ma-dot" }); if (a.pick.color) d.style.background = a.pick.color; return d; }
    function rowFor(a, idx) {
      var sel = h("select", { class: "qwp-select qwp-ma-slot" }, slotOptions(a.slotId));
      sel.onchange = function () { if (a.slotId) delete taken[a.slotId]; a.slotId = sel.value ? (+sel.value) : null; if (a.slotId) taken[a.slotId] = true; refreshState(); };
      var grip = h("span", { class: "qwp-ma-grip", title: "Sleep om te herschikken", text: "⋮⋮" });
      var row = h("div", { class: "qwp-ma-row", draggable: "true", "data-idx": idx }, [
        subjectDot(a),
        h("span", { class: "qwp-ma-fiche", title: a.pick.subject || "", text: a.pick.subject || "" }),
        h("span", { class: "qwp-ma-arrow", text: "naar" }),
        sel,
        grip,
        h("button", { class: "qwp-ma-x", title: "Verwijderen", onclick: function (ev) { ev.preventDefault(); if (a.slotId) delete taken[a.slotId]; assign = assign.filter(function (x) { return x !== a; }); rebuild(); }, text: "Verwijderen" })
      ]);
      // Drag-to-swap: reorder rows, then re-assign slots chronologically by new order.
      row.ondragstart = function (e) { e.dataTransfer.setData("text/plain", "row:" + idx); row.classList.add("dragging"); };
      row.ondragover = function (e) { e.preventDefault(); };
      row.ondragend = function () { row.classList.remove("dragging"); };
      row.ondrop = function (e) {
        e.preventDefault(); var d = String(e.dataTransfer.getData("text/plain") || ""); if (d.indexOf("row:") !== 0) return;
        var from = +d.slice(4); if (from === idx) return;
        var moved = assign.splice(from, 1)[0]; assign.splice(idx, 0, moved);
        reassignChronologically(); rebuild();
      };
      return row;
    }
    // After a reorder, hand out the currently-used slots in chronological order.
    function reassignChronologically() {
      var slots = assign.map(function (a) { return a.slotId; }).filter(Boolean).map(slotById).filter(Boolean)
        .sort(function (a, b) { return (a.weekIdx - b.weekIdx) || (a.dayIdx - b.dayIdx) || String(a.time).localeCompare(String(b.time)); });
      taken = {};
      assign.forEach(function (a, i) { var s = slots[i]; a.slotId = s ? s.itemId : null; if (a.slotId) taken[a.slotId] = true; });
    }
    function rebuild() {
      body.innerHTML = "";
      body.appendChild(h("p", { class: "qwp-note", text: usingTargets ? "Gekozen doel-lesuren worden op volgorde gevuld. Sleep rijen (⋮⋮) om te herschikken." : "Elke les krijgt een leeg lesuur (voorkeur: vak uit Instellingen). Sleep rijen (⋮⋮) om te herschikken." }));
      assign.forEach(function (a, i) { body.appendChild(rowFor(a, i)); });
      body.appendChild(h("p", { class: "qwp-ma-warn", id: "qwp-ma-warn" }));
      refreshState();
    }
    rebuild();

    addBtn = h("button", {
      class: "qwp-btn qwp-approve", text: "Toevoegen aan rooster", onclick: function () {
        if (addBtn.disabled) return;
        pushUndo("selectie toevoegen");
        var snapshot = [], done = 0;
        assign.forEach(function (a) {
          if (!a.slotId) return; var s = slotById(a.slotId); if (!s) return;
          snapshot.push({ itemId: s.itemId, title: s.title, ficheContentId: s.ficheContentId, ficheTitle: s.ficheTitle, ficheIsMethod: s.ficheIsMethod, isGym: s.isGym, themaFiche: s.themaFiche, vak: s.vak });
          assignFiche(s, { id: a.pick.id, subject: a.pick.subject, isMethod: a.pick.isMethod }); if (a.pick.tagId != null) s.vak = a.pick.tagId; done++;
        });
        view.panels[pi].picked = {}; clearTargets(); modal.remove(); renderTimetable(); renderPickList(pi); updatePickCount(pi);
        syncFicheVakken(snapshot.map(function (o) { return slotById(o.itemId); }).filter(Boolean));
        setStatus(done + " les(sen) in het rooster gezet (nog niet weggeschreven).");
        showToast(done + " les(sen) toegevoegd.", "Ongedaan maken", function () {
          snapshot.forEach(function (o) { var s = slotById(o.itemId); if (s) { s.title = o.title; s.ficheContentId = o.ficheContentId; s.ficheTitle = o.ficheTitle; s.ficheIsMethod = o.ficheIsMethod; s.isGym = o.isGym; s.themaFiche = o.themaFiche; s.vak = o.vak; } });
          renderTimetable(); setStatus("Toevoeging ongedaan gemaakt.");
        });
      }
    });

    var modal = h("div", { class: "qwp-modal", id: "qwp-modal" }, [
      h("div", { class: "qwp-modal-box wide qwp-ma-modal" }, [
        h("div", { class: "qwp-modal-hd", text: "Selectie toevoegen — " + picks.length + " les(sen)" + (usingTargets ? " → " + view.targetSlots.length + " doel(en)" : "") }),
        body,
        h("div", { class: "qwp-modal-ft" }, [
          h("button", { class: "qwp-btn qwp-ghost", text: "Annuleren", onclick: function () { modal.remove(); } }),
          addBtn
        ])
      ])
    ]);
    els.page.appendChild(modal);
  }

  // ---------- Toast ----------
  function showToast(msg, actionLabel, onAction) {
    var old = elId("qwp-toast"); if (old) old.remove();
    var timer = null;
    function close() { if (timer) clearTimeout(timer); var t = elId("qwp-toast"); if (t) t.remove(); }
    var toast = h("div", { class: "qwp-toast", id: "qwp-toast" }, [
      h("span", { class: "qwp-toast-msg", text: msg }),
      (actionLabel && onAction) ? h("button", { class: "qwp-toast-act", text: actionLabel, onclick: function () { onAction(); close(); } }) : null,
      h("button", { class: "qwp-toast-x", title: "Sluiten", text: "×", onclick: close })
    ]);
    els.page.appendChild(toast);
    timer = setTimeout(close, 8000);
  }

  // ---------- Update banner (compares installed version to repo version.json) ----------
  // Numeric-part compare: >0 if a is newer than b. Non-numeric parts count as 0.
  function cmpVersion(a, b) {
    var pa = String(a || "0").split("."), pb = String(b || "0").split(".");
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10) || 0, nb = parseInt(pb[i], 10) || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  }
  function showUpdateBanner(url) {
    if (elId("qwp-banner")) return;
    var banner = h("div", { class: "qwp-banner", id: "qwp-banner" }, [
      h("span", { text: "Nieuwe versie van de Questi Weekplanner beschikbaar — " }),
      h("a", { class: "qwp-banner-link", href: url || "#", target: "_blank", rel: "noopener", text: "download hier" }),
      h("button", { class: "qwp-banner-x", title: "Verbergen", text: "×", onclick: function () { banner.remove(); } })
    ]);
    els.page.insertBefore(banner, els.page.firstChild);
  }
  // Ask the service worker (which can fetch GitHub cleanly) for the latest version.
  // Fully best-effort: any error → no banner, boot is never blocked.
  function checkForUpdate() {
    try {
      if (!(chrome && chrome.runtime && chrome.runtime.sendMessage)) return;
      var installed = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "0";
      chrome.runtime.sendMessage({ type: "QWP_CHECK_VERSION" }, function (resp) {
        void chrome.runtime.lastError;
        if (resp && resp.ok && cmpVersion(resp.latest, installed) > 0) showUpdateBanner(resp.url);
      });
    } catch (e) { /* never block boot on the update check */ }
  }

  // ---------- Undo (per-slot snapshot stack; Ctrl+Z + sidebar button) ----------
  // Only these slot fields are mutated by planning actions, so snapshot just them.
  function snapshotSlots() {
    return view.slots.map(function (s) { return { itemId: s.itemId, unread: isUnhydrated(s), title: s.title, ficheContentId: s.ficheContentId, ficheTitle: s.ficheTitle, ficheIsMethod: s.ficheIsMethod, isGym: s.isGym, themaFiche: s.themaFiche, vak: s.vak }; });
  }
  function pushUndo(label) {
    view.undoStack.push({ label: label || "actie", snap: snapshotSlots() });
    if (view.undoStack.length > 30) view.undoStack.shift();
    refreshUndoBtn();
  }
  function doUndo() {
    if (!view.undoStack.length) { setStatus("Niets om ongedaan te maken."); return; }
    var entry = view.undoStack.pop();
    // A slot that was still unread when the snapshot was taken held LIST values — never restore those.
    entry.snap.forEach(function (o) { var s = slotById(o.itemId); if (s && !o.unread) { s.title = o.title; s.ficheContentId = o.ficheContentId; s.ficheTitle = o.ficheTitle; s.ficheIsMethod = o.ficheIsMethod; s.isGym = o.isGym; s.themaFiche = o.themaFiche; s.vak = o.vak; } });
    renderTimetable(); refreshUndoBtn(); setStatus("Ongedaan: " + entry.label);
  }
  function refreshUndoBtn() {
    var b = elId("qwp-undo"); if (!b) return;
    var n = view.undoStack.length;
    b.classList.toggle("qwp-disabled", n === 0);
    b.textContent = n ? ("Ongedaan maken (" + n + ")") : "Ongedaan maken";
  }

  // ---------- Blocking commit overlay (prevents edits mid-write) ----------
  function showCommitOverlay(total) {
    hideCommitOverlay();
    var bar = h("div", { class: "qwp-progress-fill", id: "qwp-commit-bar" });
    var lbl = h("div", { class: "qwp-commit-count", id: "qwp-commit-count", text: "0 / " + total });
    var ov = h("div", { class: "qwp-commit-overlay", id: "qwp-commit-overlay" }, [
      h("div", { class: "qwp-commit-card" }, [
        h("div", { class: "qwp-spinner" }),
        h("div", { class: "qwp-commit-msg", id: "qwp-commit-msg", text: "Bezig met wegschrijven — even geduld, niet bewerken. Herhalende lesuren kunnen traag zijn." }),
        h("div", { class: "qwp-progress" }, [bar]),
        lbl
      ])
    ]);
    // Swallow every interaction while writing (capture phase) — BUT never swallow clicks
    // on the result buttons (e.g. "Sluiten"), or a failed commit would lock the UI.
    ["click", "mousedown", "keydown", "wheel", "dragstart"].forEach(function (ev) {
      ov.addEventListener(ev, function (e) {
        if (e.target && e.target.closest && e.target.closest(".qwp-commit-card button")) return;
        e.stopPropagation(); if (ev === "keydown" || ev === "dragstart") e.preventDefault();
      }, true);
    });
    els.page.appendChild(ov);
    updateCommitOverlay(0, total);
  }
  function updateCommitOverlay(done, total) {
    var bar = elId("qwp-commit-bar"), cnt = elId("qwp-commit-count");
    var pct = total ? Math.round((done / total) * 100) : 0;
    if (bar) bar.style.width = pct + "%";
    if (cnt) cnt.textContent = done + " / " + total;
  }
  function commitOverlayResult(ok, fails) {
    var ov = elId("qwp-commit-overlay"); if (!ov) return;
    var msg = elId("qwp-commit-msg"); if (msg) { msg.textContent = ok + " weggeschreven, " + fails.length + " mislukt. Eerste fout: " + fails[0].error; msg.classList.add("err"); }
    var card = ov.querySelector(".qwp-commit-card"); var sp = ov.querySelector(".qwp-spinner"); if (sp) sp.style.display = "none";
    if (card) card.appendChild(h("button", { class: "qwp-btn", text: "Sluiten", onclick: hideCommitOverlay }));
  }
  function hideCommitOverlay() { var ov = elId("qwp-commit-overlay"); if (ov) ov.remove(); }

  // ---------- Diagnose / Zelftest (READ-ONLY — never writes, never mutates state) ----------
  var TOOL_VERSION = "qwp-2026-07-04";
  // Known-good write shapes captured from a real successful write (blueprint scrape).
  var REF_PATCH_KEYS = ["calendarId", "title", "description", "is_fullday_item", "startdate", "enddate", "starttime", "endtime", "is_published_students", "is_published_parents", "groups", "participants"];
  var REF_ATTACH_KEYS = ["schoolId", "visible_parents", "visible_students", "students", "groups", "id", "typeId"];
  function keyDiff(actual, ref) {
    var a = actual.slice().sort(), r = ref.slice().sort();
    var missing = r.filter(function (k) { return a.indexOf(k) < 0; });
    var extra = a.filter(function (k) { return r.indexOf(k) < 0; });
    return { missing: missing, extra: extra, ok: !missing.length && !extra.length };
  }
  // Read-only GET that reports transport-level facts (auth/HTML redirect).
  function diagGet(path) {
    return fetch(path, { credentials: "include", headers: { "Accept": "application/json" } }).then(function (r) {
      var ct = r.headers.get("content-type") || "";
      if (ct.indexOf("json") < 0) return { status: r.status, json: null, html: true };
      return r.json().then(function (j) { return { status: r.status, json: j, html: false }; }).catch(function () { return { status: r.status, json: null, html: false }; });
    });
  }
  function diagArr(res) { var j = res.json; var a = j && (j.result || j); return Array.isArray(a) ? a : []; }
  function has(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null; }

  function openDiagnose() {
    var old = elId("qwp-modal"); if (old) old.remove();
    var list = h("div", { class: "qwp-diag-list", id: "qwp-diag-list" });
    var rows = [];
    var STAT = { OK: "OK", WARN: "WARN", FAIL: "FAIL", SKIP: "SKIP" };
    function statusPill(s) { return h("span", { class: "qwp-diag-pill " + s.toLowerCase(), text: s }); }
    function rowEl(row) {
      return h("div", { class: "qwp-diag-row" }, [
        h("div", { class: "qwp-diag-row-hd" }, [statusPill(row.status), h("span", { class: "qwp-diag-name", text: row.name })]),
        (row.expected || row.found) ? h("div", { class: "qwp-diag-detail", text: "verwacht: " + (row.expected || "—") + "  ·  gevonden: " + (row.found || "—") }) : null,
        (row.status !== STAT.OK && row.next) ? h("div", { class: "qwp-diag-next", text: "→ " + row.next }) : null
      ]);
    }
    function addRow(row) { rows.push(row); list.appendChild(rowEl(row)); list.scrollTop = list.scrollHeight; }
    var omitChk = h("input", { type: "checkbox" });

    var modal = h("div", { class: "qwp-modal", id: "qwp-modal" }, [
      h("div", { class: "qwp-modal-box wide qwp-diag-modal" }, [
        h("div", { class: "qwp-modal-hd", text: "Zelftest — leest alleen, schrijft nooit" }),
        h("div", { class: "qwp-modal-body" }, [
          h("p", { class: "qwp-note", text: "Controleert of de live Questi-API nog overeenkomt met wat de tool verwacht. Elke regel: OK / WARN / FAIL met een concrete volgende stap." }),
          list
        ]),
        h("div", { class: "qwp-modal-ft" }, [
          // "Opslaan als .json": one file with rows + ctx + settings + recent errors, built by
          // settings.js (it owns the settings export). Never cookies, xsrf token or session.
          h("label", { class: "qwp-note", style: "margin-right:auto;display:inline-flex;align-items:center;gap:6px", title: "Laat namen van lesfiches en lesuren weg uit het .json-bestand" }, [omitChk, h("span", { text: "titels van lesfiches weglaten" })]),
          h("button", { class: "qwp-btn qwp-ghost", text: "Opslaan als .json", onclick: function () {
            if (window.__UQ_SETTINGS && window.__UQ_SETTINGS.saveDebugJson) window.__UQ_SETTINGS.saveDebugJson(rows, { omitTitles: omitChk.checked, toolVersion: TOOL_VERSION });
            else setStatus("Opslaan als .json kan niet: de instellingen-module (settings.js) is niet geladen.");
          } }),
          h("button", { class: "qwp-btn qwp-ghost", text: "Rapport kopiëren", onclick: function () { copyDiagReport(rows); } }),
          h("button", { class: "qwp-btn", text: "Sluiten", onclick: function () { modal.remove(); } })
        ])
      ])
    ]);
    els.page.appendChild(modal);
    runDiagnostics(addRow, STAT);
  }

  function copyDiagReport(rows) {
    var lines = ["Questi Week Planner — Zelftest", TOOL_VERSION, new Date().toString(), ""];
    rows.forEach(function (r) { lines.push("[" + r.status + "] " + r.name + (r.expected || r.found ? " — verwacht: " + (r.expected || "—") + " / gevonden: " + (r.found || "—") : "") + (r.status !== "OK" && r.next ? " — " + r.next : "")); });
    var text = lines.join("\n");
    function fallback() { var ta = document.createElement("textarea"); ta.value = text; els.page.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) {} ta.remove(); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { setStatus("Rapport gekopieerd."); }, fallback); else { fallback(); setStatus("Rapport gekopieerd."); }
  }

  // Sequentially run each check thunk, streaming its row(s) as it resolves.
  function runDiagnostics(addRow, STAT) {
    function wrap(name, group, fn) {
      return function () {
        return Promise.resolve().then(fn).then(function (row) { row.name = "[" + group + "] " + name; if (!row.status) row.status = STAT.OK; addRow(row); return row; })
          .catch(function (e) { addRow({ name: "[" + group + "] " + name, status: STAT.FAIL, found: String(e && e.message || e), next: "onverwachte fout — zie console" }); });
      };
    }
    // Test the week the planner has loaded (the viewed week) so the read-contract check hits a real
    // lesson; fall back to today's week when run before any load.
    var wr = view.weekStart ? { start: view.weekStart, end: isoDate(addDays(view.weekStart, 7 * (view.weeks || 1) - 1)) } : thisWeekRange();
    var cal = ctx.calendarId ? [ctx.calendarId, "cal_holidays"] : null;
    var itemsUrl = API + "/items?" + qs({ schoolId: ctx.schoolId, startdate: wr.start, enddate: wr.end, calendars: cal || undefined });
    var shared = { authed: false, items: null, sampleItem: null, detail: null };

    var checks = [];
    // 1. Auth & connectivity
    checks.push(wrap("Sessie / verbinding", "auth", function () {
      return diagGet(API_ROOT + "/schools").then(function (res) {
        if (res.html || res.status === 401 || res.status === 403) return { status: STAT.FAIL, expected: "JSON 200 (ingelogd)", found: res.html ? "HTML/redirect" : ("HTTP " + res.status), next: "Open questi.com en log in; draai daarna opnieuw." };
        shared.authed = true;
        return { expected: "JSON 200", found: "HTTP " + res.status };
      });
    }));
    // Real lesson items only — skips holidays + full-day/placeholder items (those legitimately lack
    // title/groups/etc., so sampling one would false-FAIL the read-contract check).
    function lessonItems(arr) {
      return (arr || []).filter(function (x) { return x && x.id_calendar !== "cal_holidays" && !x.is_fullday_item && /[T ]\d{2}:\d{2}/.test(String(x.startdate || "")); });
    }
    // 2. Read contract
    checks.push(wrap("/cal/items (weekitems)", "read", function () {
      if (!shared.authed) return { status: STAT.SKIP, found: "geen sessie" };
      return diagGet(itemsUrl).then(function (res) {
        var arr = diagArr(res); shared.items = arr;
        if (!arr.length) return { status: STAT.WARN, expected: "array met items", found: "0 items in weekvenster", next: "Kies een week met lesuren." };
        var s = lessonItems(arr)[0]; shared.sampleItem = s;
        if (!s) return { status: STAT.WARN, expected: "lesuur-item", found: "enkel hele-dag/vakantie items — geen lesuur", next: "Kies een week met lesuren." };
        var missing = ["id", "title", "startdate", "enddate", "id_calendar", "is_editable", "has_attachments", "groups"].filter(function (k) { return !has(s, k); });
        var hasTime = /T\d{2}:\d{2}|[ ]\d{2}:\d{2}/.test(String(s.startdate || ""));
        if (!hasTime) return { status: STAT.FAIL, expected: "startdate met tijd (T HH:MM)", found: String(s.startdate), next: "Tijd-matrix + commit starttime-fallback breken → controleer timeFromISO/startdate." };
        if (missing.length) return { status: STAT.FAIL, expected: "velden id,title,startdate,…", found: "mist: " + missing.join(","), next: "Read-mapping in hydrateRange aanpassen." };
        return { expected: "velden + tijd aanwezig", found: arr.length + " items, lesuur ok" };
      });
    }));
    checks.push(wrap("/cal/items/{id} (detail)", "read", function () {
      if (!shared.authed) return { status: STAT.SKIP, found: "geen sessie" };
      var less = lessonItems(shared.items);
      var it = less.filter(function (x) { return x.has_attachments; })[0] || less[0] || (shared.items || [])[0];
      if (!it) return { status: STAT.SKIP, found: "geen item om te testen" };
      return diagGet(API + "/items/" + it.id + "?" + qs({ schoolId: ctx.schoolId })).then(function (res) {
        var d = (res.json && res.json.result) || res.json; shared.detail = d;
        if (!d) return { status: STAT.FAIL, expected: "detail-object", found: "leeg", next: "detail-endpoint gewijzigd." };
        var att = ficheAttachment(d.attachments);
        var info = "description:" + (has(d, "description") ? "ja" : "nee") + ", attachments:" + ((d.attachments || []).length) +
          ", title_lessons:" + (has(d, "title_lessons") ? "ja" : "nee");
        // The planner reads the stored title from the DETAIL; the list `title` is display-only.
        if (typeof d.title !== "string") return { status: STAT.FAIL, expected: "detail.title (opgeslagen titel)", found: "ontbreekt", next: "Hydrate leest de echte titel uit de detail-call — controleer het veld." };
        if (att && !(att.content && att.content.id != null)) return { status: STAT.FAIL, expected: "attachments[0].content.id", found: "content.id ontbreekt", next: "attach-linking id-mapping controleren." };
        return { expected: "description + attachments[].content.id", found: info };
      });
    }));
    checks.push(wrap("/cal/lessons (fiches + tag-veld)", "read", function () {
      if (!shared.authed) return { status: STAT.SKIP, found: "geen sessie" };
      if (ctx.ownDefaultTagId == null) return { status: STAT.WARN, found: "ownDefaultTagId niet bepaald", next: "resolveOwnTag() — of vul handmatig in." };
      return diagGet(API + "/lessons?" + qs({ schoolId: ctx.schoolId, sorting: "new_items", status: "active", num: 1, offset: 0, default_tagId: ctx.ownDefaultTagId })).then(function (res) {
        var arr = diagArr(res), f = arr[0];
        var total = res.json && res.json.num_records;
        if (!f) return { status: STAT.WARN, expected: "≥1 fiche", found: "0 (num_records=" + total + ")", next: "Tag levert geen fiches — controleer default_tagId." };
        var cands = ["tags", "tagIds", "tag_ids", "categories"].filter(function (k) { return has(f, k); });
        var tagNote = cands.length ? ("per-fiche tagveld terug: " + cands.join(",") + " — model mogelijk gewijzigd") : "geen per-fiche tags (verwacht)";
        return { status: cands.length ? STAT.WARN : STAT.OK, expected: "id,subject; geen per-fiche tags", found: "num_records=" + total + "; " + tagNote, next: cands.length ? "Per-fiche tags terug — controleer of client-side tagfiltering weer nodig is." : "" };
      });
    }));
    checks.push(wrap("/cal/lessons/tags?filter=own", "read", function () {
      if (!shared.authed) return { status: STAT.SKIP, found: "geen sessie" };
      return diagGet(API + "/lessons/tags?" + qs({ schoolId: ctx.schoolId, filter: "own" })).then(function (res) {
        var arr = diagArr(res), t = arr[0];
        if (!t) return { status: STAT.WARN, found: "0 tags", next: "Eigen tagboom leeg — pills/mapping vallen weg." };
        var missing = ["id", "title", "parent", "type", "owner"].filter(function (k) { return !has(t, k); });
        return { status: missing.length ? STAT.FAIL : STAT.OK, expected: "id,title,parent,type,owner", found: missing.length ? ("mist: " + missing.join(",")) : (arr.length + " tags"), next: missing.length ? "Tag-shape gewijzigd → topTagsForOwner/childTags." : "" };
      });
    }));
    checks.push(wrap("possible-participants", "read", function () {
      if (!shared.authed) return { status: STAT.SKIP, found: "geen sessie" };
      return diagGet(API + "/items/shares/possible-participants?" + qs({ schoolId: ctx.schoolId })).then(function (res) {
        var arr = diagArr(res), p = arr[0];
        if (!p) return { status: STAT.WARN, found: "0 personen" };
        var ok = has(p, "id") && (has(p, "firstname") || has(p, "lastname"));
        return { status: ok ? STAT.OK : STAT.FAIL, expected: "id + firstname/lastname", found: arr.length + " personen", next: ok ? "" : "fetchPeople mapping aanpassen." };
      });
    }));
    // 3. Context resolves
    checks.push(wrap("Context-ids (school/cal/group/owner)", "context", function () {
      var found = "school:" + ctx.schoolId + " cal:" + ctx.calendarId + " group:" + ctx.groupId + " owner:" + ctx.ownerId;
      var items = shared.items || [];
      var calOk = !ctx.calendarId || items.some(function (x) { return x.id_calendar === ctx.calendarId; });
      // Groups come as {groupId}, {id} or a raw id, and the week LIST often carries none (the detail
      // does) — so also look in the details already read for the grid, and only judge what exists.
      function gidOf(g) { return g != null && typeof g === "object" ? (g.groupId != null ? g.groupId : g.id) : g; }
      var groupLists = items.map(function (x) { return x.groups || []; })
        .concat((view.slots || []).map(function (s) { return s.groups || []; }))
        .filter(function (l) { return l.length; });
      var grpOk = ctx.groupId == null || !groupLists.length || groupLists.some(function (l) { return l.some(function (g) { return String(gidOf(g)) === String(ctx.groupId); }); });
      if (!ctx.schoolId) return { status: STAT.FAIL, found: found, next: "detectContext() — schoolId niet gevonden." };
      if (!calOk || !grpOk) return { status: STAT.WARN, expected: "cal/group in live items", found: found + " · niet teruggevonden: " + [calOk ? "" : "cal", grpOk ? "" : "group"].filter(Boolean).join("+"), next: "calendar/group id mogelijk gerold — detectContext controleren." };
      return { expected: "alle ids gedetecteerd + teruggevonden", found: found + (groupLists.length ? "" : " (group niet in de weeklijst — enkel in detail, ok)") };
    }));
    checks.push(wrap("Vak → live tag mapping (enkel voor oude instellingen)", "context", function () {
      // This map now ONLY migrates legacy Instellingen (old string-based "vast vak per lesuur")
      // to live tag ids. The written description + all filtering use your live tags directly, so
      // canonical vakken that don't map are harmless on accounts with differently-named tags.
      var mapped = VAKKEN.filter(function (v) { return view.vakTagMap[v.id] != null; }).length;
      return { expected: "n.v.t. tenzij oude instellingen", found: mapped + "/" + VAKKEN.length + " canonieke vakken herkend (rest onschadelijk)" };
    }));
    checks.push(wrap("Schooljaar vs. datum", "context", function () {
      var d = new Date(), y = d.getFullYear(), start = (d.getMonth() >= 7) ? y : y - 1;
      var expect = start + " - " + (start + 1);
      var sy = String(ctx.schoolyear || "");
      var ok = sy.indexOf(String(start)) > -1;
      return { status: ok ? STAT.OK : STAT.WARN, expected: "bevat " + start, found: sy || "—", next: ok ? "" : "Schooljaar waarschijnlijk gerold — herlaad/vernieuw context." };
    }));
    // 4. Write-readiness (dry — never sends)
    checks.push(wrap("PATCH-body vs. referentie", "write", function () {
      if (!shared.authed || !shared.sampleItem) return { status: STAT.SKIP, found: "geen item" };
      var it = shared.sampleItem;
      // Throwaway slot (does NOT touch view.slots); force dirty via a title tweak.
      var tmp = { itemId: it.id, title: (it.title || "") + " ", origTitle: it.title || "", startdate: it.startdate, enddate: it.enddate, idCalendar: it.id_calendar, isEditable: true, dayIdx: 0, weekIdx: 0, time: timeFromISO(it.startdate), groups: (it.groups && it.groups.length) ? it.groups : writeGroups(), isGym: false, themaFiche: false, origDescription: "", description: "", ficheContentId: null, origFicheContentId: null, ficheTitle: "", origFicheTitle: "", starttime: "", endtime: "" };
      var plan = buildCommitPlan([tmp]);
      if (!plan.length) return { status: STAT.WARN, found: "geen plan (niet dirty?)", next: "buildCommitPlan/computeDirty controleren." };
      // `attachments:[]` is a LEGITIMATE optional key on fiche-less/detach rows (see buildCommitPlan);
      // exclude it so the check validates the required keys and doesn't false-FAIL on a detach sample.
      var keys = Object.keys(plan[0].patchBody).filter(function (k) { return k !== "attachments"; });
      var diff = keyDiff(keys, REF_PATCH_KEYS);
      var attNote = ("attachments" in plan[0].patchBody) ? " (+attachments: detach-rij, ok)" : "";
      if (diff.ok) return { expected: REF_PATCH_KEYS.length + " sleutels", found: "identiek aan referentie" + attNote };
      return { status: STAT.FAIL, expected: REF_PATCH_KEYS.join(","), found: "mist:[" + diff.missing.join(",") + "] extra:[" + diff.extra.join(",") + "]", next: "buildCommitPlan.patchBody aanpassen aan referentie." };
    }));
    checks.push(wrap("Attachment-body vs. referentie", "write", function () {
      // Reconstruct the POST payload shape WITHOUT sending it.
      var payloadKeys = Object.keys({ schoolId: 0, visible_parents: false, visible_students: false, students: [], groups: [], id: 0, typeId: 1 });
      var diff = keyDiff(payloadKeys, REF_ATTACH_KEYS);
      return { status: diff.ok ? STAT.OK : STAT.FAIL, expected: REF_ATTACH_KEYS.join(","), found: diff.ok ? "identiek" : ("mist:[" + diff.missing.join(",") + "] extra:[" + diff.extra.join(",") + "]"), next: diff.ok ? "" : "postAttachment payload aanpassen." };
    }));
    checks.push(wrap("id-gelijkwaardigheid (content.id ↔ lesfiche)", "write", function () {
      if (!shared.authed) return { status: STAT.SKIP, found: "geen sessie" };
      var att = ficheAttachment(shared.detail && shared.detail.attachments);
      if (!att || !att.content || att.content.id == null) return { status: STAT.SKIP, found: "geen gekoppelde fiche in sample" };
      var cid = att.content.id;
      return diagGet(API + "/lessons/" + cid + "?" + qs({ schoolId: ctx.schoolId, return_format: "view" })).then(function (res) {
        var ok = res.status < 400 && res.json && (res.json.result || res.json);
        return { status: ok ? STAT.OK : STAT.WARN, expected: "content.id " + cid + " is een echte lesfiche", found: ok ? "resolvet" : ("HTTP " + res.status), next: ok ? "" : "attach-POST richt zich mogelijk op verkeerde id." };
      });
    }));
    // 4b. Methodevoortgang — the panel reads nothing else, so these two shapes are its contract.
    checks.push(wrap("Methodelijst (/manage/methods)", "read", function () {
      if (!shared.authed) return { status: STAT.SKIP, found: "geen sessie" };
      return diagGet(API + "/manage/methods/" + ctx.schoolId).then(function (res) {
        var arr = (res.json && res.json.result) || [];
        if (!arr.length) return { status: STAT.WARN, expected: "id,name,grades,is_cluster", found: "0 methodes", next: "School heeft geen methodes — 'Uit Questi' blijft leeg." };
        var miss = ["id", "name", "grades"].filter(function (k) { return !has(arr[0], k); });
        return { status: miss.length ? STAT.FAIL : STAT.OK, expected: "id,name,grades,is_cluster", found: miss.length ? ("mist: " + miss.join(",")) : (arr.length + " methodes"), next: miss.length ? "Methodevoortgang → addFromQuesti aanpassen." : "" };
      });
    }));
    checks.push(wrap("Methodelessen (last_used_date)", "read", function () {
      if (!shared.authed) return { status: STAT.SKIP, found: "geen sessie" };
      return diagGet(API + "/manage/methods/" + ctx.schoolId).then(function (r1) {
        var m0 = ((r1.json && r1.json.result) || [])[0];
        if (!m0) return { status: STAT.SKIP, found: "geen methode om te testen" };
        return diagGet(API + "/methods/" + encodeURIComponent(m0.id) + "/lessons?" + qs({ is_cluster: !!m0.is_cluster, schoolId: ctx.schoolId })).then(function (res) {
          var arr = (res.json && res.json.result) || [];
          if (!arr.length) return { status: STAT.WARN, expected: "subject + last_used_date", found: "0 lessen voor " + m0.id };
          // last_used_date may legitimately be null (never used) — the KEY must exist.
          var hasKey = Object.prototype.hasOwnProperty.call(arr[0], "last_used_date");
          var miss = ["id", "subject"].filter(function (k) { return !has(arr[0], k); }).concat(hasKey ? [] : ["last_used_date"]);
          return { status: miss.length ? STAT.FAIL : STAT.OK, expected: "id,subject,last_used_date", found: miss.length ? ("mist: " + miss.join(",")) : (arr.length + " lessen"), next: miss.length ? "Methodevoortgang kan 'gegeven' niet meer afleiden." : "" };
        });
      });
    }));
    // 5. Data sanity
    checks.push(wrap("Tellingen", "sanity", function () {
      return { expected: "fiches/tags/personen/slots", found: "tags(own):" + ownTagsList().length + " personen:" + view.people.length + " slots(week):" + view.slots.length };
    }));
    checks.push(wrap("Tijd-raster Ma–Vr", "sanity", function () {
      var perDay = [0, 1, 2, 3, 4].map(function (d) { return view.timeRows.filter(function (t) { return view.presence[d + "|" + t]; }).length; });
      return { expected: "gedeelde tijd-as", found: "rijen:" + view.timeRows.length + " · per dag: " + perDay.join("/") + (Object.keys(view.rowMeta || {}).length ? " · pauzes afgeleid" : "") };
    }));
    checks.push(wrap("Thema/gym classificatie", "sanity", function () {
      // Report what the planner ACTUALLY classifies on (identity + vak), not what the title
      // happens to say — otherwise this row contradicts the grid.
      var bands = [], th = [], gy = [];
      view.slots.forEach(function (s) {
        if (isThemaSlot(s)) bands.push(s.origTitle);
        else if (s.themaFiche) th.push(s.title);
        else if (s.isGym) gy.push(s.title);
      });
      return { expected: "zichtbaar ter controle", found: "themabalken:" + bands.length + " thema-lesuren:" + th.length + " gym:" + gy.length + (gy.length ? " (" + gy.slice(0, 3).join(", ") + ")" : "") };
    }));

    // Run sequentially.
    checks.reduce(function (chain, thunk) { return chain.then(thunk); }, Promise.resolve());
  }

  // ---------- Instellingen ----------
  // Superseded by settings.js (Instellingen → Lesrooster/Agenda). The body below is the legacy
  // fallback for when that module is not loaded; delete it once the new planner shell lands.
  function openInstellingen() {
    if (window.__UQ_SETTINGS && window.__UQ_SETTINGS.open) { window.__UQ_SETTINGS.open("lesrooster"); return; }
    var old = elId("qwp-modal"); if (old) old.remove();
    computeTimeRows();
    if (!view.timeRows.length) { setStatus("Geen rooster geladen — open eerst een week met lesuren."); return; }
    var rows = view.timeRows;
    // Vak options come from the user's LIVE top-level tag hierarchy, not a fixed list.
    var tops = panelTopTags("self");
    var grid = h("div", { class: "qwp-inst" });
    grid.appendChild(h("div", {}));
    for (var d = 0; d < 5; d++) grid.appendChild(h("div", { class: "qwp-inst-hd", text: DAY_NAMES[d].slice(0, 2).toUpperCase() }));
    grid.appendChild(h("div", { class: "qwp-inst-time", text: "thema" }));
    for (var dt = 0; dt < 5; dt++) grid.appendChild(h("div", { class: "qwp-inst-cell" }, [h("div", { class: "qwp-cell-vak", text: "WO" })]));
    rows.forEach(function (t) {
      grid.appendChild(h("div", { class: "qwp-inst-time", text: t }));
      for (var d2 = 0; d2 < 5; d2++) {
        (function (day, time) {
          if (isNoSchool(day, time)) { grid.appendChild(h("div", { class: "qwp-inst-cell qwp-inst-noschool", text: "—" })); return; }
          var key = slotKeyStd(day, time);
          var sel = h("select", {}, [h("option", { value: "", text: "—", selected: (state.settings[key] ? null : "selected") })].concat(tops.map(function (v) { return h("option", { value: v.id, text: (v.title || "").trim(), selected: (String(state.settings[key]) === String(v.id) ? "selected" : null) }); })));
          sel.onchange = function () { if (sel.value) state.settings[key] = +sel.value; else delete state.settings[key]; };
          grid.appendChild(h("div", { class: "qwp-inst-cell" }, [sel]));
        })(d2, t);
      }
    });

    // Werkagenda (Feature 5): which calendar the planner loads + writes to. Only useful with >1.
    var calSel = null, calField = null;
    if ((ctx.calendars || []).length > 1) {
      calSel = h("select", { class: "qwp-input", style: "width:100%" },
        [h("option", { value: "", text: "— automatisch —", selected: (state.workingCalendarId == null ? "selected" : null) })].concat(
          ctx.calendars.map(function (c) { return h("option", { value: String(c.id), text: c.name, selected: (String(state.workingCalendarId) === String(c.id) ? "selected" : null) }); })));
      calField = h("div", { class: "qwp-field", style: "margin-top:16px;border-top:1px solid var(--line-soft);padding-top:14px" }, [
        h("label", { text: "Werkagenda (lezen + schrijven)" }),
        calSel,
        h("div", { class: "qwp-note", style: "margin-top:6px", text: "Welke agenda de weekplanner toont en naar wegschrijft. 'Automatisch' kiest de agenda met de meeste lesitems. Stel dit in als je meerdere agenda's hebt of een collega-agenda plant." })
      ]);
    }

    var throttleInp = h("input", { class: "qwp-input", type: "number", min: "0", max: "10000", step: "50", style: "width:130px", value: String(state.saveThrottleMs != null ? state.saveThrottleMs : 250) });
    var throttleField = h("div", { class: "qwp-field", style: "margin-top:16px;border-top:1px solid var(--line-soft);padding-top:14px" }, [
      h("label", { text: "Vertraging tussen opgeslagen lesuren (ms)" }),
      throttleInp,
      h("div", { class: "qwp-note", style: "margin-top:6px", text: "Basisvertraging + toevallige spreiding, zodat het opslaan niet als een machine oogt. Verhoog dit (bv. 2000) als Questi klaagt dat je te snel opslaat. Standaard 250." })
    ]);
    var modal = h("div", { class: "qwp-modal", id: "qwp-modal" }, [
      h("div", { class: "qwp-modal-box qwp-inst-modal" }, [
        h("div", { class: "qwp-modal-hd", text: "Instellingen — vast vak per lesuur" }),
        h("div", { class: "qwp-modal-body" }, [h("p", { class: "qwp-note", text: "Dit is de standaard die elke week geldt. Ze bepaalt welk vak 'Toevoegen aan rooster' automatisch in een leeg lesuur plaatst." }), grid, calField, throttleField]),
        h("div", { class: "qwp-modal-ft" }, [
          h("button", { class: "qwp-btn qwp-ghost", text: "Sluiten", onclick: function () { modal.remove(); } }),
          h("button", { class: "qwp-btn qwp-approve", text: "Bewaren", onclick: function () {
            var tv = parseInt(throttleInp.value, 10); state.saveThrottleMs = (isNaN(tv) || tv < 0) ? 250 : Math.min(tv, 10000);
            // Werkagenda change: apply + reload the grid from the chosen calendar.
            var calChanged = false;
            if (calSel) {
              var newWc = calSel.value ? calSel.value : null;
              if (String(newWc) !== String(state.workingCalendarId)) {
                calChanged = true; state.workingCalendarId = newWc;
                if (newWc != null) ctx.calendarId = newWc; // specific pick loads/writes this calendar
              }
            }
            saveState(); modal.remove(); reloadSlotVakLabels(); renderTimetable();
            if (calChanged && state.workingCalendarId == null) { try { location.reload(); return; } catch (e) {} } // 'automatisch' → re-detect busiest
            if (calChanged) { reloadAndRender(); setStatus("Werkagenda gewijzigd — week herladen."); return; }
            setStatus("Instellingen bewaard — geldt voor elke week.");
          } })
        ])
      ])
    ]);
    els.page.appendChild(modal);
  }
  function reloadSlotVakLabels() {
    view.slots.forEach(function (s) {
      var v = state.settings[slotKeyStd(s.dayIdx, s.time)];
      if (v && !s.ficheContentId) s.vak = v;
      if (!s.isFullday && isThemaVak(s.vak)) s.themaFiche = true;
    });
  }

  // ---------- Kopieer vorige week (opt-in, per-item) ----------
  // Current-week schedulable slot for a given weekday+time (first match, week 0).
  function currentSlotForDayTime(dayIdx, time) {
    return view.slots.filter(function (s) {
      if (s.idCalendar === "cal_holidays" || s.isFullday) return false;
      return s.dayIdx === dayIdx && (s.time || (s.starttime ? String(s.starttime).slice(0, 5) : "")) === time;
    }).sort(function (a, b) { return a.weekIdx - b.weekIdx; })[0] || null;
  }
  // Questi retitles an item "* <fiche> (1)" when a fiche is attached. Undo that for the loaded
  // week(s) — only where the stripped text IS the fiche title, so a hand-typed title is never
  // touched. Staged like any edit: nothing is written until the review gate.
  // Whole-week bars too: their stored title may carry our "<Thema> — " prefix in front of the
  // decoration; the commit re-applies that prefix for a tagged bar (themaCommitTitle).
  function cleanDecoratedTitles() {
    if (busyLoading()) return;
    var hits = view.slots.filter(function (s) {
      if (!s.isEditable || s.isGym || !s.ficheContentId || !s.ficheTitle || s.idCalendar === "cal_holidays") return false;
      var m = String(stripThemaPrefix(s.title || "") || s.title || "").match(DECORATED_RE);
      return !!m && m[1].trim() === String(stripThemaPrefix(s.ficheTitle) || s.ficheTitle).trim();
    });
    if (!hits.length) { setStatus("Geen '* … (1)'-titels in de geladen week."); return; }
    pushUndo("titels opschonen");
    hits.forEach(function (s) { s.title = String(stripThemaPrefix(s.ficheTitle) || s.ficheTitle).trim(); });
    renderTimetable();
    setStatus(hits.length + " titel(s) opgeschoond — controleer bij Wijzigingen en schrijf weg.");
  }
  function openCopyPrevWeek() {
    if (busyLoading()) return;
    if (!view.weekStart) { setStatus("Geen week geladen."); return; }
    var old = elId("qwp-modal"); if (old) old.remove();
    var span = 7;   // the week before the first loaded week, copied into that week
    var prevStart = isoDate(addDays(view.weekStart, -span)), prevEnd = isoDate(addDays(view.weekStart, -1));
    setStatus("Vorige week laden…");
    hydrateRange(prevStart, prevEnd).then(function (prev) {
      var filled = prev.filter(function (s) { return s.idCalendar !== "cal_holidays" && !s.isFullday && (s.ficheContentId || s.isGym); })
        .sort(function (a, b) { return (a.dayIdx - b.dayIdx) || String(a.time).localeCompare(String(b.time)); });
      if (!filled.length) { setStatus("Vorige week had geen ingevulde lesuren."); return; }
      var rows = filled.map(function (ps) {
        var tgt = currentSlotForDayTime(ps.dayIdx, ps.time);
        return { ps: ps, target: tgt, chk: false };
      });
      var body = h("div", { class: "qwp-modal-body" });
      function rowVak(ps) { return ps.vak ? ((tagTitle("self", ps.vak) || "").trim()) : (ps.isGym ? "gym" : ""); }
      // Readable day×time grid: each prior filled lesuur is a click-to-toggle tile.
      function render() {
        body.innerHTML = "";
        body.appendChild(h("p", { class: "qwp-note", text: "Klik de lesuren die je wil overnemen (blauw = gekozen). Enkel lege lesuren op hetzelfde moment worden gevuld." }));
        var times = []; rows.forEach(function (r) { var t = r.ps.time || ""; if (times.indexOf(t) < 0) times.push(t); });
        times.sort(function (a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); });
        function cellFor(day, time) { return rows.filter(function (r) { return r.ps.dayIdx === day && (r.ps.time || "") === time; })[0]; }
        var grid = h("div", { class: "qwp-copy-grid" });
        grid.style.gridTemplateColumns = "58px repeat(5, minmax(0, 1fr))";
        grid.appendChild(h("div", { class: "qwp-copy-corner", text: "uur" }));
        for (var d0 = 0; d0 < 5; d0++) grid.appendChild(h("div", { class: "qwp-copy-dayhd", text: DAY_NAMES[d0] }));
        times.forEach(function (t) {
          grid.appendChild(h("div", { class: "qwp-copy-timelbl", text: t }));
          for (var d = 0; d < 5; d++) {
            (function (day) {
              var r = cellFor(day, t);
              if (!r) { grid.appendChild(h("div", { class: "qwp-copy-cell empty" })); return; }
              var avail = !!(r.target && isTargetable(r.target));
              var tile = h("div", {
                class: "qwp-copy-cell tile" + (avail ? "" : " disabled") + (r.chk && avail ? " sel" : ""),
                title: avail ? "Klik om te (de)selecteren" : (!r.target ? "geen lesuur deze week" : "al ingevuld"),
                onclick: function () { if (!avail) return; r.chk = !r.chk; render(); }
              }, [
                h("div", { class: "qwp-copy-t", text: r.ps.isGym ? (r.ps.title || "Gym") : (r.ps.ficheTitle || r.ps.title || "(les)") }),
                rowVak(r.ps) ? h("div", { class: "qwp-copy-vak", text: rowVak(r.ps) }) : null,
                !avail ? h("div", { class: "qwp-copy-x", text: !r.target ? "geen lesuur" : "al ingevuld" }) : null
              ]);
              grid.appendChild(tile);
            })(d);
          }
        });
        body.appendChild(grid);
      }
      function setAll(fn) { rows.forEach(function (r) { var avail = r.target && isTargetable(r.target); r.chk = avail && fn(r); }); render(); }
      var modal = h("div", { class: "qwp-modal", id: "qwp-modal" }, [
        h("div", { class: "qwp-modal-box wide qwp-copy-modal" }, [
          h("div", { class: "qwp-modal-hd", text: "Kopieer vorige week — " + filled.length + " ingevulde lesuren" }),
          body,
          h("div", { class: "qwp-modal-ft" }, [
            h("button", { class: "qwp-btn qwp-ghost qwp-sm", text: "Alles", onclick: function () { setAll(function () { return true; }); } }),
            h("button", { class: "qwp-btn qwp-ghost qwp-sm", text: "Enkel WO/thema", onclick: function () { setAll(function (r) { return THEMA_RE.test(r.ps.title || "") || r.ps.themaFiche; }); } }),
            h("button", { class: "qwp-btn qwp-ghost qwp-sm", text: "Wis", onclick: function () { setAll(function () { return false; }); } }),
            h("span", { class: "qwp-spacer" }),
            h("button", { class: "qwp-btn qwp-ghost", text: "Annuleren", onclick: function () { modal.remove(); } }),
            h("button", {
              class: "qwp-btn qwp-approve", text: "Kopieer selectie", onclick: function () {
                var chosen = rows.filter(function (r) { return r.chk && r.target && isTargetable(r.target); });
                if (!chosen.length) { setStatus("Niets aangevinkt."); return; }
                pushUndo("kopieer vorige week");
                chosen.forEach(function (r) {
                  if (r.ps.isGym) { r.target.isGym = true; r.target.ficheContentId = null; r.target.ficheTitle = ""; r.target.themaFiche = false; }
                  else { assignFiche(r.target, { id: r.ps.ficheContentId, subject: r.ps.ficheTitle, isMethod: r.ps.ficheIsMethod }); }
                  if (r.ps.vak) r.target.vak = r.ps.vak;
                });
                modal.remove(); renderTimetable();
                setStatus(chosen.length + " les(sen) overgenomen uit vorige week (nog niet weggeschreven).");
                syncFicheVakken(chosen.map(function (r) { return r.target; }));
              }
            })
          ])
        ])
      ]);
      els.page.appendChild(modal); render();
      setStatus("Vorige week geladen.");
    }).catch(function () { setStatus("Vorige week laden mislukt."); });
  }

  // ---------- Colleague popover ----------
  function openColleaguePopover() {
    var ex = elId("qwp-pop"); if (ex) { ex.remove(); return; }
    var selectedIds = state.colleagues.map(function (c) { return c.id; });
    var listWrap = h("div", { class: "qwp-pop-list" });
    function renderList(filter) {
      listWrap.innerHTML = "";
      view.people.filter(function (p) { return !filter || p.name.toLowerCase().indexOf(filter.toLowerCase()) > -1; }).forEach(function (p) {
        var checked = selectedIds.indexOf(p.id) > -1;
        var row = h("label", { class: "qwp-pop-row" }, [h("input", { type: "checkbox", onchange: function (e) { if (e.target.checked) { if (selectedIds.indexOf(p.id) < 0) selectedIds.push(p.id); } else selectedIds = selectedIds.filter(function (x) { return x !== p.id; }); } }), h("span", { text: p.name })]);
        if (checked) row.querySelector("input").checked = true;
        listWrap.appendChild(row);
      });
    }
    renderList("");
    var pop = h("div", { class: "qwp-pop", id: "qwp-pop" }, [
      h("div", { class: "qwp-pop-hd", text: "Kies collega's" }),
      h("input", { class: "qwp-pop-search", placeholder: "Zoek collega…", oninput: function (e) { renderList(e.target.value); } }),
      listWrap,
      h("div", { class: "qwp-pop-ft" }, [
        h("button", { class: "qwp-btn", text: "Laden", onclick: function () { var methods = state.colleagues.filter(function (c) { return c.isMethod; }); state.colleagues = methods.concat(view.people.filter(function (p) { return selectedIds.indexOf(p.id) > -1; }).map(function (p) { return { id: p.id, name: p.name }; })); saveState(); pop.remove(); loadColleagueFiches(); } }),
        h("button", { class: "qwp-btn qwp-ghost", text: "Annuleren", onclick: function () { pop.remove(); } })
      ])
    ]);
    els.page.appendChild(pop);
  }

  // ---------- Methode popover (vendor libraries) ----------
  // Chosen methodes become pseudo-colleagues (id "method:<KEY>") so they appear in the
  // owner selectors + panels + global search. Their fiches are read-only vendor content
  // and are badged "methode" everywhere.
  function openMethodesPopover() {
    var ex = elId("qwp-pop"); if (ex) { ex.remove(); return; }
    var chosen = {}; state.colleagues.filter(function (c) { return c.isMethod; }).forEach(function (c) { chosen[c.methodKey] = c; });
    var pop = h("div", { class: "qwp-pop", id: "qwp-pop" }, [
      h("div", { class: "qwp-pop-hd", text: "Kies methodes" }),
      h("div", { class: "qwp-pop-list", id: "qwp-meth-list" }, [h("div", { class: "qwp-empty", text: "Methodes laden…" })]),
      h("div", { class: "qwp-pop-ft" }, [
        h("button", { class: "qwp-btn", text: "Laden", onclick: function () {
          var others = state.colleagues.filter(function (c) { return !c.isMethod; });
          state.colleagues = others.concat(Object.keys(chosen).map(function (k) { return chosen[k]; }));
          saveState(); pop.remove(); loadColleagueFiches();
        } }),
        h("button", { class: "qwp-btn qwp-ghost", text: "Annuleren", onclick: function () { pop.remove(); } })
      ])
    ]);
    els.page.appendChild(pop);
    fetchMethods().then(function (methods) {
      var listWrap = elId("qwp-meth-list"); if (!listWrap) return; listWrap.innerHTML = "";
      if (!methods.length) { listWrap.appendChild(h("div", { class: "qwp-empty", text: "Geen methodes beschikbaar." })); return; }
      methods.sort(function (a, b) { return (a.name || "").localeCompare(b.name || "", undefined, { numeric: true }); });
      methods.forEach(function (mth) {
        var sub = ((mth.publisher && mth.publisher.name) ? mth.publisher.name + " · " : "") + ((mth.grades || []).join(", "));
        var row = h("label", { class: "qwp-pop-row" }, [
          h("input", { type: "checkbox", onchange: function (e) {
            if (e.target.checked) chosen[mth.id] = { id: METHOD_PREFIX + mth.id, name: mth.name, isMethod: true, methodKey: mth.id, isCluster: !!mth.is_cluster };
            else delete chosen[mth.id];
          } }),
          h("span", {}, [h("span", { text: mth.name }), h("span", { class: "qwp-pop-sub", text: sub ? ("  (" + sub + ")") : "" })])
        ]);
        if (chosen[mth.id]) row.querySelector("input").checked = true;
        listWrap.appendChild(row);
      });
    });
  }

  // ---------- Review + commit (LOCKED until approved) ----------
  var _approvedPlan = null;
  // Per-cell diff class for the NEW grid. Precedence: red (overwrite) > green
  // (changed) > orange (still empty) > white (unchanged).
  function reviewCellClass(s) {
    if (!s) return "rv-empty";
    var overwrote = s.origFicheContentId && s.ficheContentId && String(s.origFicheContentId) !== String(s.ficheContentId);
    if (overwrote) return "rv-alert";
    if (computeDirty(s)) return "rv-changed";
    if (isTargetable(s)) return "rv-empty";
    return "rv-same";
  }
  function reviewCellContent(s, mode) {
    if (!s) return h("div", { class: "qwp-cell-empty-hint", text: "leeg" });
    var title = mode === "old" ? s.origTitle : s.title;
    var fiche;
    if (mode === "old") fiche = s.origFicheTitle || (stripHtml(s.origDescription) === "Zie themafiche." ? "Zie themafiche." : "");
    else fiche = s.isGym ? "(gym)" : (themaShowsLiteral(s) ? "Zie themafiche." : stripThemaPrefix(s.ficheTitle || ""));
    var overwrote = mode === "new" && s.origFicheContentId && s.ficheContentId && String(s.origFicheContentId) !== String(s.ficheContentId);
    return h("div", { class: "qwp-rv-cellbody" }, [
      h("div", { class: "qwp-cell-title", text: (overwrote ? "⚠ " : "") + (title || "(leeg)") }),
      fiche ? h("div", { class: "qwp-cell-fiche qwp-rv-fiche", text: fiche }) : null
    ]);
  }
  // A read-only, full timetable grid (OLD or NEW state) for the review modal.
  // showHeaders=false skips the date-header row (the NEW grid reuses the OLD one's).
  function buildReviewGrid(mode, showHeaders) {
    computeTimeRows();
    var grid = h("div", { class: "qwp-tt qwp-rv-tt" });
    grid.style.gridTemplateColumns = "64px repeat(" + (5 * view.weeks) + ", minmax(0, 1fr))";
    if (showHeaders) {
      grid.appendChild(h("div", { class: "qwp-tt-corner" }, [h("span", { class: "qwp-tt-corner-lbl", text: "uur" })]));
      for (var wh = 0; wh < view.weeks; wh++) {
        for (var dh = 0; dh < 5; dh++) grid.appendChild(h("div", { class: "qwp-tt-dayhd" + (dh === 0 && wh > 0 ? " wk-sep" : "") }, [h("span", { class: "qwp-tt-daydate", text: fullDateLabel(wh * 7 + dh) })]));
      }
    }
    themaRowKeys().forEach(function (key) {
      var lbl = themaLabel(key, view.slots);
      grid.appendChild(h("div", { class: "qwp-tt-themalbl", title: lbl }));   // empty, as in the grid
      for (var w = 0; w < view.weeks; w++) {
        var ts = weekThemaSlot(w, key);
        var tc = h("div", { class: "qwp-cell thema-span qwp-rv-cell" + (w > 0 ? " wk-sep" : "") }, [reviewCellContent(ts, mode)]);
        tc.style.gridColumn = "span 5"; grid.appendChild(tc);
      }
    });
    view.timeRows.forEach(function (t) {
      grid.appendChild(h("div", { class: "qwp-tt-timelbl", text: t }));
      for (var wr = 0; wr < view.weeks; wr++) {
        for (var dd = 0; dd < 5; dd++) {
          var sep = (dd === 0 && wr > 0) ? " wk-sep" : "";
          if (isNoSchool(dd, t)) { grid.appendChild(h("div", { class: "qwp-cell blank qwp-rv-cell" + sep })); continue; }
          var s = slotAt(wr, dd, t);
          var cls = "qwp-cell qwp-rv-cell" + sep + " " + (mode === "new" ? reviewCellClass(s) : "rv-old");
          grid.appendChild(h("div", { class: cls }, [reviewCellContent(s, mode)]));
        }
      }
    });
    return grid;
  }
  // ONE Controleer for everything staged (Controleer.dc.html), in write order:
  //   (1) tags to create and (2) fiche edits — both staged in lessons.js (Lesfiches tab) —
  //   (3) calendar changes from buildCommitPlan, plus "Fiche-versie" rows: lesuren in the loaded
  //   weeks that already hold a fiche being edited, offered to follow it to the new version.
  // Every row has a checkbox to leave it out (it simply stays staged). A JSON backup of the
  // affected fiches is ticked by default. Opened by the Controleer button and the header count.
  function slotWhere(s) {
    var top = topTagIdOf(s.vak), vak = top != null ? (anyTagTitle(top) || "").trim() : "";
    var d = s.startdate ? ddmm(String(s.startdate).slice(0, 10), 0) : (view.weekStart ? ddmm(view.weekStart, (s.weekIdx || 0) * 7 + (s.dayIdx || 0)) : "");
    return (DAY_ABBR[s.dayIdx] || "") + " " + d + (s.time ? " " + s.time : "") + (vak ? " · " + vak : "");
  }
  function slotByItemId(id) {
    var all = commitSlots().slots;
    for (var i = 0; i < all.length; i++) if (String(all[i].itemId) === String(id)) return all[i];
    return null;
  }
  function openReview() {
    if (busyLoading()) return;   // stored titles/fiches of some lesuren are not read yet
    var old = elId("qwp-modal"); if (old) old.remove();
    var L = lessonsApi(), lp = { tags: [], fiches: [] };
    if (L) { try { lp = L.pendingSummary(); } catch (e) { console.error("[QWP] pendingSummary:", e); } }
    var cs = commitSlots(), plan = buildCommitPlan(cs.slots);
    // Lesuren that hold a fiche being edited: dirty ones follow it to the new version as part of
    // their own row; clean ones become an opt-in "Fiche-versie" row.
    var ficheByFid = {}; lp.fiches.forEach(function (f) { ficheByFid[String(f.ficheId)] = f; });
    var follows = {}, bumps = [];
    cs.slots.forEach(function (s) {
      if (!s.isEditable || s.idCalendar === "cal_holidays" || s.isGym || !s.ficheContentId) return;
      var pf = ficheByFid[String(s.ficheContentId)]; if (!pf) return;
      if (computeDirty(s)) follows[s.itemId] = pf; else bumps.push({ slot: s, fiche: pf });
    });
    if (!lp.tags.length && !lp.fiches.length && !plan.length && !bumps.length) { setStatus("Geen wijzigingen om te controleren."); return; }
    var excl = { tag: {}, fiche: {}, cal: {}, bump: {} }, rows = [];
    function textBlock(lines) { return h("span", { class: "qwp-cr-lines" }, lines.filter(Boolean).map(function (l) { return typeof l === "string" ? h("span", { text: l }) : l; })); }
    function row(kind, key, what, where, oldLines, newLines, note) {
      var cb = h("input", { type: "checkbox", "aria-label": what + " — " + where + " meenemen" }); cb.checked = true;
      var el = h("label", { class: "qwp-cr-row" }, [
        cb,
        h("span", { class: "qwp-cr-what" }, [h("b", { text: what }), h("span", { text: where })]),
        h("span", { class: "qwp-cr-old" }, [textBlock(oldLines)]),
        h("span", { class: "qwp-cr-new" }, [textBlock(newLines), note ? h("span", { class: "qwp-cr-note", text: note }) : null])
      ]);
      cb.addEventListener("change", function () { if (cb.checked) delete excl[kind][key]; else excl[kind][key] = true; sync(); });
      rows.push({ kind: kind, key: key, cb: cb, el: el });
      return el;
    }
    function section(n, title, detail, kids) {
      return h("section", { class: "qwp-cr-sec" }, [
        h("div", { class: "qwp-cr-sechd" }, [h("span", { class: "qwp-cr-n", text: n }), h("span", { class: "qwp-cr-t", text: title }), h("span", { class: "qwp-cr-d", text: detail })])
      ].concat(kids));
    }
    var secs = [];
    if (lp.tags.length) secs.push(section("1", "Tags", lp.tags.length + (lp.tags.length === 1 ? " nieuwe tag" : " nieuwe tags"), lp.tags.map(function (t) {
      return row("tag", t.key, "Nieuwe tag", t.parentTitle ? "onder " + t.parentTitle : "hoofdtag", ["—"],
        [h("span", { class: "qwp-cr-tag" }, [h("span", { class: "qwp-cr-dot", style: "background:" + (t.color || "#c9d2d7") }), h("span", { text: t.title })])]);
    })));
    if (lp.fiches.length) secs.push(section("2", "Lesfiches", lp.fiches.length + " fiche(s) · elke fiche krijgt een nieuwe versie", lp.fiches.map(function (f) {
      var o = [], nw = [];
      f.changes.forEach(function (c) {
        o.push(c.oldEl ? h("span", { class: "qwp-cr-lbl" }, [h("i", { text: c.label + ": " }), c.oldEl]) : (c.label + ": " + String(c.old || "—").slice(0, 160)));
        nw.push(c.newEl ? h("span", { class: "qwp-cr-lbl" }, [h("i", { text: c.label + ": " }), c.newEl]) : (c.label + ": " + String(c.nw || "—").slice(0, 160)));
      });
      if (!f.changes.length) { o.push("—"); nw.push("(gewijzigd)"); }
      return row("fiche", f.key, "Lesfiche", f.title, o, nw);
    })));
    var weekCount = {};
    var calRows = plan.map(function (p) {
      var s = slotByItemId(p.itemId), what = [];
      if (p.old.fiche !== p.neu.fiche || p.fiche) what.push(s && s.isGym ? "Gym" : "Fiche");
      if ((p.old.title || "") !== (p.neu.title || "")) what.push("Titel");
      if (stripHtml(p.old.desc) !== stripHtml(p.neu.desc)) what.push("Vak");
      if (!what.length) what.push("Lesuur");
      if (s) { var wn = weekNoOf(s.weekIdx || 0); weekCount[wn] = (weekCount[wn] || 0) + 1; }
      var pf = follows[p.itemId];
      return row("cal", p.itemId, what.join(" · "), s ? slotWhere(s) : p.label,
        [p.old.title || "(leeg)", p.old.fiche !== p.neu.fiche ? "fiche: " + p.old.fiche : null, what.indexOf("Vak") >= 0 ? "vak: " + (stripHtml(p.old.desc) || "—") : null],
        [p.neu.title || "(leeg)", p.old.fiche !== p.neu.fiche ? "fiche: " + p.neu.fiche : null, what.indexOf("Vak") >= 0 ? "vak: " + (stripHtml(p.neu.desc) || "—") : null],
        pf ? "krijgt de nieuwe versie van deze fiche" : (p.descEcho ? "beschrijving wordt eerst gelezen en ongewijzigd teruggeschreven" : null));
    }).concat(bumps.map(function (b) {
      var s = b.slot, wn = weekNoOf(s.weekIdx || 0); weekCount[wn] = (weekCount[wn] || 0) + 1;
      return row("bump", s.itemId, "Fiche-versie", slotWhere(s), [(s.ficheTitle || b.fiche.title) + " (oud)"], [b.fiche.title + " (nieuw)"], "lesuur blijft verder ongewijzigd");
    }));
    if (calRows.length) {
      var grid = null;
      if (plan.length) {
        grid = h("details", { class: "qwp-cr-grid" }, [h("summary", { text: "Toon als rooster (oud / nieuw)" })]);
        grid.addEventListener("toggle", function () {
          if (!grid.open || grid.getAttribute("data-built")) return;
          grid.setAttribute("data-built", "1");
          grid.appendChild(h("p", { class: "qwp-note", text: "Groen = gewijzigd · oranje = nog leeg · rood ⚠ = overschrijft bestaande fiche · wit = ongewijzigd. Enkel deze occurrence." }));
          grid.appendChild(h("div", { class: "qwp-rv-section" }, [h("div", { class: "qwp-rv-caption", text: "HUIDIG (oud)" }), buildReviewGrid("old", true)]));
          grid.appendChild(h("div", { class: "qwp-rv-section" }, [h("div", { class: "qwp-rv-caption", text: "NA WEGSCHRIJVEN (nieuw)" }), buildReviewGrid("new", false)]));
        });
      }
      secs.push(section("3", "Agenda", Object.keys(weekCount).map(function (w) { return "week " + w + ": " + weekCount[w]; }).join(" · "), calRows.concat(grid ? [grid] : [])));
    }
    // Aside: the order of work, the version warning, backup, and the write button.
    var olderN = Object.keys(follows).length + bumps.length;
    var backupCb = h("input", { type: "checkbox", "aria-label": "Back-up downloaden" }); backupCb.checked = true;
    var masterCb = h("input", { type: "checkbox", "aria-label": "Alles aangevinkt" }); masterCb.checked = true;
    var sub = h("span", { class: "qwp-cr-sub" });
    var goBtn = h("button", { class: "qwp-cr-go", onclick: approve });
    masterCb.addEventListener("change", function () { rows.forEach(function (r) { if (!r.cb.disabled) { r.cb.checked = masterCb.checked; r.cb.dispatchEvent(new Event("change")); } }); });
    function chosen() { return rows.filter(function (r) { return r.cb.checked && !r.cb.disabled; }); }
    function sync() {
      // A Fiche-versie row only makes sense while its fiche is being written.
      rows.forEach(function (r) {
        if (r.kind !== "bump") return;
        var b = bumps.filter(function (x) { return String(x.slot.itemId) === String(r.key); })[0];
        var off = !!(b && excl.fiche[b.fiche.key]);
        r.cb.disabled = off; r.el.classList.toggle("dis", off);
      });
      rows.forEach(function (r) { r.el.classList.toggle("off", !r.cb.checked || r.cb.disabled); });
      var n = chosen().length;
      goBtn.textContent = "Wegschrijven (" + n + ")"; goBtn.disabled = n ? null : "true";
      var away = offscreenStaged().length - cs.held.length;
      sub.textContent = rows.length + (rows.length === 1 ? " wijziging" : " wijzigingen") + (away > 0 ? " (" + away + " uit andere weken)" : "") + (n !== rows.length ? " · " + n + " aangevinkt" : "") + " · nog niets is naar Questi gestuurd" +
        (cs.held.length ? " · " + cs.held.length + " uit andere weken wacht: zelfde reeks als een lesuur hier, schrijf eerst deze weg" : "");
      masterCb.checked = n === rows.length;
    }
    var aside = h("aside", { class: "qwp-cr-aside" }, [
      h("div", { class: "qwp-cr-card" }, [
        h("b", { text: "Zo gaat het" }),
        h("ol", {}, [h("li", { text: "Nieuwe tags aanmaken" }), h("li", { text: "Lesfiches bijwerken — elke fiche krijgt daarbij een nieuwe versie" }), h("li", {}, ["Agenda: lesuren koppelen aan die ", h("b", { text: "nieuwste" }), " versie"])]),
        h("span", { class: "qwp-cr-muted", text: "Enkel losse lesuren — nooit een hele reeks. Lukt een fiche niet, dan blijft een lesuur dat die fiche zou krijgen klaargezet (niet weggeschreven)." })
      ]),
      olderN ? h("div", { class: "qwp-cr-warn" }, [h("b", { text: "Let op: " }), document.createTextNode(olderN + (olderN === 1 ? " lesuur in deze weken is" : " lesuren in deze weken zijn") + " al gepland met een fiche die je bewerkt. " + (bumps.length ? "Vink een ‘Fiche-versie’-rij uit om dat lesuur op de oude versie te laten. " : "") + "Lesuren buiten de geladen weken blijven op de oude versie.")]) : null,
      lp.fiches.length ? h("label", { class: "qwp-cr-card qwp-cr-backup" }, [backupCb, h("span", {}, [h("b", { text: "Eerst een back-up downloaden" }), h("br"), h("span", { class: "qwp-cr-muted", text: "de " + lp.fiches.length + " fiche(s) zoals ze nu zijn (.json)" })])]) : null,
      h("span", { class: "qwp-spacer" }),
      goBtn,
      h("button", { class: "qwp-cr-back", onclick: function () { modal.remove(); }, text: "Terug, nog niets doen" })
    ]);
    var modal = h("div", { class: "qwp-modal qwp-cr", id: "qwp-modal" }, [
      h("div", { class: "qwp-cr-box", role: "dialog", "aria-label": "Controleer en wegschrijven" }, [
        h("header", { class: "qwp-cr-hd" }, [
          h("button", { class: "qwp-navarrow", "aria-label": "Terug", title: "Terug, nog niets doen", onclick: function () { modal.remove(); }, text: "←" }),
          h("div", { class: "qwp-cr-titles" }, [h("span", { class: "qwp-cr-title", text: "Controleer & wegschrijven" }), sub]),
          h("span", { class: "qwp-spacer" }),
          h("label", { class: "qwp-cr-all" }, [masterCb, h("span", { text: "Alles aangevinkt" })])
        ]),
        h("div", { class: "qwp-cr-main" }, [h("div", { class: "qwp-cr-secs" }, secs), aside])
      ])
    ]);
    sync();
    els.page.appendChild(modal);
    function approve() {
      var sel = {
        tagKeys: lp.tags.filter(function (t) { return !excl.tag[t.key]; }).map(function (t) { return t.key; }),
        ficheKeys: lp.fiches.filter(function (f) { return !excl.fiche[f.key]; }).map(function (f) { return f.key; }),
        ficheIdByKey: {}, calIds: {}, bumpIds: {}, backup: !!(lp.fiches.length && backupCb.checked),
        leftOut: rows.length - chosen().length
      };
      lp.fiches.forEach(function (f) { sel.ficheIdByKey[f.key] = f.ficheId; });
      plan.forEach(function (p) { if (!excl.cal[p.itemId]) sel.calIds[p.itemId] = true; });
      bumps.forEach(function (b) { if (!excl.bump[b.slot.itemId] && !excl.fiche[b.fiche.key]) sel.bumpIds[b.slot.itemId] = true; });
      if (!sel.tagKeys.length && !sel.ficheKeys.length && !Object.keys(sel.calIds).length && !Object.keys(sel.bumpIds).length) return;
      modal.remove();
      runSharedWrite(sel);
    }
  }
  // Approved: tags → fiches → remap slots to the new fiche ids → calendar (doCommit). Progress per
  // phase in the commit overlay; one summary at the end. A lesuur whose fiche write FAILED is held
  // back (its staged state stays) instead of being attached to a version that may now be stale.
  var _commitAfter = null;
  function runSharedWrite(sel) {
    var L = lessonsApi(), rep = { tags: null, fiches: null, backup: null, held: [], remapped: 0 };
    var n12 = sel.tagKeys.length + sel.ficheKeys.length;
    function msg(t) { var m = elId("qwp-commit-msg"); if (m) m.textContent = t; }
    var chain = Promise.resolve();
    if (n12 && L) {
      showCommitOverlay(n12);
      if (sel.backup && sel.ficheKeys.length) chain = chain.then(function () {
        msg("Back-up van " + sel.ficheKeys.length + " fiche(s) maken…");
        return L.backupPending(sel.ficheKeys).then(function (b) { rep.backup = b; }, function () { rep.backup = { downloaded: false, missing: 0 }; });
      });
      if (sel.tagKeys.length) chain = chain.then(function () {
        msg("1/3 · Nieuwe tags aanmaken…"); setStatus("Tags aanmaken…");
        return L.writeTags(sel.tagKeys, function (d) { updateCommitOverlay(d, n12); }).then(function (r) { rep.tags = r; });
      });
      if (sel.ficheKeys.length) chain = chain.then(function () {
        msg("2/3 · Lesfiches bijwerken — elke fiche krijgt een nieuwe versie…"); setStatus("Lesfiches bijwerken…");
        return L.writeFiches(sel.ficheKeys, function (d) { updateCommitOverlay(sel.tagKeys.length + d, n12); }).then(function (r) { rep.fiches = r; });
      });
    }
    chain.then(function () {
      // ---- remap: every slot pointing at an old version of a fiche written in THIS run ----
      var byOld = {}, failedFid = {};
      var map = (rep.fiches && rep.fiches.map) || {};
      Object.keys(map).forEach(function (k) { byOld[String(map[k].oldId)] = map[k]; });
      ((rep.fiches && rep.fiches.fails) || []).forEach(function (f) { failedFid[String(sel.ficheIdByKey[f.key])] = f.title; });
      var held = {}, cs = commitSlots();
      cs.slots.forEach(function (s) {
        if (!s.isEditable || s.idCalendar === "cal_holidays" || s.isGym || !s.ficheContentId) return;
        var fid = String(s.ficheContentId), newAssign = fid !== String(s.origFicheContentId || "");
        var m = byOld[fid];
        if (m) {
          // A newly assigned fiche always follows (it stays staged even when left out of this run);
          // an already-attached one only when its row is written now or its Fiche-versie row is ticked.
          if (!(newAssign || sel.calIds[s.itemId] || sel.bumpIds[s.itemId])) return;
          var oldTitle = s.ficheTitle || "";
          s.ficheContentId = m.newId; s.ficheTitle = m.subject || oldTitle;
          if (oldTitle && normTitle(s.title) === normTitle(oldTitle)) s.title = s.ficheTitle;
          rep.remapped++;
        } else if (failedFid[fid] && newAssign && sel.calIds[s.itemId]) {
          held[s.itemId] = true;
          rep.held.push(slotWhere(s) + " — fiche ‘" + failedFid[fid] + "’ werd niet bijgewerkt");
        }
      });
      var plan = buildCommitPlan(cs.slots).filter(function (p) { return (sel.calIds[p.itemId] || sel.bumpIds[p.itemId]) && !held[p.itemId]; });
      if (!plan.length) { finishSharedWrite(rep, sel, [], 0, []); return; }
      setStatus("3/3 · Agenda wegschrijven…");
      _commitAfter = function (ok, fails) { finishSharedWrite(rep, sel, plan, ok, fails); };
      _approvedPlan = plan;
      doCommit();
    }).catch(function (e) {
      console.error("[QWP] shared write:", e);
      finishSharedWrite(rep, sel, [], 0, [{ label: "wegschrijven", error: String((e && e.message) || e) }]);
    });
  }
  function finishSharedWrite(rep, sel, plan, ok, calFails) {
    var L = lessonsApi();
    // Written rows are no longer staged: take their new state as the stored one, so anything left
    // out (or held back) stays staged on screen without a reload.
    plan.forEach(function (p) {
      if (!p.done) return;
      var s = slotByItemId(p.itemId); if (!s) return;
      s.origTitle = s.title; s.origDescription = p.patchBody.description || "";
      s.origFicheContentId = s.ficheContentId; s.origFicheTitle = s.ficheTitle;
    });
    var tagFails = (rep.tags && rep.tags.fails) || [], ficheFails = (rep.fiches && rep.fiches.fails) || [];
    var trial = (rep.fiches && rep.fiches.trialMisses) || [];
    var tagsOk = (rep.tags && rep.tags.created.length) || 0, fichesOk = rep.fiches ? Object.keys(rep.fiches.map).length : 0;
    var problems = tagFails.length + ficheFails.length + calFails.length + rep.held.length + trial.length + (rep.backup && !rep.backup.downloaded ? 1 : 0);
    var wrote = tagsOk + fichesOk + ok;
    var leftover = totalStagedCount();
    try { if (L && L.afterSharedWrite) L.afterSharedWrite(); } catch (e) {}
    refreshStaged();
    if (!problems && !leftover) {
      // Everything landed and nothing is left staged → reload so Questi's own SPA shows it.
      setStatus("Klaar: alles weggeschreven — Questi wordt vernieuwd…");
      if (!elId("qwp-commit-overlay")) showCommitOverlay(1);
      updateCommitOverlay(1, 1);
      msg2("Klaar — Questi wordt vernieuwd…");
      var sp = document.querySelector("#qwp-commit-overlay .qwp-spinner"); if (sp) sp.style.display = "none";
      setTimeout(function () { try { location.reload(); } catch (e) { hideCommitOverlay(); reloadAndRender(); } }, 1200);
      return;
    }
    // Otherwise: a summary per phase. Failed rows stay staged; nothing was guessed.
    var lines = [];
    if (rep.backup) lines.push(rep.backup.downloaded ? ("Back-up gedownload" + (rep.backup.missing ? " — " + rep.backup.missing + " fiche(s) konden niet gelezen worden en staan onvolledig in de back-up." : ".")) : ["warn", "Back-up NIET gedownload — het wegschrijven ging toch door."]);
    if (rep.tags) lines.push(tagFails.length ? ["warn", "Tags: " + tagsOk + " aangemaakt, " + tagFails.length + " mislukt — " + tagFails.map(function (f) { return f.title + ": " + f.error; }).join(" · ") + " (blijft klaargezet)."] : ("Tags: " + tagsOk + " aangemaakt."));
    if (rep.fiches) lines.push(ficheFails.length ? ["warn", "Lesfiches: " + fichesOk + " bijgewerkt, " + ficheFails.length + " mislukt — " + ficheFails.map(function (f) { return f.title + ": " + f.error; }).join(" · ") + " (blijft klaargezet)."] : ("Lesfiches: " + fichesOk + " bijgewerkt (nieuwe versie)."));
    if (trial.length) lines.push(["warn", "Niet overgenomen door Questi — " + trial.join(" · ")]);
    if (rep.remapped) lines.push(rep.remapped + " lesuur/lesuren gekoppeld aan de nieuwste fiche-versie.");
    rep.held.forEach(function (t) { lines.push(["warn", "Niet weggeschreven: " + t + ". Dit lesuur blijft klaargezet met de huidige versie — probeer opnieuw na de fiche."]); });
    if (plan.length) lines.push(calFails.length ? ["warn", "Agenda: " + ok + " lesuur/lesuren weggeschreven, " + calFails.length + " mislukt — " + calFails.map(function (f) { return f.label + ": " + f.error; }).slice(0, 4).join(" · ")] : ("Agenda: " + ok + " lesuur/lesuren weggeschreven."));
    else if (calFails.length) lines.push(["warn", "Fout: " + calFails[0].error]);
    if (sel.leftOut || leftover) lines.push(leftover + " wijziging(en) blijven klaargezet" + (sel.leftOut ? " (waarvan " + sel.leftOut + " bewust uitgevinkt)" : "") + " — zie Controleer.");
    if (calFails.length && leftover === calFails.length) reloadAndRender();   // only failures left: show what did persist
    else renderTimetable();
    if (fichesOk) { view.ficheCache = {}; loadOwnFiches().then(renderAllPanels).catch(function () {}); }   // the sidebar list held old fiche ids
    if (tagsOk) { invalidateOwnTags(); fetchOwnTags().then(function (t) { view.ownTags = t; view.ownTopTags = topTagsForOwner(view.ownTags, ctx.ownerId); renderAllPanels(); }); }
    setStatus(problems ? "Weggeschreven met " + problems + " probleem/problemen — zie overzicht." : "Weggeschreven: " + wrote + ".");
    sharedResultCard(lines, !!problems);
  }
  function msg2(t) { var m = elId("qwp-commit-msg"); if (m) m.textContent = t; }
  function sharedResultCard(lines, bad) {
    if (!elId("qwp-commit-overlay")) showCommitOverlay(1);
    var ov = elId("qwp-commit-overlay"), card = ov && ov.querySelector(".qwp-commit-card"); if (!card) return;
    var sp = ov.querySelector(".qwp-spinner"); if (sp) sp.style.display = "none";
    msg2(bad ? "Klaar, met aandachtspunten:" : "Klaar.");
    var m = elId("qwp-commit-msg"); if (m) m.classList.toggle("err", bad);
    var list = h("ul", { class: "qwp-cr-result" }, lines.map(function (l) { return Array.isArray(l) ? h("li", { class: "warn", text: l[1] }) : h("li", { text: l }); }));
    card.appendChild(list);
    card.appendChild(h("button", { class: "qwp-btn", text: "Sluiten", onclick: hideCommitOverlay }));
  }
  // Human-ish spacing between writes: a base delay + random jitter, so the burst is never
  // perfectly periodic (metronomic timing is itself a bot fingerprint). Base is configurable
  // via Instellingen; raise it if Questi ever complains about write rate.
  function commitDelay() {
    var base = (state.saveThrottleMs != null ? state.saveThrottleMs : 250);
    return base + Math.floor(Math.random() * (base > 0 ? base : 150));
  }
  function doCommit() {
    if (busyLoading()) return;
    if (!_approvedPlan || !_approvedPlan.length) { _commitAfter = null; setStatus("Niets goedgekeurd."); return; }
    var plan = _approvedPlan, i = 0, ok = 0, fails = [];
    setStatus("Bezig met wegschrijven…");
    showCommitOverlay(plan.length);
    function finish() {
      _approvedPlan = null;
      var cb = elId("qwp-commit"); if (cb) { cb.setAttribute("disabled", "true"); cb.classList.remove("armed"); }
      // The shared Controleer (runSharedWrite) reports all three phases itself.
      if (_commitAfter) { var after = _commitAfter; _commitAfter = null; after(ok, fails); return; }
      if (fails.length) {
        var first = fails[0];
        setStatus(ok + " ok, " + fails.length + " fout: " + first.label + " — " + first.error + (fails.length > 1 ? " (+ " + (fails.length - 1) + " meer, zie console)" : ""));
        console.error("[QWP] commit failures:", JSON.stringify(fails));
        commitOverlayResult(ok, fails);
        reloadAndRender(); // refresh the planner for what did persist
        return;
      }
      // Full success → reload the page so Questi's own calendar reflects the writes
      // (its SPA doesn't refetch on its own). The overlay stays up during reload → no edits.
      setStatus("Klaar: " + ok + "/" + plan.length + " weggeschreven — Questi wordt vernieuwd…");
      updateCommitOverlay(plan.length, plan.length);
      var m = elId("qwp-commit-msg"); if (m) m.textContent = "Klaar — Questi wordt vernieuwd…";
      var sp = document.querySelector("#qwp-commit-overlay .qwp-spinner"); if (sp) sp.style.display = "none";
      setTimeout(function () { try { location.reload(); } catch (e) { hideCommitOverlay(); reloadAndRender(); } }, 1200);
    }
    function next() {
      if (i >= plan.length) { finish(); return; }
      var p = plan[i++];
      // Guard: never PATCH a lesuur without a real group (would 500 on id_groep null).
      if (!p.patchBody.groups || !p.patchBody.groups.length) {
        fails.push({ label: p.label, error: "geen groep gevonden — vernieuw context" });
        updateCommitOverlay(ok + fails.length, plan.length); setTimeout(next, 0); return;
      }
      // POST the fiche first (Questi then retitles the item "* <fiche> (1)"), THEN PATCH title +
      // description=vak. The PATCH deliberately writes OUR plain title (or the thema-prefixed one)
      // and never adopts Questi's decorated response title. (No-fiche rows carry attachments:[].)
      // descEcho (descriptions off, never read at hydrate): copy the stored description into the
      // PATCH first, so it is echoed instead of blanked. A failed read fails this row — never guess.
      (p.descEcho ? fetchItemDetail(p.itemId).then(function (d) { if (!d) throw new Error("beschrijving niet gelezen"); p.patchBody.description = d.description || ""; }) : Promise.resolve())
        .then(function () { return p.fiche ? ((p.fiche.isMethod || view.methodFicheIds[String(p.fiche.contentId)]) ? postMethodAttachment(p.itemId, p.fiche.contentId, p.fiche.groups) : postAttachment(p.itemId, p.fiche.contentId, p.fiche.groups)) : Promise.resolve(null); })
        .then(function () { return patchItem(p.itemId, p.patchBody, p.range); })
        .then(function () { ok++; p.done = true; })
        // Continue on error. A gateway timeout (504 …) usually still lands → re-read + verify
        // instead of hard-failing; only a mismatch is reported as uncertain.
        .catch(function (e) {
          if (isGatewayError(e)) return verifyLanded(p).then(function (landed) { if (landed) { ok++; p.done = true; } else fails.push({ label: p.label, error: "onzeker (504) — controleer/hertry deze" }); });
          fails.push({ label: p.label, error: String(e && e.message || e) });
        })
        // Small delay between slots — sequential PATCH→POST, avoid rate-limiting (no bulk endpoint exists).
        .then(function () { var done = ok + fails.length; setStatus("Wegschrijven " + done + "/" + plan.length + "…"); updateCommitOverlay(done, plan.length); setTimeout(next, commitDelay()); });
    }
    next();
  }
  // After a gateway timeout, re-read the item and check it reflects the intended end-state.
  function verifyLanded(p) {
    return new Promise(function (res) { setTimeout(res, 1500); })
      .then(function () { return fetchItemDetail(p.itemId); })
      .then(function (d) {
        if (!d) return false;
        var has = !!d.has_attachments;
        var titleOk = String(d.title || "") === String(p.patchBody.title || "");
        if (p.fiche) return has;                                   // fiche link → attachment present
        if (p.keepsFiche) return has && titleOk;                   // unchanged fiche → still attached + PATCH landed
        return !has && titleOk;                                    // clear → no attachment + title matches
      }).catch(function () { return false; });
  }

  // ---------- Loading ----------
  function upsertGroup(ownerId, oname, items) { var g = groupFor(ownerId); if (g) { g.items = items; g.ownerName = oname; } else view.ficheGroups.push({ ownerId: ownerId, ownerName: oname, items: items }); }
  function loadOwnFiches() { return fetchAllFiches(myId()).then(function (r) { upsertGroup(myId(), "Ik", r.items); return r; }); }
  // Colleagues changed → refresh shared tags + drop stale per-tag cache, re-render.
  function loadColleagueFiches() {
    _sharedTagsCache = null;
    view.ficheCache = {};
    return fetchSharedTags().then(function (t) { view.sharedTags = t; renderAllPanels(); renderGlobalOwners(); setStatus("Collega's geladen: " + (state.colleagues.map(function (c) { return c.name; }).join(", ") || "geen")); });
  }
  function loadAllFiches() {
    setStatus("Alle eigen lesfiches laden…");
    return loadOwnFiches().then(function (r) {
      renderAllPanels();
      var note = elId("qwp-side-note"); if (note) note.textContent = ((r.total || (groupFor(myId()) || { items: [] }).items.length)) + " eigen lesfiches geladen.";
      setStatus("Alle eigen lesfiches geladen (" + (r.total || 0) + ").");
    }).catch(function () { setStatus("Laden van lesfiches mislukt."); });
  }

  function currentWeekRange() {
    var d = new Date(); var day = (d.getDay() + 6) % 7; var mon = new Date(d); mon.setDate(d.getDate() - day + view.weekOffset * 7);
    var end = new Date(mon); end.setDate(mon.getDate() + (7 * view.weeks - 1));
    return { start: isoDate(mon), end: isoDate(end) };
  }
  // Paint first, details after. Resolves as soon as the LIST is in (view.slots set, every lesuur with a
  // detail to read marked _pending); view.hydrateP resolves true once every detail answered and the grid
  // was repainted with them — or false when a newer load replaced this one. Meanwhile each arriving
  // detail schedules a throttled repaint (scheduleHydratePaint) and the status line counts along.
  var _loadGen = 0, _hydPaintT = null;
  function hydratePending() { return (view.slots || []).filter(function (s) { return s._pending; }).length; }
  function hydrateFailed() { return (view.slots || []).filter(function (s) { return s._detailFailed; }).length; }
  function loadingReason(n) { return "Nog " + n + (n === 1 ? " lesuur" : " lesuren") + " aan het laden — Controleer kan zodra alles geladen is."; }
  // Bulk tools and Controleer call this first; true = refused, with the reason in the status line.
  function busyLoading() { var n = hydratePending(); if (n) setStatus(loadingReason(n)); return n > 0; }
  function syncHydrateStatus() {
    var n = hydratePending(), t = view.hydrateTotal || 0;
    if (n) setStatus("Lesuren laden: " + (t - n) + "/" + t + " — Controleer kan pas als alles geladen is.");
  }
  // Said once the details are in: lesuren whose detail could not be read stay as they are.
  function hydrateFailNote() {
    var f = hydrateFailed();
    return f ? (" · " + f + (f === 1 ? " lesuur kon" : " lesuren konden") + " niet gelezen worden en blijven ongewijzigd — “opnieuw proberen” onderaan links.") : "";
  }
  // Manual retry for lesuren that stayed "niet geladen" after the quiet retries: all of them (sidebar
  // button) or one (the card's "opnieuw"). Same 4-at-a-time limit and quiet retries; Controleer waits
  // meanwhile (they are `_pending` again). Afterwards the vak/fiche checks run once more.
  var _retrying = false;
  function retryFailedDetails(only) {
    if (_retrying) return;
    var failed = (only || view.slots || []).filter(function (s) { return s._detailFailed; });
    if (!failed.length) return;
    _retrying = true;
    failed.forEach(function (s) { s._detailFailed = false; s._pending = true; });
    renderTimetable(); syncRetryBtn();
    setStatus("Opnieuw laden: " + failed.length + (failed.length === 1 ? " lesuur" : " lesuren") + "…");
    mapLimit(failed, 4, function (s) {
      return readSlotDetail(s).then(function () { s._pending = false; scheduleHydratePaint(); });
    }).then(function () {
      _retrying = false;
      applyStoredVakken(view.slots); renderTimetable(); syncRetryBtn();
      var still = hydrateFailed();
      setStatus(still ? (still + (still === 1 ? " lesuur laadt" : " lesuren laden") + " nog steeds niet — probeer later opnieuw of herlaad de pagina.") : "Alle lesuren geladen.");
      resolveFicheVakken(view.slots, function (changed) { var n = applyStoredVakken(view.slots); if (changed || n) renderTimetable(); });
    });
  }
  function syncRetryBtn() {
    var box = els.root && els.root.querySelector(".qwp-side-status"); if (!box) return;
    var n = hydrateFailed(), b = elId("qwp-retry");
    if (!n || _retrying) { if (b) b.remove(); return; }
    if (!b) { b = h("button", { class: "qwp-retry", id: "qwp-retry", type: "button", onclick: function () { retryFailedDetails(); } }); box.appendChild(b); }
    b.textContent = n + (n === 1 ? " lesuur" : " lesuren") + " niet geladen · opnieuw proberen";
  }
  function scheduleHydratePaint() {
    if (_hydPaintT) return;
    _hydPaintT = setTimeout(function () {
      _hydPaintT = null;
      if (!els.root) return;
      // A repaint mid-drag would pull the dragged card out from under the pointer — wait.
      if (els.root.classList.contains("qwp-dragging")) { scheduleHydratePaint(); return; }
      renderTimetable(); syncHydrateStatus(); syncRetryBtn();
    }, 250);
  }
  function reloadWeek() {
    stashCurrent();
    // Undo snapshots address slots by item id within ONE window; across windows they could hit a
    // kept slot of another week, so the history starts fresh per window (kept edits stay staged).
    if (view.undoStack.length) { view.undoStack = []; refreshUndoBtn(); }
    var wr = currentWeekRange(); view.weekStart = wr.start;
    var gen = ++_loadGen;
    setStatus("Rooster laden…");
    var kept = function (s) { return !!(view.stash && view.stash[slotKey(s)]); };
    return hydrateRangeLive(wr.start, wr.end, function () { if (gen === _loadGen) scheduleHydratePaint(); }, kept).then(function (r) {
      if (gen !== _loadGen) return;   // a newer load owns view.slots
      // A lesuur with kept edits comes back as the kept object, re-seated in this window's week rows.
      var base = addDays(wr.start, 0);
      view.slots = r.slots.map(function (s) {
        var k = view.stash && view.stash[slotKey(s)]; if (!k) return s;
        var d0 = addDays(String(k.startdate).slice(0, 10), 0);
        if (d0 && base) k.weekIdx = Math.max(0, Math.floor(Math.round((d0 - base) / 86400000) / 7));
        return k;
      });
      view.slotsStart = wr.start; view.hydrateTotal = r.total;
      reloadSlotVakLabels(); applyStoredVakken(view.slots);
      view.hydrateP = r.done.then(function () {
        if (gen !== _loadGen) return false;
        clearTimeout(_hydPaintT); _hydPaintT = null;
        if (els.root) { renderTimetable(); syncRetryBtn(); }
        return true;
      });
    });
  }
  // Resolves only when the week is FULLY read (settings.js re-reads titles after it).
  function reloadAndRender() {
    return reloadWeek().then(function () {
      renderTimetable(); syncHydrateStatus();
      return view.hydrateP;
    }).then(function (current) {
      if (!current) return;
      var nt = view.slots.filter(function (s2) { return s2.autoThemaTitle && computeDirty(s2); }).length;
      setStatus((nt ? (nt + " WO/Godsdienst-lesuur/lesuren krijgen de themafiche als titel en het vak als beschrijving — controleer bij Wijzigingen.") : "Rooster geladen.") + hydrateFailNote());
      // Then, without blocking the paint, find out which fiches disagree with their lesuur's vak.
      resolveFicheVakken(view.slots, function (changed) {
        var n = applyStoredVakken(view.slots);
        if (changed || n) renderTimetable();
        var dirty = view.slots.filter(function (s2) { return s2.ficheContentId && computeDirty(s2); }).length;
        if (n && dirty) setStatus(dirty + " lesuur/lesuren krijgen het vak van hun fiche als beschrijving — controleer bij Wijzigingen. Enkel de beschrijving wordt aangepast.");
      });
    });
  }

  // ---------- Boot / toggle ----------
  function show() { if (els.root) els.root.classList.add("qwp-show"); document.documentElement.classList.add("qwp-locked"); }
  function hide() { if (els.root) els.root.classList.remove("qwp-show"); document.documentElement.classList.remove("qwp-locked"); var p = elId("qwp-pop"); if (p) p.remove(); }
  function toggle() { if (!els.root) { boot(); return; } var open = els.root.classList.toggle("qwp-show"); document.documentElement.classList.toggle("qwp-locked", open); }
  window.__QWP_TOGGLE = toggle;
  // Sidebar tabs. Plannen and Lesfiches swap the sidebar body and the main column inside this one
  // overlay (CSS: #qwp-overlay.qwp-tab-lf hides .qwp-plan-only, shows .qwp-lf-only); the bottom bar
  // (Alles · Instellingen · Debug · Controleer) stays. Lesfiches = lessons.js mounted into
  // #qwp-lf-side / #qwp-lf-main. Switching between all three tabs goes through goTab.
  var _tab = "plan";
  function setTab(name) {
    if (!els.root) return;
    var lf = name === "lesfiches", L = window.__QWP_LESSONS;
    if (lf && !(L && typeof L.mount === "function")) { setStatus("De Lesfiche-manager is niet geladen."); console.warn("[QWP] lessons module niet geladen"); return; }
    _tab = lf ? "lesfiches" : "plan";
    els.root.classList.toggle("qwp-tab-lf", lf);
    Array.prototype.forEach.call(els.root.querySelectorAll("#qwp-side .qwp-tab[data-tab]"), function (b) {
      var on = b.getAttribute("data-tab") === _tab;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    closeMenu("qwp-allesmenu"); closeMenu("qwp-srcmenu");
    var pop = elId("qwp-pop"); if (pop) pop.remove();
    if (!lf) { if (L && L.unmount) L.unmount(); return; }
    resetPrintFicheGoals();   // fiche goals may change on this tab; Doelen/print re-read them
    var go = function () { if (_tab === "lesfiches") L.mount(elId("qwp-lf-side"), elId("qwp-lf-main"), { onClose: hide }); };
    if (ctx.ready) go();
    else { setStatus("Context laden vóór lesfichebeheer…"); detectContext().then(go); }
  }
  // The Lesfiche-manager is the planner's Lesfiches tab: open (or boot) the planner on that tab.
  function openLessonsManager() {
    if (!(window.__QWP_LESSONS && window.__QWP_LESSONS.mount)) { console.warn("[QWP] lessons module niet geladen"); return; }
    if (!els.root) boot(); else show();
    goTab("lesfiches");
  }
  // Exposed so the in-page quick menu "Lesfiches" (content.js) opens the planner on that tab,
  // even when the planner overlay was never opened — boot detects context on demand.
  window.__QWP_OPEN_LESSONS = openLessonsManager;
  // Staged-but-unwritten changes for the badge on the toolbar launcher (content.js): calendar
  // changes (same filter as buildCommitPlan) + staged fiche edits + tags to create — the same
  // number the Controleer badge shows.
  window.__QWP_PENDING_COUNT = totalStagedCount;

  function reconcilePanelSources() {
    var valid = [String(myId())].concat(state.colleagues.map(function (c) { return String(c.id); }));
    [0, 1, 2].forEach(function (i) { if (valid.indexOf(String(view.panels[i].source)) < 0) { view.panels[i].source = myId(); state.panels[i].source = myId(); } });
  }
  function showContextError() {
    var wrap = elId("qwp-ttwrap"); if (wrap) {
      wrap.innerHTML = "";
      var sidInp = h("input", { class: "qwp-input", id: "qwp-manual-sid", placeholder: "bv. 1010", value: (state.manualSchoolId != null ? String(state.manualSchoolId) : (ctx.schoolId != null ? String(ctx.schoolId) : "")) });
      var syrInp = h("input", { class: "qwp-input", id: "qwp-manual-syr", placeholder: "bv. 2025-2026", value: (state.manualSchoolyear || ctx.schoolyear || "") });
      var tagInp = h("input", { class: "qwp-input", id: "qwp-manual-tag", placeholder: "bv. 5", value: (state.manualOwnTagId != null ? String(state.manualOwnTagId) : "") });
      wrap.appendChild(h("div", { class: "qwp-ctxerr" }, [
        h("div", { class: "qwp-ctxerr-t", text: "Questi-context / lesfiche-tag handmatig instellen" }),
        h("div", { class: "qwp-ctxerr-b", text: "Vul in wat niet automatisch gevonden werd. Open F12 → Netwerk → klik een /api/cal/lessons-aanvraag → in de URL staat 'schoolId=' en 'default_tagId=' (jouw eigen lesfiche-tag). Het schooljaar staat als 'schoolyear='." }),
        h("div", { class: "qwp-ctxerr-form" }, [
          h("div", { class: "qwp-field" }, [h("label", { text: "schoolId" }), sidInp]),
          h("div", { class: "qwp-field" }, [h("label", { text: "schooljaar" }), syrInp]),
          h("div", { class: "qwp-field" }, [h("label", { text: "eigen lesfiche-tag (default_tagId)" }), tagInp])
        ]),
        h("div", { class: "qwp-ctxerr-btns" }, [
          h("button", { class: "qwp-btn qwp-ghost", onclick: retryDetect, text: "Opnieuw auto-detecteren" }),
          h("button", { class: "qwp-btn", onclick: function () {
            var sid = sidInp.value.trim(); var syr = syrInp.value.trim(); var tag = tagInp.value.trim();
            if (sid && !/^\d{1,12}$/.test(sid)) { setStatus("schoolId moet een getal zijn."); return; }
            if (tag && !/^\d{1,12}$/.test(tag)) { setStatus("lesfiche-tag moet een getal zijn."); return; }
            if (sid) state.manualSchoolId = +sid;
            state.manualSchoolyear = syr || null;
            state.manualOwnTagId = tag ? +tag : null;
            saveState();
            setStatus("Handmatige instellingen bewaard — laden…");
            retryDetect();
          }, text: "Bewaren en laden" })
        ])
      ]));
    }
    setStatus("Context-detectie mislukt — vul gegevens handmatig in.");
    console.error("[QWP] context detection failed. ctx=", ctx);
  }
  // Cheap logged-in probe. A logged-out Questi answers an API GET with an HTML login redirect
  // (or 401/403). Only a CLEAR negative → "loggedout"; JSON 200 → "authed"; anything ambiguous
  // (network hiccup, odd status) → "unknown", so we fall through to the normal boot path and
  // never block a working session.
  function authProbe() {
    return fetch(API_ROOT + "/schools", { credentials: "include", headers: { "Accept": "application/json" } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) return "loggedout";
        if ((r.headers.get("content-type") || "").indexOf("json") < 0) return "loggedout"; // HTML/login page
        return "authed";
      })
      .catch(function () { return "unknown"; });
  }
  // Full-cover "log in first" state (only shown on a clear logged-out probe).
  function showLoginRequired() {
    if (elId("qwp-login")) return;
    var box = h("div", { class: "qwp-login-box" }, [
      h("div", { class: "qwp-login-t", text: "Log eerst in op Questi" }),
      h("div", { class: "qwp-login-b", text: "De weekplanner gebruikt je eigen Questi-sessie. Je bent niet (meer) ingelogd. Log in op questi.com en probeer daarna opnieuw." }),
      h("div", { class: "qwp-login-btns" }, [
        h("button", { class: "qwp-btn", text: "Open questi.com", onclick: function () { try { window.open("https://www.questi.com", "_blank", "noopener"); } catch (e) {} } }),
        h("button", { class: "qwp-btn qwp-approve", text: "Ik ben ingelogd — probeer opnieuw", onclick: function () {
          var o = elId("qwp-login"); if (o) o.remove();
          setStatus("Opnieuw proberen…");
          authProbe().then(function (st) {
            if (st === "loggedout") { showLoginRequired(); return; }
            return detectContext().then(function () { if (!ctx.schoolId) { showContextError(); return; } return loadEverything(); });
          }).catch(function (e) { console.error("[QWP] login retry error:", e); setStatus("Laadfout — probeer 'Vernieuwen'."); });
        } })
      ])
    ]);
    els.page.appendChild(h("div", { class: "qwp-login", id: "qwp-login" }, [box]));
    setStatus("Niet ingelogd op Questi.");
  }
  // Non-destructive prompt for the per-user lesfiche tag (grid stays visible).
  function openOwnTagPrompt() {
    if (elId("qwp-modal")) return;
    var inp = h("input", { class: "qwp-input", placeholder: "bv. 5", value: (state.manualOwnTagId != null ? String(state.manualOwnTagId) : "") });
    var modal = h("div", { class: "qwp-modal", id: "qwp-modal" }, [
      h("div", { class: "qwp-modal-box" }, [
        h("div", { class: "qwp-modal-hd", text: "Eigen lesfiche-tag instellen" }),
        h("div", { class: "qwp-modal-body" }, [
          h("p", { class: "qwp-note", text: "Je eigen lesfiches konden niet automatisch geladen worden. Open F12 → Netwerk → open je lessenlijst in Questi → klik de /api/cal/lessons-aanvraag → kopieer het getal na 'default_tagId=' uit de URL." }),
          h("div", { class: "qwp-field" }, [h("label", { text: "default_tagId" }), inp])
        ]),
        h("div", { class: "qwp-modal-ft" }, [
          h("button", { class: "qwp-btn qwp-ghost", text: "Later", onclick: function () { modal.remove(); } }),
          h("button", { class: "qwp-btn", text: "Bewaren en laden", onclick: function () {
            var v = inp.value.trim(); if (!/^\d{1,12}$/.test(v)) { setStatus("lesfiche-tag moet een getal zijn."); return; }
            state.manualOwnTagId = +v; ctx.ownDefaultTagId = +v; saveState(); modal.remove();
            setStatus("Lesfiche-tag bewaard — laden…");
            loadOwnFiches().then(function () { renderAllPanels(); var note = elId("qwp-side-note"); if (note) note.textContent = (groupFor(myId()) || { items: [] }).items.length + " eigen lesfiches geladen."; });
          } })
        ])
      ])
    ]);
    els.page.appendChild(modal);
  }
  function loadEverything() {
    var sub = elId("qwp-sub"); if (sub) sub.textContent = ctx.schoolyear || "";
    reconcilePanelSources();
    // schoolId is fine but the per-user lesfiche tag wasn't found → let the user
    // paste it (grid still renders; only the fiche panels need the tag).
    if (ctx.ownDefaultTagId == null && state.manualOwnTagId == null) { openOwnTagPrompt(); }
    // reloadWeek resolves at the LIST stage: the grid paints here while the details keep coming in.
    return Promise.all([fetchPeople(), fetchTags(), fetchOwnTags(), fetchSharedTags(), reloadWeek()]).then(function (res) {
      view.people = res[0]; view.tags = res[1]; view.ownTags = res[2]; view.sharedTags = res[3];
      view.ownTopTags = topTagsForOwner(view.ownTags, ctx.ownerId);
      buildVakTagMap();
      migrateSettingsToTagIds();
      reloadSlotVakLabels();
      renderTimetable(); syncHydrateStatus();
      markPlannerReady(true);   // context, tags and the week list: enough for the Afdrukken tab
      renderAllPanels(); // pills from real tags; each panel lazy-loads its tag's fiches
      renderGlobalOwners();
      return loadOwnFiches(); // full own list (for the slot popup search) via tag 5
    }).then(function () {
      var note = elId("qwp-side-note"); if (note) note.textContent = (groupFor(myId()) || { items: [] }).items.length + " eigen lesfiches geladen.";
      // The health check reads ctx.groupId, which only an item DETAIL supplies — and the first-run
      // wizard reads stored titles/descriptions: both wait for the week to be fully read.
      return view.hydrateP;
    }).then(function () {
      setStatus((state.colleagues.length ? ("Klaar. Collega's: " + state.colleagues.map(function (c) { return c.name; }).join(", ")) : "Klaar.") + hydrateFailNote());
      quickHealthCheck();
      // Week, tags and fiches are in: settings.js listens for this to auto-open first-run setup.
      try { document.dispatchEvent(new CustomEvent("qwp:loaded")); } catch (e) {}
    });
  }
  // Cheap on-open sanity check — if anything that breaks writes/fiches is missing, make the
  // Debug button glow red (no message; user clicks Debug for details).
  function quickHealthCheck() {
    var problem = !ctx.ready || ctx.schoolId == null || ctx.groupId == null || ctx.ownDefaultTagId == null || ((groupFor(myId()) || { items: [] }).items.length === 0);
    var b = elId("qwp-debug"); if (b) b.classList.toggle("qwp-alert", !!problem);
    // A non-technical user never clicks Debug on their own — surface the problem loudly.
    if (problem) showToast("Sommige gegevens werden niet gevonden — de planner werkt mogelijk niet volledig.", "Diagnose", openDiagnose);
    return problem;
  }
  function retryDetect() {
    setStatus("Opnieuw detecteren…");
    detectContext().then(function () { if (!ctx.schoolId) { showContextError(); return; } return loadEverything(); }).catch(function (e) { console.error("[QWP] retry error:", e); setStatus("Laadfout — probeer 'Vernieuwen'."); });
  }

  // Resolves once loadEverything has context, tags and the week list (the Afdrukken tab waits on it);
  // rejected when boot stops (logged out, no context, load error) — a later retry makes a fresh one.
  var _readyD = null;
  function readyDeferred() {
    if (!_readyD) {
      var d = _readyD = {};
      d.p = new Promise(function (res, rej) { d.res = res; d.rej = rej; });
      d.p.catch(function () {});
    }
    return _readyD;
  }
  function plannerReady() {
    if (view.ready) return Promise.resolve();
    if (view.bootFailed) return Promise.reject(new Error("planner-not-ready"));   // never wait forever
    return readyDeferred().p;
  }
  function markPlannerReady(ok) {
    var d = readyDeferred();
    if (ok) { view.ready = true; view.bootFailed = false; d.res(); }
    else if (!view.ready) { view.bootFailed = true; d.rej(new Error("planner-not-ready")); _readyD = null; }
  }
  // tab: "print" opens straight on Afdrukken (window.__QWP_PRINT).
  function boot(tab) {
    var root = buildShell();
    document.body.appendChild(root);
    show();
    if (tab === "print") goTab("print");
    checkForUpdate(); // best-effort GitHub version check → banner if a newer release exists
    // Ctrl/⌘+Z undo — only while the panel is open and not editing text.
    document.addEventListener("keydown", function (e) {
      if (!els.root || !els.root.classList.contains("qwp-show")) return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || (e.key !== "z" && e.key !== "Z")) return;
      if (view.tab === "print") return;   // nothing to undo on the Afdrukken tab
      var t = e.target, tn = t && t.tagName;
      if (tn === "INPUT" || tn === "TEXTAREA" || tn === "SELECT" || (t && t.isContentEditable)) return;
      e.preventDefault(); doUndo();
    });
    // Close the global-search dropdown when clicking outside it.
    document.addEventListener("mousedown", function (e) {
      var bar = elId("qwp-globalsearch"); if (!bar) return;
      if (!bar.contains(e.target)) closeGlobalResults();
    });
    loadState().then(function () {
      view.weeks = 2;   // Plannen always shows this week + next; state.weeks stays the print default
      applySideWidth();
      [0, 1, 2].forEach(function (i) { if (state.panels[i]) view.panels[i] = Object.assign(view.panels[i], state.panels[i]); });
      view.panels[0].autoBlock = true;   // first list load opens the stored vak on its current block
      applyFilterFold(); syncModeSeg();
      setStatus("Questi-context detecteren…");
      return authProbe().then(function (st) {
        if (st === "loggedout") { showLoginRequired(); return "__STOP__"; }
        return detectContext();
      });
    }).then(function (r) {
      if (r === "__STOP__") { markPlannerReady(false); return; }   // logged-out screen shown; don't continue
      if (!ctx.schoolId) { markPlannerReady(false); goTab("plan"); showContextError(); return; }
      // Open on the week the user is viewing in Questi (else today): seed weekOffset before the
      // first reloadWeek so currentWeekRange() lands on it. Nav buttons work from this base.
      var ow = resolveOpenWeek(), todayMon = mondayOf(isoDate(new Date()));
      if (ow.fromQuesti && todayMon) view.weekOffset = Math.round((addDays(ow.start, 0) - addDays(todayMon, 0)) / 604800000);
      else view.weekOffset = 0;
      view.weekFromQuesti = ow.fromQuesti;
      return loadEverything().then(function () {
        // Say which rule picked the week — the fallback is the common path, not an error.
        setStatus((ow.fromQuesti ? "Week overgenomen uit Questi." : "Week van vandaag geladen.") + hydrateFailNote());
      });
    }).catch(function (e) { console.error("[QWP] boot error:", e); markPlannerReady(false); setStatus("Laadfout — probeer 'Vernieuwen'."); });
  }
  window.__QWP_PRINT = openPrintTab;

  // Test hook (no effect in the browser).
  window.__QWP_TEST = { boot: boot, view: view, state: state, ctx: ctx, detectContext: detectContext, renderTimetable: renderTimetable, openSlotPopup: openSlotPopup, openMassAdd: openMassAdd, openInstellingen: openInstellingen };

  // Read-only helper bag for the sibling Lesfiche-manager module (lessons.js), which
  // loads after planner.js. `ctx` is shared BY REFERENCE, so lessons.js always sees the
  // live detected context (schoolId/schoolyear/ownerId/…) once detectContext resolves.
  window.__QWP_SHARED = {
    ctx: ctx, API: API, API_ROOT: API_ROOT, IS_BETA: IS_BETA, betaPill: betaPill,
    jget: jget, qs: qs, xsrfToken: xsrfToken, writeHeaders: writeHeaders,
    fetchTags: fetchTags, fetchOwnTags: fetchOwnTags, fetchSharedTags: fetchSharedTags, invalidateOwnTags: invalidateOwnTags,
    topTagsForOwner: topTagsForOwner, childTags: childTags, tagTitle: tagTitle, tagColor: tagColor,
    ownerName: ownerName, h: h,
    // Methodes panel (methodes.js)
    // schoolYearBounds/usedThisYear stay private: the Methodes panel derives its own bounds so
    // the teacher can look at a previous school year.
    detectContext: detectContext,
    fetchMethods: fetchMethods, fetchMethodLessons: fetchMethodLessons,
    fetchAllFichesByTag: fetchAllFichesByTag, storeGet: storeGet, storeSet: storeSet,
    // Lesdoelen in the fiche (lessons.js goals mode, print)
    ficheGoalFields: ficheGoalFields, goalText: goalText, noteFicheThread: noteFicheThread, vakAbbr: vakAbbr, refreshVakPicker: function () { renderVakToggle(0); renderSubcats(0); },
    mapLimit: mapLimit,
    // Settings module (settings.js). `state`/`view` are shared BY REFERENCE: settings edits the
    // planner's own qwp_state_v6 object and persists it through saveState, never a copy.
    state: state, view: view, loadState: loadState, saveState: saveState, setStatus: setStatus,
    ownTagsList: ownTagsList, anyTagById: anyTagById, topTagIdOf: topTagIdOf, panelTopTags: panelTopTags,
    computeTimeRows: computeTimeRows, isNoSchool: isNoSchool, renderTimetable: renderTimetable,
    reloadSlotVakLabels: reloadSlotVakLabels, reloadAndRender: reloadAndRender,
    isThemaSlot: isThemaSlot, themaIdentity: themaIdentity, setThemaVakOverride: setThemaVakOverride,
    ensureThemaKeys: ensureThemaKeys, normTitle: normTitle, stripQuestiDecoration: stripQuestiDecoration,
    fetchPeople: fetchPeople, loadColleagueFiches: loadColleagueFiches, METHOD_PREFIX: METHOD_PREFIX,
    openDiagnose: openDiagnose, recentApiErrors: recentApiErrors, noteApiError: noteApiError,
    DAY_NAMES: DAY_NAMES,
    // Lesfiches tab (lessons.js mounted): its staged edits feed the shared Controleer + badges.
    refreshStaged: refreshStaged, openReview: openReview
  };
})();
