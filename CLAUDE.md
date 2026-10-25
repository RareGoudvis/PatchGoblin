# CLAUDE.md — Questi Week Planner

Chrome MV3 extension that overlays planning tools on `questi.com`, a Belgian primary-school
platform. Written for and used by a teacher; also shared with colleagues.

**Read this before editing.** `README.md` has the user guide plus a full API reference; the
ground-truth request/response captures live in `reference/questi-api-samples.md`.

## Golden rules

1. **No build step.** Plain ES5-style IIFEs (`var`, `function`, no modules, no `import`).
   No npm, no bundler, no transpiler, no tests. Files are loaded directly by the manifest.
   Do not introduce a toolchain.
2. **Nothing hardcoded per account.** `schoolId`, `schoolyear`, `calendarId`, `groupId`,
   `ownerId`, `ownDefaultTagId` are all runtime-detected into `ctx` by `detectContext()`.
   Never hardcode an id, a tag id, or a user id.
3. **No silent magic.** If something is guessed, degraded, skipped or fell back, the UI says so.
   Prefer a visible note over a clever inference.
3b. **Never classify a slot by its live title.** `slot.title` is user-editable and is overwritten by
   `assignFiche`, so any rule reading it is a bug waiting to happen. Use the stamped identity
   (`isThemaSlot`, `s.themaFiche`, `s.isFullday`) or the slot's **vak tag**. `isThemaTitle` /
   `isGymTitle` are bootstrap heuristics for `origTitle` at hydrate, or for TAG titles — nothing
   else. Three shipped bugs came from ignoring this, the worst being a lesuur titled
   "Godsdienst - Les 1" vanishing from the grid entirely because `slotAt` filtered it out.
4. **Writes are gated.** Every mutation goes through a dry-run the user approves. Calendar writes
   are single-occurrence only (`apply_to_next_items=false`) — never touch a recurring series.
5. **Light theme only.** All CSS namespaced under the module's overlay id.
6. **Dutch UI strings.** Code, comments and commits in English.
7. **Reuse before writing.** Check `__QWP_SHARED` and the sibling modules first — a helper for
   what you need usually already exists. (A duplicate `fetchAllFichesByTag` once shadowed the
   real one and shipped a bug; function declarations hoist, the last one wins.)

## Layout

Flat repo. `icons/` and `reference/` are the only folders.

| File | Lines | Role |
|---|---|---|
| `manifest.json` | | MV3. Permissions `storage, activeTab, scripting`. Hosts `*://*.questi.com/*` + `raw.githubusercontent.com` (self-update check). |
| `background.js` | 41 | Service worker. Relays the toolbar/Alt+P toggle to the tab; serves `QWP_CHECK_VERSION`. |
| `content.js` | 131 | Boot/relay. Injects the toolbar chips into Questi's calendar header. Builds no UI itself. |
| `planner.js` / `planner.css` | 3179 / 474 | Week planner `#qwp-overlay`. Also holds context detection, the API layer, print, and the Zelftest. Exports `__QWP_SHARED`. |
| `lessons.js` / `lessons.css` | 1906 / 256 | Lesfiche-manager. Mounted as the planner's **Lesfiches** tab; standalone `#qwl-overlay` for pick mode. Fiche + tag CRUD. |
| `methodes.js` / `methodes.css` | 802 / 153 | Methodevoortgang `#qwm-overlay`. Read-only progress tracker. |
| `settings.js` / `settings.css` | 1215 / 217 | Instellingen + first-run setup wizard `#qws-overlay`. Settings export/import, Zelftest `.json`. |
| `version.json`, `update.bat` | | Self-update: `.bat` pulls the repo ZIP; the in-app banner compares `manifest.json` against the GitHub `version.json`. Bump **both** on release. |

Docs (all gitignored except `README.md`): `brief.md` (API/build reference), `featues.md` (sic —
Zelftest spec), `planned.md` (planner polish log), `plannedfeature.md` (Lesfiche CRUD / import
roadmap), `reference/questi-api-samples.md` (captured calls).

## Load order and wiring

`content_scripts.js` order is **significant**:

```
planner.js  →  lessons.js  →  methodes.js  →  settings.js  →  content.js
```

`planner.js` defines the shared bridge; the others consume it; `content.js` boots last and injects
the chips. There are no modules — everything crosses file boundaries through `window` globals:

| Global | Set by | Purpose |
|---|---|---|
| `__QWP_SHARED` | planner | ctx + API + DOM helpers used by lessons/methodes |
| `__QWP_TOGGLE` | planner | open/close the planner (action click, Alt+P) |
| `__QWP_OPEN_LESSONS` | planner | open (or boot) the planner on its **Lesfiches** tab |
| `__QWP_PRINT` | planner | open the planner on its **Afdrukken** tab (boots it first when needed) |
| `__QWP_TEST` | planner | debug handles |
| `__QWP_LESSONS` | lessons | `{ open, close, openPicker, runSequential, createUserTag, mount, unmount, isMounted, pendingCount, pendingSummary, backupPending, writeTags, writeFiches, afterSharedWrite }` |
| `__QWP_METHODES` | methodes | `{ open, close }` |
| `__UQ_SETTINGS` | settings | `{ open(sectionId?), openSetup, close, exportSettings, saveDebugJson, vakTops }` |
| `__QWP_BOOTED` | content | double-injection guard |

Each consumer starts with `function S() { return window.__QWP_SHARED; }`. Adding a helper to a
consumer that planner already has is a bug — export the existing one instead.

`__QWP_SHARED` currently exposes: `ctx, API, API_ROOT, jget, qs, xsrfToken, writeHeaders,
fetchTags, fetchOwnTags, fetchSharedTags, invalidateOwnTags, topTagsForOwner, childTags, tagTitle,
tagColor, ownerName, h, detectContext, fetchMethods, fetchMethodLessons, fetchAllFichesByTag,
storeGet, storeSet, goalsInkOn, ficheGoalFields, goalText, noteFicheThread, mapLimit`, and for settings.js:
`state, view, loadState, saveState, setStatus, ownTagsList, anyTagById, topTagIdOf, panelTopTags,
computeTimeRows, isNoSchool, renderTimetable, reloadSlotVakLabels, reloadAndRender, isThemaSlot,
themaIdentity, setThemaVakOverride, ensureThemaKeys, normTitle, stripQuestiDecoration, fetchPeople,
loadColleagueFiches, METHOD_PREFIX, openDiagnose, recentApiErrors, noteApiError, DAY_NAMES`, and for
lessons.js (mounted tab): `refreshStaged, openReview`.
`state` and `view` are the planner's own objects, by reference. `__QWP_LESSONS.createUserTag` is
exported for settings.js too.

## UI conventions

- **No HTML files.** All DOM is built with the hyperscript helper `h(tag, attrs, kids)` in
  `planner.js`, shared as `S().h`. `attrs` understands `class`, `text`, `style`, `on*` handlers;
  anything else becomes an attribute, and `null` values are skipped.
- Each module owns a fullscreen overlay and a CSS prefix: `qwp-` (planner), `qwl-` (lessons),
  `qwm-` (methodes), `qws-` (settings). Never style a bare element globally.
- z-index: planner `2147483000` < settings `2147483020` < methodes `2147483050` < lessons `2147483100` — the manager opens
  *on top of* the methodes panel in pick mode.
- Design tokens are duplicated per overlay as CSS custom properties (`--ink --muted --line
  --surface --accent #304651 --accent2 #e4e642 --change #137a3a --thema --danger`), matching
  Questi's own Angular-Material theme. The planner's PatchGoblin block adds the brand palette
  ("Goblin", from the PatchGoblin brand sheet) on `#qwp-overlay`, token names kept from UnQuesti: `--uq-blue #8B5CF6` Mischief Purple, `--uq-blue-ink #6D3FE0` for text/white-on (active/selected, the **changed**
  border on cards), `--uq-amber #7ED957` Goblin Green (Controleer fill with charcoal ink, badges, the 3px top strip on menus — no hard offset shadows; menus use a light border + soft shadow),
  `--uq-orange #F59E0B` Warning Orange (attention: zonder doelen, warnings), `--uq-cyan #7ED957` (gepland marker,
  focus ring, selection tint — never text). Ink is Charcoal `#1E1F27`. White text on purple only on `--uq-blue-ink`. Icons come from the mascot sheet: `icon128`/`icon48` = the square tile, `icon16` = the head alone; the toolbar launcher shows `icons/head48.png` (web-accessible), since a charcoal tile vanishes on the charcoal button. Vak/tag colours
  on cards stay the teacher's own Questi tag colours.
- Overlays set `html.qwX-locked` to freeze the page behind them.

## Storage

`chrome.storage.local` with a `localStorage` fallback. No sync, no IndexedDB.

| Key | Owner | Contents |
|---|---|---|
| `qwp_state_v6` | planner (+ settings UI) | colleagues, `settings` (slot→tag map keyed `"<dayIdx>\|<HH:MM>"`), `weeks` (print default only — Plannen always shows 2), `panels[0]` (sidebar list filter), `mainMode` (`plan`/`doelen`), `filterOpen`, `doelenWeek`, manual overrides, `saveThrottleMs`; settings fields `vakTags` (top-tag ids that are vakken, `null` = all), `vakOrder` (legend order, `null` = A→Z), `setupDone`, `writeVakDescription` (missing in stored state ⇒ `true`, brand-new install ⇒ `false`). `panelCount`, `pickerView`, `splitRatio`, `sideCollapsed` are legacy and unused |
| `qwp_ctx_v1` | planner | detected context per Questi user id (`schoolId, schoolyear, school, calendars, calendarId, groupId, ownDefaultTagId`) — boot starts from it after one `/users/me`, full detection re-verifies in the background and the status says when it changed |
| `qwp_lessons_v1` | lessons | last tag, page size, columns, sort |
| `qwp_methodes_v1` | methodes | methode definitions, order, manual overrides |
| `qwp_goals_v1` | planner (print) | local lesdoelen `{ "f:<fiche id>" \| "i:<item id>": {weet, ken, kan, hide} }` — hide flags, fiche-less/methode cards, and goals typed before v1.2.0 (own fiches now keep goals in the fiche) |
| `qwp_threads_v1` | planner (print) + lessons | fiche lineage `{ "<thread>": newest fiche id seen }` — learned from every edit view read/written (the list has no `thread`) |
| `qwp_goalcache_v1` | lessons (goals mode) + print | goals per fiche VERSION `{ "<fiche id>": { g: {weet,ken,kan}, m: methode hint } }` — exact forever (an id never changes content), so a seen fiche costs no request |
| `qwp_print_v1` | planner (Afdrukken tab) + settings | print choices `{ mode: "plain" \| "goals1" \| "goals2", tabs: "word" \| "icon", legend: bool, meta: bool }` (`meta` = week no. + print date, default on) |
| `qwp_xhide_v1` | planner (print) | other-agenda items hidden from the Lesdoelen print `{ "<cal>\|r<id_repeat>" \| "<cal>\|i<item id>": true }` |

**`qwp_state_v6` is restored field by field** (`mergeState` + `mergeUqSettings`): a new `state.x` that is
saved but not listed there silently resets on every reload (shipped once: vak view, abbreviations,
sidebar width, Passend/Ruim). Add every new field to the restore list.

Generic `storeGet(key)` / `storeSet(key, val)` live in `planner.js` and are shared — use them
rather than a fourth copy of the pattern.

## The Questi API

Base `"/api/cal"` (`API`), `"/api"` (`API_ROOT`). Same-origin `fetch(url, {credentials:"include"})`
— the logged-in session cookies ride along. **Mutations must send `x-xsrf-token` equal to the
`XSRF-TOKEN` cookie** (double-submit CSRF); `writeHeaders()` does this.

Reads: `/cal/items` (range; no `schoolyear` param — a non-primitive 500s it), `/cal/items/{id}`
(adds `description`, `attachments[].content`, real `groups`), `/cal/lessons` (fiches; paged via
`num`/`offset`, envelope carries `num_records`), `/cal/lessons/tags`, `/cal/lessons/{id}?return_format=edit`,
`/cal/manage/methods/{schoolId}` and `/cal/methods/{KEY}/lessons` (vendor libraries, read-only,
**unpaged** — one call returns everything), `/cal/lessons/templates`.

Writes: `PATCH /cal/items/{id}` (writes **do** send `schoolyear`; `groups` are objects),
`POST /cal/items/{id}/attachments` (here `groups` are raw numeric ids), the separate
`…/attachments/methodlesson` for methode fiches, and `POST|PATCH|DELETE /cal/lessons`.

### Gotchas that have bitten before

- **List `title` is not the stored title** (since ~2026-10). For an item with a fiche, `/cal/items`
  returns the computed `title_lessons` (`"* <fiche subject> (1)"`) in `title`; `/cal/items/{id}`
  returns the real `title` plus `title_lessons`. Questi's own UI shows the decorated one and no
  title PATCH changes that. Hydrate takes `title` from the detail — never commit the list title.

- `current_schoolyear` from `/schools` is an **object**, never `String()` it.
- Own fiche fetches need the user's personal `default_tagId`; a real category tag uses
  `user_tagId` instead. Tag 8 is only valid with `shared_userId` (else error `1203`).
- `PATCH /cal/lessons/{id}` returns a **different** `result.id` — each edit mints a new version.
  Re-read it.
- Fiche edit: `tags[]` is **replace** (echo to keep) but `selected_goals` is **omit-to-keep**
  (never send `[]`). Different rules — do not conflate.
- Bodyless `DELETE` must send **no** `Content-Type`, else HTTP 500.
- Methode fiches carry no tags and no owner, and cannot use the normal attachment endpoint.
- `last_used_date` may be `null`, `"0000-00-00"`, or a bare year — guard all three.

## Feature notes

**Planner (PatchGoblin "Plannen" window).** `buildShell`: a 360px sidebar — tabs Plannen · Lesfiches
(all three tabs switch through `goTab`: Lesfiches = `setTab`, see "Lesfiche-manager") · Afdrukken (`showTab("print")`, see **Afdrukken tab**), vak
chips (`renderVakToggle`), `Ik | Collega ▾` (`renderSource` + `openSourceMenu`, colleagues and
methodes), a folding filter (`applyFilterFold`; the button says "Filter •" when a folded filter
still hides fiches), ONE fiche list, and `Alles · Instellingen · Debug · Controleer` pinned to the
bottom. The list is the old panel 0 (`view.panels[0]`, ids `qwp-*-0`), so vak/subtag/union/grade/
mass-add helpers are unchanged; the 1/2/3 panels, Lijst/Kaart, splitter and sidebar toggle are gone.
Row date: planned in the loaded weeks (by fiche **id**, staged state) → green "gepland"; used this
school year → muted ✓; else last date or "nooit". Every old sidebar action lives in the **Alles**
menu (`openAlles`) — add new tools there, not as loose buttons. **Instellingen** calls
`window.__UQ_SETTINGS.open()` when that module exists, else the planner's own `openInstellingen`.
Controleer's badge, the header's "N wijzigingen" and the launcher badge (`__QWP_PENDING_COUNT`) are
`totalStagedCount()` = `stagedCount()` (same filter as `buildCommitPlan`) + the manager's staged fiche
edits and tags to create; week navigation's discard warning still uses `stagedCount()` (only calendar
edits die with a week reload). Main column: header (← → step ONE week and `confirm()` before discarding staged
edits, Vandaag, `Plannen | Doelen`), then `view.weeks = 2` ALWAYS — this week and next, **stacked**,
one `.qwp-wk` section and 5-column grid per week (`weekSection`); one review covers both.
`renderTimetable` keeps the scroll position. Cards (`cellFor`) use the Lesdoelen-print look: top bar
in the vak's top-tag colour with `goalsInkOn` ink, title below, green 2px border when dirty, dashed
when unplanned (`unplanned` = no fiche/gym and a "Lesuur N" title — cosmetic only, never identity).
**Doelen** mode expands `state.doelenWeek` and folds the other week into a bar; cards show WEET/KEN/
KAN read-only from `goalsRecFor` after `loadPrintFicheGoals` (expanded week only, mapLimit 4, goal
cache), and the header counts lesuren without goals (`goalsStateOf`). The review modal still draws
both weeks side by side with the generic `.qwp-tt` rules — the PatchGoblin CSS is scoped to `.qwp-wk`.
Rows, breaks and no-school days are all derived from the data, never hardcoded. `vak` (subject) is not an API field — it is
the teacher's per-timeslot tag mapping from `state.settings`. Commit path is
`buildCommitPlan` → review diff → `doCommit`. Ctrl+Z undo stack, cap 30, cleared on week change.

**Staged changes survive week navigation.** `reloadWeek` first calls `stashCurrent()`: every dirty
slot goes into `view.stash` (memory only), keyed `itemId|date` (`slotKey`) because a series might
share an id. On reload a stashed slot replaces the fresh one (weekIdx re-seated, detail read skipped);
others stay "offscreen". Every slot carries `_range` (the week window it was read in) and
`buildCommitPlan` PATCHes with `s._range`, so each change hits its own occurrence. Review/commit go
through `commitSlots()` (loaded + offscreen); review rows are matched by item id, so an offscreen slot
whose id is also loaded is **held back** with a visible note. New per-slot loops over staged work must
use `commitSlots().slots`, not `view.slots`.

**Holiday weeks are skipped.** `view.schoolWeeks` (2) is the target; `view.weeks` is how many calendar
weeks are actually loaded. A week with no non-fullday, non-`cal_holidays` item (`isHolidayWeek`)
renders as a bar, and `reloadWeek` loads one more week at a time (`grow`, max `HOLIDAY_EXTRA` = 3)
until the target is met. Loops over weeks keep using `view.weeks`; the status line says which weeks
were skipped (`holidayNote`).

**Descriptions are never wiped by "don't know".** `descHtml(s)` is what gets stored: a lesuur with
no known vak keeps its stored description (gym still clears on purpose). Controleer's trash
(`discardSlot`, `L.discardPending`) puts a lesuur back to its stored state and pins the stored
description (`s.descKeep`) until the lesuur is changed again; `s.keepTitle` stops
`applyThemaLesuurTitles` from re-staging a thrown-away title. An untouched lesuur never stages its
description: a whole-week bar only when its fiche changes, a fiche-less lesuur only when its title,
hand-picked vak or "Vakken herstellen" changed it.

**The Lesrooster fills itself.** `learnVakSeen` records the stored vak per day+hour of every
planned lesuur (`state.vakSeen`, newest wins) and `fillRosterFromSeen` puts it into an EMPTY
`state.settings` hour, said in the status line. Hours set or cleared by hand are in
`state.rosterTouched` and are never filled. Both fields are restored in `mergeUqSettings`.

**Thema rows** (whole-week full-day items: WO, Godsdienst, …). One row per distinct `themaKey`,
so a third thema needs no code change. **Identity must survive a commit**, because the commit
rewrites the item title to the fiche title (`assignFiche`, and again from the attachment POST
response in `doCommit`). `stampThemaKey` therefore resolves, in order: `repeatId` (`id_repeat`,
stable across weeks and immune to renames) → the `"<Thema> — <fiche>"` prefix we write on commit,
validated against the live tag list → tag resolution from `origTitle` → `"title:<normalised>"`.

Two traps, both of which shipped as bugs:
- **Never key a thema row off `slot.title`** — it becomes the fiche title.
- **Never widen `THEMA_ALIAS`.** It once reused `VAKKEN[].re`, whose wereldoriëntatie entry contains
  the word `thema`, so *any* fiche called "Thema …" resolved to WO and two themafiches collapsed
  onto one row. `VAKKEN[].re` is a fiche-title **search** regex, not an identity rule.

`doCommit` must re-apply the prefix to Questi's decorated title (`themaTitleFor`), or the prefix
never reaches the server. `themaCommitTitle`/`stripThemaPrefix` keep it idempotent.
An explicit **manual override** outranks all of it: picking a Vak in the popup on a whole-week slot
stores `state.themaVak[<repeatId|normalised origTitle>] = tagId` in `qwp_state_v6`, which
`stampThemaKey` consults first. That is the escape hatch for a title no rule can resolve, so a new
abbreviation never needs a code change. `THEMA_ALIAS` maps an item-title regex to a **tag-title**
regex (not a `VAKKEN` id), so a vak with no `VAKKEN` entry — lichamelijke opvoeding — resolves too.
`ensureThemaKeys` re-stamps before each render because boot fetches tags and the week in parallel.
Full-day items must not read `state.settings`: with no start time they all share the key
`"<dayIdx>|"`, so their `vak` comes from `themaTagId`. A thema slot **keeps** `themaFiche` when it
receives a fiche, so `descFor` goes on writing `"Zie themafiche."` — but the grid cell and the
print band show the *fiche* title, not that literal.

**Descriptions are published.** Enderklas (the teacher's class website) shows the calendar
**title** as the lesson and the **description** as the vak (and colours by it). So the description
is ALWAYS the vak name — a WO/Godsdienst lesuur included. A fiche-less WO/Godsdienst lesuur instead
gets the week's themafiche name as its **title** (`applyThemaLesuurTitles`, run on load, each paint
and in print), replacing only a `"Lesuur N"` placeholder, a title it set itself (`s.autoThemaTitle`)
or last version's themafiche name — never a typed title; no themafiche → back to `origTitle`.
`"Zie themafiche."` remains the whole-week **bar's** description, and on screen/paper only for a
thema lesuur still on its placeholder (`themaShowsLiteral`). A lesuur's `themaFiche` comes from its
**vak tag** (`isThemaVak`, never the title), and such a lesuur may still receive its own fiche.

Layout: the 52px label column is **empty by design** on thema rows. It once held the row label,
and because grid rows are auto-height a wrapped lesson title there stretched the whole row. The
thema name sits in the band itself (a striped one-line strip in the stacked layout).

**Boot speed.** `detectContext` = one `/users/me` + the cached context (`qwp_ctx_v1`, keyed by user id) when
known, with `detectContextFull` (the old 5–6 request chain) verifying in the background; a different result
corrects `ctx` and warns in the status line. `hydrateRange` reads item details through `mapLimit(…, 4)`
instead of one by one. The toolbar launcher badge reads `__QWP_PENDING_COUNT` (no request).

**Paint first, details after.** `hydrateRangeLive` resolves at the `/cal/items` LIST stage with
`{ slots, done, total }`; every lesuur that needs a detail read is marked `_pending` until its
`/cal/items/{id}` answers (a failed read leaves `_detailFailed`). `reloadWeek` resolves at the list
stage and sets `view.hydrateP` (true once fully read and repainted, false when a newer load replaced it,
tracked by `_loadGen`); each detail schedules a 250 ms throttled repaint (`scheduleHydratePaint`, held
while a card is dragged), and the status line counts `Lesuren laden: x/n`. A list-stage card shows
Questi's decorated title stripped, a "laden…" pill, and takes no click/drop. `isUnhydrated(s)` is the
one gate: `computeDirty` returns false, `applyStoredVakken` and `applyThemaLesuurTitles` skip it (the
latter also while that week's bars are pending), `isTargetable`/empty pools exclude it, undo never
restores a snapshot taken while it was unread, and `openReview`/`doCommit` plus the bulk tools (Kopieer
vorige week, Titels opschonen, Vakken herstellen, mass-add) refuse via `busyLoading()` with the reason.
Controleer gets `.qwp-wait` and a tooltip saying how many lesuren are still loading. `reloadAndRender`
and `loadEverything` resolve only after `view.hydrateP` (settings.js re-reads titles after it; the
health check needs `ctx.groupId`, which only a detail supplies; `qwp:loaded` fires after it). Doelen-mode
goal reads wait for the details too, so Questi only ever sees one 4-wide stream. `hydrateRange` (print)
still waits for everything.

**Opening week.** `detectViewedWeekStart` reads Questi's own `/cal/items` requests out of the
performance timeline. It must match `/cal/items?` **only** (`/cal/items/count` is a MONTH query —
matching it made `mondayOf` roll 1 Aug back to 27 Jul, i.e. a live August request produced a July
week), require a week-shaped range, skip our own reads (marked `qwp=1` by `apiItems`), and sanity-
check the distance from today. `resolveOpenWeek()` is the single answer used by both the planner
and print, and the status line says which rule fired.

**Vak follows the fiche.** The description is published — Enderklas shows it as the vak — so a
lesuur with a fiche gets the fiche's OWN vak. On assign: `syncFicheVakken` → `applyFicheVakken`. On
load: `applyStoredVakken` (also run each paint, for lesuren WITH or WITHOUT a fiche): manual
override `state.slotVak[itemId]` (any Vak pick in a lesuur's popup; cleared by `assignFiche`) →
fiche vak from `_ficheVakCache` → top tag equal to the stored description (what we wrote, so a
one-week WO/Godsdienst swap survives reloads, other devices and print) → settings. A mismatching stored vak
becomes a **description-only** change in review, and the status line says how many. This is only
safe because a commit never re-POSTs an unchanged fiche and hydrate takes the stored title from the
detail (v1.1.11 had neither and rewrote every opened week's titles). Methode fiches answer `1235` on
`/cal/lessons/{id}`, so their vak is unknown: they keep the stored/settings vak, never flagged.

**Commit never re-POSTs an unchanged fiche, and never adopts Questi's title.** The attachment POST
retitles the item `"* <fiche> (1)"`; `doCommit` PATCHes our plain title afterwards, and
`buildCommitPlan` only sends `fiche` when it differs from `origFicheContentId` (else `keepsFiche`,
plain PATCH). "Titels opschonen" (`cleanDecoratedTitles`) stages the repair for already-decorated items, bars included.
"Vakken herstellen" (`resetVakkenToDefault`) is the escape hatch for that stored-description rule:
for the loaded week(s) it drops `state.slotVak` and sets every lesuur back to fiche vak / Instellingen,
marking `s.vakReset` so `applyStoredVakken` leaves it alone until reload. A lesuur that loses its
thema vak gets its `"Lesuur N"` placeholder back (`placeholderTitleFor`: position among the same
calendar's recurring lesuren that day) instead of keeping another vak's themafiche name.

**Lesfiche-manager.** One `mgr` state, two hosts. **Mounted** (normal use): the planner's Lesfiches tab
(`setTab("lesfiches")`) toggles `.qwp-tab-lf` on `#qwp-overlay` — CSS hides every `.qwp-plan-only` part
and shows `#qwp-lf-side` / `#qwp-lf-main` — and calls `__QWP_LESSONS.mount(side, main, {onClose})`:
a tag tree in the sidebar (`renderTagTree`), header + selection bar + table + **side-sheet** editor
(`openSheet` → `fillEditor`, same editor as the standalone modal) in main. The bottom bar stays.
**Standalone** `#qwl-overlay`: pick mode, and a direct `open()`; it keeps its own "Wijzigingen
controleren" gate (`openReviewEdits` → `writePending` → `writeFiches`). Both hosts use the same element
ids, so lookups go through `E(id)` (active host only) — never `document.getElementById`. While the
standalone overlay is up over a mounted manager, the mounted list state is stashed
(`enterStandalone`/`leaveStandalone`); `openPicker` no longer clears `mgr.pending`. Edits are *staged*
into `mgr.pending`; on the mounted tab "+ Tag" stages into `mgr.pendingTags` too (shown "nieuw" in the
tree, click to take it back) — both in memory only, gone on a page reload, as before. The ✎ on an own
tag (`openRenameTag`) renames/recolours it straight away: `PATCH /cal/lessons/user-tags/{id}` with exactly
`{ title, color, parent, schoolId }`; Questi lower-cases the title, so the tree shows the reply. **Always send
`parent`** (0 = head tag): without it Questi turns a subtag into a head tag (shipped in v1.5.0). The
dialog's "Hoort bij" moves a tag; a tag with subtags stays a head tag. Every pending
change calls `notifyPending()` → `S().refreshStaged()`. Tag **delete** still writes immediately (confirm).
Bulk delete is guarded by a typed `VERWIJDER` plus an automatic JSON backup. `openPicker({title,
preselected, startTagId, onDone, onCancel})` opens the standalone overlay in **read-only pick mode**:
every write affordance is hidden, and `mgr.pickStore` keeps selections alive across tag switches.

**One shared Controleer** (planner `openReview`, bottom-bar Controleer and the header count). Lists in
write order: (1) tags to create, (2) staged fiche edits (`L.pendingSummary()`), (3) calendar rows from
`buildCommitPlan` plus opt-in **"Fiche-versie"** rows — clean lesuren in the loaded weeks that already
hold a fiche being edited. Every row has a checkbox (left out = stays staged); "Toon als rooster" folds
out the old/new grids. A fiche backup (`L.backupPending`, reads snapshots it lacks) is ticked by default.
`runSharedWrite`: backup → `L.writeTags` → `L.writeFiches` (each PATCH mints a new id; it returns
`map[key] = {oldId,newId,subject}`) → **remap** every slot whose `ficheContentId` is an old id written in
this run to the new id (a newly assigned fiche always; an already-attached one only when its row or
Fiche-versie row is ticked; a title equal to the old fiche title follows the rename) → `buildCommitPlan`
again, filtered to the ticked rows → `doCommit` (single occurrence). A lesuur that would newly receive a
fiche whose write **failed** is held back and reported — never attached silently. `doCommit` marks
`p.done` per row and hands off to `_commitAfter`; `finishSharedWrite` takes written rows as stored
(orig* = current) so left-out rows stay staged, reloads the page only when everything landed and nothing
is left, and otherwise shows a per-phase summary in the commit overlay.

**Methodevoortgang.** Read-only. Status derives from one field: `last_used_date` inside the chosen
school year. Two sources — a Questi vendor library, or your own fiches picked once via
`openPicker`. Blocks come from **subtags** for own-fiche methodes and from parsed titles for vendor
ones; rows are sorted by block rank so a thema is never split. Only the teacher's decisions
persist; titles and dates are re-fetched live every open. Note Questi rolls `schoolyear` in summer,
so between the roll and 1 September nothing counts as given — hence the explicit year picker.

**Afdrukken tab** (`buildPrintPanel`, built once inside `buildShell`; `showTab` swaps the column pairs via
`.qwp-main.tab-print`). Sidebar: the same tabs (`tabsNav`), week ← →, Versie cards, Op het blad
(labels + legend for Lesdoelen, week no. + date), other agendas, "Opmerking voor deze week" (Gewoon
adds "Lege notitieregels" when it is empty), a note when edits are staged or a detail failed, the
orange "N kaarten zonder doelen · nu invullen" (own fiches → `openLesfichesTab` when `__QWP_LESSONS`
exists, else Plannen in Doelen mode; methode cards are typed in the preview), and **Bewaar als PDF** /
**Afdrukken** pinned at the bottom — both open the browser print dialog; PDF says to pick "Opslaan als
PDF". Main: the live A4 preview iframe; for the Lesdoelen versions a Voorkant/Achterkant switch hides
every other page on screen only (`@media screen` style injected by `applyPrintPage`). Entering waits on
`plannerReady()` (context + tags + week list) and `view.hydrateP`, then follows the planner's first
week unless the tab was stepped on its own. It prints the STORED planning: `plannerPrintView` reuses
copies of the planner's slots when they cover the week, are fully read and nothing is staged; otherwise
`fetchPrintView` reads the week itself. `window.__QWP_PRINT` = `openPrintTab` (boot("print") when the
planner never opened). The old standalone `#qwp-print-overlay` is gone.

**Lesdoelen print.** The Afdrukken tab's "Versie" choice: Gewoon (the original layout, untouched) or
Lesdoelen 1 A4 / 2 A4 (`printGoalsDocHtml`). Equal-height cards with WEET/KEN/KAN write lines
(3 per card on 1 A4, 8 on 2 A4, both ≈7mm; titles fixed at 2 lines — front = first half of the lesuren, back = rest + week info); the
free Wednesday afternoon holds thema names and the vak legend. Goals live **in the fiche** (see
"Lesdoelen in the fiche"); `loadPrintFicheGoals` reads them per print-tab visit and `goalsRecFor` merges
them with the local record. Only a card with no own fiche behind it (fiche-less lesuur, methode fiche)
is still typed in the preview (`wireGoalsEditor`, listeners attached from the content script —
Questi's CSP blocks inline scripts) and stored locally. Kinds hide per fiche, all
three included (LO, zwemmen); visible kinds split the block evenly (`goalsLayout`). Line pitch uses
container-query units (`cqh`) on `.gl`, so it follows whatever height a wrapped title leaves.
Other agendas ("Andere agenda's meeprinten", e.g. the zorgjuf's) never enter the Lesdoelen grid: they
are listed in the Wednesday box and their start time shows under the card's own time. A click on a
list row hides it — by `id_repeat` when it recurs, so in every week — and hidden items never print.
`fetchPrintExtras` returns the raw `items` per week for this, next to the `cells`/`inject` the plain
layout uses.

**Settings module** (`settings.js`, `#qws-overlay`). Owns no storage key: it edits the planner's
`state` through `__QWP_SHARED` and persists with `saveState()`; print defaults go to `qwp_print_v1`.
Seven sections (Lesrooster, Vakken, Agenda, Collega's & methodes, Afdrukken, Delen & back-up, Over)
and a 5-step first-run wizard that auto-opens once (planner dispatches `qwp:loaded` at the end of
`loadEverything`; the wizard opens when `state.settings` is empty and `setupDone` is false; closing
it sets `setupDone`). The old `openInstellingen` modal delegates to `__UQ_SETTINGS.open("lesrooster")`.
The only Questi write is creating a tag (missing vak), always behind a confirm. Wizard lesrooster
suggestions are bootstrap guesses (rule 3b) — fiche/description vak first, else the ORIGINAL item
title matched to vak names — drawn with an orange border, and dropped unless confirmed.
**Export/import** (`format: "unquesti-settings"`, `version: 1`) carries tags by **title + colour (+
parent title), never by id**; import maps them onto the importer's own tags (exact → alias table →
prefix, the last two flagged as a guess), offers "aanmaken in Questi" for missing ones, and applies
only on Importeren. Thema overrides keyed `rep:<id_repeat>` are exported as the title of a loaded item
(else skipped, and the UI says so) and imported against the importer's loaded whole-week items.
**"Vak als beschrijving schrijven"** (`state.writeVakDescription`): off ⇒ `computeDirty` ignores the
description and `buildCommitPlan` echoes the stored one — the vak and the bar's `"Zie themafiche."`
alike. A slot hydrate never read (`descEcho`) is read in `doCommit` just before its PATCH; a failed
read fails that row rather than blanking the description. Vakken selection (`vakTags`/`vakOrder`)
drives the settings UI only so far — the planner's own vak lists and the print legend do not read it yet.
**Zelftest `.json`**: `saveDebugJson` writes rows, ctx ids, the settings export and the last 20 API
errors (`noteApiError` ring buffer in planner: kind, id, status, message — never a body, cookie or
token); "titels van lesfiches weglaten" replaces every known lesuur/fiche title with `[titel]`.

**Gym / LO.** `s.isGym` means "title only, no fiche": `descFor` returns null (empty description),
the commit sends `attachments: []`, and the slot is excluded from targeting. The trigger is the
**gym checkbox** in the slot popup — this account has no "Lichamelijke opvoeding" TAG, so a
vak-based trigger is unreachable (that shipped once and did nothing). Ticking titles the slot from
`LO_TITLES`; unticking restores the pre-tick title rather than blanking it, because an empty title
commits as the `"Lesuur"` fallback. `GYM_RE` **must** match every title the planner itself writes
(hence `lichamelijke`), or hydrate re-reads the slot as non-gym and the flag is lost on reload.

**Zelftest** (`planner.js` `runDiagnostics`, smaller twin in `lessons.js`). Strictly read-only.
Compares live responses against captured shapes and emits OK/WARN/FAIL/SKIP rows with
`expected`/`found`/`next`, copyable as plain text. **When you add a feature that depends on an API
shape, add a check here.**

**Open question — can a methode fiche's content be read?** Nothing in the codebase has ever
deliberately tried. It matters because "copy a methode fiche into my own library" (planned, parked
until Questi ships the new-curriculum fiches) is impossible without it. `probeMethodLesson` in
`lessons.js` answers it: it GETs a real methode lesson with `return_format` `edit`/`view`/`short`
and reports whether `templateId`, `fields[]`, text content, goals and attachments come back. The
copied Zelftest report includes the raw key names. Two related unknowns it does **not** answer,
because both would need a write: whether `attachments: []` on a fiche PATCH wipes existing
attachments, and where the write-side `attachmentId` comes from (it matches neither `content.id`
nor `id_attachment`). Test those by hand on a throwaway fiche.

**Lesdoelen in the fiche.** WEET/KEN/KAN are three per-fiche **extra** text fields (Questi
editor "+ toevoegen → Tekst"): `template_field_id: null`, value in `content`, `description` = the ⓘ
helper text. Matched by **title** (`ficheGoalFields`), never by id — field ids change with every fiche
version. `buildPatch` sends every extra field exactly as Questi's editor does, `{ id, content }`, and
`opts.goals` updates or appends them; never create an empty one. Text fields key on `fieldKey()`
(template id, or `"x"+id` for an extra field) — keying on `template_field_id` alone made all extra
fields share one `"null"` key. Goals mode in the manager (`makeGoalsTable`) stages into `mgr.pending`
like any edit and backs up ≥5 goal writes first. Goal reads are **viewport-driven** (IntersectionObserver,
max 4 in flight) and print caps its reads at 4 (`mapLimit`) — keep Questi traffic light, never a burst. A planned lesuur keeps its fiche **version**, so print
follows the fiche's `thread` (same for every version; `qwp_threads_v1`) to the newest version, then the
newest own fiche with the same title, and marks the card "nieuwere versie".

**New fiche (beta).** "+ Nieuwe fiche" in the Lesfiches tab builds a fiche in the side sheet
(`openNewFiche`): template picker (`fetchTemplates`), title, leerjaren, zichtbaarheid, tags, the
template's text fields, WEET/KEN/KAN and leerplandoelen. It is staged as `mgr.pending["new:N"]`
(`isNew`, `draft`, `template`) and created by Controleer before any edit or calendar write
(`writeNewFiche`: POST, read back, one PATCH if Questi dropped the WEET/KEN/KAN extras). A
`methods` field has no captured create shape and is left out, said in the sheet. Op.Stap
leerplandoelen use Katholiek Onderwijs Vlaanderen's own `<op-stap-selector>` web component, which
Questi loads only once its own editor opened (`op-stap-selector.latest.js`); the bridge loads that same
script on the extension's `uq-opstap-load` event and marks `<html data-uq-opstap>` once it is defined
(`ensureOpstap`). `opstapSelector` places it (mode FULL,
marked `data-uq`) and reads `OpStapSelectionChanged` `{ selectedKeys: ["/content/<uuid>"] }`. The
event detail does not reach the isolated world, so **`opstap-bridge.js` runs in the page world**
(second manifest content-script entry, `"world": "MAIN"`) and copies it to `data-uq-sel`. Skip the
`{ selectedKeys: [], version: null }` events the modal fires on open. Goal ids are UUID strings —
never cast them. ZILL templates: no picker, said in the sheet. Keep the MAIN-world entry when
releasing (beta→stable only touches the CSS list).

**Full fiche editor.** Double-click opens every field of the edit view. Editable: title, tags
(pill picker, full-set replace), all text fields (`fieldKey`), new extra text fields (`opts.newFields`).
`grades`/`visibility` are a **trial** — the create call's keys, never captured on PATCH — so writePending
reads the new version back and reports a mismatch instead of trusting it. Template, attachments,
methode doelen and leerplandoelen are read-only (goal tree + attachment upload are not built).
Traffic rules: fiche reads are viewport-driven and cached per version (`qwp_goalcache_v1` carries goals
AND tags), parallel reads go through `mapLimit(…, 4)`, `ficheEditTags` is memoised per id.

## Working on this repo

- After editing, reload the extension **and** reload the Questi tab — Chrome keeps old content
  scripts alive in already-open tabs. Each module logs its version on load; a missing line means a
  stale script.
- Syntax check with `node --check <file>` (node is available; it is not a dependency of the addon).
- Verification is manual: load unpacked on a `…/calendar` page and drive the UI. In summer there
  are no lesson items, so `groupId` stays null and several Zelftest rows WARN — that is expected.
- Bump `manifest.json` **and** `version.json` together on release.
- **Beta channel.** A beta is a branch whose manifest `name` contains `BETA`: it runs next to the
  stable copy (Alt+Shift+P, dormant while stable is active), keeps its CSS **out** of the manifest
  (the worker injects it, see `content.js`), and checks/updates from its own branch. To make one:
  rename, drop the manifest `css`, point `install.bat`, `update.bat` and the version check at the
  branch. Releasing reverses all of that — v1.3.0 was released from the `unquesti` beta this way.
