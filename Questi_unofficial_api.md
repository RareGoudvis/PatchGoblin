# Questi — unofficial API notes & PatchGoblin developer guide

> **Disclaimer.** Questi has no public API. Everything in Part 1 was reverse-engineered from the
> Questi web app's own network traffic (browser DevTools) and from what PatchGoblin has learned by
> using it. It is **unofficial**, **incomplete**, and **may change without notice**. It is not
> endorsed, reviewed or supported by Questi. Every id and value in the examples below is a
> placeholder — never copy one into code; PatchGoblin detects all of them at runtime.

This file is the developer reference. The user guide (Dutch) is [`README.md`](README.md).

## Contents

**Part 1 — The unofficial Questi API**

1. [Conventions](#1-conventions)
2. [Transport & authentication](#2-transport--authentication)
3. [Errors](#3-errors)
4. [Bootstrap & context detection](#4-bootstrap--context-detection)
5. [Calendar reads](#5-calendar-reads)
6. [Calendar writes](#6-calendar-writes)
7. [Lesfiche reads](#7-lesfiche-reads)
8. [Tag reads](#8-tag-reads)
9. [Lesfiche writes (create / edit / delete)](#9-lesfiche-writes-create--edit--delete)
10. [Tag writes (create / rename / delete)](#10-tag-writes-create--rename--delete)
11. [Templates & leerplandoelen (ZILL, Op.Stap)](#11-templates--leerplandoelen-zill-opstap)
12. [Methode fiches (vendor libraries)](#12-methode-fiches-vendor-libraries)
13. [Other reads](#13-other-reads)
14. [Write reliability: timeouts, "maybe written", read-back](#14-write-reliability-timeouts-maybe-written-read-back)
15. [Gotchas checklist](#15-gotchas-checklist)

**Part 2 — How PatchGoblin is built**

16. [Principles](#16-principles)
17. [Files and load order](#17-files-and-load-order)
18. [The `window` globals bridge](#18-the-window-globals-bridge)
19. [UI, CSS prefixes and themes](#19-ui-css-prefixes-and-themes)
20. [Storage](#20-storage)
21. [The write path: staging → Controleer → write](#21-the-write-path-staging--controleer--write)
22. [Loading: paint first, details after](#22-loading-paint-first-details-after)
23. [Feature internals worth knowing](#23-feature-internals-worth-knowing)
24. [Zelftest (self-diagnostics)](#24-zelftest-self-diagnostics)
25. [Releases, self-update and the beta channel](#25-releases-self-update-and-the-beta-channel)
26. [Working on the code](#26-working-on-the-code)

---

# Part 1 — The unofficial Questi API

## 1. Conventions

- Base URL: `https://www.questi.com/api`. In the code `API_ROOT = "/api"` and `API = "/api/cal"`;
  paths below are written relative to `/api` (so `/cal/items` means `/api/cal/items`).
- Placeholders: `<schoolId>`, `<userId>`, `<itemId>`, `<ficheId>`, `<tagId>`, `<groupId>`,
  `<calendarId>` (looks like `cal_12345`), `<templateId>`, `<tfid>` (a template-field id, a short
  hex string), `<METHOD_KEY>` (a methode library key such as `PUBLISHER_METHOD`).
- `schoolyear` is a label of the form `"YYYY - YYYY"` (with spaces), e.g. `2025 - 2026`.
- Array params use PHP style: `calendars[]=a&calendars[]=b`, `lessons[]=1&lessons[]=2`.
- Successful responses use the envelope `{ "status": "success", "result": … }`; lists that page also
  carry `num_records`.

## 2. Transport & authentication

- Plain **same-origin** `fetch(url, { credentials: "include" })` from a content script running on
  `questi.com`. The logged-in session cookies (session cookie + `XSRF-TOKEN`) ride along. There is
  no `Authorization` / bearer header and no API key.
- **Reads** (`GET`) need nothing else (PatchGoblin sends `Accept: application/json`).
- **Writes** (`POST` / `PATCH` / `DELETE`) must send header **`x-xsrf-token`** whose value equals the
  `XSRF-TOKEN` cookie (URI-decoded) — a double-submit CSRF check. Without it the write is refused.
  Writes with a body also send `Content-Type: application/json`.
- **Bodyless `DELETE` must NOT send `Content-Type`.** `application/json` with an empty body makes
  Questi answer HTTP 500. Send only `Accept` and `x-xsrf-token`.

```js
function xsrfToken() {
  var m = /(?:^|;\s*)XSRF-TOKEN=([^;]+)/.exec(document.cookie || "");
  return m ? decodeURIComponent(m[1]) : "";
}
function writeHeaders() {      // POST / PATCH with a JSON body
  return { "Content-Type": "application/json", "Accept": "application/json", "x-xsrf-token": xsrfToken() };
}
function bodylessHeaders() {   // DELETE — no Content-Type!
  return { "Accept": "application/json", "x-xsrf-token": xsrfToken() };
}
```

## 3. Errors

Application errors come back as HTTP 400 with:

```json
{ "status": "error", "error_type": "app_error", "error_msg": "<code> - <text>" }
```

Codes seen so far:

| Code | Meaning / when |
|---|---|
| `1203` | `tag does not exist` — an own-fiche fetch with a tag that is not yours (e.g. the universal tag `8` without `shared_userId`). |
| `1235` | `no access to lesson` — a methode (vendor) fiche on `/cal/lessons/{id}` (any `return_format`) or on the normal attachment endpoint. |
| `1253` | `shared_userId` without a valid tag. |
| `1254` | `searchstring required when searching without tags` — an own-fiche fetch with neither a tag nor a search string. |

Other statuses: HTTP 500 for a bodyless DELETE with `Content-Type`, for `/cal/items` with a
non-primitive `schoolyear`, and for an item PATCH with no group (`id_groep` null). HTTP 429 is rate
limiting. Gateway statuses (502/503/504/408/524) and network failures do **not** mean the write
failed — see [§14](#14-write-reliability-timeouts-maybe-written-read-back).

## 4. Bootstrap & context detection

Nothing is account-specific in code: every id is detected at runtime into a `ctx` object
`{ schoolId, schoolyear, calendarId, groupId, ownerId, ownDefaultTagId, calendars, school }`.

| Call | Gives |
|---|---|
| `GET /users/me` | `result.id` = your user id (the `owner.id` of your fiches), plus `firstname`, `lastname`, `level`, `is_student`, `is_parent`. |
| `GET /schools` | `result[].id` = **schoolId**, `name`, address fields, `current_schoolyear`. ⚠ `current_schoolyear` is an **object**, never a string — never `String()` it. Derive the `"YYYY - YYYY"` label from a label-like key, or from its `startdate`/`enddate` years. |
| `GET /cal/calendars?schoolId=<schoolId>` | The calendars you can see; their ids (`cal_<n>`) feed the `calendars[]` filter on `/cal/items`. `cal_holidays` is the school-holiday calendar. |
| `GET /cal/items/{id}` (any lesson item) | `groups[]` — the class **group id**, needed for every calendar write. The `/cal/items` *list* returns empty `groups`; only the detail has the real ones. |

Order: `users/me` → `schools` → `cal/calendars` → `cal/items` (→ one item detail for the group).

Useful tricks PatchGoblin uses:

- **Sniffing Questi's own requests.** The page has already fired requests carrying `schoolId=`,
  `schoolyear=` and `cal_<n>`. They are readable from `performance.getEntriesByType("resource")`,
  which needs no login-specific globals.
- **The viewed week.** Questi's SPA fetches `/cal/items?…&startdate=<Monday>&enddate=…` for the week
  on screen. Match **`/cal/items?` only**: `/cal/items/count` is a **month** query (its `startdate`
  is the 1st of the month — rolling that back to a Monday once opened the planner on a July week
  from an August view). Also require a week-shaped range (≤ 14 days) and skip your own reads
  (PatchGoblin marks them with an extra `pg=1` param, which Questi ignores).
- **Own default tag.** Own-fiche lists need your personal "Alle eigen lesfiches" tag id
  (`ownDefaultTagId`, see [§7](#7-lesfiche-reads)). Resolution order: sniff `default_tagId=` from
  Questi's own `/cal/lessons` request (skipping `shared_userId` ones) → `/cal/lessons/tags?filter=own`,
  pick the `parent: 0` tag whose title matches `/alle.*lesfiches/i` (else the first `type:"default"`
  one) → `/cal/lessons/possible-settings` → a manual value.
- **Cache.** The detected context is cached per user id; a later boot needs only `/users/me`, then
  re-verifies in the background and warns if anything changed.

## 5. Calendar reads

### `GET /cal/items` — items in a date range

```
GET /cal/items?schoolId=<schoolId>&calendars[]=<calendarId>&calendars[]=cal_holidays
              &startdate=YYYY-MM-DD&enddate=YYYY-MM-DD
```

- **Do not send `schoolyear`** on this read. The web app omits it, and a non-primitive value (the
  object from `/schools`) makes it HTTP 500.
- `result[]` items: `{ id, title, startdate: "YYYY-MM-DDTHH:MM:SS+02:00", enddate, is_fullday_item,
  id_repeat, is_editable, has_attachments, id_calendar, is_published_students,
  is_published_parents, groups, translation }`.
- `id_repeat` identifies a recurring series (stable across weeks and renames). Several occurrences
  may share an `id`, so key an occurrence by `id` + date. ⚠ Only the item PATCH takes an occurrence
  window: `GET /cal/items/{id}` and the attachment POSTs carry no date. For occurrences that share an
  id, PatchGoblin writes each one but reports its fiche link as checked per item, not per week
  (untested: whether the POST then hits one occurrence or the series — capture pending).
- ⚠ **The list `title` is not the stored title** (since about October 2026). For an item with a
  fiche attached, the list's `title` is the computed `title_lessons`, decorated like
  `"* <fiche subject> (1)"`. Questi's own calendar shows that decorated text, and no title PATCH
  changes it. Read the real title from the detail; never write the list title back.
- `groups` is empty in the list.

### `GET /cal/items/{id}` — item detail

```
GET /cal/items/<itemId>?schoolId=<schoolId>
```

Adds: `title` (the **real stored** title), `title_lessons` (the decorated one), `description`
(HTML), `starttime`, `endtime` (`"8:35:00"`), the real `groups[]`, and `attachments[]`:

```json
{ "id_attachment": 11111, "id_type": 1, "content": { "id": "<ficheId>", "url": "…", "subject": "<fiche title>" } }
```

- `id_type: 1` = a lesfiche. `content.id` is the linked fiche id.
- ⚠ `id_attachment` changes every time a fiche is re-linked — never cache it.

### `GET /cal/items/count` — per-day counts (a MONTH query)

```
GET /cal/items/count?schoolId=<schoolId>&calendars[]=…&startdate=YYYY-MM-01&enddate=YYYY-MM-31
→ [ { "date": "YYYY-MM-DDT00:00:00+02:00", "calendars": [ { "id": "<calendarId>", "num": 2 } ] }, … ]
```

PatchGoblin does not call it; it only has to avoid mistaking it for the week query (§4).

## 6. Calendar writes

All calendar writes touch **one occurrence only**. PatchGoblin never edits a recurring series.

### `PATCH /cal/items/{id}` — edit one occurrence

```
PATCH /cal/items/<itemId>?schoolId=<schoolId>&schoolyear=YYYY - YYYY&apply_to_next_items=false
      [&range_startdate=YYYY-MM-DD&range_enddate=YYYY-MM-DD]
```

```json
{ "calendarId": "<calendarId>", "title": "Lesuur 1", "description": "<vak name>",
  "is_fullday_item": false,
  "startdate": "YYYY-MM-DD", "enddate": "YYYY-MM-DD", "starttime": "8:35:00", "endtime": "9:25:00",
  "is_published_students": false, "is_published_parents": false,
  "groups": [ { "groupId": "<groupId>", "schoolId": "<schoolId>" } ], "participants": [] }
```

- Writes **do** send `schoolyear` (unlike the read).
- `apply_to_next_items=false` + the occurrence window `range_startdate`/`range_enddate` (the week
  the item was read in) = this occurrence only.
- `groups` are **objects** `{ groupId, schoolId }` here. A missing/null group 500s the call — never
  send `{ groupId: null }`.
- A full-day item: `is_fullday_item: true`, keep its date span, no times.
- Questi rejects an empty title — PatchGoblin falls back to `"Lesuur"`.
- **Attachments:** omit the `attachments` key to **keep** the linked fiche. To **detach**, send
  `"attachments": []` (there is no DELETE for item attachments). The captured web-app PATCH has no
  `attachments` key; `[]` is what PatchGoblin sends for an emptied or gym lesuur.
- Response: `{ result: { items: [ { id, title, startdate, enddate, … } ] } }`.

### `POST /cal/items/{id}/attachments` — link an own/colleague fiche

```
POST /cal/items/<itemId>/attachments?schoolId=<schoolId>&schoolyear=YYYY - YYYY
```

```json
{ "attachments": [ { "schoolId": "<schoolId>", "visible_parents": false, "visible_students": false,
                     "students": [], "groups": ["<groupId>"], "id": "<ficheId>", "typeId": 1 } ] }
```

- Here `groups` are **raw numeric ids**, not objects.
- Read→write renames: `content.id → id`, `id_type → typeId`, `is_visible_* → visible_*`.
- ⚠ **The POST retitles the item** to Questi's decorated `"* <fiche> (1)"`. Its response carries that
  title. PatchGoblin therefore POSTs the attachment first and PATCHes its own plain title right
  after, and **never re-POSTs an unchanged fiche** (doing so once rewrote every old lesuur's title).
- For a methode fiche use `…/attachments/methodlesson` instead ([§12](#12-methode-fiches-vendor-libraries)).

## 7. Lesfiche reads

### `GET /cal/lessons` — a page of fiches under one tag

```
GET /cal/lessons?schoolId=<schoolId>&sorting=new_items&status=active&num=100&offset=0
               &default_tagId=<tagId> | &user_tagId=<tagId>
               [&shared_userId=<colleagueUserId>]
→ { "status": "success", "num_records": 973,
    "result": [ { "id", "subject", "last_used_date", "owner": { "id", … }, "co_editors": [],
                  "grades": ["L3"], "context": [], "contains_attachments", "id_school",
                  "active", "visibility": "school" } ] }
```

- Paged with `num` / `offset`; `num_records` is the total. PatchGoblin reads 100 per page.
- `sorting=new_items` = newest first (what Questi's own list uses).
- **Exactly one tag filter is required**, and which key depends on the tag type:
  - a **default bucket** tag (`type: "default"`: "Alle eigen lesfiches", "Lesfiches zonder tag",
    "Samenwerk fiches", universal) → `default_tagId=<id>`;
  - a **user category** tag (`type: "user"`: a vak or subtag) → `user_tagId=<id>`.
    Sending `default_tagId` for a user tag 400s.
- **Own fiches** need your **personal** default tag (`ownDefaultTagId`). The default-bucket ids are
  per account — never hardcode them.
- **A colleague's fiches**: add `shared_userId=<colleague>` with one of their tags. The universal
  tag (`8` in captures) is only valid together with `shared_userId`; on an own fetch it answers
  `1203`.
- Never send an empty `searchstring` (400) — omit the key. With no tag and no search string an own
  fetch answers `1254`.
- ⚠ **The list carries no per-fiche tags.** Membership is known only by *which* tag you fetched.
- ⚠ Fetching a **parent** tag does **not** include fiches tagged only with a **child** tag. To see
  everything under a vak, fetch the parent and every child and union by fiche id.
- ⚠ The list has **no `thread`** (see the edit view).
- ⚠ `last_used_date` may be `null`, `""`, `"0000-00-00"`, a full date, or a bare year. Guard all.

### `GET /cal/lessons/{id}?return_format=edit` — one fiche, editable view

```
GET /cal/lessons/<ficheId>?schoolId=<schoolId>&return_format=edit
```

The source of truth for any fiche write:

```json
{ "id": "<ficheId>", "thread": "<threadId>", "subject": "Titel",
  "tags": [ { "id": "<tagId>", "title": "…", "color": "#hex" } ],
  "grades": ["L3"], "visibility": "school", "owner": { … }, "co_editors": [],
  "template": { "id": "<templateId>", "name": "…", "is_latest": false, "id_latest_version": "<templateId>" },
  "attachments": [ { "id_attachment", "id_type": 1, "content": { "id", "url", "subject" } } ],
  "fields": [
    { "id": 1001, "type": "text",  "title": "Lesverloop", "template_field_id": "<tfid>", "content": "<html>" },
    { "id": 1002, "type": "goals", "template_field_id": "<tfid>", "selected_goals": […], "content": { "goals": […] } },
    { "id": 1003, "type": "methods", "title": "Doelen", "template_field_id": "<tfid>",
      "method": { "id": "<METHOD_KEY>", … }, "content": { …vendor doelen tree… }, "concordances": [ … ] },
    { "id": 1004, "type": "text", "title": "WEET", "description": "<helper text>", "order": 1,
      "mandatory": false, "template_field_id": null, "content": "…" } ] }
```

- `fields[].id` is a field-instance id. ⚠ **Every field id changes with every fiche version** — always
  re-read before a PATCH, never cache them.
- **`thread`** is the fiche's lineage: every version of one fiche reports the same `thread`. Since each
  edit mints a new fiche id ([§9](#9-lesfiche-writes-create--edit--delete)), a calendar item keeps
  pointing at the *version* it was linked to; `thread` is the only way to find the newest version,
  and it is only available from edit views (PatchGoblin remembers `thread → newest id seen`).
- Fields with `template_field_id: null` are **per-fiche extra fields** (Questi editor
  "+ toevoegen → Tekst"). Their value is `content`; `description` is the ⓘ helper text.
- `return_format=view` also exists (read-only view; PatchGoblin uses it only in the Zelftest).
- A methode (vendor) fiche answers `1235` here on every `return_format`.

## 8. Tag reads

```
GET /cal/lessons/tags?schoolId=<schoolId>                                 (all visible)
GET /cal/lessons/tags?schoolId=<schoolId>&filter=own                      (your tree)
GET /cal/lessons/tags?schoolId=<schoolId>&filter=shared&active_users=true (colleagues' tags)
→ result[]: { "type": "user" | "default", "id", "title", "icon", "color": "#hex",
              "parent": 0 | <parentTagId>, "order", "number_of_lessons",
              "owner": { "id", … }, "is_owner", "context", "pinned" }
```

- `parent: 0` = a head (root) tag. Roots include the `type: "default"` buckets ("Alle eigen
  lesfiches", "Lesfiches zonder tag", "Samenwerk fiches") and your own category roots (typically
  one per vak), with subtags below them.
- Filter the shared list by `owner.id` to get one colleague's tags.
- Questi stores tag titles **lower-cased**.

## 9. Lesfiche writes (create / edit / delete)

### Create — `POST /cal/lessons?return_format=short`

```json
{ "schoolId": "<schoolId>", "subject": "Titel", "grades": ["L3"], "visibility": "school",
  "tags": ["<tagId>"], "create_tags": [ { "name": "Nieuw", "color": "#e0e0e0" } ],
  "attachments": [], "templateId": "<templateId>",
  "fields": [
    { "field_type": "text",  "template_field_id": "<tfid-1>", "content": "<html>" },
    { "field_type": "goals", "template_field_id": "<tfid-2>",
      "selected_goals": ["00000000-0000-0000-0000-000000000001"] },
    { "field_type": "text", "title": "WEET", "description": "", "order": 1, "content": "…" } ] }
→ { "status": "success", "result": { "id": "<newFicheId>", "subject", "owner", "grades",
                                      "visibility", "id_school", "active", "contains_attachments" } }
```

- One entry per template field (`template_field_id` = the template's `structure[].id`, see §11).
- `selected_goals`: the leerplandoel ids — **numbers for ZILL**, **UUID strings for Op.Stap**. Never
  cast an Op.Stap id.
- Questi's own editor omits `tags`/`create_tags` when the fiche has none.
- `visibility`: `"private"` or `"school"`.
- Extra text fields (e.g. WEET/KEN/KAN) can be appended with the extra-field shape. Whether a create
  always keeps them is not guaranteed: PatchGoblin reads the new fiche back and adds missing ones
  with one PATCH.
- A `methods` field has no captured create shape; PatchGoblin leaves it out (and says so).

### Edit — `PATCH /cal/lessons/{id}?return_format=short`

```json
{ "lessonId": "<ficheId>", "subject": "Titel", "schoolId": "<schoolId>", "attachments": [],
  "tags": ["<tagId-a>", "<tagId-b>"], "create_tags": [],
  "fields": [
    { "template_field_id": "<tfid-1>", "id": 1001, "content": "<html>" },
    { "template_field_id": "<tfid-2>", "id": 1002 },
    { "id": 1004, "content": "Ik kan …" },
    { "field_type": "text", "title": "KEN", "description": "", "order": 2, "content": "…" } ] }
→ { "result": { "id": "<NEW ficheId>", … } }
```

Per-key rules — they differ, do not conflate them:

| Key | Rule |
|---|---|
| `tags[]` | **Full replace.** Echo the current tag ids or a title-only edit wipes the tags. Adding/removing a tag = read current set, add/filter, PATCH. `create_tags: [{name, color}]` creates and attaches a new tag inline. (Questi's own editor sometimes sends neither `subject` nor `tags`; then they are kept — PatchGoblin always sends both explicitly.) |
| goals field | **Omit `selected_goals` to keep.** Send `{ template_field_id, id }` with no `selected_goals` key. **Never send `selected_goals: []`** — it clears the goals. |
| `methods` field | Send `{ template_field_id, id }` only ⇒ unchanged. |
| template text field | `{ template_field_id, id, content }`. Include every field from the edit read so none drop; echo the current `content` on fields you don't change. |
| extra text field (existing) | Exactly what Questi's editor sends: **`{ id, content }`** — no `template_field_id` key. |
| extra text field (new) | `{ field_type: "text", title, description, order, content }`. Never create an empty one. |
| `grades`, `visibility` | **Trial.** These are the create call's keys; they were never captured on a PATCH. PatchGoblin sends them only when changed and reads the new version back to check. |
| `attachments` | PatchGoblin sends `[]`. A captured web-app edit sends `[{ "attachmentId": <n> }]` for a fiche with files; whether `[]` wipes existing file attachments is **untested**, and where the write-side `attachmentId` comes from is unknown (it matches neither `content.id` nor `id_attachment`). |

⚠ **Every PATCH mints a new fiche version with a new `result.id`** (≠ `lessonId`). Re-read it and use
it for any later operation. Field ids change too. Calendar items keep pointing at the old version.

**WEET / KEN / KAN.** PatchGoblin stores lesdoelen as three per-fiche extra text fields titled
`WEET`, `KEN`, `KAN` (value in `content`). They are matched by **title** (case-insensitive), never by
id, because ids change per version. In a key map, an extra field must key on its own id
(`"x" + id`), not on `template_field_id` — all extras share `null`.

### Delete — `DELETE /cal/lessons`

```
DELETE /cal/lessons?schoolId=<schoolId>&lessons[]=<ficheId>[&lessons[]=<ficheId>…]
→ { "status": "success" }
```

Bulk, **no body, no `Content-Type`** (else HTTP 500), `x-xsrf-token` required. **Irreversible** —
there is no server-side undo. PatchGoblin gates it behind a typed `VERWIJDER` and an automatic JSON
backup.

## 10. Tag writes (create / rename / delete)

### Create — `POST /cal/lessons/user-tags`

```json
{ "title": "spelling", "color": "#e0e0e0", "schoolId": "<schoolId>", "parent": "<parentTagId>" }
→ result: the new tag object { "type": "user", "id", "title", "color", "parent", … }
```

Omit `parent` (or send `0`) for a head tag.

### Rename / recolour / move — `PATCH /cal/lessons/user-tags/{id}`

```json
{ "title": "Spelling", "color": "#c2c2c2", "parent": 0, "schoolId": "<schoolId>" }
→ { "result": { "type": "user", "id", "title": "spelling", "color": "#c2c2c2", "parent": 0, … } }
```

- Send exactly `{ title, color, parent, schoolId }`.
- **`parent` is required** (`0` = head tag). Questi's own dialog was captured on a head tag and sent
  no `parent`; sent on a **subtag**, that body silently turns it into a head tag (shipped as a bug
  once). Changing `parent` moves the tag.
- Questi **lower-cases** the title; show the reply, not what you sent.

### Delete — `DELETE /cal/lessons/user-tags/{id}`

```
DELETE /cal/lessons/user-tags/<tagId>?schoolId=<schoolId>&action=unlink
DELETE /cal/lessons/user-tags/<tagId>?schoolId=<schoolId>&action=move&secondTagId=<otherTagId>
```

Bodyless (no `Content-Type`). `unlink`: the fiches stay and lose this tag. `move`: the fiches are
re-tagged to `secondTagId`, then the tag is deleted. To change one fiche's tags, use the fiche
PATCH `tags[]` instead.

## 11. Templates & leerplandoelen (ZILL, Op.Stap)

### `GET /cal/lessons/templates`

```
GET /cal/lessons/templates?schoolId=<schoolId>
→ result[]: { "id": "<templateId>", "name": "…", "lessons_count",
              "structure": [ { "id": "<tfid>", "type": "text" | "goals" | "methods", "title", … } ] }
```

- A `structure[]` entry's `id` **is** the `template_field_id` a create needs.
- A `goals` entry carries `source.version` — `{ id, format_type }`. Seen: ZILL
  (`format_type: "zill"`, version 36) and Op.Stap (`format_type: "opstap"`, version 57). Read the
  version off the template; never hardcode it.
- A `methods` entry carries `method.id` = a methode KEY ([§12](#12-methode-fiches-vendor-libraries)) —
  an exact template ↔ methode link. Older (ZILL-era) templates that follow a vendor methode have
  one; the Op.Stap templates seen so far do not.

### ZILL goals

`GET /cal/lessons/goals/<versionId>?goals[]=<original_id uuid>…` returns a ZILL tree of nodes
`{ id (numeric), code, title, is_goal, original_id (uuid), children[] }`. The **numeric `id`** goes in
`selected_goals`; the `original_id` is the query key. (Documented from a capture; PatchGoblin does not
call it yet.)

### Op.Stap goals

- Op.Stap leerplandoel ids are **UUID strings**; `selected_goals` stores the bare UUIDs.
- Questi's editor uses Katholiek Onderwijs Vlaanderen's own web component `<op-stap-selector>`,
  loaded from `https://opstap.katholiekonderwijs.vlaanderen/webcomponent/op-stap-selector.latest.js`
  — and only once Questi's own fiche editor has been opened.
- In `mode="FULL"` the component renders its own select button, modal and selected list. Initial
  selection: attribute `keys` = JSON array of `"/content/<uuid>"`.
- It reports selections with the DOM event **`OpStapSelectionChanged`**, detail
  `{ selectedKeys: ["/content/<uuid>", …] }`. Strip the `/content/` prefix to get the id.
- Opening the modal first fires an **empty** event `{ selectedKeys: [], version: null }`. Ignore it,
  or opening the picker wipes the selection.
- **Why a MAIN-world script:** a content script runs in an isolated world, and a `CustomEvent`'s
  `detail` object does not cross into it. `opstap-bridge.js` is a second content-script entry with
  `"world": "MAIN"` that copies each detail (for elements marked `data-pg`) into a `data-pg-sel`
  attribute as JSON; the extension observes that attribute. The bridge also loads the component
  script on an `pg-opstap-load` event and marks `<html data-pg-opstap="1">` once
  `customElements` has it.

## 12. Methode fiches (vendor libraries)

Publisher methode libraries (e.g. a reading or maths method) are read-only vendor content.

```
GET /cal/manage/methods/<schoolId>
→ result[]: { "id": "<METHOD_KEY>", "publisher": { "id", "name" }, "name", "hash",
              "grades": ["L2", "L3"], "is_cluster": true, "has_concordance": true, "available": true }

GET /cal/methods/<METHOD_KEY>/lessons?is_cluster=<bool>&schoolId=<schoolId>
→ result[]: { "id", "subject", "last_used_date", "grades" }      — no tags, no owner
```

- The lesson list is **unpaged**: one call returns everything.
- `available: false` = the library is listed but not (yet) published.
- **Content:** `/cal/lessons/{id}` refuses methode fiches with `1235` on every `return_format`. The one
  route that returns content (captured 2026-08) is
  `GET /cal/methods/<METHOD_KEY>/lessons/<lessonId>?is_cluster=<bool>&schoolId=<schoolId>`. The result
  is a synthesized view: `id: null`, `thread: null`, `template: null`, `tags: []`, `owner` = the
  caller, `id_method_lesson`, and exactly **one** field of `type: "methods"` holding the vendor's
  doelen tree (`content`) and a curriculum `concordances[]` (with numeric ZILL goal ids). There is no
  lesson prose to copy.
- **Linking to a calendar item** needs a dedicated endpoint (the normal one answers `1235`):

```
POST /cal/items/<itemId>/attachments/methodlesson?schoolId=<schoolId>&schoolyear=YYYY - YYYY
{ "schoolId": "<schoolId>", "visible_parents": false, "visible_students": false,
  "students": [], "groups": ["<groupId>"], "id": "<methodeLessonId>" }      — no typeId, not wrapped
```

  The response carries the decorated `"* <fiche> (1)"` title; do not reuse it.

## 13. Other reads

| Call | Gives |
|---|---|
| `GET /cal/lessons/possible-settings?schoolId=<schoolId>` | `co_owners[]` (people). Some accounts may expose a default tag here; PatchGoblin probes a few key names and treats it as a fallback only. |
| `GET /cal/items/shares/possible-participants?schoolId=<schoolId>` | `result[]: { id, firstname, lastname, email, level, function }` — used to pick colleagues. |
| `GET /cal/attachments/<schoolId>/possible-students` | Groups with students (`{ id, name, num_students, students[] }`). Not used. |

## 14. Write reliability: timeouts, "maybe written", read-back

A write has **three** outcomes, not two:

1. **Done** — 2xx and no `"status": "error"`.
2. **Refused** — Questi answered with an error (400 app error, 500, …). Nothing changed; a retry
   is safe once the cause is fixed.
3. **Onzeker (maybe written)** — no answer within **30 s** (PatchGoblin aborts the fetch), a dropped
   connection, or a gateway status **502 / 503 / 504 / 408 / 524**. Questi may well have committed
   the write. Never report this as "failed", and never blindly retry a non-idempotent write.

How PatchGoblin settles "maybe written":

| Write | Verification |
|---|---|
| Calendar item (`verifyLanded`, planner) | Wait 1.5 s, re-read `/cal/items/{id}`. Fiche attached (by `content.id`) **and** title as sent → *landed*. Fiche attached but title not → redo the title PATCH (a PATCH is safe to repeat) → *landed*. Attachment missing → *not written*, retry is safe. Read fails → *unknown*: the slot is flagged, and the next commit reads the item first and skips the attachment POST if that fiche is already there (an attachment POST must never run twice). |
| New fiche (`writeNewFiche` + `findCreatedFiche`) | Before the POST, read the 10 newest own fiches as a baseline. After an unclear answer, wait 1.5 s and read them again: a fiche with this exact subject that was not in the baseline = created after all (no second POST). None → not created. Read fails → stays uncertain, and the baseline is kept on the staged fiche (`p.createUnsure`): the next attempt runs the same check first and only POSTs when the fiche is certainly not there. Once a POST returned an id, that id is kept (`p.createdId`); a failed read-back or WEET/KEN/KAN PATCH after it is reported, and the goals come back as an ordinary staged edit on the new id — never a second POST. |
| Fiche PATCH (`writeFiches` + `findNewVersion`) | One baseline of the 10 newest own fiches per write run (every id the run mints joins it). After an unclear answer, wait 1.5 s, read the list again and read the edit view of each fiche not in the baseline: one with the same `thread` = the PATCH landed (no second PATCH; its new id is used). None → not written, retry is safe. Read fails → stays uncertain with a marker (`p.unsure`); the next attempt checks first. If the baseline read itself failed, the candidates are the fiches titled as sent (the old id was the newest version, so any other version of its thread is ours). If the fiche was changed again meanwhile and the earlier PATCH landed, the newer state is PATCHed on top of the landed version. There is no endpoint that lists a thread's versions — this relies on a new version showing up at the top of the `new_items` list, the same assumption the create check makes. |
| Tag create (`createUserTag`) | Baseline = the cached own tags. Re-read own tags: a new tag with the same (lower-cased) title and parent = created. |
| Tag rename (`renameUserTag`) | Re-read own tags: title, colour and parent as sent = landed. |
| Fiche DELETE | Not settled automatically — reported as *onzeker*. Before any delete, a backup is downloaded; if the download or any fiche read fails, deleting needs an explicit confirm. |

Further rules:

- **Read-back of normal successes is selective**, to keep traffic light: a newly linked fiche is
  re-read once per lesuur (Questi has silently dropped attachments before) — when that read fails,
  the lesuur is reported as *weggeschreven, niet nagelezen*, never as a plain success; a fiche edit that
  touched goals/tags/grades/visibility is re-read and mismatches are reported. Plain PATCHes are not.
- **HTTP 429** — the planner's write path retries with backoff 1 s → 2 s → 4 s (max 3 retries), then
  gives up. (The Lesfiche-manager's writes do not retry on 429; they run one at a time with a short
  pause between them.)
- **Pacing.** No bulk endpoints exist for calendar writes; PatchGoblin writes sequentially with a
  small delay, and parallel reads are capped at 4 in flight.

## 15. Gotchas checklist

- `x-xsrf-token` header on every write; bodyless DELETE without `Content-Type`.
- `current_schoolyear` is an object; writes need the `"YYYY - YYYY"` label.
- No `schoolyear` on `/cal/items` reads; writes **do** send it.
- `/cal/items/count` is a month query — don't confuse it with the week list.
- List `title` ≠ stored title; read the detail. The attachment POST retitles the item to
  `"* <fiche> (1)"`.
- `/cal/items` list `groups` are empty; the detail has them. PATCH `groups` = objects, attachment POST
  `groups` = raw ids.
- Calendar writes: `apply_to_next_items=false` + occurrence range; never touch a series.
- Don't cache `id_attachment` or fiche field ids.
- Every fiche PATCH mints a new id — re-read `result.id`. Use `thread` to follow versions.
- Fiche PATCH: `tags[]` replace (echo to keep) vs. `selected_goals` omit-to-keep (never `[]`).
- Extra fields: value in `content`, update as `{ id, content }`, match by title.
- `default_tagId` for default buckets, `user_tagId` for user tags; own fetches need your personal
  default tag; the universal tag needs `shared_userId` (else `1203`).
- Never send an empty `searchstring`.
- Parent-tag fetch ≠ union of its children.
- `last_used_date`: `null`, `""`, `"0000-00-00"`, bare year — guard them all.
- Tag PATCH: always send `parent`; titles come back lower-cased.
- Op.Stap goal ids are UUID strings, ZILL ids numbers; skip the empty `OpStapSelectionChanged`.
- Methode fiches: `1235` on `/cal/lessons/{id}` and on the normal attachment endpoint; use
  `/cal/methods/{KEY}/lessons/{id}` and `…/attachments/methodlesson`.
- Gateway status / timeout / dropped connection = maybe written. Verify by reading back.

---

# Part 2 — How PatchGoblin is built

## 16. Principles

- **No build step.** Plain ES5-style IIFEs (`var`, `function`, no modules, no `import`), loaded
  directly by the manifest. No npm, bundler, transpiler or test runner. Don't add a toolchain.
- **Nothing hardcoded per account.** All ids are detected into `ctx` (Part 1, §4).
- **No silent magic.** When something is guessed, skipped, degraded or fell back, the UI says so.
- **Never classify a lesuur by its live title.** `slot.title` is user-editable and is overwritten when
  a fiche is assigned. Identity comes from stamped fields (thema identity, full-day flag) or the
  lesuur's vak tag. Title regexes are bootstrap heuristics for the *original* title or for tag titles.
- **Writes are gated.** Every mutation is staged and goes through one review the user approves.
- **Dutch UI, English code/comments/commits.**
- **Reuse before writing.** Shared helpers live in `planner.js` and are exported through
  `__PG_SHARED`. Function declarations hoist — a duplicate silently shadows the original.

## 17. Files and load order

| File | Role |
|---|---|
| `manifest.json` | MV3. Permissions `storage`, `activeTab`, `scripting`; hosts `questi.com` + `raw.githubusercontent.com` (update check). Two content-script entries: the isolated-world scripts + CSS, and `opstap-bridge.js` in the MAIN world at `document_start`. Alt+P command. |
| `background.js` | Service worker. Relays the toolbar click / Alt+P to the tab (`PG_TOGGLE`); answers `PG_CHECK_VERSION` (fetches `version.json` from GitHub); for a beta copy injects the CSS (`PG_INSERT_CSS`). |
| `planner.js` / `planner.css` | The PatchGoblin window `#pg-overlay`: Plannen, Afdrukken, the shared Controleer. Also context detection, the API layer, print documents and the Zelftest. Exports `__PG_SHARED`. |
| `lessons.js` / `lessons.css` | Lesfiche-manager: mounted as the planner's **Lesfiches** tab; standalone `#pgl-overlay` for read-only pick mode. Fiche + tag CRUD, new fiche, Op.Stap picker host. |
| `methodes.js` / `methodes.css` | Methodevoortgang `#pgm-overlay`. Read-only progress tracker. |
| `settings.js` / `settings.css` | Instellingen + first-run wizard `#pgs-overlay`. Settings export/import, Zelftest `.json`. |
| `content.js` | Boot/relay, last in order. Injects the PatchGoblin launcher button + quick menu into Questi's calendar header, reopens the planner after a write-triggered reload, handles the beta/stable coexistence. Builds no other UI. |
| `opstap-bridge.js` | MAIN-world bridge for the Op.Stap web component (Part 1, §11). |
| `version.json`, `update.bat`, `install.bat` | Self-update and install (§25). |
| `icons/`, `docs/img/` | Icons/mascot; README screenshots (rendered with invented data). |

Content-script order is **significant**:

```
planner.js → lessons.js → methodes.js → settings.js → content.js        (isolated world)
opstap-bridge.js                                                         (MAIN world)
```

`planner.js` defines the shared bridge, the others consume it, `content.js` boots last.

## 18. The `window` globals bridge

There are no modules; files talk through `window` globals.

| Global | Set by | Purpose |
|---|---|---|
| `__PG_SHARED` | planner | ctx, API helpers, DOM helper `h`, storage, tag helpers, and (by reference) the planner's `state`/`view` for settings.js |
| `__PG_TOGGLE` | planner | open/close the planner |
| `__PG_OPEN_LESSONS` | planner | open the planner on its Lesfiches tab |
| `__PG_PRINT` | planner | open the planner on its Afdrukken tab |
| `__PG_TEST` | planner | debug handles |
| `__PG_PENDING_COUNT` | planner | staged-change count for the launcher badge |
| `__PG_LESSONS` | lessons | `open, close, openPicker, mount, unmount, createUserTag, writeTags, writeFiches, backupPending, pendingSummary, …` |
| `__PG_METHODES` | methodes | `open, close` |
| `__PG_SETTINGS` | settings | `open(sectionId?), openSetup, close, exportSettings, saveDebugJson, …` |
| `__PG_BOOTED` | content | double-injection guard |

Each consumer starts with `function S() { return window.__PG_SHARED; }`. Before adding a helper to
a consumer, check whether planner already has it and export that instead.

## 19. UI, CSS prefixes and themes

- **No HTML files.** All DOM is built with the hyperscript helper `h(tag, attrs, kids)`
  (`attrs`: `class`, `text`, `style`, `on*`; anything else becomes an attribute; `null` is skipped).
- Each module owns a fullscreen overlay and a CSS prefix — `pg-` planner, `pgl-` lessons, `pgm-`
  methodes, `pgs-` settings — and namespaces all CSS under its overlay id. Overlays set
  `html.qwX-locked` to freeze the page behind them.
- z-index: planner < settings < methodes < lessons (the manager opens on top of methodes in pick mode).
- **Themes:** light "Parchment" (default) and dark "Slate", set as `html[data-pg-theme]`. Every colour
  goes through CSS tokens (`--page --panel --surface --hover --soft --line --line2 --ink --muted
  --faint` + the `--pg-*` brand palette); each stylesheet ends with its dark token block. Print
  documents keep literal colours and always print white. Vak colours on cards are the teacher's own
  Questi tag colours.
- Design rule from the user: no decorative accent stripes (coloured left edges, top strips) on cards,
  rows or notes — state shows through fill or text.

## 20. Storage

`chrome.storage.local` with a `localStorage` fallback; no sync, no IndexedDB. `storeGet(key)` /
`storeSet(key, val)` in planner.js are the only accessors; a failed save is logged and shown in the
status line.

| Key | Contents |
|---|---|
| `pg_state_v6` | Planner state: lesrooster (slot → vak tag, keyed `"<dayIdx>\|<HH:MM>"`), colleagues, manual overrides, vak/thema overrides, theme, settings fields (`vakTags`, `vakOrder`, `setupDone`, `writeVakDescription`, …). Restored **field by field** (`mergeState` / `mergeUqSettings`) — a new field not added there resets on every reload. |
| `pg_ctx_v1` | Detected context per Questi user id. |
| `pg_lessons_v1` | Lesfiche-manager: last tag, page size, columns, sort. |
| `pg_methodes_v1` | Methode definitions, order, manual overrides (see §23). |
| `pg_goals_v1` | Local lesdoelen for cards without an own fiche (`"f:<ficheId>"` / `"i:<itemId>"`), hide flags. |
| `pg_threads_v1` | Fiche lineage `{ "<thread>": newest fiche id seen }`. |
| `pg_goalcache_v1` | Goals (and tags) per fiche **version** — exact forever, since a version never changes. |
| `pg_print_v1` | Print choices (`mode`, `tabs`, `legend`, `meta`). |
| `pg_xhide_v1` | Other-agenda items hidden from the Lesdoelen print. |

**Migration (v2.0).** Before the PatchGoblin rebrand every key was named `qwp_*` (e.g. `qwp_state_v6`).
`storeGet` reads a `pg_*` key that does not exist yet from its old `qwp_*` name, copies it to the new name
and keeps the old copy, so an update keeps all settings and going back to v1.x still works. The status line
says how many parts were carried over. Settings files exported before v2.0 (`format: "unquesti-settings"`)
are still accepted by import.

## 21. The write path: staging → Controleer → write

1. **Staging.** Every edit is staged in memory: calendar changes on the planner's slots, fiche edits
   and new fiches in the manager's `mgr.pending`, new tags in `mgr.pendingTags`. Nothing is written.
   Staged calendar edits survive week navigation (a memory-only stash keyed `itemId|date`; each slot
   keeps the week window it was read in, so each PATCH hits its own occurrence).
2. **One shared Controleer** (`openReview`) lists everything in write order — tags to create, fiche
   edits / new fiches, calendar rows (`buildCommitPlan`), plus opt-in "Fiche-versie" rows — each with
   a checkbox. Unticked rows stay staged. Calendar rows are a dry-run diff (old/new title, description,
   fiche), optionally drawn as grids.
3. **`runSharedWrite`**, in this order:
   1. **backup** — a JSON download of the fiches about to change (ticked by default);
   2. **tags** — `writeTags` (POST user-tags);
   3. **fiches** — `writeFiches`: new fiches first (POST + read-back), then PATCHes; returns
      `oldId → newId` for every version minted;
   4. **remap** — every slot pointing at an old version written in this run now points at the new id;
   5. **calendar** — `buildCommitPlan` again, filtered to ticked rows → `doCommit`: per lesuur,
      POST the attachment only if the fiche changed, then PATCH title + description (single
      occurrence), read back a newly linked fiche, verify on unclear answers (§14).
   A lesuur that would receive a fiche whose write failed is held back and reported, never attached
   silently.
4. **Finish.** Written rows become the new "stored" state; left-out rows stay staged. If everything
   landed and nothing is left, the page reloads (Questi's SPA does not refetch) and PatchGoblin
   reopens on the same weeks; otherwise a per-phase summary is shown, uncertain writes separately.

Ctrl+Z undoes staged edits (stack of 30, cleared on week change).

## 22. Loading: paint first, details after

- Boot needs one `/users/me` when the context is cached; full detection re-verifies in the background.
- A week loads from the `/cal/items` **list** first and paints at once. Every lesuur that needs its
  detail is marked pending, shows a "laden…" pill and takes no input; details are read 4 at a time
  (`mapLimit`) with quiet retries, and the grid repaints (throttled) as they arrive.
- `isUnhydrated(s)` is the single gate: an unread slot is never dirty, never auto-fixed, never a
  drop target, and Controleer and the bulk tools refuse with a visible reason until everything is read.
- Two weeks are always shown; holiday weeks (no non-full-day, non-holiday item) are skipped and more
  weeks are loaded (up to 3 extra), said in the status line.
- Fiche goal reads (Doelen mode, Lesfiches goal columns, print) are viewport-driven or capped at 4
  in flight, and cached per fiche version.

## 23. Feature internals worth knowing

- **Vak = description.** Questi has no subject field. The teacher's class website (Enderklas) shows an
  item's title as the lesson and its **description** as the vak, so PatchGoblin writes the vak name
  into the description (configurable). The vak comes from: manual pick → the fiche's own tag →
  the stored description → the lesrooster setting. The lesrooster also fills itself from what it sees
  stored.
- **Thema rows.** Whole-week full-day items (WO, godsdienst, …) get one row per distinct identity.
  The identity must survive a commit, because the title becomes the fiche title: it is resolved
  from `id_repeat`, then a `"<Thema> — <fiche>"` prefix PatchGoblin writes, then tag resolution of
  the original title, with a manual override that outranks everything.
- **Gym / LO.** A gym lesuur has a title only, no fiche and no description (`attachments: []`).
- **Lesdoelen print.** WEET/KEN/KAN are read from the fiche (following `thread` to the newest
  version); cards without an own fiche are typed in the print preview and stored locally.
- **Methodevoortgang.** Read-only. Status derives from one field: `last_used_date` within the chosen
  school year (Questi rolls `schoolyear` over in summer, hence an explicit year picker). Only the
  teacher's decisions persist:

  ```js
  { methodes: [{ id, name, source: "questi" | "tag",
                 methodKey, isCluster, publisher, grade,      // source "questi"
                 tagId, ownerId,                               // source "tag"
                 color, order: ["<ficheId>"],                  // order[] IS the membership list
                 overrides: { "<ficheId>": { status: "given" | "open", on: "YYYY-MM-DD" } } }],
    activeId, sortKey: "order" | "az" | "date", onlyOpen }
  ```

  Titles and dates are re-fetched on every open. Blocks: for an own-fiche methode the **subtag** a
  fiche hangs under; for a vendor methode parsed from the title (`blok|thema|hoofdstuk N`). Lesson
  numbers (`les|nr N`) are trusted only when at least half the titles yield one; otherwise Questi's
  order is used and rows can be dragged.
- **Methode fiches in the planner** are loaded as a pseudo-colleague `"method:<KEY>"`, badged
  "methode", and routed to `…/attachments/methodlesson` on commit.
- **Settings export/import** (`format: "patchgoblin-settings"`) carries tags by title + colour (+ parent
  title), never by id, and maps them onto the importer's own tags.

## 24. Zelftest (self-diagnostics)

Debug → Zelftest (`runDiagnostics` in planner.js, a smaller twin in lessons.js) is strictly
**read-only**. It calls the endpoints above and compares the live shapes with the captured ones,
emitting OK / WARN / FAIL / SKIP rows with *expected*, *found* and *next step*, copyable as text.
It also builds the fiche-PATCH, new-fiche and tag-rename bodies offline from fixed samples and checks
the rules in Part 1 (e.g. no `selected_goals: []`, Op.Stap ids kept as UUID strings, `parent` sent),
fires a test `OpStapSelectionChanged` to prove the MAIN-world bridge runs, and probes whether a
methode fiche's content is readable. **When a feature depends on an API shape, add a check here.**

"Opslaan als .json" (settings) saves rows, ctx ids, the settings export and the last 20 API errors
(kind, id, status, message — never a body, cookie or token), optionally with fiche titles masked.
In summer there are no lesson items, so `groupId` stays empty and several rows WARN — expected.

## 25. Releases, self-update and the beta channel

- **Version** lives in both `manifest.json` and `version.json` — bump both on release.
- **Update check:** the background worker fetches `version.json` from the GitHub repo's branch
  (`raw.githubusercontent.com`) and the planner shows a banner when it is newer than the manifest.
- **`update.bat`** (Windows, no Git needed): downloads the branch ZIP to a temp folder, **refuses** it
  unless the core files exist and `manifest.json` and `version.json` agree, backs the current folder
  up to `%LOCALAPPDATA%\PatchGoblin-backups` (last 3 kept), replaces the files, re-checks, and
  **rolls back** on failure. Its PowerShell sits after a `#=PS=` marker and runs from a single
  launch line, because the `.bat` overwrites itself mid-run and `cmd` reads it line by line.
- **Beta channel:** a branch whose manifest `name` contains `BETA`. It runs next to the stable copy
  (Alt+Shift+P; dormant while stable is active), keeps its CSS out of the manifest (the worker
  injects it on request, so beta styles never bleed into stable), and checks/updates from its own
  branch. Releasing reverses that: rename, restore the manifest `css` list, point `install.bat`,
  `update.bat` and the version check back at `main`. Keep the MAIN-world `opstap-bridge.js` entry.

## 26. Working on the code

- After editing, reload the extension **and** the Questi tab — Chrome keeps old content scripts alive
  in open tabs. Each module logs its version on load; a missing line means a stale script.
- Syntax check: `node --check <file>` (Node is not a dependency of the addon).
- Verification is manual: load unpacked, open a Questi `…/calendar` page, drive the UI, run the
  Zelftest.
- Fresh API captures: DevTools → Network on Questi's own UI, copy payload/response, **strip every
  personal value** (names, e-mails, ids, cookies, tokens) before keeping them anywhere public.
- `CLAUDE.md` holds the detailed, terse working notes (traps that shipped as bugs, per-feature
  invariants) used during development.
