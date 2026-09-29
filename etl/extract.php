<?php
/**
 * Extract – Messwerte von der BAFU-API holen.
 *
 * Holt Wasserstand und Wassertemperatur (Tagesmittel) unserer sechs
 * Messstationen und gibt die Rohdaten unverändert als PHP-Array weiter.
 * Hier wird nichts gerechnet, nichts umbenannt und nichts gefiltert – das ist
 * Aufgabe von transform.php.
 *
 * Datenfluss dieser Datei:
 *
 *   BAFU-API (GraphQL, POST)
 *     -> 1 Abfrage: Stammdaten der 6 Stationen
 *       -> 1 oder mehr Abfragen: Tagesmittel, aufgeteilt in Zeitfenster
 *         -> return: Rohdaten als PHP-Array
 *
 * Eigenheiten der BAFU-API (Details in docs/api-analyse.md):
 *
 * - Es ist eine GraphQL-API. Die Abfrage geht per POST als JSON an eine
 *   einzige Adresse, nicht als Parameter in der URL.
 * - Pro Abfrage kommen höchstens 10 000 Zeilen, und es gibt keine Seiten
 *   (keine Pagination). Deshalb teilen wir den Zeitraum in Fenster auf.
 * - Ohne User-Agent antwortet die API mit HTTP 403.
 *
 * Aufgerufen wird die Datei von transform.php, und zwar mit include. Den
 * Startzeitpunkt legt load.php in der Variablen $startDate fest.
 */

// ---------------------------------------------------------------------------
// 1. Einstellungen
// ---------------------------------------------------------------------------

$endpoint = 'https://data.bafu.admin.ch/api';

// Die sechs Messstationen der DataStory (offizielle BAFU-Nummern).
// Geprüft per API: in Betrieb, Wasserstand und Wassertemperatur lückenlos ab
// 2020. Die Reihenfolge ist auch die Reihenfolge in unload.php.
$stationNos = [
    '2243', // Limmat – Baden
    '2044', // Thur – Andelfingen
    '2091', // Rhein – Rheinfelden
    '2019', // Aare – Brienzwiler
    '2009', // Rhône – Porte du Scex
    '2068', // Ticino – Riazzino
];

// W = Wasserstand, WT = Wassertemperatur
$parameterCodes = ['W', 'WT'];

// Die API erlaubt 10 000 Zeilen pro Abfrage. Wir planen mit 8000, als Reserve.
$maxRowsPerRequest = 8000;

// ---------------------------------------------------------------------------
// 2. Der Helfer fetchJson()
// ---------------------------------------------------------------------------
//
// Derselbe Helfer wie in Code-Along 07, mit drei Erweiterungen für die
// BAFU-API:
//
// - $postData: GraphQL erwartet die Abfrage per POST als JSON.
// - CURLOPT_USERAGENT: ohne ihn blockt die BAFU-API mit HTTP 403.
// - Fehler werden geprüft. Statt still null zurückzugeben, bricht die Funktion
//   laut ab. Der Code der Exception ist der HTTP-Status (0 = kein Netz).

function fetchJson(string $url, ?array $postData = null): array {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 60); // grosse Zeitfenster brauchen länger als 10 s
    curl_setopt($ch, CURLOPT_USERAGENT, 'FHGR-IM3-DataStory/1.0 (Studienprojekt)');

    if ($postData !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($postData));
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    }

    $response = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($response === false) {
        throw new RuntimeException('Netzwerkfehler: ' . curl_error($ch), 0);
    }

    if ($status !== 200) {
        throw new RuntimeException("Die BAFU-API antwortet mit HTTP {$status}.", $status);
    }

    return json_decode($response, true, 512, JSON_THROW_ON_ERROR);
}

// ---------------------------------------------------------------------------
// 3. Eine GraphQL-Abfrage schicken
// ---------------------------------------------------------------------------
//
// Schickt die Abfrage mit fetchJson() und gibt den Teil «data» zurück.
//
// Ist die API kurz überlastet (kein Netz, 403, 429 oder 5xx), versuchen wir es
// bis zu dreimal und warten dazwischen 2, 4 und 8 Sekunden.
//
// GraphQL meldet manche Fehler mit Status 200 und einem Schlüssel «errors» im
// JSON. Auch die gelten als Fehler.

function fetchGraphql(string $url, string $query, array $variables): array {
    $attempt = 1;

    while (true) {
        try {
            $answer = fetchJson($url, ['query' => $query, 'variables' => $variables]);
            break;
        } catch (RuntimeException $e) {
            $status = $e->getCode();
            $retry = $status === 0 || $status === 403 || $status === 429 || $status >= 500;

            if (!$retry || $attempt > 3) {
                throw $e;
            }

            sleep(2 ** $attempt);
            $attempt++;
        }
    }

    if (!empty($answer['errors'])) {
        throw new RuntimeException('GraphQL-Fehler: ' . ($answer['errors'][0]['message'] ?? 'unbekannt'));
    }

    return $answer['data'] ?? [];
}

// ---------------------------------------------------------------------------
// 4. Zeitraum festlegen
// ---------------------------------------------------------------------------
//
// $startDate kommt aus load.php. Fehlt sie, holen wir die letzten 7 Tage.
//
// Ein Tagesmittel des BAFU beginnt um Mitternacht Schweizer Normalzeit (MEZ).
// Die API rechnet aber in UTC, eine Stunde früher. «Etc/GMT-1» ist die feste
// Zeitzone UTC+1 (das Minus ist in dieser Schreibweise kein Tippfehler).

$dayZone = new DateTimeZone('Etc/GMT-1');
$utc = new DateTimeZone('UTC');

$startDate = $startDate ?? date('Y-m-d', strtotime('-7 days'));

$from = (new DateTimeImmutable($startDate, $dayZone))->setTimezone($utc);
$to = (new DateTimeImmutable('tomorrow', $dayZone))->setTimezone($utc);

$audit = [
    'api_requests' => 0,
    'failed_windows' => 0,
];

// ---------------------------------------------------------------------------
// 5. Stammdaten der Stationen holen
// ---------------------------------------------------------------------------
//
// Name, Gewässer, Koordinaten und Status kommen direkt vom BAFU. So steht in
// unserer Datenbank nichts, das wir selbst abgetippt haben.

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

if (count($rawStations) === 0) {
    throw new RuntimeException('Die BAFU-API liefert keine unserer Stationen.');
}

// ---------------------------------------------------------------------------
// 6. Messwerte in Zeitfenstern holen
// ---------------------------------------------------------------------------
//
// Pro Tag kommen 6 Stationen × 2 Messgrössen = 12 Zeilen. Mit 8000 Zeilen pro
// Abfrage reicht ein Fenster also für 666 Tage. Von 2020 bis heute sind das
// vier Abfragen, beim täglichen Update genügt eine.

$rowsPerDay = count($stationNos) * count($parameterCodes);
$daysPerWindow = intdiv($maxRowsPerRequest, $rowsPerDay);

$windows = [];
for ($start = $from; $start < $to; $start = $end) {
    $end = min($to, $start->modify("+{$daysPerWindow} days"));
    $windows[] = [$start, $end];
}

// Wichtig: kein «limit» in der Abfrage. Mit limit schneidet die API bei 10 000
// Zeilen still ab, ohne limit lehnt sie eine zu grosse Abfrage ab. Ein Fehler
// ist besser als fehlende Daten, die niemand bemerkt.
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

// $windows ist eine Warteschlange: vorne eins wegnehmen, bei Bedarf halbiert
// wieder vorne einreihen.
while (count($windows) > 0) {
    [$windowFrom, $windowTo] = array_shift($windows);
    $audit['api_requests']++;

    try {
        $data = fetchGraphql($endpoint, $observationQuery, [
            'nos' => $stationNos,
            'params' => $parameterCodes,
            'from' => $windowFrom->format('Y-m-d\TH:i:s\Z'),
            'to' => $windowTo->format('Y-m-d\TH:i:s\Z'),
        ]);
        $rows = $data['water']['observations']['data_1day_mean'] ?? [];

        // Sicherheitsprüfung: Eine volle Antwort behandeln wir wie «zu gross».
        if (count($rows) >= 10000) {
            throw new RuntimeException('Query returned more than 10000 rows');
        }
    } catch (RuntimeException $e) {
        $seconds = $windowTo->getTimestamp() - $windowFrom->getTimestamp();

        // Zu viele Zeilen: Fenster halbieren und beide Hälften neu anfragen.
        if (str_contains($e->getMessage(), 'more than 10000') && $seconds > 86400) {
            $middle = $windowFrom->setTimestamp($windowFrom->getTimestamp() + intdiv($seconds, 2));
            array_unshift($windows, [$windowFrom, $middle], [$middle, $windowTo]);
            continue;
        }

        // Anderer Fehler: dieses Fenster zählen und überspringen. Die übrigen
        // Fenster laden wir trotzdem – load.php meldet den Lauf als «partial».
        $audit['failed_windows']++;
        error_log('extract.php: ' . $e->getMessage());
        continue;
    }

    // Die Zeilen des Fensters hinten an die Liste anhängen.
    foreach ($rows as $row) {
        $rawObservations[] = $row;
    }
}

// ---------------------------------------------------------------------------
// 7. Rohdaten zurückgeben
// ---------------------------------------------------------------------------
//
// return beendet diese Datei. transform.php bekommt das Array mit include.

return [
    'stations' => $rawStations,
    'observations' => $rawObservations,
    'station_order' => $stationNos,
    'audit' => $audit,
];
