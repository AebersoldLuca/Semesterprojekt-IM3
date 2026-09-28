<?php
/**
 * ============================================================
 *  1) E X T R A C T   –   BAFU GraphQL-API  →  PHP-Array
 * ============================================================
 *
 * Holt die Rohdaten von https://data.bafu.admin.ch/api (POST, JSON, ohne Auth)
 * und gibt sie UNVERÄNDERT als PHP-Array an transform.php weiter.
 * Es werden keine Dateien geschrieben: Die Datenmengen sind klein genug
 * (max. ~8000 Zeilen pro Request), um sie direkt im Speicher zu übergeben.
 * Dauerhaft gespeichert wird ausschliesslich in MySQL (load.php).
 *
 * Wichtige API-Eigenheiten (siehe docs/api-analyse.md):
 *  - max. 10 000 Zeilen pro Abfrage; grössere Abfragen werden ABGELEHNT
 *    (nicht gekürzt) → der Zeitraum wird in Fenster aufgeteilt.
 *  - keine Offset/Cursor-Pagination, Reihenfolge der Zeilen undefiniert.
 *  - Ratenlimit 500 Requests / 5 Min. pro IP, Überschreitung → HTTP 403.
 *
 * Normalerweise wird diese Datei von load.php eingebunden. Zum Testen lässt
 * sie sich auch alleine starten (schreibt NICHTS in die Datenbank):
 *   php etl/extract.php                 letzte 7 Tage abrufen und zusammenfassen
 *   php etl/extract.php --candidates    welche aktiven Stationen liefern W und WT?
 */

require_once __DIR__ . '/../db.php';

const BAFU_ENDPOINT        = 'https://data.bafu.admin.ch/api';
const BAFU_AGGREGATION     = 'data_1day_mean';   // Tagesmittel
const BAFU_PARAMETERS      = ['W', 'WT'];         // Wasserstand, Wassertemperatur
const BAFU_TIMEOUT         = 60;                  // Sekunden pro Request
const BAFU_RETRIES         = 3;                   // bei 403/429/5xx/Netzwerkfehler
const BAFU_MAX_ROWS        = 8000;                // Reserve unter dem API-Limit von 10 000

/**
 * Ausgewählte Messstationen (BAFU-Stationsnummern) für die DataStory.
 *
 * Alle Nummern wurden per API geprüft: Status «Aufgebaut», Wasserstand (W)
 * und Wassertemperatur (WT) als Tagesmittel lückenlos ab 2020 (siehe
 * docs/api-analyse.md, reproduzierbar mit «php etl/extract.php --candidates»).
 *
 * Name, Gewässer, Koordinaten usw. kommen NICHT von hier, sondern aus der API.
 * display_name und story_role sind redaktionelle Texte für die Website.
 * Die Reihenfolge bestimmt die Farbe der Station im Chart.
 */
const STATIONS = [
    '2019' => [
        'display_name' => 'Aare – Brienzwiler',
        'story_role'   => 'Die junge Aare im Berner Oberland, noch vor dem Brienzersee. Gespeist von Gletschern und Schneeschmelze.',
    ],
    '2243' => [
        'display_name' => 'Limmat – Baden',
        'story_role'   => 'Abfluss des Zürichsees: Das Wasser war zuvor im See, dessen Oberfläche sich im Sommer stark erwärmt.',
    ],
    '2009' => [
        'display_name' => 'Rhône – Porte du Scex',
        'story_role'   => 'Die Rhône kurz vor dem Genfersee, mit dem Wasser aus den Walliser Alpen.',
    ],
    '2044' => [
        'display_name' => 'Thur – Andelfingen',
        'story_role'   => 'Fluss aus der Ostschweiz ohne grossen See und ohne grosse Gletscher im Einzugsgebiet.',
    ],
    '2068' => [
        'display_name' => 'Ticino – Riazzino',
        'story_role'   => 'Alpensüdseite: der Ticino kurz vor dem Lago Maggiore.',
    ],
    '2091' => [
        'display_name' => 'Rhein – Rheinfelden',
        'story_role'   => 'Der Rhein unterhalb der Aaremündung. Hier fliesst das Wasser eines grossen Teils der Nordschweiz vorbei.',
    ],
];

/** Stationsauswahl mit Reihenfolge (sort_order = Farbe im Chart). */
function selected_stations(): array
{
    $stations = [];
    $i = 0;
    foreach (STATIONS as $no => $s) {
        $stations[(string) $no] = $s + ['sort_order' => ++$i];
    }
    return $stations;
}

/** Exception für alle Fehler beim Abruf der BAFU-API. */
class BafuApiException extends RuntimeException
{
}

/**
 * Sendet eine GraphQL-Abfrage an die BAFU-API und gibt das «data»-Objekt zurück.
 * Wiederholt bei Netzwerkfehlern und HTTP 403/429/5xx mit wachsender Wartezeit.
 */
function bafu_graphql(string $query, array $variables = []): array
{
    $payload   = json_encode(['query' => $query, 'variables' => (object) $variables]);
    $lastError = '';

    for ($attempt = 1; $attempt <= BAFU_RETRIES + 1; $attempt++) {
        $ch = curl_init(BAFU_ENDPOINT);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Accept: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => BAFU_TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_USERAGENT      => 'FHGR-IM3-DataStory/1.0 (Studienprojekt)',
        ]);
        $body      = curl_exec($ch);
        $status    = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);

        if ($body === false) {
            $lastError = "Netzwerkfehler: $curlError";
        } elseif ($status === 403 || $status === 429 || $status >= 500) {
            $lastError = "HTTP $status von der BAFU-API";
        } elseif ($status !== 200) {
            throw new BafuApiException("HTTP $status von der BAFU-API");
        } else {
            $json = json_decode($body, true);
            if (!is_array($json)) {
                throw new BafuApiException('Antwort der BAFU-API ist kein gültiges JSON');
            }
            if (!empty($json['errors'])) {
                // GraphQL-Fehler, z.B. «Query returned more than 10000 rows»
                $messages = array_map(fn($e) => $e['message'] ?? 'unbekannt', $json['errors']);
                throw new BafuApiException('GraphQL-Fehler: ' . implode(' | ', $messages));
            }
            return $json['data'] ?? [];
        }

        // Wiederholbarer Fehler: kurz warten (2, 4, 8 s), dann nochmals
        if ($attempt <= BAFU_RETRIES) {
            $wait = 2 ** $attempt;
            log_message('warning', "$lastError – neuer Versuch in {$wait}s", 'etl');
            sleep($wait);
        }
    }

    throw new BafuApiException($lastError);
}

/**
 * Stammdaten der gewünschten Stationen abrufen.
 * @param string[] $stationNos BAFU-Stationsnummern
 */
function extract_stations(array $stationNos): array
{
    $query = <<<'GQL'
    query Stations($nos: [String!]) {
      water { observations {
        stations(where: { no: { _in: $nos } }, limit: 1000) {
          no name siteName riverName catchmentName
          latitude longitude elevation status coverageFrom coverageTo
        }
      } }
    }
    GQL;

    $data = bafu_graphql($query, ['nos' => array_values($stationNos)]);
    return $data['water']['observations']['stations'] ?? [];
}

/**
 * Tagesmittel für ALLE Stationen und Parameter in EINEM Zeitfenster abrufen.
 * @param DateTimeImmutable $from inklusive (UTC)
 * @param DateTimeImmutable $to   exklusive (UTC)
 */
function extract_observations(array $stationNos, DateTimeImmutable $from, DateTimeImmutable $to): array
{
    $aggregation = BAFU_AGGREGATION; // Feldname kann in GraphQL keine Variable sein
    $query = <<<GQL
    query Observations(\$nos: [String!], \$params: [String!], \$from: AWSDateTime!, \$to: AWSDateTime!) {
      water { observations {
        $aggregation(
          where: {
            station: { no: { _in: \$nos } }
            parameterName: { _in: \$params }
            timestamp: { _gte: \$from, _lt: \$to }
          }
          limit: 10000
        ) {
          parameterName unitSymbol timestamp value releaseState
          station { no }
        }
      } }
    }
    GQL;

    $data = bafu_graphql($query, [
        'nos'    => array_values($stationNos),
        'params' => BAFU_PARAMETERS,
        'from'   => $from->format('Y-m-d\TH:i:s\Z'),
        'to'     => $to->format('Y-m-d\TH:i:s\Z'),
    ]);
    return $data['water']['observations'][$aggregation] ?? [];
}

/**
 * Teilt [from, to) in Zeitfenster auf, die sicher unter dem Zeilenlimit bleiben.
 * Beispiel: 6 Stationen × 2 Parameter = 12 Zeilen pro Tag
 *           → 8000 / 12 = 666 Tage pro Fenster → 2020 bis heute = 4 Requests.
 */
function plan_windows(DateTimeImmutable $from, DateTimeImmutable $to, int $rowsPerDay): array
{
    $days    = max(1, intdiv(BAFU_MAX_ROWS, max(1, $rowsPerDay)));
    $windows = [];
    for ($start = $from; $start < $to; $start = $end) {
        $end = min($to, $start->modify("+$days days"));
        $windows[] = [$start, $end];
    }
    return $windows;
}

/**
 * Kompletter Extract-Schritt: Stationen + Messwerte abrufen.
 *
 * @param array $selection station_no → Angaben aus STATIONS
 * @return array{stations: array, rows: array, api_requests: int, failed_windows: int, missing_stations: string[]}
 *         stations = Rohdaten aus «stations», rows = Rohdaten aus «data_1day_mean»
 */
function run_extract(array $selection, DateTimeImmutable $from, DateTimeImmutable $to, callable $say): array
{
    $result = ['stations' => [], 'rows' => [], 'api_requests' => 0, 'failed_windows' => 0, 'missing_stations' => []];
    $stationNos = array_map('strval', array_keys($selection));

    // --- Stationen ---------------------------------------------------------
    foreach (extract_stations($stationNos) as $s) {
        $result['stations'][(string) $s['no']] = $s;
    }
    $result['api_requests']++;
    $result['missing_stations'] = array_values(array_diff($stationNos, array_keys($result['stations'])));
    $stationNos = array_values(array_intersect($stationNos, array_map('strval', array_keys($result['stations']))));
    if (!$stationNos) {
        throw new BafuApiException('Keine der ausgewählten Stationen wurde von der API geliefert.');
    }

    // --- Messwerte in Zeitfenstern -----------------------------------------
    $windows = plan_windows($from, $to, count($stationNos) * count(BAFU_PARAMETERS));
    $say('   ' . count($windows) . ' Zeitfenster geplant');

    // Warteschlange: Lehnt die API ein Fenster wegen > 10 000 Zeilen ab,
    // wird es halbiert und erneut versucht.
    while ($windows) {
        [$wFrom, $wTo] = array_shift($windows);
        $label = $wFrom->format('Y-m-d H:i') . ' → ' . $wTo->format('Y-m-d H:i') . ' UTC';
        $result['api_requests']++;
        try {
            $rows = extract_observations($stationNos, $wFrom, $wTo);
        } catch (BafuApiException $e) {
            $span = $wTo->getTimestamp() - $wFrom->getTimestamp();
            if (str_contains($e->getMessage(), 'more than 10000') && $span > 86400) {
                $mid = $wFrom->setTimestamp($wFrom->getTimestamp() + intdiv($span, 2));
                array_unshift($windows, [$wFrom, $mid], [$mid, $wTo]);
                $say("   $label: zu viele Zeilen – Fenster wird halbiert");
                continue;
            }
            // Anderer Fehler: dieses Fenster überspringen, die übrigen trotzdem laden
            $result['failed_windows']++;
            log_message('error', "Extract $label: " . $e->getMessage(), 'etl');
            $say("   FEHLER $label: " . $e->getMessage());
            continue;
        }
        array_push($result['rows'], ...$rows);
        $say(sprintf('   %s: %d Zeilen', $label, count($rows)));
    }

    return $result;
}

/**
 * Stationsauswahl nachvollziehbar machen: Welche aktiven Stationen liefern
 * gestern sowohl Wasserstand als auch Wassertemperatur? (Ausgabe in der Konsole)
 */
function extract_candidates(callable $say): void
{
    $day = (new DateTimeImmutable('yesterday', new DateTimeZone('Etc/GMT-1')))->setTimezone(new DateTimeZone('UTC'));
    $query = <<<'GQL'
    query Candidates($ts: AWSDateTime!) {
      water { observations {
        data_1day_mean(where: { timestamp: { _eq: $ts }, parameterName: { _in: ["W", "WT"] } }, limit: 10000) {
          parameterName value station { no }
        }
        stations(where: { status: { _eq: "Aufgebaut" } }, limit: 10000) {
          no name riverName catchmentName coverageFrom
        }
      } }
    }
    GQL;
    $data = bafu_graphql($query, ['ts' => $day->format('Y-m-d\TH:i:s\Z')])['water']['observations'];

    $params = [];
    foreach ($data['data_1day_mean'] as $r) {
        if ($r['value'] !== null) {
            $params[$r['station']['no']][$r['parameterName']] = true;
        }
    }
    $candidates = [];
    foreach ($data['stations'] as $s) {
        if (isset($params[$s['no']]['W'], $params[$s['no']]['WT'])) {
            $candidates[] = [
                'station_no' => $s['no'], 'river' => $s['riverName'], 'name' => $s['name'],
                'catchment' => $s['catchmentName'], 'coverage_from' => substr((string) $s['coverageFrom'], 0, 10),
            ];
        }
    }
    usort($candidates, fn($x, $y) => [$x['catchment'], $x['river']] <=> [$y['catchment'], $y['river']]);

    $say(sprintf('%d aktive Stationen mit Tagesmittel für W und WT am %s:', count($candidates),
        $day->setTimezone(new DateTimeZone('Etc/GMT-1'))->format('Y-m-d')));
    foreach ($candidates as $c) {
        $mark = isset(STATIONS[$c['station_no']]) ? '*' : ' ';
        $say(sprintf(' %s %s  %-28s %-32s %-14s seit %s', $mark, $c['station_no'], $c['river'],
            $c['name'], $c['catchment'], $c['coverage_from']));
    }
    $say('(* = in dieser DataStory verwendet)');
}

// ------------------------------------------------------------------
// Direkter Aufruf über die Kommandozeile (zum Testen des Extract-Schritts)
// ------------------------------------------------------------------
if (PHP_SAPI === 'cli' && realpath($_SERVER['argv'][0] ?? '') === __FILE__) {
    $say = fn(string $l) => print($l . PHP_EOL);
    try {
        if (in_array('--candidates', $_SERVER['argv'], true)) {
            extract_candidates($say);
            exit(0);
        }
        $zone = new DateTimeZone('Etc/GMT-1');
        $utc  = new DateTimeZone('UTC');
        $from = new DateTimeImmutable('-7 days midnight', $zone);
        $to   = new DateTimeImmutable('tomorrow', $zone);
        $r = run_extract(selected_stations(), $from->setTimezone($utc), $to->setTimezone($utc), $say);
        $say(sprintf('%d Stationen, %d Rohzeilen in %d Requests. Beispielzeile:',
            count($r['stations']), count($r['rows']), $r['api_requests']));
        $say(json_encode($r['rows'][0] ?? null, JSON_UNESCAPED_UNICODE));
    } catch (Throwable $e) {
        $say('FEHLER: ' . $e->getMessage());
        exit(2);
    }
}
