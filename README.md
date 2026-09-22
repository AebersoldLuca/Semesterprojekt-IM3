# Sechs Flüsse, sechs Temperamente

Eine datenjournalistische DataStory über Wasserstand und Wassertemperatur von sechs Schweizer Flüssen –
Semesterprojekt im Modul «Interaktive Medien 3», Fachhochschule Graubünden (FHGR).

## Kurzbeschreibung

Die DataStory vergleicht Aare, Limmat, Rhône, Thur, Ticino und Rhein anhand der Tagesmittel von Wasserstand
und Wassertemperatur seit 2020. Die Daten stammen aus dem nationalen hydrologischen Messnetz des Bundesamts für
Umwelt BAFU. Ein PHP-ETL-Prozess lädt sie täglich über die BAFU-API, prüft sie und speichert sie in einer eigenen
MySQL-Datenbank. Die Website liest ausschliesslich aus dieser Datenbank und zeigt in interaktiven Grafiken, wie
unterschiedlich Seeabflüsse, Gletscherflüsse und Mittellandflüsse durch das Jahr gehen.

## Projektidee

**Leitfrage:** Wie unterscheiden sich Wasserstand und Wassertemperatur von sechs Schweizer Flüssen im
Jahresverlauf – und was verraten diese Unterschiede über Gletscher, Seen und Regen?

Die Story ist aufgebaut in:

1. **Einstieg** – Hero mit zwei Kennzahlen (wärmstes Tagesmittel vs. höchstes Tagesmittel am kältesten Fluss) und der Leitfrage
2. **Kontext** – Was misst das BAFU, was ist Wasserstand / Wassertemperatur, welche Faktoren spielen mit; die sechs Stationen
3. **Vergleich & Zeitverlauf** – interaktive Hauptgrafik (Messgrösse, Zeitraum, Flüsse wählbar; Tooltip pro Tag)
4. **Jahresgang** – typisches Jahr aus den Monatsmitteln aller vollständigen Jahre
5. **Erkenntnisse** – aus der Datenbank berechnete Aussagen, Tage ≥ 20 °C pro Jahr, Vergleich des laufenden Jahres mit den Vorjahren, Grenzen der Aussagekraft
6. **Methodik & Transparenz** – Quelle, Zeitraum, letzter Import, Freigabestatus, Verarbeitungsregeln

Alle Zahlen in den Texten werden aus der Datenbank berechnet (`unload.php?type=insights`) und aktualisieren sich
nach jedem Import. Es gibt keine von Hand eingetippten Messwerte.

## Datenquelle

| | |
|---|---|
| Herausgeber | Bundesamt für Umwelt BAFU |
| Plattform | https://api.data-platform.cloud.bafu.admin.ch/ |
| Datensatz | «Hydrologische Beobachtungen» – https://api.data-platform.cloud.bafu.admin.ch/dataproduct-water-observations |
| API | GraphQL, `POST https://data.bafu.admin.ch/api`, ohne Authentifizierung |
| Aggregation | `data_1day_mean` (Tagesmittel) |
| Parameter | `W` Wasserstand (m ü.M.), `WT` Wassertemperatur (°C) |
| Zeitraum | ab 1. Januar 2020 bis heute |
| Lizenz | Freie Nutzung. Quellenangabe ist Pflicht (opendata.swiss) |

Die detaillierte API-Analyse (Felder, Queries, Limits, Zeitstempel, Stationsauswahl) steht in
[docs/api-analyse.md](docs/api-analyse.md).

### Messstationen

| BAFU-Nr. | Gewässer – Station | Warum ausgewählt |
|---|---|---|
| 2019 | Aare – Brienzwiler | alpiner Fluss vor dem Brienzersee (Gletscher, Schnee) |
| 2243 | Limmat – Baden | Abfluss des Zürichsees |
| 2009 | Rhône – Porte du Scex | Walliser Alpen, vor dem Genfersee |
| 2044 | Thur – Andelfingen | Ostschweiz, kein grosser See |
| 2068 | Ticino – Riazzino | Alpensüdseite |
| 2091 | Rhein – Rheinfelden | grosser Fluss unterhalb der Aaremündung |

Alle sechs sind in Betrieb und liefern W und WT seit 2020 lückenlos. Ausgewählt aus 75 aktiven Stationen mit
beiden Messgrössen (`php etl/extract.php --candidates`).

## Datenfluss

```
BAFU-API (GraphQL)
   ↓
etl/extract.php     Extract   – Rohdaten abrufen (Zeitfenster < 10 000 Zeilen)
   ↓
etl/transform.php   Transform – prüfen, bereinigen, Kalendertag berechnen
   ↓
etl/load.php        Load      – Upsert in MySQL, Import protokollieren
   ↓
MySQL-Datenbank     stations · observations · parameters · import_runs
   ↓
unload.php          Unload    – MySQL → JSON
   ↓
script.js           JSON → D3-Grafiken → interaktive DataStory
```

Das Frontend ruft **nie** die BAFU-API auf, sondern nur `unload.php`. Fällt die BAFU-API aus, zeigt die Website
weiterhin die gespeicherten Daten. Die Daten werden zwischen Extract, Transform und Load direkt als PHP-Array
übergeben – es gibt keine JSON-Zwischendateien; dauerhaft gespeichert wird nur in MySQL.

## Projektstruktur

```
.
├── etl/
│   ├── data/            nur Lock-Datei des laufenden Imports (nicht im Repo)
│   ├── extract.php      1) BAFU-API → PHP-Array, Stationsauswahl (STATIONS)
│   ├── transform.php    2) Validierung und Aufbereitung
│   ├── load.php         3) Speichern in MySQL – Einstiegspunkt für den Cronjob
│   └── schema.sql       Datenbankschema
├── docs/
│   ├── api-analyse.md   Analyse der BAFU-API
│   └── cronjob.md       Cronjob-Einrichtung
├── logs/                Logdateien (nicht im Repo)
├── config.example.php   Vorlage für die Zugangsdaten
├── config.php           echte Zugangsdaten (NICHT im Repo, .gitignore)
├── db.php               zentrale PDO-Verbindung
├── unload.php           JSON-Endpunkt (liest nur MySQL)
├── index.html           DataStory
├── script.js            Datenabruf und Visualisierung
├── style.css            Gestaltung
└── .htaccess            Zugriffsschutz für sensible Dateien
```

Ein Ordner `data/` wie im Beispielprojekt wird nicht benötigt: Es gibt keine statischen Datendateien, alle Daten
kommen aus der BAFU-API und liegen in MySQL.

## Datenbank

Schema: [etl/schema.sql](etl/schema.sql) (MySQL 5.7+ / MariaDB 10.3+, `utf8mb4`).

| Tabelle | Inhalt | Wichtige Schlüssel |
|---|---|---|
| `parameters` | Messgrössen `W`, `WT` mit Bezeichnung und Einheit | PK `code` |
| `stations` | Stammdaten aus der API (Nr., Name, Gewässer, Einzugsgebiet, Koordinaten, Status) + redaktionelle Texte | PK `id`, UNIQUE `station_no` |
| `observations` | ein Tagesmittel pro Station, Messgrösse und Tag | PK `id`, **UNIQUE (`station_id`, `parameter_code`, `measured_at`)**, FK auf `stations`, `parameters`, `import_runs` |
| `import_runs` | Protokoll jedes ETL-Laufs (Zeitraum, Anzahl neu/geändert/verworfen, Status) | PK `id` |

Entscheide:
- **Einheit in `parameters`** statt in jeder Messwert-Zeile: Die Einheit gehört zur Messgrösse. Der Transform prüft,
  dass die Einheit aus der API (`unitSymbol`) exakt übereinstimmt.
- **`measured_at` + `obs_date`**: Der Originalzeitstempel (UTC) bleibt erhalten, `obs_date` ist der Kalendertag
  in Schweizer Normalzeit, mit dem das Frontend arbeitet.
- **`release_state`** speichert den Freigabestatus des BAFU (1 provisorisch, 2 validiert, 3 definitiv, `NULL` = ohne Status).
- **Duplikate** verhindert der UNIQUE-Key. Der ETL schreibt mit `INSERT … ON DUPLICATE KEY UPDATE` und ändert
  bestehende Zeilen nur, wenn sich Wert oder Freigabestatus geändert haben.

CRUD im Projekt: **Create** (neue Messwerte/Stationen/Importläufe), **Read** (`unload.php`, Import-Zeitraum),
**Update** (geänderte BAFU-Werte, Stationsdaten, Deaktivieren entfernter Stationen), **Delete** (Importprotokolle
älter als ein Jahr).

## ETL

`php etl/load.php` führt alle drei Schritte aus:

1. **Zeitraum bestimmen** – Beim ersten Lauf ab 2020-01-01, danach ab dem jüngsten gespeicherten Tag minus
   60 Tage (das BAFU validiert und korrigiert Werte nachträglich). `--full` lädt alles neu.
2. **Extract** – 1 Request für die Stationen, dann Tagesmittel in Zeitfenstern (6 Stationen × 2 Parameter =
   12 Zeilen/Tag → 666 Tage pro Request). Wiederholung bei HTTP 403/429/5xx, automatische Halbierung eines
   Fensters, falls die API es wegen > 10 000 Zeilen ablehnt.
3. **Transform** – Station und Parameter prüfen, Einheit prüfen, Zeitstempel streng parsen und in den
   Kalendertag (MEZ) umrechnen, Werte auf Zahl und Plausibilität prüfen (W 150–2500 m ü.M., WT −0.5–35 °C),
   Freigabestatus normalisieren, Duplikate in der Antwort entfernen. Ungeprüfte Tagesmittel von exakt 0.00 °C
   werden als vermuteter Sensorausfall verworfen. **Es werden keine Werte geschätzt oder aufgefüllt.**
4. **Load** – Stationen und Messwerte per Prepared Statements in einer Transaktion speichern, Lauf in
   `import_runs` protokollieren.

Beispielausgabe eines täglichen Laufs:

```
1) Extract: BAFU-API abfragen
   1 Zeitfenster geplant
   2026-07-22 23:00 → 2026-09-22 23:00 UTC: 732 Zeilen
2) Transform: prüfen und aufbereiten
   732 gültige Messwerte, 0 verworfen
3) Load: in MySQL speichern
Status: success · Neu: 0 · Aktualisiert: 1 · Unverändert: 731 · Verworfen: 0
```

Zum Testen lassen sich die Schritte einzeln starten (ohne in die Datenbank zu schreiben):
`php etl/extract.php` und `php etl/transform.php`. Cronjob: siehe [docs/cronjob.md](docs/cronjob.md).

## Unload (`unload.php`)

| Aufruf | Liefert |
|---|---|
| `unload.php?type=stations` | aktive Stationen inkl. verfügbarem Zeitraum |
| `unload.php?type=observations&stations=2019,2243&parameter=WT&from=2026-01-01&to=2026-09-21` | Tagesmittel (alle Parameter optional) |
| `unload.php?type=seasonal&parameter=W` | Monatsmittel der vollständigen Jahre |
| `unload.php?type=insights` | Kennzahlen für die Story-Texte |
| `unload.php?type=meta` | Quelle, Zeitraum, letzter Import, Freigabestatus |

Eingaben werden per Whitelist bzw. festem Format geprüft (Stationsnummer = 4 Ziffern, Datum = gültiges
`YYYY-MM-DD`, Parameter = `W`/`WT`). Fehler liefern JSON mit passendem HTTP-Status (400, 404, 405, 503, 500)
und werden in `logs/` protokolliert – nie eine rohe PHP-Fehlermeldung.

## Frontend

- **HTML/CSS/JavaScript** ohne Build-Schritt, Visualisierung mit **D3.js v7** (einzige Bibliothek).
- **Hauptgrafik**: Liniendiagramm der Tagesmittel. Umschalter Wassertemperatur/Wasserstand (nie beide auf einer
  Achse), Zeitraum 7 Tage bis «Alle», Flüsse ein-/ausblenden über die Legende. Jede Änderung von Zeitraum oder
  Flüssen löst eine neue Abfrage an `unload.php` aus.
- **Wasserstand** wird als Abweichung vom mittleren Pegel der Station (in cm) gezeigt – absolute Höhen (z.B.
  570 m ü.M. vs. 198 m ü.M.) wären nicht vergleichbar. Der absolute Wert steht im Tooltip.
- **Temperaturachse** beginnt bei 0 °C (keine abgeschnittene Achse). Fehlende Tage erscheinen als Lücke.
- **Tooltip** mit Crosshair: Datum, alle Flüsse mit Gewässer, Messstation, Wassertemperatur, Wasserstand und
  Freigabestatus. Auf schmalen Bildschirmen erscheinen die Werte in einem Panel unter der Grafik, damit der
  Finger die Linien nicht verdeckt. Tastatur: Pfeiltasten links/rechts.
- **Weitere Grafiken**: Jahresgang (Monatsmittel), Tabelle «Tage ≥ 20 °C», Punktdiagramm «dieses Jahr vs. Vorjahre».
- **Farben**: validierte, farbenblindfreundliche Palette; Farbe folgt immer der Station. Hell- und Dunkelmodus.
- **Barrierefreiheit**: Tabellenansicht der Kennzahlen, ARIA-Labels, Fokus-Stile, `prefers-reduced-motion`.
- **Responsive** ohne horizontale Scrollbar (getestet bei 375 px Breite).

## Learnings

- Eine eigene Datenbank macht die Website unabhängig von der Verfügbarkeit der Quelle und erlaubt eigene
  Auswertungen (Monatsmittel, Jahresvergleiche) direkt in SQL.
- GraphQL-Introspection (`__schema`) ist der schnellste Weg, verfügbare Felder zu finden, statt sie zu erraten.
- Zeitstempel genau lesen: «UTC, Beginn des Intervalls» bedeutet hier, dass `23:00Z` zum *nächsten* Kalendertag gehört.
- Ein UNIQUE-Key zusammen mit `ON DUPLICATE KEY UPDATE` macht einen ETL wiederholbar (idempotent).
- Datenjournalistisch sauber heisst auch: Vergleiche fair machen (gleicher Zeitraum pro Jahr, nur vollständige
  Jahre für Monatsmittel) und Grenzen offen benennen.

## Schwierigkeiten

- **10 000-Zeilen-Limit ohne Pagination** – gelöst mit berechneten Zeitfenstern und automatischer Halbierung.
- **Wasserstand in m ü.M.** – absolut nicht vergleichbar; Lösung: Abweichung vom mittleren Pegel in cm.
- **Freigabestatus `null`** – nicht dokumentierter Wert; wird als «ohne Status» gespeichert und ausgewiesen.
- **Verdächtige 0.00-°C-Werte** bei Brienzwiler (März 2026) – Regel im Transform, transparent dokumentiert.
- **Unvollständiges laufendes Jahr** – Jahresvergleiche immer über denselben Zeitraum (1.1. bis Stichtag).
- **PHP wandelt numerische Array-Keys** (`'2019'`) in Integer um – Stationsnummer deshalb immer aus dem Datensatz lesen.
- **Mobile Tooltips** verdeckten die Grafik – Lösung: Werte-Panel unter der Grafik.

## Ressourcen

- BAFU Datenplattform, Dokumentation: https://api.data-platform.cloud.bafu.admin.ch/
  (Datensatz, Pagination, Ratenbegrenzung, Lizenz)
- BAFU GraphQL-API: https://data.bafu.admin.ch/api
- D3.js v7: https://d3js.org/ (über jsDelivr eingebunden, mit Subresource-Integrity-Hash)
- PHP-Handbuch, PDO: https://www.php.net/manual/de/book.pdo.php
- MySQL-Referenz `INSERT … ON DUPLICATE KEY UPDATE`: https://dev.mysql.com/doc/refman/8.0/en/insert-on-duplicate.html
- Entwicklung unterstützt durch Claude Code (Anthropic)

## Installation (lokal)

Voraussetzungen: PHP ≥ 8.1 mit `pdo_mysql` und `curl`, MySQL oder MariaDB.

```bash
# 1. Datenbank anlegen (Name frei wählbar) und Schema einspielen
mysql -u root -p -e "CREATE DATABASE im3_gewaesser CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mysql -u root -p im3_gewaesser < etl/schema.sql

# 2. Zugangsdaten eintragen
cp config.example.php config.php     # danach DB_HOST, DB_NAME, DB_USERNAME, DB_PASSWORD ersetzen

# 3. Daten importieren (erster Lauf lädt alles ab 2020, ca. 10 Sekunden)
php etl/load.php

# 4. Website starten
php -S localhost:8000
# → http://localhost:8000
```

## Deployment (PHP/MySQL-Hosting, z.B. Hostpoint)

1. Im Control Panel eine MySQL-Datenbank und einen Benutzer anlegen (oder die bestehende verwenden).
2. `etl/schema.sql` in phpMyAdmin (Reiter «SQL») ausführen.
3. Alle Projektdateien per SFTP in das Web-Verzeichnis laden – **ohne** `.git/`, `.idea/`.
4. Auf dem Server `config.example.php` nach `config.php` kopieren und die Zugangsdaten des Hostings eintragen.
5. Einmal den Import starten: per SSH `php etl/load.php` (oder über die URL, siehe docs/cronjob.md).
6. Cronjob für den täglichen Import einrichten: [docs/cronjob.md](docs/cronjob.md).
7. Prüfen, dass `https://DOMAIN/config.php`, `https://DOMAIN/logs/` und `https://DOMAIN/etl/schema.sql` mit
   403 gesperrt sind (`.htaccess`).

Kein Node.js, kein Docker, kein Build-Schritt nötig.

## Sicherheit

**Nie ins Repository** (in `.gitignore` ausgeschlossen):

- `config.php` – echte Datenbank-Zugangsdaten und ETL-Token
- `.env` / `.env.*` – falls lokal verwendet
- `.idea/`, `.vscode/` – PhpStorm speichert dort u.a. FTP/SFTP-Deployment-Daten
- `logs/`, `etl/data/` – Laufzeitdateien
- Datenbank-Dumps (`dump*.sql`, `*.sql.gz`)

Weitere Massnahmen: PDO mit echten Prepared Statements, Whitelist-Validierung aller GET-Parameter,
`load.php` nur per Kommandozeile oder mit geheimem Token aufrufbar, `.htaccess` sperrt `config.php`, `db.php`,
`logs/`, `etl/` (ausser `load.php`) und versteckte Dateien, Ausgabe von Daten im Frontend nur über `textContent`.

## Screenshots

_Platzhalter – Screenshots nach dem Deployment ergänzen._

| Desktop | Mobile |
|---|---|
| `docs/screenshots/desktop.png` | `docs/screenshots/mobile.png` |
