// PatchGoblin write-safety tests. Run: node tests/run.js  (Node built-ins only — no npm, no deps.)
// Loads lessons.js into a sandbox against a fake Questi (in-memory fiches + tags) and checks that a
// write without a clear answer is never blindly repeated. Not part of the extension (not in the
// manifest). Keep it small: one test per failure scenario that once could lose or duplicate data.
"use strict";
var vm = require("vm"), fs = require("fs"), path = require("path"), assert = require("assert");
var SRC = fs.readFileSync(path.join(__dirname, "..", "lessons.js"), "utf8");
var REPO = path.join(__dirname, "..");

// ---- Fake Questi -------------------------------------------------------------------------------
function makeServer() {
  var srv = { fiches: {}, tags: {}, seq: 1000, calls: [], faults: [] };
  // A fault is { op, mode }: "drop" = request rejected before Questi saw it,
  // "lost" = Questi applied it but the answer never came; "fail" = a read that errors;
  // "garbled" = Questi applied it and said 200, but the body is unreadable.
  srv.fault = function (op, mode) { srv.faults.push({ op: op, mode: mode }); };
  function takeFault(op) { var i = srv.faults.findIndex(function (f) { return f.op === op; }); return i < 0 ? null : srv.faults.splice(i, 1)[0]; }
  srv.addFiche = function (f) { var id = String(++srv.seq); srv.fiches[id] = Object.assign({ id: id, thread: "t" + id, subject: "", fields: [], tags: [], grades: [], newest: true }, f); return srv.fiches[id]; };
  function newest(num, offset) {
    return Object.keys(srv.fiches).map(function (k) { return srv.fiches[k]; })
      .filter(function (f) { return f.newest; }).sort(function (a, b) { return Number(b.id) - Number(a.id); }).slice(offset, offset + num)
      .map(function (f) { return { id: f.id, subject: f.subject }; });
  }
  function patchFiche(id, body) {
    var old = srv.fiches[id]; if (!old) return { status: "error", error_msg: "1235" };
    var fields = old.fields.map(function (f) { var c = JSON.parse(JSON.stringify(f)); var b = (body.fields || []).filter(function (x) { return String(x.id) === String(f.id); })[0]; if (b && b.content !== undefined) c.content = b.content; return c; });
    (body.fields || []).filter(function (x) { return x.id == null; }).forEach(function (x) { fields.push({ id: ++srv.seq, type: "text", title: x.title, template_field_id: null, content: x.content }); });
    old.newest = false;
    var nf = srv.addFiche({ thread: old.thread, subject: body.subject, fields: fields, tags: (body.tags || []).map(function (t) { return { id: t }; }) });
    return { result: { id: nf.id, subject: nf.subject } };
  }
  function handle(method, url, body) {
    var u = new URL(url, "https://questi.test"), p = u.pathname;
    var m;
    if (method === "GET" && p === "/api/cal/lessons") return { result: newest(Number(u.searchParams.get("num")) || 10, Number(u.searchParams.get("offset")) || 0) };
    if (method === "GET" && p === "/api/cal/lessons/tags") return { result: Object.keys(srv.tags).map(function (k) { return srv.tags[k]; }) };
    if (method === "GET" && (m = p.match(/^\/api\/cal\/lessons\/(\d+)$/))) { var f = srv.fiches[m[1]]; return f ? { result: JSON.parse(JSON.stringify(f)) } : { status: "error", error_msg: "nf" }; }
    if (method === "POST" && p === "/api/cal/lessons/user-tags") { var nt = { id: String(++srv.seq), title: body.title.toLowerCase(), color: body.color, parent: body.parent || 0 }; srv.tags[nt.id] = nt; return { result: nt }; }
    if (method === "PATCH" && (m = p.match(/^\/api\/cal\/lessons\/user-tags\/(\d+)$/))) { var t = srv.tags[m[1]]; Object.assign(t, { title: body.title.toLowerCase(), color: body.color, parent: body.parent }); return { result: t }; }
    if (method === "PATCH" && (m = p.match(/^\/api\/cal\/lessons\/(\d+)$/))) return patchFiche(m[1], body);
    if (method === "POST" && p === "/api/cal/lessons") {
      var f2 = srv.addFiche({ subject: body.subject, grades: body.grades, fields: [] });   // Questi drops the WEET/KEN/KAN extras on create
      return { result: { id: f2.id } };
    }
    throw new Error("fake Questi: no route for " + method + " " + p);
  }
  function opName(method, url) {
    var p = new URL(url, "https://questi.test").pathname;
    if (/user-tags/.test(p)) return method + " tag";
    if (method === "GET") return p === "/api/cal/lessons" ? "GET list" : p === "/api/cal/lessons/tags" ? "GET tags" : "GET fiche";
    return method + " lesson";
  }
  srv.fetch = function (url, opts) {
    var method = (opts && opts.method) || "GET", body = opts && opts.body ? JSON.parse(opts.body) : null, op = opName(method, url);
    srv.calls.push(op);
    var f = takeFault(op);
    if (f && f.mode === "drop") return Promise.reject(new TypeError("Failed to fetch"));
    if (f && f.mode === "fail") return Promise.resolve(resp(500, { status: "error", error_msg: "HTTP 500" }));
    var out = handle(method, url, body);
    if (f && f.mode === "lost") return Promise.reject(new TypeError("Failed to fetch"));
    if (f && f.mode === "garbled") return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.reject(new SyntaxError("Unexpected end of JSON input")); } });
    return Promise.resolve(resp(out && out.status === "error" ? 400 : 200, out));
  };
  function resp(status, j) { return { ok: status < 300, status: status, json: function () { return Promise.resolve(j); } }; }
  srv.count = function (op) { return srv.calls.filter(function (c) { return c === op; }).length; };
  return srv;
}

// ---- Sandbox ------------------------------------------------------------------------------------
function load(srv) {
  var win = { __PG_TEST_HOOKS: true };
  win.__PG_SHARED = {
    ctx: { schoolId: 1, ownDefaultTagId: 5 }, API: "/api/cal",
    qs: function (o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]); }).join("&"); },
    jget: function (u) { return srv.fetch(u, { method: "GET" }).then(function (r) { return r.json().then(function (j) { if (!r.ok || (j && j.status === "error")) throw new Error("read failed"); return j; }); }); },
    writeHeaders: function () { return {}; }, xsrfToken: function () { return "x"; },
    fetchOwnTags: function () { return Promise.resolve(Object.keys(srv.tags).map(function (k) { return srv.tags[k]; })); },
    invalidateOwnTags: function () {}, noteFicheThread: function () {}, noteApiError: function () {},
    ficheGoalFields: function (edit) {
      var out = {}; (edit && edit.fields || []).forEach(function (f) { var t = String(f.title || "").trim().toLowerCase(); if (f.template_field_id == null && /^(weet|ken|kan)$/.test(t) && !out[t]) out[t] = f; });
      return out;
    },
    h: function () { return {}; }
  };
  // Timers run at once, except the 30 s write timeout (it must never fire in a test).
  var sandbox = {
    window: win, console: { log: function () {}, warn: function () {}, error: function () {} },
    fetch: function (u, o) { return srv.fetch(u, o); }, URL: URL, Promise: Promise, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number, Error: Error, TypeError: TypeError, Math: Math, Date: Date,
    setTimeout: function (fn, ms) { if (ms >= 10000) return 0; setImmediate(fn); return 0; }, clearTimeout: function () {},
    AbortController: AbortController, document: { getElementById: function () { return null; }, addEventListener: function () {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "lessons.js" });
  return { L: win.__PG_LESSONS, T: win.__PG_LESSONS_TEST, S: win.__PG_SHARED };
}
function threadCount(srv, th) { return Object.keys(srv.fiches).filter(function (k) { return srv.fiches[k].thread === th; }).length; }
// The first `method` write times out in the browser, but Questi applies it later, on commit().
function slowWrite(srv, method) {
  var orig = srv.fetch, late = { commit: null };
  srv.fetch = function (u, o) {
    if (o && o.method === method && !late.commit) { srv.calls.push(method + " lesson"); late.commit = function () { return orig(u, o); }; return Promise.reject(new TypeError("aborted")); }
    return orig(u, o);
  };
  return late;
}
function stageEdit(T, fiche, extra) { T.mgr.pending[fiche.id] = Object.assign({ fiche: { id: fiche.id, subject: fiche.subject }, edit: null, changes: [] }, extra); }
function stageNew(T, key, subject, goals) {
  T.mgr.pending[key] = { isNew: true, key: key, fiche: { id: null, subject: subject }, edit: null, changes: [],
    template: { id: 9, structure: [] }, draft: { subject: subject, grades: ["L3"], visibility: "school", tags: [], text: {}, selected: {}, goals: goals || {} } };
}

// ---- Tests --------------------------------------------------------------------------------------
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("fiche edit: answer lost after Questi saved it → found by thread, no second PATCH", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken" }), x = load(srv);
  stageEdit(x.T, f, { subject: "Breuken 2" });
  srv.fault("PATCH lesson", "lost");
  return x.L.writeFiches([f.id]).then(function (r) {
    assert.strictEqual(r.fails.length, 0, JSON.stringify(r.fails));
    assert.strictEqual(srv.count("PATCH lesson"), 1);
    var nv = r.map[f.id].newId; assert.notStrictEqual(nv, f.id); assert.strictEqual(srv.fiches[nv].thread, f.thread);
  });
});

// A "drop" (rejected before Questi saw it) looks exactly like a lost answer from the browser: both
// are a failed fetch. So it stays onzeker; only the NEXT run, finding nothing again, writes.
test("fiche edit: no answer and nothing saved → onzeker, marker kept; next run checks again, then writes once", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken" }), x = load(srv);
  stageEdit(x.T, f, { subject: "Breuken 2" });
  srv.fault("PATCH lesson", "drop");
  return x.L.writeFiches([f.id]).then(function (r) {
    assert.strictEqual(r.fails.length, 1); assert.ok(r.fails[0].uncertain); assert.ok(!/veilig/.test(r.fails[0].error));
    assert.ok(x.T.mgr.pending[f.id].unsure, "marker kept");
    assert.strictEqual(srv.count("PATCH lesson"), 1, "no automatic retry");
    return x.L.writeFiches([f.id]);
  }).then(function (r2) {
    assert.strictEqual(r2.fails.length, 0, JSON.stringify(r2.fails));
    assert.strictEqual(srv.count("PATCH lesson"), 2);
    assert.strictEqual(threadCount(srv, f.thread), 2, "exactly one new version");
  });
});

test("fiche edit: slow Questi commits the PATCH after the read-back → onzeker, next run finds it, no second version", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken" }), x = load(srv);
  stageEdit(x.T, f, { subject: "Breuken 2" });
  var late = slowWrite(srv, "PATCH");
  return x.L.writeFiches([f.id]).then(function (r) {
    assert.ok(r.fails[0].uncertain, "not 'safe to retry': " + r.fails[0].error);
    return late.commit();
  }).then(function () { return x.L.writeFiches([f.id]); }).then(function (r2) {
    assert.strictEqual(r2.fails.length, 0, JSON.stringify(r2.fails));
    assert.strictEqual(threadCount(srv, f.thread), 2, "exactly one new version");
  });
});

test("new fiche: slow Questi commits the POST after the read-back → onzeker, next run finds it, no duplicate", function () {
  var srv = makeServer(), x = load(srv);
  stageNew(x.T, "new:1", "Kommagetallen");
  var late = slowWrite(srv, "POST");
  return x.L.writeFiches(["new:1"]).then(function (r) {
    assert.ok(r.fails[0].uncertain, "not 'safe to retry': " + r.fails[0].error);
    return late.commit();
  }).then(function () { return x.L.writeFiches(["new:1"]); }).then(function (r2) {
    assert.strictEqual(r2.fails.length, 0, JSON.stringify(r2.fails)); assert.ok(r2.map["new:1"].created);
    assert.strictEqual(Object.keys(srv.fiches).length, 1, "one fiche");
  });
});

test("fiche edit: two write runs at once → the second writes nothing", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken" }), x = load(srv);
  stageEdit(x.T, f, { subject: "Breuken 2" });
  return Promise.all([x.L.writeFiches([f.id]), x.L.writeFiches([f.id])]).then(function (rs) {
    assert.strictEqual(srv.count("PATCH lesson"), 1);
    assert.ok(/schrijfbeurt/.test(rs[1].fails[0].error));
  });
});

test("fiche edit: re-staged while its PATCH runs → the newer change stays staged on the new version", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken" }), x = load(srv);
  stageEdit(x.T, f, { subject: "Breuken 2" });
  var orig = srv.fetch;
  srv.fetch = function (u, o) {
    if (o && o.method === "PATCH") x.T.stagePending({ id: f.id, subject: "Breuken" }, null, { goals: { weet: "tienden" }, goalsOrig: { weet: "" } }, [{ label: "WEET", old: "", nw: "tienden" }]);
    return orig(u, o);
  };
  return x.L.writeFiches([f.id]).then(function (r) {
    srv.fetch = orig;
    var nid = r.map[f.id].newId, q = x.T.mgr.pending[nid];
    assert.ok(q && q.goals.weet === "tienden" && q.subject == null, "kept: " + JSON.stringify(Object.keys(x.T.mgr.pending)));
    return x.L.writeFiches([nid]);
  }).then(function (r2) {
    var nv = srv.fiches[r2.map[Object.keys(r2.map)[0]].newId];
    assert.strictEqual(nv.subject, "Breuken 2"); assert.ok(nv.fields.some(function (fl) { return fl.title === "WEET"; }));
  });
});

test("fiche edit: WEET from goals mode, then edited in the full editor → the editor's text is written", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken", fields: [{ id: 50, type: "text", title: "WEET", template_field_id: null, content: "x" }] }), x = load(srv);
  x.T.stagePending({ id: f.id, subject: "Breuken" }, null, { goals: { weet: "A" }, goalsOrig: { weet: "x" } }, [{ label: "WEET", old: "x", nw: "A" }]);
  var edit = JSON.parse(JSON.stringify(srv.fiches[f.id]));
  x.T.stagePending({ id: f.id, subject: "Breuken" }, edit, { subject: "Breuken", text: { x50: "B" }, tags: null, grades: null, visibility: null, newFields: [] }, [{ label: "WEET", old: "x", nw: "B" }]);
  return x.L.writeFiches([f.id]).then(function (r) { assert.strictEqual(srv.fiches[r.map[f.id].newId].fields[0].content, "B"); });
});

test("fiche edit: landed, then a write on top failed → the later success still maps from the version slots point at", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken" }), x = load(srv);
  stageEdit(x.T, f, { subject: "Breuken 2" });
  srv.fault("PATCH lesson", "lost");
  var patched = false, o0 = srv.fetch;
  srv.fetch = function (u, o) { if (o && o.method === "PATCH") patched = true; if (patched && (!o || o.method === "GET") && new URL(u, "https://q.t").pathname === "/api/cal/lessons") { srv.calls.push("GET list"); return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({ status: "error" }); } }); } return o0(u, o); };
  return x.L.writeFiches([f.id]).then(function (r) {
    assert.ok(r.fails[0].uncertain); srv.fetch = o0;
    x.T.stagePending({ id: f.id, subject: "Breuken" }, null, { subject: "Breuken 3" }, [{ label: "Titel", old: "Breuken", nw: "Breuken 3" }]);
    srv.fault("PATCH lesson", "fail");
    return x.L.writeFiches([f.id]);
  }).then(function (r2) {
    assert.strictEqual(r2.fails.length, 1);
    return x.L.writeFiches([f.id]);
  }).then(function (r3) {
    assert.strictEqual(r3.fails.length, 0, JSON.stringify(r3.fails));
    assert.strictEqual(String(r3.map[f.id].oldId), String(f.id));
  });
});

test("fiche edit: edit view without tags[] → refused, nothing PATCHed (tags[] would wipe them)", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken" }), x = load(srv);
  stageEdit(x.T, f, { subject: "Breuken 2", edit: { id: f.id, thread: f.thread, subject: "Breuken", fields: [] } });
  return x.L.writeFiches([f.id]).then(function (r) {
    assert.strictEqual(r.fails.length, 1); assert.ok(/tags/.test(r.fails[0].error));
    assert.strictEqual(srv.count("PATCH lesson"), 0);
  });
});

test("fiche edit: baseline read failed, answer lost after save → still found (same thread + title), no second PATCH", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken" }), x = load(srv);
  stageEdit(x.T, f, { subject: "Breuken 2" });
  srv.fault("GET list", "fail"); srv.fault("PATCH lesson", "lost");
  return x.L.writeFiches([f.id]).then(function (r) {
    assert.strictEqual(r.fails.length, 0, JSON.stringify(r.fails));
    assert.strictEqual(srv.count("PATCH lesson"), 1);
    assert.strictEqual(srv.fiches[r.map[f.id].newId].subject, "Breuken 2");
  });
});

test("fiche edit: changed again while the earlier write is uncertain → newer change written on top, nothing lost", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken" }), x = load(srv);
  stageEdit(x.T, f, { subject: "Breuken 2" });
  srv.fault("PATCH lesson", "lost");
  var origFetch = srv.fetch, patched = false;
  srv.fetch = function (u, o) { if (o && o.method === "PATCH") patched = true; if (patched && (!o || o.method === "GET") && new URL(u, "https://q.t").pathname === "/api/cal/lessons") { srv.calls.push("GET list"); return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({ status: "error" }); } }); } return origFetch(u, o); };
  return x.L.writeFiches([f.id]).then(function (r) {
    assert.ok(r.fails[0].uncertain);
    srv.fetch = origFetch;
    x.T.stagePending({ id: f.id, subject: "Breuken" }, null, { subject: "Breuken 3" }, [{ label: "Titel", old: "Breuken", nw: "Breuken 3" }]);
    return x.L.writeFiches([f.id]);
  }).then(function (r2) {
    assert.strictEqual(r2.fails.length, 0, JSON.stringify(r2.fails));
    assert.strictEqual(r2.map[f.id].oldId, f.id, "slots still remap from the version they point at");
    assert.strictEqual(srv.fiches[r2.map[f.id].newId].subject, "Breuken 3", "the newer change landed");
    assert.strictEqual(srv.count("PATCH lesson"), 2, "first write once, newer change once");
  });
});

test("fiche edit: lost answer + failed read-back → stays uncertain; next run checks first, no second version", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken" }), x = load(srv);
  stageEdit(x.T, f, { subject: "Breuken 2" });
  srv.fault("PATCH lesson", "lost");
  // the baseline list read comes first and must succeed: only list reads AFTER the PATCH fail
  var origFetch = srv.fetch, patched = false;
  srv.fetch = function (u, o) { if (o && o.method === "PATCH") patched = true; if (patched && (!o || o.method === "GET") && new URL(u, "https://q.t").pathname === "/api/cal/lessons") { srv.calls.push("GET list"); return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({ status: "error" }); } }); } return origFetch(u, o); };
  return x.L.writeFiches([f.id]).then(function (r) {
    assert.strictEqual(r.fails.length, 1); assert.ok(r.fails[0].uncertain, "uncertain");
    assert.ok(x.T.mgr.pending[f.id].unsure, "marker kept");
    srv.fetch = origFetch;
    return x.L.writeFiches([f.id]);
  }).then(function (r2) {
    assert.strictEqual(r2.fails.length, 0, JSON.stringify(r2.fails));
    assert.strictEqual(srv.count("PATCH lesson"), 1, "never PATCHed twice");
    assert.strictEqual(Object.keys(srv.fiches).filter(function (k) { return srv.fiches[k].thread === f.thread; }).length, 2, "exactly one new version");
  });
});

test("new fiche: created, read-back fails → reported, goals staged on the NEW id, retry never POSTs again", function () {
  var srv = makeServer(), x = load(srv);
  stageNew(x.T, "new:1", "Kommagetallen", { weet: "tienden" });
  srv.fault("GET fiche", "fail");
  return x.L.writeFiches(["new:1"]).then(function (r) {
    assert.strictEqual(r.fails.length, 0); var nid = r.map["new:1"].newId;
    assert.ok(r.trialMisses.some(function (m) { return /niet nagelezen/.test(m); }), "said: not read back");
    assert.ok(x.T.mgr.pending[nid] && !x.T.mgr.pending[nid].isNew && x.T.mgr.pending[nid].goals.weet === "tienden", "goals staged as an edit");
    return x.L.writeFiches([nid]);
  }).then(function () {
    assert.strictEqual(srv.count("POST lesson"), 1, "one fiche created");
    var weet = Object.keys(srv.fiches).map(function (k) { return srv.fiches[k]; }).filter(function (f) { return f.newest; })[0].fields.filter(function (fl) { return fl.title === "WEET"; });
    assert.strictEqual(weet.length, 1); assert.strictEqual(weet[0].content, "tienden");
  });
});

test("new fiche: WEET/KEN/KAN PATCH refused → fiche counts as created, goals staged, no duplicate", function () {
  var srv = makeServer(), x = load(srv);
  stageNew(x.T, "new:1", "Kommagetallen", { ken: "1/10 = 0,1" });
  var orig = srv.fetch;
  srv.fetch = function (u, o) { if (o && o.method === "PATCH") { srv.calls.push("PATCH lesson"); return Promise.resolve({ ok: false, status: 400, json: function () { return Promise.resolve({ status: "error", error_msg: "nee" }); } }); } return orig(u, o); };
  return x.L.writeFiches(["new:1"]).then(function (r) {
    assert.strictEqual(r.fails.length, 0); assert.ok(r.map["new:1"].created);
    assert.ok(x.T.mgr.pending[r.map["new:1"].newId], "goals staged on the new id");
    assert.ok(!x.T.mgr.pending["new:1"], "no new-fiche entry left to POST again");
    assert.strictEqual(srv.count("POST lesson"), 1);
  });
});

test("new fiche: POST answer lost + verify read fails → uncertain; retry finds it, no second POST", function () {
  var srv = makeServer(), x = load(srv);
  stageNew(x.T, "new:1", "Kommagetallen");
  srv.fault("POST lesson", "lost");
  var orig = srv.fetch, posted = false;
  srv.fetch = function (u, o) { if (o && o.method === "POST") posted = true; if (posted && (!o || o.method === "GET") && new URL(u, "https://q.t").pathname === "/api/cal/lessons") { srv.calls.push("GET list"); return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({ status: "error" }); } }); } return orig(u, o); };
  return x.L.writeFiches(["new:1"]).then(function (r) {
    assert.strictEqual(r.fails.length, 1); assert.ok(r.fails[0].uncertain);
    srv.fetch = orig;
    return x.L.writeFiches(["new:1"]);
  }).then(function (r2) {
    assert.strictEqual(r2.fails.length, 0, JSON.stringify(r2.fails)); assert.ok(r2.map["new:1"].created);
    assert.strictEqual(srv.count("POST lesson"), 1, "never POSTed twice");
  });
});

test("new fiche: baseline read failed → nothing POSTed, 'retry is safe'", function () {
  var srv = makeServer(), x = load(srv);
  stageNew(x.T, "new:1", "Kommagetallen");
  srv.fault("GET list", "fail");
  return x.L.writeFiches(["new:1"]).then(function (r) {
    assert.strictEqual(r.fails.length, 1); assert.ok(!r.fails[0].uncertain); assert.ok(/veilig/.test(r.fails[0].error));
    assert.strictEqual(srv.count("POST lesson"), 0, "no POST without a baseline");
    assert.ok(x.T.mgr.pending["new:1"], "stays staged");
  });
});

test("new fiche: saved but the 200 answer is unreadable → found by read-back, no second POST", function () {
  var srv = makeServer(), x = load(srv);
  stageNew(x.T, "new:1", "Kommagetallen");
  srv.fault("POST lesson", "garbled");
  return x.L.writeFiches(["new:1"]).then(function (r) {
    assert.strictEqual(r.fails.length, 0, JSON.stringify(r.fails)); assert.ok(r.map["new:1"].created);
    assert.strictEqual(srv.count("POST lesson"), 1);
    assert.strictEqual(Object.keys(srv.fiches).length, 1, "one fiche");
  });
});

test("new fiche: uncertain create pushed off the first page by 30 newer fiches → retry still finds it", function () {
  var srv = makeServer(), x = load(srv);
  for (var i = 0; i < 5; i++) srv.addFiche({ subject: "Ouder " + i });
  stageNew(x.T, "new:1", "Kommagetallen");
  srv.fault("POST lesson", "lost");
  var orig = srv.fetch, posted = false;
  srv.fetch = function (u, o) { if (o && o.method === "POST") posted = true; if (posted && (!o || o.method === "GET") && new URL(u, "https://q.t").pathname === "/api/cal/lessons") { srv.calls.push("GET list"); return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({ status: "error" }); } }); } return orig(u, o); };
  return x.L.writeFiches(["new:1"]).then(function (r) {
    assert.ok(r.fails[0].uncertain);
    srv.fetch = orig;
    for (var j = 0; j < 30; j++) srv.addFiche({ subject: "Nieuwer " + j });
    return x.L.writeFiches(["new:1"]);
  }).then(function (r2) {
    assert.strictEqual(r2.fails.length, 0, JSON.stringify(r2.fails)); assert.ok(r2.map["new:1"].created);
    assert.strictEqual(srv.count("POST lesson"), 1, "never POSTed twice");
  });
});

test("tag create: own tags unreadable → no POST (an existing tag must not pass for 'created')", function () {
  var srv = makeServer(); srv.tags["7"] = { id: "7", title: "rekenen", color: "#111111", parent: 0 };
  var x = load(srv);
  x.S.fetchOwnTags = function () { return Promise.resolve([]); };   // the planner swallows a failed read into []
  srv.fault("GET tags", "fail");
  return x.L.createUserTag({ title: "Rekenen", color: "#111111", schoolId: 1, parent: 0 }).then(function () { assert.fail("must not resolve"); }, function (e) {
    assert.ok(/veilig/.test(e.message)); assert.strictEqual(srv.count("POST tag"), 0);
  });
});

test("tag rename: colour-only change, answer dropped → not reported as done", function () {
  var srv = makeServer(); srv.tags["7"] = { id: "7", title: "rekenen", color: "#111111", parent: 0 };
  var x = load(srv);
  srv.fault("PATCH tag", "drop");
  return x.T.renameUserTag("7", "Rekenen", "#22aa22", 0).then(function () { assert.fail("must not resolve"); }, function (e) { assert.ok(/niet weggeschreven/.test(e.message)); });
});

test("tag rename: colour-only change, answer lost after save → read-back confirms it", function () {
  var srv = makeServer(); srv.tags["7"] = { id: "7", title: "rekenen", color: "#111111", parent: 0 };
  var x = load(srv);
  srv.fault("PATCH tag", "lost");
  return x.T.renameUserTag("7", "Rekenen", "#22aa22", 0).then(function (t) { assert.strictEqual(t.color, "#22aa22"); });
});

test("delete: a failed backup download asks before deleting", function () {
  var x = load(makeServer()), P = x.T.deleteBackupProblem;
  assert.ok(P({ downloaded: false, failed: [] }, 3));
  assert.ok(P({ downloaded: true, failed: [{}] }, 3));
  assert.strictEqual(P({ downloaded: true, failed: [] }, 3), "");
});

// ==== planner.js: calendar write path ================================================================
// PatchGoblin planner write-path tests. Run: node planner-write-tests.js  (Node built-ins only.)
// planner.js is one big DOM-bound IIFE, so loadPlanner() lifts the REAL write-path functions out of
// it by name (brace-matched) into a vm sandbox, with the network calls (postAttachment, patchItem,
// fetchItemDetail, jget, …) replaced by an in-memory fake Questi. One test per data-loss scenario.

var PLANNER_FNS = ["writesDescriptions", "descFor", "descHtml", "toHtmlDesc", "stripHtml", "decodeEnt", "descSame", "descText", "esc",
  "computeDirty", "isUnhydrated", "buildCommitPlan", "slotKey", "stashCurrent", "offscreenStaged", "commitSlots", "sharedItemIds",
  "markSharedItems", "slotByKey", "attachedContentId", "markUncertain", "ficheAttachment", "isGatewayError", "verifyLanded", "doCommit",
  "hydrateRangeLive", "readSlotDetail", "applySlotDetail", "timeFromISO", "weekdayIdx", "addDays", "isoDate", "slotKeyStd",
  "slotVakOverride", "isThemaSlot", "assignFiche", "setSlotVakOverride", "slotPayload", "applySlotPayload", "clearSlotContent",
  "moveOrSwap", "writeGroupObjs", "mapLimit", "noteFicheKind", "ficheKindOf", "ficheEditTags", "qs"];
function plannerExtract(src, name) {
  var i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("planner.js: function not found: " + name);
  var k = src.indexOf("{", i), depth = 0;
  for (; k < src.length; k++) { var c = src[k]; if (c === "{") depth++; else if (c === "}" && !--depth) break; }
  return src.slice(i, k + 1);
}
function plannerVar(src, name) { var m = src.match(new RegExp("var " + name + " = [^\\n]*;")); if (!m) throw new Error("planner.js: var not found: " + name); return m[0]; }

// srv.items[id] = { title, description, att }; srv.lessons[id] = "method" | "lesson" | "down" (read fails).
// srv.faults: consumed one per write, in order — null = ok, "500" = clear failure, "lost504" = no answer and
// NOT applied, "1235" = Questi refuses a methode fiche on the normal attachment endpoint.
function loadPlanner() {
  var src = fs.readFileSync(path.join(REPO, "planner.js"), "utf8");
  var srv = { items: {}, lessons: {}, faults: [], log: { post: [], method: [], patch: [], detail: [], lessonGet: [] } };
  function fault() { var f = srv.faults.shift(); if (!f) return null; var e = new Error(f === "1235" ? "1235 - no access to lesson" : "HTTP " + f.replace(/\D/g, "")); e.httpStatus = f === "1235" ? 400 : +f.replace(/\D/g, ""); e.lost = f.indexOf("lost") === 0; return e; }
  var c = {
    console: console, Promise: Promise, setTimeout: function (f) { Promise.resolve().then(f); }, clearTimeout: function () {},
    state: { settings: {}, slotVak: {}, writeVakDescription: true, saveThrottleMs: 0 },
    ctx: { schoolId: 1, schoolyear: "2026 - 2027", groupId: 326, calendarId: 9 },
    view: { slots: [], stash: {}, methodFicheIds: {}, weekStart: "2026-10-26", undoStack: [] },
    _ficheKind: {}, _ficheTagsP: {}, API: "/api/cal", DAY_ABBR: ["ma", "di", "wo", "do", "vr"], _approvedPlan: null, _commitAfter: null,
    TAGS: { 10: "Wiskunde", 11: "Taal & <b>lezen</b>" },
    topTagIdOf: function (v) { return (v === "" || v == null) ? null : v; },
    anyTagTitle: function (id) { return c.TAGS[id] || ""; },
    isThemaVak: function () { return false; }, isGymTitle: function () { return false; }, isThemaTitle: function () { return false; },
    stampThemaKey: function (s) { return s; }, themaCommitTitle: function (s, t) { return t; },
    writeGroups: function () { return [{ groupId: 326, schoolId: 1 }]; }, firstGroupId: function () { return 326; },
    saveState: function () {}, busyLoading: function () { return false; }, setStatus: function () {}, showCommitOverlay: function () {},
    updateCommitOverlay: function () {}, commitOverlayResult: function () {}, reloadAndRender: function () {}, reloadAndReopen: function () {},
    goblinImg: function () { return null; }, elId: function () { return null; }, commitDelay: function () { return 0; },
    document: { querySelector: function () { return null; } },
    currentWeekRange: function () { return { start: "2026-10-26", end: "2026-11-08" }; },
    postAttachment: function (id, cid) { srv.log.post.push([id, cid]); var e = fault(); if (!e && srv.lessons[cid] === "method") { e = new Error("1235 - no access to lesson"); e.httpStatus = 400; } if (e) return Promise.reject(e); srv.items[id].att = cid; srv.items[id].title = "* x (1)"; return Promise.resolve({}); },
    postMethodAttachment: function (id, cid) { srv.log.method.push([id, cid]); var e = fault(); if (e) return Promise.reject(e); srv.items[id].att = cid; return Promise.resolve({}); },
    patchItem: function (id, body) {
      srv.log.patch.push({ id: id, desc: body.description, att: body.attachments });
      var e = fault(); if (e && !e.lost) return Promise.reject(e);
      if (!e) { var it = srv.items[id]; it.title = body.title; it.description = body.description; if (body.attachments && !body.attachments.length) it.att = null; }
      return e ? Promise.reject(e) : Promise.resolve({});
    },
    fetchItemDetail: function (id) { srv.log.detail.push(id); var it = srv.items[id]; return Promise.resolve({ title: it.title, description: it.description, has_attachments: !!it.att, attachments: it.att ? [{ id_type: 1, content: { id: it.att, subject: "F" } }] : [] }); },
    fetchItems: function () { return Promise.resolve(c.listItems || []); },
    jget: function (url) {
      var m = String(url).match(/\/lessons\/([^?]+)\?/), id = m && m[1], k = srv.lessons[id];
      srv.log.lessonGet.push(id);
      if (k === "down" || !k) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(k === "method" ? { status: "error", error_type: "app_error", error_msg: "1235 - no access to lesson" } : { result: { id: id, tags: [] } });
    }
  };
  vm.createContext(c);
  vm.runInContext(plannerVar(src, "ENT") + "\n" + plannerVar(src, "UNSURE") + "\n" + PLANNER_FNS.map(function (n) { return plannerExtract(src, n); }).join("\n"), c);
  c.srv = srv;
  c.run = function (plan) {
    return new Promise(function (res) { c._commitAfter = function (ok, fails) { res({ ok: ok, fails: fails, plan: plan }); }; c._approvedPlan = plan; c.doCommit(); });
  };
  return c;
}
function plannerSlot(o) {
  return Object.assign({ itemId: 1, title: "Lesuur 3", origTitle: "Lesuur 3", startdate: "2026-10-27 10:00:00", enddate: "2026-10-27 10:50:00",
    idCalendar: 9, isFullday: false, isEditable: true, dayIdx: 1, weekIdx: 0, time: "10:00", groups: [{ groupId: 326, schoolId: 1 }],
    vak: "", description: "", origDescription: "", ficheContentId: null, origFicheContentId: null, ficheTitle: "", origFicheTitle: "",
    starttime: "10:00:00", endtime: "10:50:00", _hydrated: true, _range: { start: "2026-10-26", end: "2026-11-08" } }, o);
}

var plannerTests = [];
function plannerTest(name, fn) { plannerTests.push({ name: name, fn: fn }); }

plannerTest("F1 an unread 'Lesuur N' placeholder, retitled with no vak known, keeps its stored description", function () {
  var c = loadPlanner();
  c.listItems = [{ id: 1, title: "Lesuur 3", startdate: "2026-10-27 10:00:00", enddate: "2026-10-27 10:50:00", id_calendar: 9, has_attachments: false }];
  c.srv.items[1] = { title: "Lesuur 3", description: "Wiskunde", att: null };
  return c.hydrateRangeLive("2026-10-26", "2026-11-08").then(function (r) { return r.done; }).then(function (slots) {
    var s = slots[0]; assert.strictEqual(s._hydrated, false, "placeholder is not detail-read at hydrate");
    s.title = "Toets breuken"; c.view.slots = [s];
    var plan = c.buildCommitPlan([s]);
    assert.ok(plan[0].descEcho, "unread row echoes the stored description");
    return c.run(plan);
  }).then(function (out) {
    assert.strictEqual(out.ok, 1);
    assert.strictEqual(c.srv.items[1].description, "Wiskunde", "description not blanked");
    assert.strictEqual(c.srv.items[1].title, "Toets breuken");
  });
});

plannerTest("F2 a description-only PATCH that never landed is redone, not counted as written", function () {
  var c = loadPlanner();
  c.srv.items[1] = { title: "Lesuur 3", description: "Taal", att: null };
  var s = plannerSlot({ vak: 10, origDescription: "Taal", vakReset: true }); c.view.slots = [s];
  c.srv.faults = ["lost504"];   // no answer, nothing applied
  return c.run(c.buildCommitPlan([s])).then(function (out) {
    assert.strictEqual(c.srv.log.patch.length, 2, "verifyLanded re-PATCHed after seeing the old description");
    assert.strictEqual(c.srv.items[1].description, "Wiskunde");
    assert.ok(out.plan[0].done);
  });
});

plannerTest("F3 attachment POST ok + title PATCH failed: the retry only PATCHes, the review still shows the title change", function () {
  var c = loadPlanner();
  c.srv.items[1] = { title: "Lesuur 3", description: "", att: null };
  var s = plannerSlot({ vak: 10, ficheContentId: "777", ficheTitle: "Breuken", title: "Breuken", ficheIsMethod: false }); c.view.slots = [s];
  c.srv.faults = [null, "500"];
  return c.run(c.buildCommitPlan([s])).then(function (out) {
    assert.strictEqual(out.ok, 0); assert.strictEqual(c.srv.items[1].att, "777");
    c.stashCurrent(); assert.ok(c.view.stash[c.slotKey(s)], "still staged (stashed, not re-read)");
    var plan = c.buildCommitPlan([s]);
    assert.strictEqual(plan.length, 1); assert.strictEqual(plan[0].fiche, null, "no second POST planned");
    assert.ok(plan[0].keepsFiche && plan[0].ficheAlready);
    assert.notStrictEqual(plan[0].old.title, plan[0].neu.title, "title change still in the review");
    return c.run(plan);
  }).then(function (out) {
    assert.strictEqual(out.ok, 1); assert.strictEqual(c.srv.log.post.length, 1, "attachment POSTed once in total");
    assert.strictEqual(c.srv.items[1].title, "Breuken");
  });
});

function plannerMoveSetup(c) {
  c.srv.items[1] = { title: "Rekensprong les 4", description: "Wiskunde", att: "M55" };
  c.srv.items[2] = { title: "Lesuur 4", description: "", att: null };
  var a = plannerSlot({ itemId: 1, title: "Rekensprong les 4", origTitle: "Rekensprong les 4", ficheContentId: "M55", origFicheContentId: "M55", ficheTitle: "R4", origFicheTitle: "R4", ficheIsMethod: null, vak: 10, origDescription: "Wiskunde" });
  var b = plannerSlot({ itemId: 2, startdate: "2026-10-28 10:00:00", dayIdx: 2, vak: 10, title: "Lesuur 4", origTitle: "Lesuur 4" });
  c.view.slots = [a, b]; c.moveOrSwap(a, b);
  // The source row (detach) comes first in the plan, as in the bug.
  return c.buildCommitPlan([a, b]);
}
plannerTest("F4 moving a methode fiche of unknown type: learned via 1235, attached through methodlesson, detached only after", function () {
  var c = loadPlanner(); c.srv.lessons.M55 = "method";
  var plan = plannerMoveSetup(c);
  assert.strictEqual(plan[0].itemId, 1); assert.strictEqual(plan[0].dropsFiche, "M55");
  return c.run(plan).then(function (out) {
    assert.strictEqual(out.ok, 2, JSON.stringify(out.fails));
    assert.strictEqual(c.srv.log.post.length, 0, "never the normal endpoint");
    assert.deepStrictEqual(c.srv.log.method, [[2, "M55"]]);
    assert.strictEqual(c.srv.items[2].att, "M55"); assert.strictEqual(c.srv.items[1].att, null);
  });
});
plannerTest("F4b fiche type unreadable: the receiving row is refused and the source row is held back (fiche stays put)", function () {
  var c = loadPlanner(); c.srv.lessons.M55 = "down";
  return c.run(plannerMoveSetup(c)).then(function (out) {
    assert.strictEqual(out.ok, 0); assert.strictEqual(out.fails.length, 2);
    assert.ok(/fichetype onbekend/.test(out.fails[0].error)); assert.ok(/blijft hier staan/.test(out.fails[1].error));
    assert.strictEqual(c.srv.log.patch.length, 0, "nothing detached");
    assert.strictEqual(c.srv.items[1].att, "M55");
  });
});

plannerTest("Security: a tag title is escaped in the description; an old raw '&' does not make a lesuur dirty", function () {
  var c = loadPlanner();
  assert.strictEqual(c.toHtmlDesc("Taal & <b>lezen</b>\nx"), "Taal &amp; &lt;b&gt;lezen&lt;/b&gt;<br />x");
  var s = plannerSlot({ vak: 11, vakReset: true, origDescription: "Taal & <b>lezen</b>" });
  assert.strictEqual(c.computeDirty(s), false, "raw stored vs escaped intended = same text");
  s.origDescription = "Taal &amp; &lt;b&gt;lezen&lt;/b&gt;";
  assert.strictEqual(c.computeDirty(s), false);
});
plannerTests.forEach(function (t) { test("planner write: " + t.name, t.fn); });

// ==== planner.js: storage and context ================================================================
// PatchGoblin planner storage/context tests. Run: node planner-storage-tests.js  (Node built-ins only.)
// Slices the real storage and context-detection code out of planner.js BY NAME / section marker and
// runs it in a vm sandbox against a fake chrome.storage shared by several "tabs". Written to be merged
// into tests/run.js later: every helper here is prefixed `pst`.
var PST_SRC = fs.readFileSync(path.join(REPO, "planner.js"), "utf8").replace(/\r\n/g, "\n");

// ---- Source slicing -----------------------------------------------------------------------------
// A section between two marker lines, or one top-level (2-space indented) function by name.
function pstSection(from, to) {
  var a = PST_SRC.indexOf(from), b = PST_SRC.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error("section not found: " + from);
  return PST_SRC.slice(a, b);
}
function pstFn(name) {
  var lines = PST_SRC.split("\n"), re = new RegExp("^  function " + name + "\\(");
  for (var i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    if (/\}\s*$/.test(lines[i]) && !/\{\s*$/.test(lines[i])) return lines[i];   // one-liner
    for (var j = i + 1; j < lines.length; j++) if (lines[j] === "  }") return lines.slice(i, j + 1).join("\n");
  }
  throw new Error("function not found: " + name);
}
function pstTick() { return new Promise(function (r) { setImmediate(r); }); }
function pstFlush(n) { var p = Promise.resolve(); for (var i = 0; i < (n || 20); i++) p = p.then(pstTick); return p; }

// ---- Fake chrome.storage.local, shared by every tab of one "browser" ---------------------------
// chrome.storage hands values back with object keys sorted at every level (a plain JSON copy would
// keep insertion order and hide a bug that compared a save with its own echo as strings).
function pstSorted(v) {
  return JSON.parse(JSON.stringify(v, function (k, x) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return x;
    var o = {}; Object.keys(x).sort().forEach(function (key) { o[key] = x[key]; }); return o;
  }));
}
function pstDisk() {
  var disk = { data: {}, failGets: 0, listeners: [] };
  disk.chrome = function () {
    var c = { runtime: { lastError: null } };
    c.storage = {
      local: {
        get: function (keys, cb) {
          setImmediate(function () {
            if (disk.failGets > 0) { disk.failGets--; c.runtime.lastError = { message: "IO error: simulated" }; cb(undefined); c.runtime.lastError = null; return; }
            var o = {}; keys.forEach(function (k) { if (k in disk.data) o[k] = pstSorted(disk.data[k]); }); cb(o);
          });
        },
        set: function (o, cb) {
          setImmediate(function () {
            var changes = {};
            Object.keys(o).forEach(function (k) {
              var nv = pstSorted(o[k]);
              changes[k] = { oldValue: disk.data[k], newValue: nv };
              disk.data[k] = nv;
            });
            if (cb) cb();
            // chrome.storage.onChanged reaches every tab — the writer included.
            disk.listeners.forEach(function (fn) { setImmediate(function () { fn(JSON.parse(JSON.stringify(changes)), "local"); }); });
          });
        }
      },
      onChanged: { addListener: function (fn) { disk.listeners.push(fn); } }
    };
    return c;
  };
  return disk;
}

// ---- A planner "tab": the real Storage section + stubs for what it calls ------------------------
function pstTab(disk) {
  var sb = {
    chrome: disk.chrome(), localStorage: null, console: { info: function () {}, warn: function () {}, log: function () {}, error: function () {} },
    document: { documentElement: { setAttribute: function () {} } }, window: {},
    setImmediate: setImmediate, setTimeout: setTimeout, clearTimeout: clearTimeout, Promise: Promise, JSON: JSON, Date: Date, Object: Object,
    statuses: [], errors: []
  };
  vm.createContext(sb);
  vm.runInContext(
    "function setStatus(t){ statuses.push(t); } function noteApiError(k,id,s,m){ errors.push([k,id,m]); }\n" +
    "var els = {}; function scheduleHydratePaint(){}\n" +
    "var GOALS_STORE_KEY = 'pg_goals_v1', _goals = {};\n" +
    pstSection("  // ---------- Storage ----------", "  // ---------- Runtime context detection ----------") +
    "\nthis.api = { state: function(){ return state; }, loadState: loadState, saveState: saveState, storeGet: storeGet, storeSet: storeSet," +
    " goals: function(){ return _goals; }, setGoals: function(g){ _goals = g; }, flushGoals: function(){ _goalsDirty = {}; storeSet(GOALS_STORE_KEY, _goals); } };", sb);
  return sb;
}

var pstTests = [];
function pstTest(name, fn) { pstTests.push({ name: name, fn: fn }); }

// H3: a failed read of pg_state_v6 must not let the defaults be saved over the real settings.
pstTest("storage: failed state read → no save overwrites the stored settings", function () {
  var disk = pstDisk();
  disk.data.pg_state_v6 = { settings: { "0|08:30": 11 }, setupDone: true, writeVakDescription: true };
  disk.failGets = 1;
  var A = pstTab(disk);
  return A.api.loadState().then(function () {
    A.api.state().vakSeen = { "1|09:20": { id: 3, d: "2026-10-27" } };   // learnVakSeen's automatic save
    A.api.saveState();
    return pstFlush();
  }).then(function () {
    assert.deepStrictEqual(disk.data.pg_state_v6.settings, { "0|08:30": 11 }, "stored settings survived");
    assert.ok(A.statuses.some(function (s) { return /niet gelezen/.test(s); }), "status line says so");
    assert.ok(A.errors.some(function (e) { return e[0] === "storage" && e[1] === "pg_state_v6"; }), "noted for the Zelftest");
    // Other modules keep the old contract: storeGet resolves null on failure, never rejects.
    disk.failGets = 1;
    return A.api.storeGet("pg_print_v1");
  }).then(function (v) {
    assert.strictEqual(v, null);
    A.api.storeSet("pg_print_v1", { mode: "plain" });   // that key's read failed → its save is refused too
    return pstFlush();
  }).then(function () {
    assert.ok(!("pg_print_v1" in disk.data), "no save after a failed read of the same key");
    return A.api.loadState();   // a later successful load lifts the block
  }).then(function () {
    A.api.saveState(); return pstFlush();
  }).then(function () {
    assert.deepStrictEqual(disk.data.pg_state_v6.settings, { "0|08:30": 11 });
    assert.ok(disk.data.pg_state_v6.vakSeen == null || typeof disk.data.pg_state_v6.vakSeen === "object");
  });
});

// H2: two tabs — the second tab's automatic save must carry the first tab's change, not wipe it.
pstTest("storage: two tabs — a save in one tab is merged into the other, own echoes ignored", function () {
  var disk = pstDisk();
  disk.data.pg_state_v6 = { settings: { "0|08:30": 11 }, setupDone: true, writeVakDescription: false, mainMode: "plan" };
  var A = pstTab(disk), B = pstTab(disk);
  return Promise.all([A.api.loadState(), B.api.loadState()]).then(function () {
    B.api.state().settings["1|09:20"] = 22; B.api.state().mainMode = "doelen"; B.api.saveState();
    return pstFlush();
  }).then(function () {
    assert.strictEqual(A.api.state().settings["1|09:20"], 22, "B's lesrooster edit reached A");
    assert.strictEqual(A.api.state().mainMode, "plan", "per-tab view state is not taken over");
    assert.strictEqual(A.api.state().writeVakDescription, false, "an unchanged field is not reset by the merge");
    // A saves twice quickly; the older echo must not undo the newer in-memory value.
    A.statuses.length = 0;
    A.api.state().vakSeen = { a: 1 }; A.api.saveState();
    A.api.state().vakSeen = { a: 2 }; A.api.saveState();
    return pstFlush();
  }).then(function () {
    assert.deepStrictEqual(A.api.state().vakSeen, { a: 2 });
    assert.ok(!A.statuses.some(function (t) { return /ander tabblad/.test(t); }), "A's own saves are not taken for another tab's");
    assert.strictEqual(disk.data.pg_state_v6.settings["1|09:20"], 22, "A's save kept B's change");
    assert.deepStrictEqual(B.api.state().vakSeen, { a: 2 }, "and B learned A's");
    // pg_goals_v1: B writes a goal, A's in-memory goals follow; A's unflushed edit is kept.
    var g = B.api.goals(); g["i:1"] = { weet: "x" }; B.api.setGoals(g); B.api.flushGoals();
    return pstFlush();
  }).then(function () {
    assert.deepStrictEqual(A.api.goals()["i:1"], { weet: "x" });
  });
});

// L2: no own tags (read failed) → a legacy string vak is not deleted.
pstTest("storage: legacy vak setting kept when the own-tag list is empty", function () {
  var sb = { saved: 0, state: { settings: { "0|08:30": "taal" } } };
  vm.createContext(sb);
  vm.runInContext("function ownTagsList(){ return []; } function vakById(v){ return v === 'taal' ? {} : null; } function vakTagId(){ return null; }" +
    " function saveState(){ saved++; }\n" + pstFn("migrateSettingsToTagIds") + "\nmigrateSettingsToTagIds();", sb);
  assert.strictEqual(sb.state.settings["0|08:30"], "taal");
  assert.strictEqual(sb.saved, 0);
});

// H1 + M2: a cached boot keeps its calendar while the background check runs, and a changed class
// (groupId) found by that check is applied and named in the status line.
pstTest("context: background verification never changes ctx midway; groupId re-checked", function () {
  var sb = {
    console: { info: function () {}, warn: function () {}, log: function () {}, error: function () {} },
    Promise: Promise, JSON: JSON, Date: Date, String: String, statuses: [], gate: null,
    state: { workingCalendarId: "cal_1", manualSchoolId: null, manualSchoolyear: null }
  };
  sb.gateP = new Promise(function (r) { sb.gate = r; });
  vm.createContext(sb);
  var cache = { "7": { schoolId: 1, schoolyear: "2026 - 2027", school: { name: "S" }, calendars: [{ id: "cal_1" }, { id: "cal_99" }], calendarId: "cal_1", groupId: 326, ownDefaultTagId: 5 } };
  sb.cacheJson = JSON.stringify(cache);
  vm.runInContext(
    "var ctx = { schoolId: null, schoolyear: null, calendarId: null, groupId: null, ownerId: null, ownDefaultTagId: null, school: null, calendars: [], ready: false };\n" +
    "function setStatus(t){ statuses.push(t); }\n" +
    "function storeGet(k){ return Promise.resolve(k === 'pg_ctx_v1' ? JSON.parse(cacheJson) : null); } function storeSet(){}\n" +
    "function bootUsersMe(){ return Promise.resolve(7); }\n" +
    "function bootSchools(){ return Promise.resolve([{ id: 1, name: 'S', current_schoolyear: '2026 - 2027' }]); }\n" +
    "function bootCalendars(){ return Promise.resolve([{ id: 'cal_1' }, { id: 'cal_99' }]); }\n" +
    "function sniffFromRequests(){ return { schoolId: 1, schoolyear: null, calendarId: 'cal_99' }; }\n" +   // Questi is showing ANOTHER calendar
    "function scrapeContext(){ return {}; } function sniffCookies(){ return {}; }\n" +
    "function extractSchoolyear(v){ return v; } function defaultSchoolyear(){ return '2026 - 2027'; }\n" +
    "function thisWeekRange(){ return { start: '2026-10-26', end: '2026-11-01' }; }\n" +
    // Questi's sniffed calendar is busier this week — the busiest-calendar rule alone would pick it.
    "function apiItems(){ return gateP.then(function(){ return [{ id: 1, id_calendar: 'cal_99' }, { id: 2, id_calendar: 'cal_99' }, { id: 3, id_calendar: 'cal_1' }]; }); }\n" +
    "function fetchItemDetail(id){ return Promise.resolve({ groups: [{ groupId: id === 3 ? 555 : 999 }] }); }\n" +   // the class changed
    "function fetchTags(){ return Promise.resolve([]); } function detectOwnerFromTags(){ return null; }\n" +
    "function resolveOwnTag(tags, c){ c.ownDefaultTagId = 5; return Promise.resolve(); }\n" +
    pstFn("firstGroupId") + "\n" + pstFn("deriveFromItems") + "\n" + pstFn("pickSchool") + "\n" + pstFn("calIdOf") + "\n" + pstFn("safeHex") + "\n" +
    pstSection("  var CTX_KEY = ", "  // ---------- API ----------") +
    "\nthis.api = { ctx: ctx, detectContext: detectContext };", sb);
  return sb.api.detectContext().then(function (c) {
    assert.strictEqual(c.calendarId, "cal_1", "first week loads from the cached/working calendar");
    return pstFlush(5);
  }).then(function () {
    assert.strictEqual(sb.api.ctx.calendarId, "cal_1", "still untouched while the verification runs");
    assert.strictEqual(sb.api.ctx.groupId, 326);
    sb.gate();
    return pstFlush();
  }).then(function () {
    assert.strictEqual(sb.api.ctx.calendarId, "cal_1", "working calendar applied last");
    assert.strictEqual(sb.api.ctx.groupId, 555, "groupId re-derived from the working calendar's item");
    assert.ok(sb.statuses.some(function (s) { return /klas/.test(s) && !/agenda/.test(s); }), "status names the changed class only: " + sb.statuses.join(" | "));
  });
});
pstTests.forEach(function (t) { test("planner storage: " + t.name, t.fn); });

// ==== methodes.js ====================================================================================
// methodes.js checks (merge candidate for tests/run.js). Run: node methodes-tests.js
var MTH_SRC = fs.readFileSync(path.join(REPO, "methodes.js"), "utf8");

// Load methodes.js in a sandbox with a minimal __PG_SHARED. `edits` = { id: { id, thread, subject } }.
function mthLoad(opts) {
  opts = opts || {};
  var store = { pg_threads_v1: opts.threads || {} }, reads = [];
  var shared = {
    ctx: { schoolId: 1, ready: true },
    h: function () { return {}; },
    storeGet: function (k) { return Promise.resolve(store[k] == null ? null : JSON.parse(JSON.stringify(store[k]))); },
    storeSet: function (k, v) { store[k] = JSON.parse(JSON.stringify(v)); },
    noteFicheThread: function () {},
    mapLimit: function (items, n, fn) {
      var i = 0;
      function worker() { if (i >= items.length) return Promise.resolve(); var it = items[i++]; return Promise.resolve().then(function () { return fn(it); }).catch(function () {}).then(worker); }
      var ws = []; for (var k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
      return Promise.all(ws);
    },
    fetchFicheEdit: function (id) {
      reads.push(String(id));
      var e = (opts.edits || {})[String(id)];
      return e ? Promise.resolve(JSON.parse(JSON.stringify(e))) : Promise.reject(new Error("1235"));
    }
  };
  var win = { __PG_SHARED: shared, __PG_TEST_HOOKS: true };
  var sb = { window: win, console: { log: function () {}, warn: function () {}, error: function () {} }, chrome: { runtime: { getManifest: function () { return { version: "t" }; } } },
    document: { getElementById: function () { return null; } }, setTimeout: setTimeout, Promise: Promise };
  vm.createContext(sb);
  vm.runInContext(MTH_SRC, sb);
  return { T: win.__PG_METHODES_TEST, store: store, reads: reads };
}

var mthTests = [];
function mthTest(name, fn) { mthTests.push({ name: name, fn: fn }); }

mthTest("H4: backup import matches by source, never by per-machine id", function () {
  var X = mthLoad(), st = X.T.mstate;
  st.methodes = [
    { id: "m_1", name: "Rekenen", source: "questi", methodKey: "REK", grade: "L3", order: ["a"], overrides: { a: { status: "given" } } },
    { id: "m_2", name: "Taal", source: "tag", tagId: 50, ownerId: "self", order: ["1"], overrides: {} }
  ];
  st.activeId = "m_2";
  // The other machine numbered them the other way round, and adds a third one whose id collides.
  var file = [
    { id: "m_1", name: "Taal (thuis)", source: "tag", tagId: 50, ownerId: "self", order: ["1", "2"], overrides: {} },
    { id: "m_2", name: "Rekenen", source: "questi", methodKey: "REK", grade: "L3", order: ["a", "b"], overrides: {} },
    { id: "m_1", name: "WO", source: "tag", tagId: 77, ownerId: "self", order: [], overrides: {} }
  ];
  var plan = X.T.planImport(file);
  assert.strictEqual(plan[0].match.id, "m_2", "Taal matched by tag, not by id m_1");
  assert.strictEqual(plan[1].match.id, "m_1", "Rekenen matched by vendor key");
  assert.strictEqual(plan[2].match, null, "WO is new");
  X.T.applyImportPlan(plan);
  assert.strictEqual(st.methodes.length, 3);
  var byName = {}; st.methodes.forEach(function (m) { byName[m.name] = m; });
  assert.strictEqual(byName["Taal (thuis)"].id, "m_2");
  assert.strictEqual(byName.Rekenen.id, "m_1");
  assert.deepStrictEqual(byName.Rekenen.order, ["a", "b"]);
  assert.strictEqual(byName.WO.id, "m_3", "colliding id gets a fresh one");
  assert.strictEqual(st.activeId, "m_2");
});

mthTest("H4: name is the fallback, and one local methode is replaced at most once", function () {
  var X = mthLoad(), st = X.T.mstate;
  st.methodes = [{ id: "m_1", name: "Lezen", source: "tag", tagId: 9, order: [], overrides: {} }];
  var plan = X.T.planImport([
    { id: "m_9", name: "lezen ", source: "tag", tagId: 99, order: [] },
    { id: "m_1", name: "Lezen", source: "tag", tagId: 98, order: [] }
  ]);
  assert.strictEqual(plan[0].match.id, "m_1");
  assert.strictEqual(plan[1].match, null);
  X.T.applyImportPlan(plan);
  assert.deepStrictEqual(st.methodes.map(function (m) { return m.id; }), ["m_1", "m_2"], "the replacing m_9 takes local m_1; the colliding m_1 gets a fresh id");
});

mthTest("M1: an edited fiche is followed to its newest version, order + override kept", function () {
  var X = mthLoad({
    threads: { T1: "105" },   // learned by the planner on this machine
    edits: { "100": { id: "100", thread: "T1", subject: "Les 1" }, "200": { id: "200", thread: "T2", subject: "Les 2" },
      "210": { id: "210", thread: "T2", subject: "Les 2" }, "211": { id: "211", thread: "T9", subject: "Les 2" } }
  });
  var m = { id: "m_1", source: "tag", order: ["100", "150", "200", "300"], overrides: { "100": { status: "given", on: "2026-10-01" } } };
  X.T.mstate.methodes = [m];
  var byId = { "105": { id: "105", subject: "Les 1" }, "150": { id: "150", subject: "Les 1b" },
    "210": { id: "210", subject: "Les 2" }, "211": { id: "211", subject: "Les 2" } };
  return X.T.followNewVersions(m, byId).then(function (n) {
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(m.order, ["105", "150", "210", "300"], "300 (deleted) stays and is reported missing");
    assert.deepStrictEqual(m.overrides, { "105": { status: "given", on: "2026-10-01" } });
    assert.deepStrictEqual(X.store.pg_methodes_v1.methodes[0].order, m.order, "remap persisted");
    assert.ok(X.reads.indexOf("150") < 0, "a fiche still in the list is never read");
    // Second open: thread of 100 known -> no edit-view read for it.
    X.reads.length = 0;
    return X.T.followNewVersions(m, byId).then(function (n2) {
      assert.strictEqual(n2, 0);
      assert.deepStrictEqual(X.reads, ["300"], "only the unreadable 300 is tried again; 100's thread is known");
    });
  });
});
mthTests.forEach(function (t) { test("methodes: " + t.name, t.fn); });

// ---- Runner -------------------------------------------------------------------------------------
var failed = 0;
tests.reduce(function (chain, t) {
  return chain.then(function () { return Promise.resolve().then(t.fn); }).then(function () { console.log("ok   " + t.name); },
    function (e) { failed++; console.log("FAIL " + t.name + "\n     " + (e && e.stack || e)); });
}, Promise.resolve()).then(function () {
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " passed");
  process.exitCode = failed ? 1 : 0;
});
