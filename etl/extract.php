<?php
/**
 * Extract – die Messwerte beim Bund abholen.
 *
 * Das Bundesamt für Umwelt (BAFU) misst an vielen Flüssen, wie warm das
 * Wasser ist und wie hoch es steht. Diese Werte stellt es im Internet zur
 * Verfügung. Diese Datei fragt dort nach und holt die Werte für unsere sechs
 * Flüsse ab.
 *
 * Hier wird noch nichts geprüft oder verändert. Die Daten werden nur
 * abgeholt und so, wie sie ankommen, an transform.php weitergegeben.
 *
 * Ablauf:
 *
 *   1. Fragen: «Welche sechs Messstationen sind das?»
 *   2. Fragen: «Welche Tageswerte gibt es dort?»
 *   3. Alles als Liste an transform.php weitergeben
 *
 * Drei Besonderheiten der BAFU-Schnittstelle:
 *
 * - Man schickt keine einfache Web-Adresse, sondern einen kleinen
 *   Fragebogen (eine «GraphQL-Abfrage»).
 * - Pro Frage gibt es höchstens 10 000 Werte zurück. Deshalb fragen wir in
 *   mehreren Portionen.
 * - Man muss sich mit einem Namen vorstellen, sonst bekommt man keine Antwort.
 *
 * Gestartet wird diese Datei nicht direkt, sondern über transform.php.
 */

// ---------------------------------------------------------------------------
// 1. Einstellungen
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
// 2. Der Helfer fetchJson(): eine Frage ins Internet schicken
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
// 3. Fragen und es bei Bedarf nochmals versuchen
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
// 4. Ab wann holen wir Daten?
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
// 5. Die Messstationen abholen
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
// 6. Die Messwerte in Portionen abholen
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

// ---------------------------------------------------------------------------
// 7. Alles an transform.php weitergeben
// ---------------------------------------------------------------------------

return [
    'stations' => $rawStations,
    'observations' => $rawObservations,
    'station_order' => $stationNos,
    'audit' => $audit,
];
