# PatchGoblin for Questi

**Doing the job their UI designer was paid for.**

PatchGoblin is the lightweight addon that strips away the user-hostile layout, bypasses the clumsy
navigation, and restores sanity to your workflow. Because life is too short for a terrible UI.

> PatchGoblin is an independent, unofficial project. It is not made, endorsed or supported by Questi.

---

## Wat het doet

PatchGoblin legt één venster over je Questi-agenda, bereikbaar met één knop in de werkbalk
(of **Alt + P**). Daarin:

- **Plannen** — deze week en volgende week onder elkaar. Sleep lesfiches uit de lijst links op je
  lesuren; de lijst toont wat je al gaf en wat nog niet.
- **Doelen** — schakel naar één week en zie per les **WEET / KEN / KAN**. De doelen staan in de
  lesfiche zelf, dus ook op je andere computer en bij je collega's.
- **Lesfiches** — je hele bibliotheek: titels, tags, leerjaren en doelen in één tabel, met een
  volledige editor per fiche.
- **Afdrukken** — je week op papier, met schrijflijnen voor de lesdoelen, in de kleuren van je vakken.
- **Eén keer controleren** — niets gaat naar Questi voor je alle wijzigingen samen nakijkt en
  goedkeurt. Een lesuur dat deel is van een reeks wordt nooit als hele reeks aangepast.
- **Weken vooruit plannen** — blader verder en je wijzigingen blijven klaarstaan; plan een hele
  maand en schrijf alles in één keer weg. Vakantieweken worden overgeslagen.
- **Nieuwe lesfiches maken** — sjabloon, velden, tags, WEET/KEN/KAN en de Op.Stap-leerplandoelen
  (met de echte Op.Stap-kiezer), zonder Questi's editor.

| Onderdeel | Status |
|---|---|
| Plannen · Lesfiches · Afdrukken in één venster, Methodevoortgang | werkt (v1.4) |
| Eén PatchGoblin-knop met snelmenu | werkt |
| Eén Controleer voor tags, lesfiches en agenda | werkt |
| Weken vooruit plannen, vakantieweken overslaan | werkt |
| Eerste installatie (wizard), instellingen delen (.json) | werkt |
| Nieuwe lesfiche met Op.Stap-leerplandoelen | werkt (methode-sjablonen: doelen nog in Questi) |
| Tags hernoemen en herkleuren (✎ in de tagboom) | werkt (v1.5) |

## Voor wie

Leerkrachten die hun lessen in Questi plannen. Werkt met je **eigen** Questi-account en je
**eigen** tags: bij de eerste start duid je aan welke tags je vakken zijn en welk vak je op welk
lesuur geeft. Een collega van je school kan jouw instellingen als bestand overnemen.

## Hulp nodig?

Open **Debug** (onderaan links) en klik **Opslaan als .json**. Stuur dat bestand mee met je vraag.
Het bevat geen wachtwoord, cookies of sessie — wel je schoolnaam, tags, titels van lesfiches
(kan je weglaten) en de laatste foutmeldingen.

---

# Handleiding

> De schermafbeeldingen hieronder tonen PatchGoblin met **verzonnen voorbeeldgegevens** (een
> fictieve juf en school). Bij jou staan er je eigen vakken, lesuren en lesfiches.

PatchGoblin legt één venster over je Questi-agenda. Je plant er twee weken tegelijk, beheert je
lesfiches, vult lesdoelen in en drukt je week af. **Niets gaat naar Questi** voor jij alle
wijzigingen samen nakijkt en op **Wegschrijven** klikt. Werkt in **Chrome**, **Brave** en **Edge**,
met je gewone Questi-login.

## 1. Installeren

De makkelijkste weg is de stap-voor-stap-gids: **[PatchGoblin installeren](https://claude.ai/artifact/BzuDN1SfiziugCxB5YvToL)**.
In het kort:

1. Download [`install.bat`](https://github.com/RareGoudvis/ce-questi-utility/blob/main/install.bat)
   en dubbelklik het. Het zet PatchGoblin in `%LOCALAPPDATA%\PatchGoblin`, kopieert die map naar je
   klembord en opent de extensiepagina van je browser.
2. Zet daar **Ontwikkelaarsmodus** aan (Chrome/Brave: rechtsboven, Edge: links).
3. Klik **Uitgepakt laden**, plak de map (Ctrl+V, Enter) en klik **Map selecteren**.
4. Herlaad je Questi-agenda (F5).

Op een pc die door de school beheerd wordt, staat ontwikkelaarsmodus soms uit. Gebruik dan je
eigen computer. Op een Mac: download de ZIP (groene knop **Code → Download ZIP**), pak hem uit en
kies die map bij stap 3.

**Bijwerken.** Meldt PatchGoblin een nieuwe versie, dubbelklik dan `update.bat` in
`%LOCALAPPDATA%\PatchGoblin`. Het kijkt de download eerst na, maakt een back-up van je huidige
versie (in `%LOCALAPPDATA%\PatchGoblin-backups`) en zet die vanzelf terug als het vervangen
mislukt. Klik daarna op de extensiepagina op **↻** bij PatchGoblin en herlaad Questi.

## 2. Openen

![De PatchGoblin-knop in Questi's werkbalk](docs/img/00-knop.png)

![Het snelmenu achter het pijltje](docs/img/00-knop-menu.png)

Op je Questi-**agenda** staat de knop **PatchGoblin** in de werkbalk. Klik hem, of druk
**Alt + P**. Het pijltje ernaast opent een snelmenu: **Plannen**, **Lesfiches**, **Afdrukken deze
week** en **Instellingen**. Staan er nog wijzigingen klaar, dan zie je daar ook hoeveel.

**De eerste keer** opent een korte wizard:

1. **Vakken**: duid aan welke van je Questi-tags echte vakken zijn (wiskunde, taal …).
2. **Lesrooster**: kies per lesuur het vak. PatchGoblin stelt voor wat het al in je agenda ziet
   (met een oranje rand); bevestig of pas aan.
3. **Agenda**: zet "Vak als beschrijving" alleen aan als je klaswebsite (bv. Enderklas) de
   beschrijving van een les als vak toont.

Alles kan later nog in **Instellingen**.

## 3. Plannen

![Plannen: links je lesfiches, rechts deze week en volgende week](docs/img/01-plannen.png)

Het venster heeft links een zijbalk met drie tabbladen: **Plannen · Lesfiches · Afdrukken**.

- **Rechts** staan **deze week en volgende week** onder elkaar. Elke kaart is een lesuur: bovenaan
  het vak in de kleur van je Questi-tag, daaronder de les. Een gestippelde kaart heeft nog geen
  lesfiche. Met **← →** blader je een week verder; **Vandaag** brengt je terug. Vakantieweken
  worden overgeslagen.
- **Links** staat je lijst met lesfiches. Kies bovenaan een **vak**, verfijn met de subtags
  (blok 4, blok 5 …), of kies **Ik / Collega** om de fiches van een collega of een methode te zien.
  **Filter** klapt zoeken, leerjaar en sorteren open.
- Achter elke fiche staat wanneer je ze gebruikte: groen **gepland** (staat in deze weken),
  een grijs ✓ (dit schooljaar al gegeven), of de laatste datum / **nooit**.

**Een les plannen**

- **Sleep** een fiche uit de lijst op een lesuur. Het lesuur krijgt de titel en het vak van de fiche.
- **Klik** op een lesuur om een fiche te kiezen, de titel aan te passen, het vak te wijzigen, het
  leeg te maken, of het te markeren als **Lichamelijke opvoeding / zwemmen** (geen fiche, enkel
  een titel).
- Sleep een ingevulde kaart naar een ander lesuur om te **verplaatsen of te wisselen**.
- **Ctrl + Z** draait je laatste actie terug.

![Klaargezette wijzigingen: groene kaarten en een teller](docs/img/02-staged.png)

Wat je verandert, wordt eerst **klaargezet**: de kaart krijgt een groene rand en bovenaan staat
hoeveel wijzigingen er wachten. Je kan gerust verder bladeren en een hele maand vooruit plannen —
klaargezette wijzigingen blijven staan tot je ze wegschrijft of de pagina herlaadt.

**Het menu Alles** (onderaan de zijbalk) bevat de rest:

| Groep | Wat |
|---|---|
| Deze weken | **Kopieer vorige week** · **Titels opschonen** (haalt Questi's `* … (1)` uit titels) · **Vakken herstellen** · **Ongedaan maken** · **Vernieuwen** · **Balans** (lesuren per vak) |
| Lesfiches | **Zoek in alle lesfiches** (jij, collega's en methodes tegelijk) · **Eigen lesfiches herladen** · **Lesfiches van collega's** · **Methodes** |
| Overzicht | **Methodevoortgang** |

**Themarijen.** Hele-week-items zoals WO of Godsdienst staan als brede balk bovenaan elke week.
Leg er de themafiche van die week in. Herkent PatchGoblin het thema niet, klik dan de balk en kies
het vak: dat wordt onthouden.

## 4. Controleren en wegschrijven

![Controleer: elke wijziging op een rij, met een vinkje](docs/img/03-controleer.png)

Klik **Controleer** (onderaan de zijbalk). Je ziet alles wat klaarstaat, in de volgorde waarin het
naar Questi gaat: eerst nieuwe tags, dan aangepaste lesfiches, dan de lesuren in je agenda.

- Elke rij heeft een **vinkje**. Wat je uitvinkt, blijft klaargezet voor later.
- Met het **vuilbakje** gooi je een wijziging weg: het lesuur gaat terug naar wat er in Questi staat.
- **Toon als rooster** toont de weken voor en na naast elkaar.
- Bij aangepaste lesfiches wordt eerst een **back-up** (JSON-bestand) gedownload.

Klik **Wegschrijven**. Een lesuur uit een herhalende reeks wordt altijd **alleen voor die ene
week** aangepast, nooit de hele reeks. Daarna herlaadt Questi en opent PatchGoblin vanzelf weer op
dezelfde weken.

**Als iets misgaat** zegt het venster per onderdeel wat lukte en wat niet. Wat niet lukte, blijft
klaargezet. Antwoordt Questi niet (bv. een trage verbinding), dan kijkt PatchGoblin zelf na of het
toch aankwam. Lukt ook dat niet, dan staat het er als **onzeker** bij: kijk het even na in Questi
voor je opnieuw wegschrijft.

## 5. Doelen

![Doelen: per les WEET, KEN en KAN](docs/img/04-doelen.png)

Schakel bovenaan van **Plannen** naar **Doelen**. Je ziet één week, en op elke kaart de
**WEET / KEN / KAN**-doelen van de lesfiche. Bovenaan staat hoeveel lessen nog geen doelen hebben.
Klik de balk van de andere week om te wisselen.

De doelen staan **in de lesfiche zelf** (drie extra tekstvelden WEET, KEN en KAN). Ze zijn dus ook
zichtbaar in Questi, op je andere computer en voor collega's met wie je de fiche deelt. Invullen
doe je in **Lesfiches** (zie hieronder).

## 6. Lesfiches

![Lesfiches: tagboom links, je bibliotheek als tabel](docs/img/05-lesfiches.png)

Het tabblad **Lesfiches** toont je hele bibliotheek.

- **Links** je tags als boom: **Alle eigen lesfiches**, **Zonder tag** en je vakken met hun
  subtags. Met **✎** naast een eigen tag hernoem of herkleur je hem, of hang je hem onder een
  ander vak. **+ Tag** maakt een nieuwe.
- **Rechts** een tabel met titel, leerjaar, laatst gebruikt en tags. Klik een kolomkop om te
  sorteren, filter op leerjaar of zoek op titel.
- **Een titel aanpassen**: klik erop en typ.
- **Meerdere tegelijk**: vink fiches aan en kies **Tags bewerken** of **Verwijderen**. Verwijderen
  is definitief: je typt eerst `VERWIJDER` en er wordt automatisch een back-up gedownload.
- **Lesdoelen invullen** zet de lijst om in een invulblad: per fiche Titel · WEET · KEN · KAN.
  **Tab** = volgend vak, **Enter** = zelfde kolom, volgende fiche.

![De volledige editor van één lesfiche](docs/img/06-fiche-editor.png)

**Dubbelklik** een fiche voor de volledige editor: titel, leerjaren, zichtbaarheid, tags, alle
tekstvelden (ook WEET/KEN/KAN) en **+ Tekstveld toevoegen**. Sjabloon, bijlagen en
leerplandoelen staan er ter info bij.

**+ Nieuwe fiche** maakt een fiche zonder Questi's editor: kies een sjabloon, vul titel, leerjaren,
tags, tekstvelden en WEET/KEN/KAN in, en kies de **leerplandoelen** met de echte Op.Stap-kiezer.

Ook hier wordt alles eerst **klaargezet** en pas weggeschreven via dezelfde **Controleer** als bij
Plannen. Fiches die je aanpast en die al in je agenda staan, kan je daar meteen laten meeverhuizen
naar de nieuwe versie.

## 7. Afdrukken

![Afdrukken: Lesdoelen-versie op A4](docs/img/07-afdrukken.png)

Het tabblad **Afdrukken** toont een voorbeeld op A4 van de week die in Questi staat (dus niet je
klaargezette wijzigingen — die zegt het er ook bij).

- **Versie**: **Gewoon** (je weekplanning) of **Lesdoelen** op 1 of 2 A4, met per les
  schrijflijnen voor WEET, KEN en KAN. Op de vrije woensdagnamiddag staan de thema's en de legende
  met je vakkleuren.
- **Op het blad**: weeknummer en afdrukdatum, labels, legende.
- **Andere agenda's meeprinten**, bv. die van de zorgjuf. Klik een item om het te verbergen.
- **Opmerking voor deze week** komt mee op het blad.
- "**N kaarten zonder doelen · nu invullen**" brengt je meteen naar die fiches.
- **Bewaar als PDF** of **Afdrukken** opent het afdrukvenster van je browser.

## 8. Instellingen

![Instellingen: het lesrooster](docs/img/08-instellingen.png)

**Instellingen** (onderaan de zijbalk, of via het snelmenu):

- **Lesrooster**: welk vak je op welk lesuur geeft. PatchGoblin vult lege uren ook zelf aan met
  wat het in je agenda ziet; wat je met de hand zet, blijft.
- **Vakken**: welke tags vakken zijn, hun volgorde en afkortingen.
- **Agenda**: o.a. "Vak als beschrijving schrijven".
- **Collega's & methodes**: wiens fiches je in de lijst kan kiezen.
- **Afdrukken**: standaardversie en wat er op het blad komt.
- **Weergave**: licht, donker of volgens je computer.
- **Delen & back-up**: je instellingen als bestand bewaren of overnemen van een collega.
  Vakken gaan mee op naam en kleur, dus het werkt ook met de tags van iemand anders.

## 9. Methodevoortgang

![Methodevoortgang: welke lessen al gegeven zijn](docs/img/09-methodes.png)

Via **Alles → Methodevoortgang**. Per methode zie je welke lessen je dit schooljaar al gaf en welke
nog open staan, gegroepeerd per thema of blok, met een voortgangsbalk en de **overgeslagen**
lessen. Het **leest alleen**: er wordt nooit iets naar Questi geschreven.

- Een methode komt **uit Questi** (de methodes van je school) of **uit eigen lesfiches** (kies een
  vak en vink één keer aan welke fiches de methode vormen; de subtags worden de thema's).
- "Gegeven" = de lesfiche werd binnen het gekozen **schooljaar** gebruikt. Rechtsboven kies je het
  schooljaar. Klik een statuspil om het met de hand te zetten.
- **Exporteer** geeft een CSV; **Back-up** neemt je methodes mee naar een andere computer.

## 10. Lukt het niet?

- **Geen PatchGoblin-knop?** Herlaad Questi (F5) en kijk of de extensie aan staat op de
  extensiepagina.
- **Na een update doet iets raar?** Klik op de extensiepagina op ↻ bij PatchGoblin **en** herlaad
  je Questi-tabblad. Meldt de statusregel "Instellingen niet bewaard", dan is dat precies dit.
- **Iets klopt niet?** Open **Debug** (onderaan de zijbalk): de **Zelftest** leest alleen en zegt
  wat er mis is. Klik **Opslaan als .json** en stuur dat bestand mee met je vraag. Het bevat geen
  wachtwoord, cookies of sessie — wel je schoolnaam, tags, titels van lesfiches (kan je weglaten)
  en de laatste foutmeldingen.
- **PatchGoblin weer weg?** Klik op de extensiepagina op **Verwijderen**. Je agenda in Questi
  blijft zoals hij is.

---

## Privacy

De extensie draait volledig in je eigen browser en praat enkel met `questi.com` via je eigen
login, plus `raw.githubusercontent.com` om te kijken of er een nieuwe versie is. Er worden geen
gegevens naar derden gestuurd, er is geen eigen server en er wordt niets gevolgd.

---

# API reference (developer)

> Ground-truth notes on the Questi backend this extension drives. English, dev-facing —
> the user guide above is the product. Companion files with fuller samples:
> [`brief.md`](brief.md) and [`reference/questi-api-samples.md`](reference/questi-api-samples.md).
> All paths are relative to `https://www.questi.com/api`.

## Transport & auth

- Same-origin `fetch(url, { credentials: "include" })` from the content script — the logged-in
  session cookies (`PHPSESSID`, `XSRF-TOKEN`) ride along automatically.
- **Mutations (`POST` / `PATCH` / `DELETE`) must send the header `x-xsrf-token` equal to the
  `XSRF-TOKEN` cookie value** (double-submit CSRF). `GET` needs neither header. Writes also send
  `content-type: application/json` and `origin: https://www.questi.com`.
- No `Authorization`/Bearer header. Everything is cookie + XSRF.
- Errors: HTTP 400 `{ "status":"error", "error_type":"app_error", "error_msg":"<code> - <text>" }`.
  Seen: `1203` tag not yours · `1253` `shared_userId` without a valid tag · `1254` own fetch with
  no tag and no `searchstring`.

## Bootstrap / context

| Call | Gives |
|---|---|
| `GET /users/me` | `result.id` = own user id (owner id on your fiches). |
| `GET /schools` | `result[].id` = **schoolId**. ⚠ `current_schoolyear` is an **object** — never `String()` it; writes need the `"YYYY - YYYY"` label. |
| `GET /cal/calendars?schoolId` | calendar ids (e.g. `cal_95193`) for the `calendars[]` read filter. |

Load order: `users/me` → `schools` → `cal/calendars` → `cal/items`.

## Calendar reads

- `GET /cal/items?schoolId&calendars[]=…&startdate&enddate` — week list. **Do not send
  `schoolyear`** (a bad/object value 500s it). `startdate`/`enddate` carry the time (`…T08:35:00…`).
- `GET /cal/items/{id}?schoolId` — detail: `description`, `starttime`, `endtime`, `attachments[]`
  (`content.id` = linked lesson id; `id_type:1` = lesfiche). ⚠ `id_attachment` changes on every
  re-link — never cache it.
- `GET /cal/items/count?schoolId&calendars[]&startdate&enddate` — per-day counts.

## Fiche & tag reads

- `GET /cal/lessons?schoolId&sorting=new_items&status=active&num&offset&default_tagId={id}[&shared_userId={colleagueId}]`
  — server-side **tag-filtered** fiche list; page with `num`/`offset` (100/page). Response
  `{ result:[…], num_records }`. **The list carries no per-fiche tags** — membership is discovered
  by *which* `default_tagId` you fetched. (`user_tagId={id}` is an equivalent filter param.)
  Never send an empty `searchstring` (400) — omit it.
- Default/root tag ids (per user; never hardcode): `5` = all own, `1` = untagged, `2` = samenwerk,
  `8` = universal (only valid with `shared_userId`). Resolve the own "all" tag by matching
  `/alle.*lesfiches/i` among `type:"default", parent:0` tags.
- `GET /cal/lessons/tags?schoolId&filter=own|shared&active_users=true` — tag tree. Tag object:
  `{ id, title, color(hex), parent (0 = root), type:"user"|"default", number_of_lessons, owner{…} }`.
- `GET /cal/lessons/{id}?schoolId&return_format=edit` — the editable fiche: `subject`,
  `tags:[{id,title,color}]`, `grades`, and `fields[]` each `{ id (field-instance id),
  type:"text"|"goals"|"methods", template_field_id, content | content.goals }`. **This is the
  source of truth for any write** — you need `fields[].id` and the current `tags[]`.
- `GET /cal/lessons/possible-settings?schoolId` → `{ co_owners[], grades[], visibilities:["private","school"] }`.

## Fiche writes — CRUD

**Create** — `POST /cal/lessons?return_format=short`
```json
{ "schoolId":1010, "subject":"Titel", "grades":["L3"], "visibility":"school",
  "tags":[<existingTagId>…], "create_tags":[{ "name":"Nieuw", "color":"#e0e0e0" }],
  "attachments":[], "templateId":56559,
  "fields":[
    { "field_type":"text",  "template_field_id":"236b565a", "content":"<html>" },
    { "field_type":"goals", "template_field_id":"4eef24c6", "selected_goals":[101598,101606] } ] }
```
→ `result.id` = new fiche id.

**Edit** — `PATCH /cal/lessons/{id}?return_format=short`
```json
{ "lessonId":15966963, "subject":"Titel", "schoolId":1010, "attachments":[],
  "tags":[1735707,1796445], "create_tags":[],
  "fields":[
    { "template_field_id":"236b565a", "id":96254544, "content":"…" },
    { "template_field_id":"4eef24c6", "id":96254547 } ] }
```
Per-key semantics (learned the hard way — see the gotchas):
- **`tags[]` = FULL REPLACE.** Echo the fiche's *current* tag ids or a title-only edit **wipes**
  its tags. This is also how you **add/remove a tag**: read current, add/filter, PATCH.
  `create_tags:[{name,color}]` creates + attaches a new tag inline.
- **Goals field: OMIT `selected_goals`.** Send the goals field entry (`{template_field_id, id}`)
  with **no** `selected_goals` key → goals unchanged. **Never send `selected_goals:[]`** (clears).
- **Include every `fields[]` entry** from the edit-read so none drop; put `content` only on the
  text fields you change (echo current `content` on the rest).
- ⚠ **Every edit mints a NEW `result.id` ≠ `lessonId`.** Re-read `result.id` and use it for any
  later op. Field ids change with every version too.

**Extra per-fiche fields** (Questi editor: "+ toevoegen → Tekst") — no `template_field_id`. Read
back as `{ id, type:"text", title, description, content, template_field_id:null }`: the **value is
`content`**, `description` is the ⓘ helper text. Questi's own editor updates one as `{ id, content }`
(no `template_field_id` key) and adds one as `{ field_type:"text", title, description, order,
content }`. The Lesfiche-manager stores lesdoelen in three such fields titled `WEET` / `KEN` / `KAN`, matched by
title; `buildPatch` echoes every extra field as `{ id, content }` so a rename never drops them.

**Delete** — `DELETE /cal/lessons?schoolId&lessons[]=<id>[&lessons[]=<id>…]`
Bulk, **no body**, `x-xsrf-token` required → `{ "status":"success" }`. **Irreversible — no server
undo.** ⚠ **Send NO `content-type` header** on this bodyless DELETE — `application/json` with an
empty body makes Questi return **HTTP 500**. (Observed but unused:
`DELETE /cal/lessons/user-tags/{tagId}?schoolId&action=unlink`, null body — ambiguous fiche target;
the PATCH-`tags[]` path above is the deterministic one.)

**Tag filtering (reads)** — a **default-bucket** tag (Alle=5 / Zonder tag=1 / Samenwerk=2) filters
with `default_tagId=<id>`; a **user category** tag (a vak or sub-tag) filters with
`user_tagId=<id>`. Sending `default_tagId` for a user tag **400s**. ⚠ Filtering by a **parent**
subject tag does **not** include fiches tagged only under a **child** — fetch the parent + all
children and merge (union) to see everything under a vak.

## Calendar writes (planner)

- `PATCH /cal/items/{id}?schoolId&schoolyear=YYYY - YYYY&apply_to_next_items=false` — single
  occurrence only. Body has **no `attachments` key**; `groups` are OBJECTS `[{groupId,schoolId}]`;
  writes **do** send `schoolyear`. Recurring items also take `range_startdate`/`range_enddate`.
- `POST /cal/items/{id}/attachments?schoolId&schoolyear` — link a fiche. Here `groups` are **raw
  ids** `[326]`; `id` = `attachments[0].content.id` from fiche detail; `typeId:1`. No DELETE verb
  for attachments — detach = PATCH the item without it.
- Read→write field renames: `content.id → id`, `id_type → typeId`, `is_visible_* → visible_*`.

## Methode-fiches (vendor libraries — read-only)

The planner can load publisher method libraries and treat each as a pseudo-colleague so their
fiches appear in the owner selectors, filter panels, and global search (badged **"methode"**).

- `GET /cal/manage/methods/{schoolId}` → `result[]` each `{ id (KEY), publisher{name}, name,
  grades[], is_cluster, has_concordance, available }` — the pick list.
- `GET /cal/methods/{KEY}/lessons?is_cluster=<bool>&schoolId` → `result[]` each `{ id, subject,
  last_used_date, grades }` (no tags, no owner; full list in one shot — no server paging).
- **Scheduling a methode fiche uses a dedicated attach endpoint** — the normal
  `POST /cal/items/{id}/attachments` 400s with `1235 - no access to lesson`. Instead:
  `POST /cal/items/{id}/attachments/methodlesson?schoolId&schoolyear` with body
  `{ schoolId, visible_parents, visible_students, students:[], groups:[<raw ids>], id:<methodeFicheId> }`
  — **same shape minus `typeId`**. Response carries Questi's decorated title `"* <fiche> (1)"` — **do not** reuse it; the item PATCH writes the plain fiche title.
- Implementation: a chosen methode becomes a colleague entry `{ id:"method:<KEY>", isMethod:true,
  methodKey, isCluster }`; `fetchFiches`/`fetchFichesByTag` short-circuit method owners to the
  methods endpoint, stamping each fiche `__method` + recording its id in `view.methodFicheIds` so
  the commit routes it to `methodlesson` and the UI badges it "methode".

## Templates & goals (import — Phase 2)

- `GET /cal/lessons/templates?schoolId` → `result[]` each `{ id, name, structure[] }`. A
  `structure[]` item's `id` **is** the `template_field_id`; `type` ∈ text|goals|methods; goals
  fields carry `source.version.id` (ZILL = 36); methods carry a `method{}` concordance.
- `GET /cal/lessons/goals/36?goals[]=<original_id-uuid>…` → ZILL tree. Nodes:
  `{ id (numeric), code, title, is_goal, original_id (uuid), children[] }`. The **numeric `id`**
  goes in a create's `selected_goals`; the **`original_id` uuid** is the query key.

## Gotchas checklist

- `current_schoolyear` is an **object** — derive the `"YYYY - YYYY"` label, never `String()`.
- **`x-xsrf-token` header on every write** (mirror the `XSRF-TOKEN` cookie).
- Never send an empty `searchstring` (400) — omit it.
- **Re-read `result.id` after every fiche PATCH** — the id changes each edit.
- Fiche edit: **`tags[]` is replace** (echo to keep) but **`selected_goals` is omit-to-keep**
  (never `[]`). Different rules — don't conflate them.
- Don't cache `id_attachment`; re-read `content.id` at commit time.
- Single occurrence only on calendar writes (`apply_to_next_items=false`).
- Fiche delete is irreversible — gate behind a typed confirm + test-one-first.

## Extension file map

| File | Role |
|---|---|
| `manifest.json` | MV3; content scripts `planner.js` → `lessons.js` → `methodes.js` → `content.js`, css `planner.css` + `lessons.css` + `methodes.css`, on `*://www.questi.com/*`. |
| `background.js` | Service worker; relays the toolbar/Alt+P toggle to the tab. |
| `content.js` | Boot/relay; injects the single **PatchGoblin** launcher button + quick menu (only on `…/calendar`); reopens the planner after our own write. |
| `planner.js` / `planner.css` | The week planner (`#qwp-overlay`). Exports `window.__QWP_SHARED` (ctx + helpers) and `window.__QWP_OPEN_LESSONS`. |
| `lessons.js` / `lessons.css` | The Lesfiche-manager — mounted as the planner's Lesfiches tab (`mount()`), standalone `#qwl-overlay` for `openPicker()` (read-only selectiemodus used by the Methodes panel); consumes `__QWP_SHARED`; own storage key `qwp_lessons_v1`. Its staged edits are written by the planner's shared Controleer. |
| `methodes.js` / `methodes.css` | Methodevoortgang (`#qwm-overlay`); consumes `__QWP_SHARED`; storage key `qwp_methodes_v1`. **Never writes to Questi.** |

### Methodevoortgang internals

Status comes from one field only: `last_used_date` on the fiche, tested with `usedThisYear()`
against `schoolYearBounds()`. There is no calendar scan.

`qwp_methodes_v1` stores only the teacher's decisions — never fiche titles or dates, which are
re-fetched live on every open so the table cannot drift:

```js
{ methodes:[{ id, name, source:"questi"|"tag",
              methodKey, isCluster, publisher, grade,      // source "questi"
              tagId, ownerId,                               // source "tag"
              color, order:["<ficheId>"…],                  // order[] IS the membership list
              overrides:{ "<ficheId>": { status:"given"|"open", on:"YYYY-MM-DD" } } }],
  activeId, sortKey:"order"|"az"|"date", onlyOpen }
```

Blocks: for `source:"tag"` the block is the **subtag** the fiche hangs under (one
`fetchAllFichesByTag` per child of the hoofdtag). Vendor methodes carry no tags, so their blocks are
parsed out of the title (`blok|thema|hoofdstuk \d+`). Lesson numbers come from `les|nr \d+` in the
title, and are only trusted when **at least half** the titles yield one — otherwise Questi's own
order is used and rows become drag-reorderable.
