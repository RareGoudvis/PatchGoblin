/* Questi Week Planner — background.js (MV3 service worker)
 * Relays the toolbar-action click and the Alt+P command to the active tab.
 * All UI/logic lives in the content scripts; this worker only forwards a toggle. */

// Beta channel: the sideloaded BETA copy (manifest name contains "BETA") checks the beta branch
// for updates and loads its CSS on demand instead of through the manifest (see content.js).
var PG_IS_BETA = /BETA/.test(chrome.runtime.getManifest().name || "");
var PG_BETA_CSS = ["planner.css", "lessons.css", "methodes.css", "settings.css"];

function toggleActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "PG_TOGGLE" }, function () {
      // Swallow "no receiving end" errors (e.g. non-questi tab) without noise.
      void chrome.runtime.lastError;
    });
  });
}

chrome.action.onClicked.addListener(function (tab) {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "PG_TOGGLE" }, function () {
    void chrome.runtime.lastError;
  });
});

chrome.commands.onCommand.addListener(function (command) {
  if (command === "toggle-planner") toggleActiveTab();
});

// Version check: the content script asks the worker to fetch the repo's version.json
// (cross-origin fetch is clean here — host is in host_permissions, no page CSP/CORS in play).
// Never throws back to the caller; on any failure it just returns { ok:false }.
var PG_VERSION_URL = "https://raw.githubusercontent.com/RareGoudvis/PatchGoblin/" + (PG_IS_BETA ? "beta" : "main") + "/version.json";
// The banner links to version.json `url`; only our own GitHub repo or guide is accepted, so a
// tampered file can never point the link at another site (or a javascript: URL).
function pgSafeUpdateUrl(u) {
  u = typeof u === "string" ? u.trim() : "";
  return (u.indexOf("https://github.com/RareGoudvis/") === 0 || u.indexOf("https://raregoudvis.github.io/PatchGoblin") === 0) ? u : null;
}
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.type === "PG_INSERT_CSS") {
    if (!PG_IS_BETA || !sender.tab || !sender.tab.id) { sendResponse({ ok: false }); return; }
    chrome.scripting.insertCSS({ target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] }, files: PG_BETA_CSS })
      .then(function () { sendResponse({ ok: true }); }, function () { sendResponse({ ok: false }); });
    return true;
  }
  if (msg.type !== "PG_CHECK_VERSION") return; // not ours → let other listeners handle
  fetch(PG_VERSION_URL, { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (j && j.version) sendResponse({ ok: true, latest: String(j.version), url: pgSafeUpdateUrl(j.url) || PG_VERSION_URL });
      else sendResponse({ ok: false });
    })
    .catch(function () { sendResponse({ ok: false }); });
  return true; // keep the message channel open for the async sendResponse
});
