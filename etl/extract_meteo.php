<?php
/**
 * Extract (Regen) – die Regenmengen bei MeteoSchweiz abholen.
 *
 * Ob ein Fluss tief steht, hängt stark davon ab, wie viel es geregnet hat.
 * Deshalb holen wir zusätzlich zu den BAFU-Daten den Regen pro Tag. Den
 * misst das Bundesamt für Meteorologie, MeteoSchweiz, an seinen
 * Wetterstationen und stellt ihn frei ins Internet («Open Data»).
 *
 * Wie bei extract.php wird hier noch nichts geprüft oder verändert. Die
 * Daten werden nur abgeholt und an transform_meteo.php weitergegeben.
 *
 * Ablauf:
 *
 *   1. Die Liste aller Wetterstationen holen (Name, Ort, Höhe)
 *   2. Für jede unserer sechs Wetterstationen die Tageswerte holen
 *   3. Alles als Liste an transform_meteo.php weitergeben
 *
 * Der Unterschied zum BAFU: MeteoSchweiz hat keinen «Fragebogen» (GraphQL).
 * Stattdessen gibt es pro Wetterstation eine fertige Tabelle als Datei
 * (CSV = Werte, mit Strichpunkt getrennt). Wir laden die Datei herunter und
 * lesen sie Zeile für Zeile. Pro Station gibt es zwei Dateien:
 *
 *   …_d_recent.csv       das laufende Jahr (klein, wird täglich ergänzt)
 *   …_d_historical.csv   alle früheren Jahre (gross, ab 1864)
 *
 * Gestartet wird diese Datei nicht direkt, sondern über transform_meteo.php.
 */

// ---------------------------------------------------------------------------
// 1. Einstellungen
// ---------------------------------------------------------------------------

// Hier legt MeteoSchweiz die Dateien der automatischen Wetterstationen ab
// (das «SwissMetNet», abgekürzt smn).
$meteoBase = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn';

// Zu jedem Fluss eine Wetterstation, die in seinem Gebiet liegt.
// Links die Nummer der BAFU-Station am Fluss, rechts das Kürzel der
// Wetterstation bei MeteoSchweiz.
$weatherStations = [
    '2243' => 'SMA', // Limmat – Zürich / Fluntern
    '2044' => 'STG', // Thur – St. Gallen
    '2091' => 'BUS', // Rhein – Buchs / Aarau (Mitte des grossen Einzugsgebiets)
    '2019' => 'MER', // Aare – Meiringen
    '2009' => 'SIO', // Rhône – Sion
    '2068' => 'BIA', // Ticino – Biasca
];

// Welche Spalte der Tabelle wir brauchen:
// rka150d0 = Regen, Tagessumme von Mitternacht bis Mitternacht (Weltzeit), in mm.
$precipitationColumn = 'rka150d0';

// ---------------------------------------------------------------------------
// 2. Der Helfer fetchText(): eine Datei aus dem Internet holen
// ---------------------------------------------------------------------------
//
// Fast wie fetchJson() in extract.php, nur dass die Antwort hier kein JSON
// ist, sondern eine Tabelle als Text. Auch hier stellen wir uns mit einem
// Namen vor (User-Agent) und versuchen es bei einer Störung bis zu dreimal.

function fetchText(string $url): string {
    $attempt = 1;

    while (true) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 90); // grosse Dateien: höchstens 90 Sekunden warten
        curl_setopt($ch, CURLOPT_USERAGENT, 'FHGR-IM3-DataStory/1.0 (Studienprojekt)');

        $response = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);

        // Alles in Ordnung (Code 200): die Datei zurückgeben.
        if ($response !== false && $status === 200) {
            return $response;
        }

        // Lohnt sich ein neuer Versuch? Nur bei «Server beschäftigt» oder «kein Netz».
        $retry = $response === false || $status === 429 || $status >= 500;

        if (!$retry || $attempt > 3) {
            throw new RuntimeException("MeteoSchweiz antwortet mit HTTP {$status} für {$url}");
        }

        sleep(2 ** $attempt); // kurz warten: 2, 4 oder 8 Sekunden
        $attempt++;
    }
}

// ---------------------------------------------------------------------------
// 3. Der Helfer readCsv(): eine Tabelle in eine PHP-Liste verwandeln
// ---------------------------------------------------------------------------
//
// Die erste Zeile der Datei enthält die Spaltennamen, z.B.
//   station_abbr;reference_timestamp;…;rka150d0;…
// Jede weitere Zeile ist ein Tag. Wir machen daraus pro Zeile eine Liste
// mit Namen, z.B. $row['rka150d0'].
//
// Die Dateien haben über 40 Spalten. Wir behalten nur die Spalten, die in
// $keep stehen. Sonst wäre die Liste mit allen Tagen seit 1864 zu gross für
// den Arbeitsspeicher des Servers.
//
// MeteoSchweiz speichert Umlaute in einer älteren Schreibweise (ISO-8859-1).
// Damit aus «Zürich» nicht «Z?rich» wird, wandeln wir den Text zuerst um.

function readCsv(string $text, array $keep): array {
    $text = mb_convert_encoding($text, 'UTF-8', 'ISO-8859-1');
    $lines = preg_split('/\r\n|\n/', trim($text));
    $header = str_getcsv(array_shift($lines), ';', '"', '');
    unset($text); // den grossen Text brauchen wir nicht mehr: Speicher freigeben

    // An welcher Stelle steht jede gewünschte Spalte? z.B. 'rka150d0' → 22
    $positions = array_intersect($header, $keep);

    $rows = [];
    foreach ($lines as $line) {
        if ($line === '') {
            continue; // leere Zeile überspringen
        }
        $values = str_getcsv($line, ';', '"', '');
        $row = [];
        foreach ($positions as $index => $name) {
            $row[$name] = $values[$index] ?? null;
        }
        $rows[] = $row;
    }

    return $rows;
}

// ---------------------------------------------------------------------------
// 4. Ab wann holen wir Daten?
// ---------------------------------------------------------------------------
//
// Das Startdatum bestimmt load.php. Fehlt es, holen wir die letzten 7 Tage.
// Liegt es vor dem 1. Januar dieses Jahres, brauchen wir zusätzlich die
// grosse Datei mit den früheren Jahren.

$meteoStartDate = $meteoStartDate ?? date('Y-m-d', strtotime('-7 days'));
$needHistorical = $meteoStartDate < date('Y') . '-01-01';

// Ein kleines Protokoll: Wie oft haben wir gefragt, was hat nicht geklappt?
$meteoExtractAudit = [
    'api_requests' => 0,
    'failed_files' => 0,
];

// ---------------------------------------------------------------------------
// 5. Die Wetterstationen abholen
// ---------------------------------------------------------------------------
//
// Name, Koordinaten und Höhe kommen direkt von MeteoSchweiz. Wir behalten
// nur unsere sechs Stationen.

$meteoAbbrs = array_values($weatherStations);

$allStations = readCsv(fetchText($meteoBase . '/ogd-smn_meta_stations.csv'), [
    'station_abbr', 'station_name', 'station_height_masl',
    'station_coordinates_wgs84_lat', 'station_coordinates_wgs84_lon',
]);
$meteoExtractAudit['api_requests']++;

$rawWeatherStations = array_values(array_filter(
    $allStations,
    fn ($station) => in_array($station['station_abbr'] ?? '', $meteoAbbrs, true)
));

// Ohne Stationen können wir nichts machen: abbrechen.
if (count($rawWeatherStations) === 0) {
    throw new RuntimeException('MeteoSchweiz liefert keine unserer Wetterstationen.');
}

// ---------------------------------------------------------------------------
// 6. Die Tageswerte abholen, Station für Station
// ---------------------------------------------------------------------------
//
// Die Dateien enthalten viele Spalten (Temperatur, Wind, Sonne …). Wir
// behalten nur drei: Station, Tag und Regen. Und nur die Tage ab dem
// Startdatum, denn die Werte ab 1864 brauchen wir nicht.
//
// Fällt eine Datei aus, holen wir die anderen trotzdem. Der nächste Import
// holt die Lücke nach.

$rawPrecipitation = [];

foreach ($meteoAbbrs as $abbr) {
    $lower = strtolower($abbr); // die Dateinamen sind kleingeschrieben: sma, stg …
    $files = ["{$meteoBase}/{$lower}/ogd-smn_{$lower}_d_recent.csv"];

    if ($needHistorical) {
        $files[] = "{$meteoBase}/{$lower}/ogd-smn_{$lower}_d_historical.csv";
    }

    foreach ($files as $url) {
        $meteoExtractAudit['api_requests']++;

        try {
            $rows = readCsv(fetchText($url), ['station_abbr', 'reference_timestamp', $precipitationColumn]);
        } catch (RuntimeException $e) {
            $meteoExtractAudit['failed_files']++;
            error_log('extract_meteo.php: ' . $e->getMessage());
            continue;
        }

        foreach ($rows as $row) {
            // Das Datum steht so in der Datei: «21.09.2026 00:00».
            // Umgedreht als «2026-09-21» kann man es mit dem Startdatum vergleichen.
            $timestamp = (string) ($row['reference_timestamp'] ?? '');
            $isoDate = substr($timestamp, 6, 4) . '-' . substr($timestamp, 3, 2) . '-' . substr($timestamp, 0, 2);

            if ($isoDate < $meteoStartDate) {
                continue; // zu alt, brauchen wir nicht
            }

            $rawPrecipitation[] = [
                'station_abbr' => $row['station_abbr'] ?? null,
                'reference_timestamp' => $timestamp,
                'value' => $row[$precipitationColumn] ?? null,
            ];
        }
    }
}

// ---------------------------------------------------------------------------
// 7. Alles an transform_meteo.php weitergeben
// ---------------------------------------------------------------------------

return [
    'stations' => $rawWeatherStations,
    'observations' => $rawPrecipitation,
    'station_map' => $weatherStations,
    'audit' => $meteoExtractAudit,
];
