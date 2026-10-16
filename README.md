# Wenn Flüsse Durst haben

**Website:** https://im3.ixigamil.myhostpoint.ch/ ·
**Datenquellen / APIs:** [BAFU Hydrologische Beobachtungen](https://api.data-platform.cloud.bafu.admin.ch/dataproduct-water-observations) (GraphQL: https://data.bafu.admin.ch/api) ·
[MeteoSchweiz Open Data, automatische Wetterstationen](https://opendatadocs.meteoswiss.ch/a-data-groundbased/a1-automatic-weather-stations) (CSV über https://data.geo.admin.ch)

## Kurzbeschreibung

Die DataStory prüft die These, dass die Flüsse im Mittelland 2026 bisher wärmer waren und weniger Wasser
führten als im Hitzesommer 2022. Grundlage sind Tagesmittel von Wassertemperatur und Wasserstand an sechs
BAFU-Stationen sowie der Niederschlag von MeteoSchweiz. Ein PHP-ETL-Prozess speichert die Daten täglich in einer
eigenen MySQL-Datenbank. Die Story lässt Lesende Kurven zeichnen und Regenmengen schätzen; eine Datenseite zeigt
alle Details – mit drei Alpenflüssen als Vergleichsgruppe.

## Aufbau

| Teil | Dateien | Aufgabe |
|---|---|---|
| Extract | `etl/extract.php` | Tagesmittel beim BAFU (GraphQL) und Regen bei MeteoSchweiz (CSV) abholen |
| Transform | `etl/transform.php` | jeden Wert beider Quellen prüfen, unplausible verwerfen und zählen, Datum in Schweizer Zeit |
| Load | `etl/load.php`, `etl/schema.sql` | in sieben MySQL-Tabellen speichern, täglich per Cronjob, letzte 60 Tage neu |
| Unload | `unload.php` | JSON nach Datenvertrag liefern, mit geprüften Filtern in der URL |
| Story | `index.html`, `daten.html`, `script.js`, `style.css` | Grafiken mit D3.js, Text und Zahlen aus den Daten berechnet |

## Datenbank und Datenvertrag

Die MySQL-Datenbank (`etl/schema.sql`) hat sieben Tabellen:

| Tabelle | Inhalt |
|---|---|
| `parameters` | die zwei Messgrössen des BAFU: Wasserstand (`W`, m ü.M.) und Wassertemperatur (`WT`, °C) |
| `stations` | die sechs Flussstationen des BAFU mit Name, Fluss, Koordinaten und Reihenfolge auf der Website |
| `observations` | ein Tagesmittel pro Zeile (Station, Messgrösse, Tag, Wert, Prüfstatus), rund 30 000 Zeilen |
| `station_baselines` | der mittlere Wasserstand jeder Station seit 2020, nach jedem Import neu berechnet |
| `weather_stations` | die sechs Wetterstationen von MeteoSchweiz, je einem Fluss zugeordnet |
| `precipitation` | der Regen pro Tag und Wetterstation in mm |
| `import_runs` | das Protokoll jedes Imports: Zeitraum, neue, geänderte und verworfene Werte, Fehler |

Der Regen steht bewusst nicht als dritte Messgrösse in `observations`: Er kommt von einer anderen Quelle und von
anderen Stationen, ist eine Tagessumme statt eines Tagesmittels, hat keinen Prüfstatus und gehört zu einem Tag
statt zu einem Zeitpunkt. Mit eigenen Tabellen bleibt jede Spalte eindeutig. Ein UNIQUE-Key pro Station und Tag
verhindert in beiden Fällen doppelte Werte.

`unload.php` liefert eine Zeile pro Flussstation und Tag (Datenvertrag), mit Filtern für Stationen, Messgrösse,
Jahre und Zeitraum:

```json
{
  "station_no": "2044", "river_name": "Thur", "station_name": "Andelfingen", "date": "2026-10-10",
  "water_temperature_c": 14.4, "water_level_deviation_cm": -23.3, "release_state": null,
  "precipitation_mm": 11.2, "precipitation_station": "St. Gallen"
}
```

Mit `unload.php?summary=1` gibt es zusätzlich eine Zusammenfassung pro Fluss und Jahr (Mittelwerte, Tage ab
25 °C, Regensumme), jedes Jahr vom 1. Januar bis zum selben Stichtag. Daraus rechnet die Website den
Durchschnitt 2020–2025 als zweiten Massstab neben dem Hitzesommer 2022.

## Learnings

- **Eine eigene Datenbank macht unabhängig.** Ich hätte die Daten auch direkt im Browser bei der API holen
  können. Mit der eigenen Datenbank läuft die Seite aber weiter, wenn BAFU oder MeteoSchweiz ausfallen, und ich
  kann Auswertungen wie den Durchschnitt pro Jahr direkt in SQL rechnen.
- **Einer API nicht blind vertrauen.** Mit `limit: 10000` hat die BAFU-API zu grosse Antworten einfach
  abgeschnitten, ohne Fehlermeldung. Gemerkt habe ich das erst, als ich die Zeilen nachgezählt habe. Seither
  prüfe ich jede Antwort und frage in Zeitfenstern ab.
- **Zwei Quellen sind zwei Welten.** GraphQL beim BAFU, CSV-Dateien mit Latin-1-Umlauten und Werten ab 1864 bei
  MeteoSchweiz: Für jede Quelle brauchte ich einen eigenen Weg, aber dieselben Prüfregeln.
- **Wiederholbare Importe sparen Nerven.** Dank UNIQUE-Key und `INSERT … ON DUPLICATE KEY UPDATE` kann ich den
  Import beliebig oft laufen lassen. Nichts wird doppelt gespeichert, und Korrekturen des BAFU kommen trotzdem an.
- **Ein Vergleichsjahr reicht nicht.** Zuerst habe ich 2026 nur mit 2022 verglichen. Erst der Durchschnitt
  2020–2025 zeigt, dass 2026 nicht nur heisser als der Hitzesommer war, sondern das wärmste und trockenste Jahr
  der ganzen Messreihe.
- **Weniger ist mehr.** Meine erste Seite hatte alle Grafiken untereinander. Eine kurze Story mit wenigen
  Grafiken und eine eigene Datenseite für die Details lesen sich viel besser.
- **Erst raten, dann zeigen.** Wer zuerst selbst schätzt, merkt sich das Ergebnis besser. Dafür darf die Seite
  die Lösung vorher nicht verraten. Eine Kennzahl weiter oben hat genau das getan, also habe ich sie gestrichen.
- **Sicherheit von Anfang an.** Zugangsdaten stehen nur in `config.php`, die nie in Git landet, und alle
  Datenbankabfragen laufen über Prepared Statements. Vor der Abgabe habe ich die ganze Git-Geschichte nach
  Passwörtern durchsucht.

## Schwierigkeiten

- **10 000-Zeilen-Limit ohne Pagination:** Die BAFU-API lehnt grössere Abfragen ab. Gelöst mit berechneten
  Zeitfenstern und automatischer Halbierung, falls ein Fenster trotzdem zu gross ist.
- **Stilles Abschneiden:** Mit `limit: 10000` in der Abfrage kürzt die API zu grosse Antworten ohne Fehlermeldung.
  Entdeckt erst durch gezieltes Testen; jetzt ohne `limit` und mit Zusatzprüfung gelöst. Ausserdem blockt die API
  Anfragen ohne User-Agent mit HTTP 403 – im Unterrichtsbeispiel für die Sensorbox war das nicht nötig.
- **Zwei sehr verschiedene Quellen:** MeteoSchweiz bietet keine Abfrage-API, sondern pro Station eine CSV-Datei
  (Latin-1-kodiert, über 40 Spalten, Werte ab 1864). Die grosse Datei sprengte zuerst den Arbeitsspeicher; jetzt
  behält das Script nur die drei nötigen Spalten. Ein fehlender Regentag bleibt leer statt 0 mm.
- **Wasserstand in Metern über Meer:** Absolute Pegel (z.B. 570 m ü.M. in Brienzwiler, 198 m ü.M. am Ticino)
  sind nicht vergleichbar. Lösung: Abweichung vom mittleren Pegel jeder Station in Zentimetern.
- **Unklarer Freigabestatus:** Die API liefert neben 1/2/3 oft `null`. Dieser Wert wird als «ohne Status»
  gespeichert und auf der Website ausgewiesen.
- **Verdächtige Messwerte:** Bei Brienzwiler meldet die API im März 2026 drei Tage lang exakt 0.00 °C. Diese
  ungeprüften Werte werden als vermuteter Sensorausfall verworfen und erscheinen als Lücke.
- **Regentag und Flusstag:** MeteoSchweiz zählt einen Regentag von Mitternacht bis Mitternacht Weltzeit, das
  BAFU rechnet in Schweizer Zeit. Die eine Stunde Verschiebung ist für Wochen- und Jahressummen vernachlässigbar
  und auf der Website offen ausgewiesen.
- **Eine Wetterstation pro Fluss:** Eine Station misst den Regen an einem Ort, nicht im ganzen Einzugsgebiet.
  Beim Rhein, dessen Wasser aus der halben Schweiz kommt, ist das nur eine Annäherung.
- **Spoiler im eigenen Text:** Die Regen-Kennzahl weiter oben verriet das Ergebnis des Schätzspiels. Sie wurde
  gestrichen; Titel, Einleitung und Grafik erscheinen pro Fluss erst nach dem Auflösen.
- **Unvollständiges laufendes Jahr:** Für faire Jahresvergleiche wird jedes Jahr nur vom 1. Januar bis zum
  gleichen Stichtag gemittelt.
- **PHP-Eigenheit:** Numerische Array-Keys wie `'2019'` werden automatisch zu Zahlen – die Stationsnummer
  wird deshalb immer aus dem Datensatz gelesen.
- **Tooltips auf dem Handy:** Ein schwebender Tooltip verdeckte die ganze Grafik. Lösung: Auf schmalen
  Bildschirmen erscheinen die Werte in einem Panel unter der Grafik.
- **Deployment:** Zugangsdaten und Import-Token nur auf dem Server hinterlegen, sensible Dateien per
  `.htaccess` sperren und den täglichen Import als Cronjob im Hostpoint Control Panel einrichten.

## Ressourcen

- **Datenquelle Flüsse:** Bundesamt für Umwelt BAFU, [Hydrologische Beobachtungen](https://api.data-platform.cloud.bafu.admin.ch/dataproduct-water-observations),
  Tagesmittel von Wassertemperatur und Wasserstand (GraphQL-API, freie Nutzung mit Quellenangabe)
- **Datenquelle Regen:** MeteoSchweiz, [Automatische Wetterstationen](https://opendatadocs.meteoswiss.ch/a-data-groundbased/a1-automatic-weather-stations),
  Tagessumme Niederschlag `rka150d0` (Open Data, CSV)
- **BAFU:** [Hitzewelle und Trockenheit](https://www.bafu.admin.ch/de/hitzewelle-und-trockenheit) – Niedrigwasser und Gletscherflüsse im Sommer 2022
- **MeteoSchweiz:** [Klimabulletin Sommer 2022](https://www.meteoschweiz.admin.ch/service-und-publikationen/publikationen/berichte-und-bulletins/2022/klimabulletin-sommer-2022.html)
- **Kanton Aargau:** [Notfallkonzept Trockenheit und Hitze](https://www.ag.ch/media/kanton-aargau/bvu/umwelt-natur/fischerei/informationen-fuer-fischer/notfallkonzept-trockenheit-und-hitze.pdf) – Fischsterben 2022
- **Kanton Basel-Stadt:** [Temperaturen der Gewässer 2014–2018](https://media.bs.ch/original_file/e8e97aa97f41294b844e6c3232593cd5aa0739ed/temperaturen-gewaesser-bs-2014-2018.pdf) – Temperaturgrenzen für Äschen
- **AquaPlus im Auftrag des Bundes (NCCS):** [Fischschutzmassnahmen bei Hitzeereignissen](https://www.nccs.admin.ch/dam/nccs/de/dokumente/website/massnahmen/projekte/AquaPlus_Fischschutzmassnahmen_bei_Hitzeereignissen_Arbeitshilfe_2022.pdf.download.pdf/AquaPlus_Fischschutzmassnahmen_bei_Hitzeereignissen_Arbeitshilfe_2022.pdf) (2022)

## KI-Unterstützung

Bei Konzeption, Programmierung, Texten und Dokumentation habe ich Claude Code (Anthropic) als Assistenten
eingesetzt. Fragestellung, Auswahl der Quellen, Entscheidungen zur Gestaltung und die Prüfung der Ergebnisse
lagen bei mir.

## Screenshots

### Desktop

![Einstieg mit Titel, These und der Thur als Fluss, gefärbt nach Wassertemperatur 2022 und 2026](docs/screenshots/desktop.png)

![Schätzspiel: Regen 2022 im Messbecher, den Becher für 2026 füllt man selbst, die Grafik bleibt bis zum Auflösen verschwommen](docs/screenshots/desktop-schaetzen.png)

![Datenseite: Regen seit 1. Januar und Pegel für alle sechs Flüsse, 2022 und 2026 übereinander](docs/screenshots/desktop-grafik.png)

### Mobile

<p>
  <img src="docs/screenshots/mobile.png" alt="Einstieg mit Titel, These und der Thur als Fluss in der Mobile-Ansicht" width="300">
  <img src="docs/screenshots/mobile-grafik.png" alt="Schätzspiel mit Messbechern in der Mobile-Ansicht" width="300">
</p>

## Foto des Marktstands

![Marktstand: das gemalte Plakat mit Fluss, Fischen und den ETL-Schritten, daneben der Laptop mit der Website](docs/marktstand.jpg)
