<?php
/**
 * Extract – die Rohdaten bei den zwei Quellen abholen.
 *
 * Diese Datei holt alle Daten, die wir brauchen, aus zwei Quellen:
 *
 *   Teil A  Bundesamt für Umwelt (BAFU): wie warm das Wasser unserer sechs
 *           Flüsse ist und wie hoch es steht
 *   Teil B  MeteoSchweiz: wie viel es im Gebiet dieser Flüsse geregnet hat
 *
 * Hier wird noch nichts geprüft oder verändert. Die Daten werden nur abgeholt
 * und so, wie sie ankommen, an transform.php weitergegeben.
 *
 * Die zwei Quellen funktionieren ganz verschieden:
 *
 * - Dem BAFU schickt man einen kleinen Fragebogen (eine «GraphQL-Abfrage»).
 *   Pro Frage gibt es höchstens 10 000 Werte zurück, deshalb fragen wir in
 *   mehreren Portionen. Und man muss sich mit einem Namen vorstellen, sonst
 *   bekommt man keine Antwort.
 * - MeteoSchweiz stellt pro Wetterstation eine fertige Tabelle als Datei
 *   bereit (CSV: Werte, mit Strichpunkt getrennt). Wir laden sie herunter und
 *   lesen sie Zeile für Zeile. Pro Station gibt es zwei Dateien:
 *     …_d_recent.csv       das laufende Jahr (klein, wird täglich ergänzt)
 *     …_d_historical.csv   alle früheren Jahre (gross, ab 1864)
 *
 * Fällt das BAFU aus, bricht der Import ab: Ohne Flussdaten gibt es nichts zu
 * erzählen. Fällt nur MeteoSchweiz aus, holen wir die Flussdaten trotzdem und
 * notieren den Fehler. Der nächste Import holt den Regen nach.
 *
 * Gestartet wird diese Datei nicht direkt, sondern über transform.php.
 */

// ===========================================================================
// TEIL A: Wassertemperatur und Wasserstand vom BAFU
// ===========================================================================

// ---------------------------------------------------------------------------
// A1. Einstellungen fürs BAFU
// ---------------------------------------------------------------------------

// Die Adresse, unter der das BAFU seine Daten anbietet.
$endpoint = 'https://data.bafu.admin.ch/api';

// Unsere sechs Messstationen, mit ihrer offiziellen Nummer beim BAFU.
// Alle messen seit 2020 lückenlos Temperatur und Wasserstand.
// In dieser Reihenfolge erscheinen sie später auch auf der Website.
$stationNos = [
    '2243', // Limmat – Baden
    '2044', // Thur – Andelfingen
    '2091', // Rhein – Rheinfelden
    '2019', // Aare – Brienzwiler
    '2009', // Rhône – Porte du Scex
    '2068', // Ticino – Riazzino
];

// Was wir messen wollen: W = Wasserstand, WT = Wassertemperatur.
$parameterCodes = ['W', 'WT'];

// Das BAFU gibt höchstens 10 000 Werte pro Frage heraus.
// Wir fragen sicherheitshalber nur nach 8000 auf einmal.
$maxRowsPerRequest = 8000;

// ---------------------------------------------------------------------------
// A2. Der Helfer fetchJson(): eine Frage ins Internet schicken
// ---------------------------------------------------------------------------
//
// Diesen Helfer kennen wir aus dem Unterricht. Er schickt eine Anfrage an eine
// Web-Adresse und gibt die Antwort als Liste zurück, mit der PHP arbeiten kann.
//
// Für das BAFU haben wir ihn etwas erweitert:
// - Er kann einen Fragebogen mitschicken ($postData).
// - Er stellt sich mit einem Namen vor (User-Agent). Ohne Namen sagt das
//   BAFU «kein Zugang».
// - Klappt etwas nicht, meldet er den Fehler laut, statt still nichts zu tun.

function fetchJson(string $url, ?array $postData = null): array {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 60); // höchstens 60 Sekunden auf die Antwort warten
    curl_setopt($ch, CURLOPT_USERAGENT, 'FHGR-IM3-DataStory/1.0 (Studienprojekt)');

    // Den Fragebogen mitschicken, falls es einen gibt.
    if ($postData !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($postData));
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    }

    $response = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    // Gar keine Antwort, zum Beispiel weil das Internet weg ist.
    if ($response === false) {
        throw new RuntimeException('Netzwerkfehler: ' . curl_error($ch), 0);
    }

    // Eine Antwort, aber nicht «alles in Ordnung» (das wäre der Code 200).
    if ($status !== 200) {
        throw new RuntimeException("Die BAFU-API antwortet mit HTTP {$status}.", $status);
    }

    // Die Antwort ist Text im JSON-Format. Daraus wird eine PHP-Liste.
    return json_decode($response, true, 512, JSON_THROW_ON_ERROR);
}

// ---------------------------------------------------------------------------
// A3. Fragen und es bei Bedarf nochmals versuchen
// ---------------------------------------------------------------------------
//
// Manchmal ist der Server des BAFU kurz überlastet. Dann geben wir nicht
// sofort auf, sondern versuchen es bis zu dreimal. Dazwischen warten wir
// jedes Mal etwas länger: 2, dann 4, dann 8 Sekunden.
//
// Auch eine Antwort mit einer Fehlermeldung darin gilt als Fehler.

function fetchGraphql(string $url, string $query, array $variables): array {
    $attempt = 1;

    while (true) {
        try {
            $answer = fetchJson($url, ['query' => $query, 'variables' => $variables]);
            break; // hat geklappt
        } catch (RuntimeException $e) {
            // Lohnt sich ein neuer Versuch? Nur bei «Server beschäftigt» oder «kein Netz».
            $status = $e->getCode();
            $retry = $status === 0 || $status === 403 || $status === 429 || $status >= 500;

            if (!$retry || $attempt > 3) {
                throw $e; // aufgeben
            }

            sleep(2 ** $attempt); // kurz warten: 2, 4 oder 8 Sekunden
            $attempt++;
        }
    }

    if (!empty($answer['errors'])) {
        throw new RuntimeException('GraphQL-Fehler: ' . ($answer['errors'][0]['message'] ?? 'unbekannt'));
    }

    return $answer['data'] ?? [];
}

// ---------------------------------------------------------------------------
// A4. Ab wann holen wir Daten?
// ---------------------------------------------------------------------------
//
// Das Startdatum bestimmt load.php. Fehlt es, holen wir die letzten 7 Tage.
//
// Zeitzonen: Das BAFU rechnet in Weltzeit (UTC). Ein Schweizer Tag beginnt
// aber eine Stunde früher. «Etc/GMT-1» bedeutet «Schweizer Winterzeit».
// So landet jeder Messwert am richtigen Tag.

$dayZone = new DateTimeZone('Etc/GMT-1');
$utc = new DateTimeZone('UTC');

$startDate = $startDate ?? date('Y-m-d', strtotime('-7 days'));

$from = (new DateTimeImmutable($startDate, $dayZone))->setTimezone($utc);
$to = (new DateTimeImmutable('tomorrow', $dayZone))->setTimezone($utc);

// Ein kleines Protokoll: Wie oft haben wir gefragt, was hat nicht geklappt?
$audit = [
    'api_requests' => 0,
    'failed_windows' => 0,
];

// ---------------------------------------------------------------------------
// A5. Die Messstationen abholen
// ---------------------------------------------------------------------------
//
// Name, Fluss, Ort und Koordinaten kommen direkt vom BAFU. So haben wir
// nichts von Hand abgetippt.

// Der «Fragebogen» an das BAFU: Gib mir diese Angaben zu diesen Stationen.
$stationQuery = '
query Stations($nos: [String!]) {
  water { observations {
    stations(where: { no: { _in: $nos } }) {
      no name siteName riverName catchmentName
      latitude longitude elevation status coverageFrom
    }
  } }
}';

$data = fetchGraphql($endpoint, $stationQuery, ['nos' => $stationNos]);
$audit['api_requests']++;

$rawStations = $data['water']['observations']['stations'] ?? [];

// Ohne Stationen können wir nichts machen: abbrechen.
if (count($rawStations) === 0) {
    throw new RuntimeException('Die BAFU-API liefert keine unserer Stationen.');
}

// ---------------------------------------------------------------------------
// A6. Die Messwerte in Portionen abholen
// ---------------------------------------------------------------------------
//
// Pro Tag gibt es 12 Werte: 6 Stationen mal 2 Messgrössen. In eine Portion
// von 8000 Werten passen also 666 Tage. Für alle Daten seit 2020 braucht es
// darum vier Portionen. Beim täglichen Update reicht eine.

$rowsPerDay = count($stationNos) * count($parameterCodes);
$daysPerWindow = intdiv($maxRowsPerRequest, $rowsPerDay);

// Den Zeitraum in Portionen («Zeitfenster») aufteilen.
$windows = [];
for ($start = $from; $start < $to; $start = $end) {
    $end = min($to, $start->modify("+{$daysPerWindow} days"));
    $windows[] = [$start, $end];
}

// Der Fragebogen für die Messwerte.
// Wichtig: Wir setzen absichtlich keine Obergrenze («limit»). Mit Obergrenze
// schneidet das BAFU heimlich ab, ohne Obergrenze meldet es einen Fehler.
// Ein Fehler ist besser als fehlende Daten, die niemand bemerkt.
$observationQuery = '
query Observations($nos: [String!], $params: [String!], $from: AWSDateTime!, $to: AWSDateTime!) {
  water { observations {
    data_1day_mean(where: {
      station: { no: { _in: $nos } }
      parameterName: { _in: $params }
      timestamp: { _gte: $from, _lt: $to }
    }) {
      parameterName unitSymbol timestamp value releaseState
      station { no }
    }
  } }
}';

$rawObservations = [];

// Die Portionen der Reihe nach abarbeiten, wie eine Warteschlange.
while (count($windows) > 0) {
    [$windowFrom, $windowTo] = array_shift($windows); // die nächste Portion nehmen
    $audit['api_requests']++;

    try {
        $data = fetchGraphql($endpoint, $observationQuery, [
            'nos' => $stationNos,
            'params' => $parameterCodes,
            'from' => $windowFrom->format('Y-m-d\TH:i:s\Z'),
            'to' => $windowTo->format('Y-m-d\TH:i:s\Z'),
        ]);
        $rows = $data['water']['observations']['data_1day_mean'] ?? [];

        // Zur Sicherheit: Ist die Antwort randvoll, könnte etwas fehlen.
        if (count($rows) >= 10000) {
            throw new RuntimeException('Query returned more than 10000 rows');
        }
    } catch (RuntimeException $e) {
        $seconds = $windowTo->getTimestamp() - $windowFrom->getTimestamp();

        // Zu viele Werte auf einmal: Portion halbieren und beide Hälften
        // vorne in die Warteschlange stellen.
        if (str_contains($e->getMessage(), 'more than 10000') && $seconds > 86400) {
            $middle = $windowFrom->setTimestamp($windowFrom->getTimestamp() + intdiv($seconds, 2));
            array_unshift($windows, [$windowFrom, $middle], [$middle, $windowTo]);
            continue;
        }

        // Ein anderer Fehler: diese Portion auslassen und notieren.
        // Die übrigen holen wir trotzdem. Der nächste Lauf holt die Lücke nach.
        $audit['failed_windows']++;
        error_log('extract.php: ' . $e->getMessage());
        continue;
    }

    // Die Werte dieser Portion zur grossen Liste hinzufügen.
    foreach ($rows as $row) {
        $rawObservations[] = $row;
    }
}

// ===========================================================================
// TEIL B: Regen von MeteoSchweiz
// ===========================================================================

// ---------------------------------------------------------------------------
// B1. Einstellungen für MeteoSchweiz
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
// B2. Der Helfer fetchText(): eine Datei aus dem Internet holen
// ---------------------------------------------------------------------------
//
// Fast wie fetchJson() in Teil A, nur dass die Antwort hier kein JSON
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
// B3. Der Helfer readCsv(): eine Tabelle in eine PHP-Liste verwandeln
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
// B4. Ab wann holen wir Daten?
// ---------------------------------------------------------------------------
//
// Auch hier bestimmt load.php das Startdatum (für den Regen ein eigenes).
// Fehlt es, holen wir die letzten 7 Tage. Liegt es vor dem 1. Januar dieses
// Jahres, brauchen wir zusätzlich die grosse Datei mit den früheren Jahren.

$meteoStartDate = $meteoStartDate ?? date('Y-m-d', strtotime('-7 days'));
$needHistorical = $meteoStartDate < date('Y') . '-01-01';

// Ein kleines Protokoll: Wie oft haben wir gefragt, was hat nicht geklappt?
$meteoExtractAudit = [
    'api_requests' => 0,
    'failed_files' => 0,
];

// Was wir am Schluss weitergeben. Bleibt es leer, ist etwas schiefgegangen.
$rawWeatherStations = [];
$rawPrecipitation = [];
$meteoError = null; // die Fehlermeldung, falls MeteoSchweiz nicht erreichbar ist

// Alles Folgende steht in einem «try»: Geht dabei etwas schief, fangen wir
// den Fehler ab («catch»), notieren ihn und machen ohne Regen weiter.
try {
    // ---------------------------------------------------------------------------
    // B5. Die Wetterstationen abholen
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

    // Ohne Stationen können wir nichts machen: ohne Regen weiter (siehe «catch» unten).
    if (count($rawWeatherStations) === 0) {
        throw new RuntimeException('MeteoSchweiz liefert keine unserer Wetterstationen.');
    }

    // ---------------------------------------------------------------------------
    // B6. Die Tageswerte abholen, Station für Station
    // ---------------------------------------------------------------------------
    //
    // Die Dateien enthalten viele Spalten (Temperatur, Wind, Sonne …). Wir
    // behalten nur drei: Station, Tag und Regen. Und nur die Tage ab dem
    // Startdatum, denn die Werte ab 1864 brauchen wir nicht.
    //
    // Fällt eine Datei aus, holen wir die anderen trotzdem. Der nächste Import
    // holt die Lücke nach.

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
                error_log('extract.php (MeteoSchweiz): ' . $e->getMessage());
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
} catch (Throwable $e) {
    $meteoError = $e->getMessage();
    error_log('extract.php (MeteoSchweiz): ' . $meteoError);
}

// ---------------------------------------------------------------------------
// Alles an transform.php weitergeben
// ---------------------------------------------------------------------------
//
// Die Flussdaten stehen direkt in der Liste, der Regen unter «meteo».

return [
    'stations' => $rawStations,
    'observations' => $rawObservations,
    'station_order' => $stationNos,
    'audit' => $audit,
    'meteo' => [
        'stations' => $rawWeatherStations,
        'observations' => $rawPrecipitation,
        'station_map' => $weatherStations,
        'audit' => $meteoExtractAudit,
        'error' => $meteoError,
    ],
];
