# Analyse der BAFU-API (Phase 1)

Stand der Analyse: 22. September 2026. Alle Angaben wurden direkt gegen die API
(`https://data.bafu.admin.ch/api`) und die offizielle Dokumentation
(`https://api.data-platform.cloud.bafu.admin.ch/dataproduct-water-observations`) geprüft.

## 1. Aufbau der API

- **GraphQL**, ein Endpunkt: `POST https://data.bafu.admin.ch/api`, `Content-Type: application/json`, keine Authentifizierung.
- Einstieg für Hydrologie: `water { observations { … } }`
- Per Introspection (`__schema`) ermittelte Felder unter `observations`:
  `stations`, `data_10min_mean`, `data_1hour_mean`, `data_1day_mean`, `data_1day_min`, `data_1day_max`,
  `data_1month_mean/min/max`, `data_1year_mean/min/max`, `data_live`.
- Filter nach Hasura-Konvention (`_eq`, `_in`, `_gte`, `_lt`, …). Für Messwerte filterbar sind
  `timestamp`, `parameterName`, `value` und `station.no`.

### Felder der Messwerte (`data_1day_mean`)

| Feld | Typ | Beispiel | Verwendung |
|---|---|---|---|
| `parameterName` | String | `W`, `WT`, `Q` | Messgrösse |
| `tsName` | String | `TagMittel` | nicht gespeichert |
| `unitSymbol` | String | `m ü.M.`, `°C` | im Transform gegen die erwartete Einheit geprüft |
| `unitName` | String | `cubic meter per second` | nicht gespeichert |
| `timestamp` | AWSDateTime | `2026-09-20T23:00:00Z` | → `measured_at` + `obs_date` |
| `value` | Float | `21.35` | → `value` |
| `releaseState` | String | `"2"`, `"3"`, `null` | → `release_state` |
| `station { no name id latitude longitude }` | Objekt | `no: "2243"` | Zuordnung zur Station |

### Felder der Stationen (`stations`)

`no, name, siteName, riverName, catchmentName, localX, localY, latitude, longitude, status,
elevation, adminName, adminLevel, coverageFrom, coverageTo`

- 1341 Stationen insgesamt, davon 253 mit `status = "Aufgebaut"` (in Betrieb), 1087 «Aufgehoben».
- `elevation` ist bei den gewählten Stationen `null` → wird nicht verwendet.

## 2. Verwendete Queries

**Stationen** (1 Request pro Import):

```graphql
query Stations($nos: [String!]) {
  water { observations {
    stations(where: { no: { _in: $nos } }, limit: 1000) {
      no name siteName riverName catchmentName
      latitude longitude elevation status coverageFrom coverageTo
    }
  } }
}
```

**Tagesmittel** für alle Stationen und beide Messgrössen in einem Zeitfenster:

```graphql
query Observations($nos: [String!], $params: [String!], $from: AWSDateTime!, $to: AWSDateTime!) {
  water { observations {
    data_1day_mean(
      where: {
        station: { no: { _in: $nos } }
        parameterName: { _in: $params }          # ["W", "WT"]
        timestamp: { _gte: $from, _lt: $to }
      }
      limit: 10000
    ) { parameterName unitSymbol timestamp value releaseState station { no } }
  } }
}
```

**Kandidatensuche** (`php etl/extract.php --candidates`): Tagesmittel aller Stationen für W und WT an einem Stichtag
+ alle Stationen mit Status «Aufgebaut».

## 3. Limits, Pagination, Zeitfenster

- Laut Doku und getestet: Eine Abfrage mit mehr als **10 000 Zeilen wird abgelehnt**
  (`Query returned more than 10000 rows …`), nicht gekürzt. Es gibt **keine Offset- oder Cursor-Pagination**.
- Lösung im ETL: Der Zeitraum wird in Fenster aufgeteilt. Zeilen pro Tag = Stationen × Parameter = 6 × 2 = 12.
  Mit einer Reserve von 8000 Zeilen pro Fenster ergibt das 666 Tage pro Request.
  → Erstimport 2020 bis heute: **4 Requests**, täglicher Import (60 Tage): **1 Request**.
- Lehnt die API ein Fenster trotzdem ab, halbiert `extract.php` das Fenster automatisch.
- Ratenlimit: 500 Requests / 5 Minuten pro IP, Überschreitung → HTTP 403. Wir liegen bei 2–5 Requests pro Lauf;
  bei 403/429/5xx wird mit 2, 4, 8 Sekunden Wartezeit wiederholt.

## 4. Zeitstempel

- Zeitstempel sind UTC und bezeichnen laut Doku den **Beginn des Aggregationsintervalls**.
- Alle Tagesmittel haben den Zeitstempel `23:00:00Z` – auch im Sommer. Ein Tag beginnt also um 00:00 **MEZ (UTC+1)**,
  ohne Sommerzeit-Umstellung. Beispiel: `2026-09-20T23:00:00Z` ist das Tagesmittel des **21. September 2026**.
- Der ETL speichert beides: `measured_at` (Original, UTC) und `obs_date` (Kalendertag, berechnet mit `Etc/GMT-1`).

## 5. Freigabestatus (`releaseState`)

Laut Doku: `1` provisorisch, `2` validiert, `3` definitiv. Zusätzlich liefert die API oft `null`.
Verteilung in unserer Datenbank (Stand Analyse):

| Status | W | WT |
|---|---|---|
| 3 definitiv | bis 2025-01-01 | bis 2025-01-01 |
| 2 validiert | 2023–2026 | 2025–2026 |
| 1 provisorisch | 5 Werte | – |
| `null` | 2132 Werte (v.a. jüngste Monate, Ticino-Pegel auch ältere) | 1452 Werte (jüngste Monate) |

Umgang: Der Status wird gespeichert, im Tooltip angezeigt und auf der Website als Anteil ausgewiesen.
Weil sich Werte nachträglich ändern können, lädt jeder Import die letzten 60 Tage neu; geänderte Werte
werden per Upsert aktualisiert.

## 6. Auffällige Daten

- Aare – Brienzwiler (2019), WT: drei Tagesmittel von exakt `0.00 °C` (Zeitstempel 23.–25. März 2026, 23:00 UTC, d.h. Tage 24.–26. März MEZ)
  ohne Freigabestatus, eingerahmt von 5.03 °C und 2.57 °C. Für ein ganzes Tagesmittel unplausibel →
  im Transform als «vermuteter Sensorausfall» verworfen (nur unvalidierte Werte). In der Grafik als Lücke.
- Wasserstände wurden auf Sprünge im Pegelbezug geprüft (Jahresmittel je Station 2020–2026): keine Verschiebung erkennbar.

## 7. Wahl der Aggregation

`data_1day_mean` (Tagesmittel):
- zeigt Hochwasser-Spitzen und Hitzeperioden (Stunden- und 10-Minuten-Werte wären für mehrere Jahre zu viele Daten),
- 6 Stationen × 2 Messgrössen × ~2450 Tage ≈ 29 500 Zeilen – klein genug für jedes Hosting,
- lückenlos ab 2020 verfügbar.

## 8. Auswahl der Messstationen

Grundlage: 75 aktive Stationen liefern am Stichtag sowohl W als auch WT
(`php etl/extract.php --candidates`). Daraus wurden sechs Stationen gewählt, die unterschiedliche Landschaften
und Abflusstypen vertreten und für die W und WT seit 2020 lückenlos vorliegen (je 2456 Tage bis 21.9.2026; bei der Aare fehlen nur die drei verworfenen WT-Werte):

| Nr. | Gewässer – Station | Einzugsgebiet | Warum |
|---|---|---|---|
| 2019 | Aare – Brienzwiler | Aaregebiet | alpiner Fluss vor dem Brienzersee (Gletscher/Schnee) |
| 2243 | Limmat – Baden | Limmatgebiet | Abfluss des Zürichsees |
| 2009 | Rhône – Porte du Scex | Rhonegebiet | Walliser Alpen, vor dem Genfersee |
| 2044 | Thur – Andelfingen | Rheingebiet | Ostschweiz, ohne grossen See |
| 2068 | Ticino – Riazzino | Tessingebiet | Alpensüdseite |
| 2091 | Rhein – Rheinfelden | Rheingebiet | grosser Fluss unterhalb der Aaremündung |

Die Auswahl ist im Code als Konfiguration hinterlegt (`STATIONS` in `etl/extract.php`) und kann dort geändert werden.
