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
| `lessons.js` / `lessons.css` | 1035 / 157 | Lesfiche-manager `#qwl-overlay`. Fiche + tag CRUD, and a read-only pick mode. |
| `methodes.js` / `methodes.css` | 802 / 153 | Methodevoortgang `#qwm-overlay`. Read-only progress tracker. |
| `version.json`, `update.bat` | | Self-update: `.bat` pulls the repo ZIP; the in-app banner compares `manifest.json` against the GitHub `version.json`. Bump **both** on release. |

Docs (all gitignored except `README.md`): `brief.md` (API/build reference), `featues.md` (sic —
Zelftest spec), `planned.md` (planner polish log), `plannedfeature.md` (Lesfiche CRUD / import
roadmap), `reference/questi-api-samples.md` (captured calls).

## Load order and wiring

`content_scripts.js` order is **significant**:

```
planner.js  →  lessons.js  →  methodes.js  →  content.js
```

`planner.js` defines the shared bridge; the others consume it; `content.js` boots last and injects
the chips. There are no modules — everything crosses file boundaries through `window` globals:

| Global | Set by | Purpose |
|---|---|---|
| `__QWP_SHARED` | planner | ctx + API + DOM helpers used by lessons/methodes |
| `__QWP_TOGGLE` | planner | open/close the planner (action click, Alt+P) |
| `__QWP_OPEN_LESSONS` | planner | open the Lesfiche-manager |
| `__QWP_PRINT` | planner | headless print — does not need the overlay |
| `__QWP_TEST` | planner | debug handles |
| `__QWP_LESSONS` | lessons | `{ open, close, openPicker, runSequential }` |
| `__QWP_METHODES` | methodes | `{ open, close }` |
| `__QWP_BOOTED` | content | double-injection guard |

Each consumer starts with `function S() { return window.__QWP_SHARED; }`. Adding a helper to a
consumer that planner already has is a bug — export the existing one instead.

`__QWP_SHARED` currently exposes: `ctx, API, API_ROOT, jget, qs, xsrfToken, writeHeaders,
fetchTags, fetchOwnTags, fetchSharedTags, invalidateOwnTags, topTagsForOwner, childTags, tagTitle,
tagColor, ownerName, h, detectContext, fetchMethods, fetchMethodLessons, fetchAllFichesByTag,
storeGet, storeSet, ficheGoalFields, goalText, IS_BETA, betaPill`.

## UI conventions

- **No HTML files.** All DOM is built with the hyperscript helper `h(tag, attrs, kids)` in
  `planner.js`, shared as `S().h`. `attrs` understands `class`, `text`, `style`, `on*` handlers;
  anything else becomes an attribute, and `null` values are skipped.
- Each module owns a fullscreen overlay and a CSS prefix: `qwp-` (planner), `qwl-` (lessons),
  `qwm-` (methodes). Never style a bare element globally.
- z-index: planner `2147483000` < methodes `2147483050` < lessons `2147483100` — the manager opens
  *on top of* the methodes panel in pick mode.
- Design tokens are duplicated per overlay as CSS custom properties (`--ink --muted --line
  --surface --accent #304651 --accent2 #e4e642 --change #137a3a --thema --danger`), matching
  Questi's own Angular-Material theme.
- Overlays set `html.qwX-locked` to freeze the page behind them.

## Storage

`chrome.storage.local` with a `localStorage` fallback. No sync, no IndexedDB.

| Key | Owner | Contents |
|---|---|---|
| `qwp_state_v6` | planner | colleagues, `settings` (slot→tag map keyed `"<dayIdx>\|<HH:MM>"`), weeks, panels, split ratio, manual overrides |
| `qwp_lessons_v1` | lessons | last tag, page size, columns, sort |
| `qwp_methodes_v1` | methodes | methode definitions, order, manual overrides |
| `qwp_goals_v1` | planner (print) | local lesdoelen `{ "f:<fiche id>" \| "i:<item id>": {weet, ken, kan, hide} }` — hide flags, fiche-less/methode cards, and pre-beta text (own fiches now keep goals in the fiche) |
| `qwp_print_v1` | planner (print) | print window choices `{ mode: "plain" \| "goals1" \| "goals2", tabs: "word" \| "icon", legend: bool }` |
| `qwp_xhide_v1` | planner (print) | other-agenda items hidden from the Lesdoelen print `{ "<cal>\|r<id_repeat>" \| "<cal>\|i<item id>": true }` |

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

**Planner.** Week grid is one CSS Grid so two weeks sit side by side. Rows, breaks and no-school
days are all derived from the data, never hardcoded. `vak` (subject) is not an API field — it is
the teacher's per-timeslot tag mapping from `state.settings`. Commit path is
`buildCommitPlan` → review diff → `doCommit`. Ctrl+Z undo stack, cap 30.

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

Layout: the 64px label column is **empty by design**. It once held the row label, and because grid
rows are auto-height a wrapped lesson title there stretched the whole row. The thema name now sits
in the band, in the same `.qwp-cell-top` slot a normal cell uses for its vak label — that is what
makes a band exactly as tall as a filled lesuur, rather than a hand-tuned `min-height`. Anything
added to a band must stay out of flow (see `.qwp-thema-more`) or it will grow the row again.

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

**Lesfiche-manager.** Edits are *staged* into `mgr.pending` and only written through the
"Wijzigingen controleren" gate. Tag catalog CRUD writes immediately. Bulk delete is guarded by a
typed `VERWIJDER` plus an automatic JSON backup. `openPicker({title, preselected, startTagId,
onDone, onCancel})` opens the same overlay in **read-only pick mode**: every write affordance is
hidden, and `mgr.pickStore` keeps selections alive across tag switches.

**Methodevoortgang.** Read-only. Status derives from one field: `last_used_date` inside the chosen
school year. Two sources — a Questi vendor library, or your own fiches picked once via
`openPicker`. Blocks come from **subtags** for own-fiche methodes and from parsed titles for vendor
ones; rows are sorted by block rank so a thema is never split. Only the teacher's decisions
persist; titles and dates are re-fetched live every open. Note Questi rolls `schoolyear` in summer,
so between the roll and 1 September nothing counts as given — hence the explicit year picker.

**Lesdoelen print.** The print window's "Versie" choice: Gewoon (the original layout, untouched) or
Lesdoelen 1 A4 / 2 A4 (`printGoalsDocHtml`). Equal-height cards with WEET/KEN/KAN write lines
(3 per card on 1 A4, 8 on 2 A4, both ≈7mm; titles fixed at 2 lines — front = first half of the lesuren, back = rest + week info); the
free Wednesday afternoon holds thema names and the vak legend. Goals live **in the fiche** (see
"Lesdoelen in the fiche"); `loadPrintFicheGoals` reads them per print window and `goalsRecFor` merges
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

**Lesdoelen in the fiche (beta).** WEET/KEN/KAN are three per-fiche **extra** text fields (Questi
editor "+ toevoegen → Tekst"): `template_field_id: null`, value in `content`, `description` = the ⓘ
helper text. Matched by **title** (`ficheGoalFields`), never by id — field ids change with every fiche
version. `buildPatch` sends every extra field exactly as Questi's editor does, `{ id, content }`, and
`opts.goals` updates or appends them; never create an empty one. Text fields key on `fieldKey()`
(template id, or `"x"+id` for an extra field) — keying on `template_field_id` alone made all extra
fields share one `"null"` key. Goals mode in the manager (`makeGoalsTable`) stages into `mgr.pending`
like any edit and backs up ≥5 goal writes first. A planned lesuur keeps its fiche **version**, so print
falls back to the newest own fiche with the same title and marks the card "nieuwere versie".

**Beta channel.** Branch `beta`, sideloaded from its own folder (git worktree) next to the stable
addon. Manifest name contains `BETA` — that one string drives everything: `IS_BETA` in content.js,
planner.js and background.js. The beta has **no manifest CSS**; the worker inserts it on first use
(`QWP_INSERT_CSS`) so it never styles the stable overlay. content.js detects the stable copy by probing
for its CSS (`.qwp-banner` is `display:flex`) and then stays dormant with a visible notice; its chips use
`data-qwpb-*` attributes; shortcut Alt+Shift+P; update check + `update.bat` follow the `beta` branch.
Keep beta-only differences in manifest/icons/version.json/update.bat so feature commits cherry-pick
cleanly onto `dev`.

## Working on this repo

- After editing, reload the extension **and** reload the Questi tab — Chrome keeps old content
  scripts alive in already-open tabs. Each module logs its version on load; a missing line means a
  stale script.
- Syntax check with `node --check <file>` (node is available; it is not a dependency of the addon).
- Verification is manual: load unpacked on a `…/calendar` page and drive the UI. In summer there
  are no lesson items, so `groupId` stays null and several Zelftest rows WARN — that is expected.
- Bump `manifest.json` **and** `version.json` together on release.
