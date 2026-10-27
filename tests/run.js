// PatchGoblin write-safety tests. Run: node tests/run.js  (Node built-ins only — no npm, no deps.)
// Loads lessons.js into a sandbox against a fake Questi (in-memory fiches + tags) and checks that a
// write without a clear answer is never blindly repeated. Not part of the extension (not in the
// manifest). Keep it small: one test per failure scenario that once could lose or duplicate data.
"use strict";
var vm = require("vm"), fs = require("fs"), path = require("path"), assert = require("assert");
var SRC = fs.readFileSync(path.join(__dirname, "..", "lessons.js"), "utf8");

// ---- Fake Questi -------------------------------------------------------------------------------
function makeServer() {
  var srv = { fiches: {}, tags: {}, seq: 1000, calls: [], faults: [] };
  // A fault is { op, mode }: "drop" = request rejected before Questi saw it,
  // "lost" = Questi applied it but the answer never came; "fail" = a read that errors.
  srv.fault = function (op, mode) { srv.faults.push({ op: op, mode: mode }); };
  function takeFault(op) { var i = srv.faults.findIndex(function (f) { return f.op === op; }); return i < 0 ? null : srv.faults.splice(i, 1)[0]; }
  srv.addFiche = function (f) { var id = String(++srv.seq); srv.fiches[id] = Object.assign({ id: id, thread: "t" + id, subject: "", fields: [], tags: [], grades: [], newest: true }, f); return srv.fiches[id]; };
  function newest() {
    return Object.keys(srv.fiches).map(function (k) { return srv.fiches[k]; })
      .filter(function (f) { return f.newest; }).sort(function (a, b) { return Number(b.id) - Number(a.id); }).slice(0, 10)
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
    if (method === "GET" && p === "/api/cal/lessons") return { result: newest() };
    if (method === "GET" && p === "/api/cal/lessons/tags") return { result: Object.keys(srv.tags).map(function (k) { return srv.tags[k]; }) };
    if (method === "GET" && (m = p.match(/^\/api\/cal\/lessons\/(\d+)$/))) { var f = srv.fiches[m[1]]; return f ? { result: JSON.parse(JSON.stringify(f)) } : { status: "error", error_msg: "nf" }; }
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
    if (method === "GET") return p === "/api/cal/lessons" ? "GET list" : "GET fiche";
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
  return { L: win.__PG_LESSONS, T: win.__PG_LESSONS_TEST };
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

test("fiche edit: no answer and nothing saved → 'retry is safe', one PATCH", function () {
  var srv = makeServer(), f = srv.addFiche({ subject: "Breuken" }), x = load(srv);
  stageEdit(x.T, f, { subject: "Breuken 2" });
  srv.fault("PATCH lesson", "drop");
  return x.L.writeFiches([f.id]).then(function (r) {
    assert.strictEqual(r.fails.length, 1); assert.ok(!r.fails[0].uncertain); assert.ok(/veilig/.test(r.fails[0].error));
    assert.ok(x.T.mgr.pending[f.id] && !x.T.mgr.pending[f.id].unsure, "stays staged, no marker");
    assert.strictEqual(srv.count("PATCH lesson"), 1, "no automatic retry");
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

// ---- Runner -------------------------------------------------------------------------------------
var failed = 0;
tests.reduce(function (chain, t) {
  return chain.then(function () { return Promise.resolve().then(t.fn); }).then(function () { console.log("ok   " + t.name); },
    function (e) { failed++; console.log("FAIL " + t.name + "\n     " + (e && e.stack || e)); });
}, Promise.resolve()).then(function () {
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " passed");
  process.exitCode = failed ? 1 : 0;
});
