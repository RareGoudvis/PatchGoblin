# UnQuesti

**Doing the job their UI designer was paid for.**

UnQuesti is the lightweight addon that strips away the user-hostile layout, bypasses the clumsy
navigation, and restores sanity to your workflow. Because life is too short for a terrible UI.

> **Beta.** UnQuesti is the successor of the *Questi Weekplanner* and is being rebuilt right now.
> Everything below "Handleiding" still describes the current version; it gets rewritten as each
> part of the new design lands.
>
> UnQuesti is an independent, unofficial project. It is not made, endorsed or supported by Questi.

---

## Wat het doet

UnQuesti legt één venster over je Questi-agenda, bereikbaar met één knop in de werkbalk
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

| Onderdeel | Status |
|---|---|
| Weekplanner, Lesfiche-manager, Lesdoelen-afdruk, Methodevoortgang | werkt (v1.2) |
| Eén UnQuesti-knop met snelmenu | in aanbouw |
| Snellere start | in aanbouw |
| Nieuw venster: Plannen · Lesfiches · Afdrukken | gepland |
| Eerste installatie, instellingen delen (.json) | gepland |
| Lesfiches als tabblad in het venster + één Controleer voor tags, lesfiches en agenda | in aanbouw |

## Voor wie

Leerkrachten die hun lessen in Questi plannen. Werkt met je **eigen** Questi-account en je
**eigen** tags: bij de eerste start duid je aan welke tags je vakken zijn en welk vak je op welk
lesuur geeft. Een collega van je school kan jouw instellingen als bestand overnemen.

## Hulp nodig?

Open **Debug** (onderaan links) en klik **Opslaan als .json**. Stuur dat bestand mee met je vraag.
Het bevat geen wachtwoord, cookies of sessie — wel je schoolnaam, tags, titels van lesfiches
(kan je weglaten) en de laatste foutmeldingen.

---

# Handleiding (huidige versie)

Een browserextensie die bovenop de **Questi**-agenda een volledig scherm-weekplanner legt.
Plan in één overzicht een (of twee) volledige lesweken: sleep lesfiches in je lesuren,
maak lesuren leeg, controleer alles in een voorbeeldweergave en schrijf het daarna in één
keer weg naar Questi. Werkt in **Chrome**, **Brave** en **Edge**.

> Je moet ingelogd zijn op [questi.com](https://www.questi.com) — de extensie gebruikt je
> eigen sessie en verandert niets zonder dat jij op **Wegschrijven** klikt.

---

## Installeren (Chrome, Brave of Edge)

De extensie zit niet in de webshops; je laadt ze zelf in ("uitgepakt laden"). Dat is in de
drie browsers bijna identiek.

1. **Download de bestanden.** Klik op deze pagina op de groene knop **`Code` → `Download ZIP`**
   en pak het ZIP-bestand uit naar een map die je makkelijk terugvindt
   (bv. `Documenten/questi-weekplanner`). *Of*, als je Git kent:
   ```
   git clone https://github.com/RareGoudvis/ce-questi-utility.git
   ```
   > Belangrijk: onthoud waar de map staat en verwijder ze niet — de browser leest de
   > extensie telkens uit die map.

2. **Open de extensiepagina** in je browser:
   - **Chrome:** typ `chrome://extensions` in de adresbalk en druk Enter.
   - **Brave:** typ `brave://extensions`.
   - **Edge:** typ `edge://extensions`.

3. **Zet "Ontwikkelaarsmodus" aan** (schuifknop rechtsboven, in Edge links).

4. Klik op **"Uitgepakt laden"** (Edge: **"Uitgepakt laden"** / "Load unpacked") en kies de
   **map** die je in stap 1 hebt uitgepakt (de map waarin `manifest.json` staat).

5. Klaar — de "Questi Weekplanner" verschijnt in de lijst. Ga naar je Questi-agenda en je
   ziet er een knop verschijnen (zie hieronder).

> **Bijwerken naar een nieuwere versie (makkelijk):** dubbelklik `update.bat` in de map — dat
> haalt de laatste versie op en vervangt de bestanden. **Herstart daarna Chrome** (of klik op de
> extensiepagina het **↻ (vernieuwen)**-icoon bij de extensie). Als de extensie zelf meldt dat er
> een nieuwe versie is, verschijnt bovenaan de planner een balkje met een downloadlink.
>
> **Handmatig bijwerken:** download opnieuw de ZIP, vervang de bestanden in dezelfde map, en klik
> op de extensiepagina op het **↻ (vernieuwen)**-icoon bij de extensie.

---

## Openen

Op je Questi-agenda (de kalenderpagina) verschijnen **twee knoppen** in de werkbalk, naast de
zoom/Week/print-knoppen:

- **"Weekplanner"** — opent de volledige weekplanner. (Of druk op **Alt + P**, of klik het
  extensie-icoon in je browserwerkbalk.)
- **"Lesfiches"** — opent de **Lesfiche-manager** (zie onder).

De knoppen verschijnen **enkel op de kalenderpagina**. Sluiten doe je met het **✕** rechtsboven
(of **Alt + P** voor de planner).

---

## De weekplanner gebruiken

1. **Kies je week.** De planner opent op de week die je in Questi bekijkt; lukt dat niet, dan op de
   week van vandaag (de statusregel zegt welke van de twee). In de bovenbalk (naast de zoekbalk)
   kies je *1 week* of *2 weken* en blader je met **← / Deze week / →**.
2. **Zoek lesfiches.** Onderaan staan filterpanelen: kies een vak, verfijn met de sub-tags
   (blok 1, blok 2 …) of gebruik de zoekbalk. Via **Lesfiches laden** (links) laad je je
   **Eigen lesfiches**, die van **Collega's**, of **Methodes** (uitgeverij-fiches — die krijgen
   een oranje **"methode"**-label en zijn alleen-lezen sjablonen).
3. **Plan lesuren.**
   - **Sleep** een lesfiche vanuit een paneel op een leeg lesuur — de titel van het lesuur wordt
     meteen de titel van de fiche.
   - Of **klik** op een lesuur om handmatig een fiche te kiezen, het als gymles te markeren, of
     het **leeg te maken**.
   - Sleep een ingevuld lesuur naar een ander om het te **verplaatsen of te wisselen**.
   - Met **"Add selectie"** vul je meerdere gekozen fiches in één keer in.
   - **Kopieer vorige week** toont een **rooster** — klik de lesuren die je wil overnemen; ze
     landen in de lege lesuren op hetzelfde moment deze week.
4. **Vergist? Ctrl + Z** (of **"Ongedaan maken"**) draait je laatste actie terug.
5. **Controleer & wegschrijven.** Klik **"Controleer & wegschrijven"** voor een voor/na-overzicht
   (groen = gewijzigd, oranje = nog leeg, rood = overschrijft). Klik **"Goedkeuren en
   wegschrijven"** — dat schrijft meteen weg (geen aparte knop meer). Daarna vernieuwt de pagina.

### Goed om te weten

- **Niets wordt geschreven** tot je goedkeurt; tot dan blijft alles enkel in de planner staan.
- Wijzigingen gelden **enkel voor die ene week** (herhalende reeksen blijven ongemoeid).
- **Lichamelijke opvoeding / zwemmen.** Vink in het lesuur-venster **"Lichamelijke opvoeding /
  zwemmen"** aan: het lesuur krijgt meteen de titel *Lichamelijke opvoeding* en er wordt geen
  lesfiche gekoppeld. Onder het titelveld verschijnen twee knoppen — **Lichamelijke opvoeding** en
  **Zwemmen** — om te wisselen. Vink je het weer uit, dan komt de oude titel terug (bv. "M3").
  Een titel die je zelf typte blijft staan. De knoppen verschijnen bij elk gymuur, ook bij lesuren
  die Questi al zo noemt.
- **Titel aanpassen.** In het lesuur-venster staat bovenaan een veld **Titel**. Handig voor dingen
  die ingepland moeten worden maar geen lesfiche nodig hebben (een toets, een uitstap): typ een
  titel, kies geen fiche, en schrijf weg. Zit er wél een fiche aan het lesuur, dan waarschuwt het
  venster: Questi zet bij het wegschrijven de fichetitel terug.
- **Vak klopt niet met de fiche?** Het label onder een les is het vak dat jij voor dat lesuur in
  **Instellingen** hebt gezet. Hoort de gekoppelde fiche bij een ànder vak, dan krijgt de cel een
  oranje randje en een label als "≠ Wiskunde" — zo zie je meteen dat er een rekenles in een
  taal-uur staat. Bij methodefiches kan het vak niet opgehaald worden; die krijgen dus nooit een
  waarschuwing (liever geen melding dan een verkeerde).
- **Themarijen** (hele-week-items zoals WO en Godsdienst) staan bovenaan het rooster, elk op een
  **eigen rij**, even hoog als een gewoon lesuur. De naam van het thema staat in de balk zelf.
  Herkent de planner het thema niet (bv. een titel als "Camino 3 – …"), dan staat er
  *geen vaktag*: klik de balk, kies een **Vak**, en de rij is meteen benoemd — die keuze wordt
  onthouden en komt bij het wegschrijven ook in de titel terecht. Afkortingen die vanzelf herkend
  worden: `WO`/`wero`, `godsdienst`, `muvo`/`muzo`, `LO`/`turnen`. Heb je er drie (bv. ook MUVO), dan krijg je er drie —
  ze worden afgeleid uit je tags, niet uit een vaste lijst. Een hele-dag-item dat bij geen enkele
  tag hoort (bv. een schooluitstap) krijgt een eigen rij met zijn eigen titel.
  Bij het wegschrijven krijgt zo'n item de titel `"Godsdienst — <fichetitel>"`: zo weet de planner
  ook na een herlaadbeurt nog welk thema het is (voordien raakte dat kwijt zodra je er een fiche in
  legde, en verdween er één van de twee rijen). De beschrijving in Questi blijft
  `"Zie themafiche."`. Een **lesuur** met vak WO of Godsdienst krijgt als beschrijving de **naam van
  de themafiche** van die week (is er geen, dan de vaknaam) — zo staat er iets zinnigs op de
  klaswebsite in plaats van "Zie themafiche.". Zo'n lesuur mag ook gewoon een eigen lesfiche krijgen.
- **Instellingen** (vast vak per lesuur) blijft bewaard en geldt voor elke week.
- **Diagnose** (links onderaan) draait een zelftest als er iets niet automatisch gevonden werd.

---

## De Lesfiche-manager gebruiken

Open via de **"Lesfiches"**-knop in de werkbalk. Hiermee beheer je je **volledige eigen
fiche-bibliotheek** (los van de kalender).

- **Overzicht + filteren.** Bovenaan staan je tags: **Alle eigen lesfiches**, **Zonder tag**
  (handig om te zien wat nog getagd moet worden / oude leerjaren), en je **vakken**. Klik een vak
  → je ziet **Alle [vak]** (alles onder dat vak, ook via sub-tags) plus de sub-tags (blok 1…).
  Rechts bovenaan filter je op **leerjaar** en zoek je op titel. Klik een **kolomkop** (Titel /
  Leerjaar / Laatst gebruikt / Tags) om te **sorteren**.
- **Titel snel aanpassen.** Klik op een titel in de lijst om hem **direct** te bewerken.
  **Dubbelklik** op een rij voor de volledige editor: titel, leerjaren, zichtbaarheid, tags, alle
  tekstvelden (ook extra velden zoals WEET/KEN/KAN) en **+ Tekstveld toevoegen**. Sjabloon,
  bijlagen en leerplan-/methodedoelen staan er ter info bij (die bewerk je in Questi). Leerjaren
  en zichtbaarheid zijn **proef**: na het wegschrijven controleert de manager of Questi ze echt
  overnam en meldt het als dat niet zo is.
- **Meerdere tegelijk.** Vink fiches aan (of **Alles selecteren**), dan links: **Tags bewerken**
  (toevoegen/verwijderen, of een **nieuwe tag** maken) of **Verwijderen**.
- **Eén bevestiging.** Al je wijzigingen (titels, inhoud, tags) worden **klaargezet** en pas
  weggeschreven via **"Wijzigingen controleren"** → goedkeuren. Doelen en niet-gewijzigde tags
  blijven altijd behouden.
- **Verwijderen** is definitief: typ `VERWIJDER`, test eerst met één fiche, dan de rest.
- **1/2 kolommen** en **Diagnose** (zelftest) staan links. **Importeren** komt binnenkort (OPSTAP).
- **Lesdoelen invullen**. Links → **Lesdoelen invullen** zet de lijst om in een invulblad:
  per fiche **Titel · WEET · KEN · KAN**. **Tab** = volgende vak, **Enter** = zelfde kolom, volgende
  fiche (**Shift+Enter** = nieuwe regel). Ook de titel pas je hier aan. De doelen worden **in de
  lesfiche zelf** bewaard (drie extra tekstvelden WEET / KEN / KAN, zichtbaar in Questi en voor je
  collega's) — dus op elke computer. Het ⓘ-icoon naast een titel toont de doelen van de methode.
  Alles loopt via **Wijzigingen controleren**; bij 5 of meer fiches wordt eerst een back-up (JSON)
  gedownload. **Lokale doelen overnemen** zet doelen die je vroeger in het afdrukvoorbeeld typte
  in de fiches. Tip: zet in Questi **"Onthouden"** aan op WEET/KEN/KAN, dan krijgt elke nieuwe
  fiche die velden vanzelf.
- ⚠ **Een ingeplande les houdt de fiche-versie waarmee ze gepland is** (Questi: "aanpassingen …
  niet automatisch bijgewerkt in het gekoppelde agenda item"). Het Lesdoelen-afdrukvoorbeeld neemt
  dan de doelen van de nieuwste fiche met dezelfde titel, en zet **"nieuwere versie"** op die kaart
  (alleen op het scherm).

---

## Methodevoortgang gebruiken

Open via **"Methodevoortgang"** in de zijbalk van de weekplanner. Het toont per methode welke
lessen je **al gegeven** hebt en welke nog **open** staan. Het **leest alleen** — er wordt nooit
iets naar Questi geschreven.

Hoe het "gegeven" bepaalt: elke lesfiche heeft in Questi een **laatst-gebruikt-datum**. Ligt die
binnen het **gekozen schooljaar**, dan telt de les als gegeven. Een fiche die je vorig jaar
gebruikte staat dus terecht weer op open, met de oude datum er grijs bij.

**Schooljaar kiezen.** Rechts bovenaan staat een schooljaarkiezer (huidig + de twee vorige). Handig
om terug te kijken naar wat je vorig jaar gaf terwijl je het nieuwe jaar plant. Let op: Questi rolt
het schooljaar al door in de zomer, dus tussen die rol en **1 september** staat alles op open —
dat klopt (het nieuwe jaar is nog niet begonnen) en de panel zegt het ook met zoveel woorden.

Een methode toevoegen kan op twee manieren:

- **Uit Questi** — de methodes die je school heeft. Alle lessen komen in één keer binnen, je hoeft
  niets te kiezen. Loopt de methode over meerdere leerjaren, dan vraagt hij welk leerjaar je volgt.
- **Uit eigen lesfiches** — kies je **hoofdtag** (het vak), daarna open je de Lesfiche-manager in
  **selectiemodus** en vink je aan welke fiches de methode vormen. Dat doe je één keer. De
  **subtags** onder je hoofdtag worden automatisch de **thema's** in de tabel. In selectiemodus zijn
  alle bewerk- en verwijderknoppen verborgen, dus er kan niets misgaan.

In de tabel:

- **Voortgangsbalk** bovenaan (`23/41 gegeven`), en per thema een eigen tellertje.
- **Gaten** worden gemarkeerd: staan er open lessen tussen twee gegeven lessen, dan zie je
  "les 14–15 overgeslagen".
- **Klik op een statuspil** om te wisselen: automatisch → gegeven → open → automatisch. Een
  handmatige keuze wint altijd van de berekende en is gemerkt met **handmatig**; het kruisje zet
  hem terug op automatisch.
- **Sorteren** op volgorde / a–z / datum, filteren met **alleen open**, en zoeken op titel.
- Halen de titels geen lesnummers op (bv. `Les 12: …`), dan gebruikt hij de volgorde van Questi en
  kun je rijen **verslepen**. Die volgorde wordt onthouden.
- **Exporteer** geeft een CSV van de volledige lijst.
- Lessen worden **gegroepeerd per thema** in de volgorde van je subtags ("Blok 1", "Blok 2", …).
  Fiches die onder geen enkele subtag hangen komen onderaan bij **Overige**.

**Back-up (tussen computers).** De knop **Back-up** rechts bovenaan exporteert al je methodes naar
één JSON-bestand en leest zo'n bestand ook weer in. Handig om je opzet van je schoollaptop naar je
thuis-pc te zetten zonder alles opnieuw aan te vinken. Alleen jouw instellingen reizen mee (welke
fiches, hun volgorde, handmatige aanpassingen); titels en datums worden op de andere computer
gewoon opnieuw uit Questi gelezen. Bij importeren zie je eerst wat er nieuw is en wat overschreven
wordt. Komt het bestand van een andere school, dan waarschuwt hij — lesfiche-ids zijn per school.

Alleen jouw keuzes worden bewaard (welke fiches, hun volgorde, handmatige aanpassingen). Titels en
datums worden élke keer opnieuw opgehaald, zodat de tabel nooit uit de pas loopt met Questi.

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
| `content.js` | Boot/relay; injects the **Weekplanner** + **Lesfiches** toolbar chips (only on `…/calendar`). |
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
