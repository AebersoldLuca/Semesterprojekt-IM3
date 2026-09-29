<?php
/**
 * Transform – Rohdaten prüfen und in die Form unserer Tabellen bringen.
 *
 * Holt die Rohdaten aus extract.php und liefert zwei saubere Listen: eine
 * Zeile pro Station und eine Zeile pro Messwert.
 *
 *   ['station_no' => '2044', 'parameter_code' => 'WT',
 *    'measured_at' => '2026-09-20 23:00:00', 'obs_date' => '2026-09-21',
 *    'value' => 16.8, 'release_state' => 1]
 *
 * Grundsatz: Es werden keine Werte erfunden, geschätzt oder aufgefüllt. Ein
 * ungültiger Wert wird verworfen und im Audit gezählt. In der Grafik erscheint
 * er als Lücke.
 *
 * Transform braucht keine Datenbank. Geschrieben wird erst in load.php.
 */

$rawData = include __DIR__ . '/extract.php';

// ---------------------------------------------------------------------------
// 1. Regeln
// ---------------------------------------------------------------------------
//
// Pro Messgrösse: die Einheit, die die API liefern muss, und der Bereich, in
// dem ein Wert plausibel ist. Der tiefste Punkt der Schweiz liegt auf 193 m,
// kein BAFU-Pegel liegt über 2500 m ü.M.

$parameterRules = [
    'W' => ['unit' => 'm ü.M.', 'min' => 150.0, 'max' => 2500.0],
    'WT' => ['unit' => '°C', 'min' => -0.5, 'max' => 35.0],
];

// Die Zeitzone für den Kalendertag, gleich wie in extract.php.
$dayZone = new DateTimeZone('Etc/GMT-1');
$utc = new DateTimeZone('UTC');

$audit = [
    'input_rows' => 0,
    'unknown_station' => 0,
    'unknown_parameter' => 0,
    'wrong_unit' => 0,
    'invalid_timestamp' => 0,
    'missing_value' => 0,
    'not_numeric' => 0,
    'implausible_value' => 0,
    'sensor_zero' => 0,
    'duplicate' => 0,
    'output_rows' => 0,
];

// ---------------------------------------------------------------------------
// 2. Stationen
// ---------------------------------------------------------------------------
//
// Die Felder der API heissen anders als unsere Spalten (riverName wird zu
// river_name). Leere Texte werden zu null: «wir wissen es nicht» statt ''.
// sort_order ist die Position in der Liste aus extract.php.

$stations = [];

foreach ($rawData['stations'] as $raw) {
    $stationNo = trim((string) ($raw['no'] ?? ''));
    $position = array_search($stationNo, $rawData['station_order'], true);

    if ($position === false) {
        continue;
    }

    $stations[$stationNo] = [
        'station_no' => $stationNo,
        'name' => trim((string) $raw['name']),
        'river_name' => trim((string) $raw['riverName']),
        'site_name' => trim((string) ($raw['siteName'] ?? '')) ?: null,
        'catchment_name' => trim((string) ($raw['catchmentName'] ?? '')) ?: null,
        'latitude' => is_numeric($raw['latitude'] ?? null) ? round((float) $raw['latitude'], 7) : null,
        'longitude' => is_numeric($raw['longitude'] ?? null) ? round((float) $raw['longitude'], 7) : null,
        'elevation' => is_numeric($raw['elevation'] ?? null) ? (float) $raw['elevation'] : null,
        'status' => trim((string) ($raw['status'] ?? '')) ?: null,
        'coverage_from' => !empty($raw['coverageFrom']) ? substr($raw['coverageFrom'], 0, 10) : null,
        'sort_order' => $position + 1,
    ];
}

// ---------------------------------------------------------------------------
// 3. Messwerte
// ---------------------------------------------------------------------------
//
// Jede Prüfung folgt demselben Muster: erst zählen, dann überspringen.
// Kein Wert verschwindet ohne Zähler.

$observations = [];

foreach ($rawData['observations'] as $raw) {
    $audit['input_rows']++;

    // Station: nur unsere sechs.
    $stationNo = (string) ($raw['station']['no'] ?? '');

    if (!isset($stations[$stationNo])) {
        $audit['unknown_station']++;
        continue;
    }

    // Messgrösse: nur W und WT.
    $parameter = (string) ($raw['parameterName'] ?? '');

    if (!isset($parameterRules[$parameter])) {
        $audit['unknown_parameter']++;
        continue;
    }

    $rule = $parameterRules[$parameter];

    // Einheit: Passt sie nicht, wären die Werte nicht vergleichbar.
    if (($raw['unitSymbol'] ?? null) !== $rule['unit']) {
        $audit['wrong_unit']++;
        continue;
    }

    // Zeitstempel: streng im Format der API, z.B. 2026-09-20T23:00:00Z.
    $timestamp = DateTimeImmutable::createFromFormat('Y-m-d\TH:i:s\Z', (string) ($raw['timestamp'] ?? ''), $utc);

    if ($timestamp === false) {
        $audit['invalid_timestamp']++;
        continue;
    }

    // Der Kalendertag in Schweizer Zeit: 2026-09-20 23:00 UTC -> 2026-09-21.
    $obsDate = $timestamp->setTimezone($dayZone)->format('Y-m-d');

    // Messwert: vorhanden, eine Zahl und im plausiblen Bereich?
    $value = $raw['value'] ?? null;

    if ($value === null) {
        $audit['missing_value']++;
        continue;
    }

    if (!is_numeric($value)) {
        $audit['not_numeric']++;
        continue;
    }

    $value = (float) $value;

    if ($value < $rule['min'] || $value > $rule['max']) {
        $audit['implausible_value']++;
        continue;
    }

    // Freigabestatus: 1 provisorisch, 2 validiert, 3 definitiv, sonst null.
    $releaseState = $raw['releaseState'] ?? null;
    $releaseState = in_array((string) $releaseState, ['1', '2', '3'], true) ? (int) $releaseState : null;

    // Sensorausfall: Ein Tagesmittel von genau 0.00 °C, das noch niemand
    // geprüft hat, kommt z.B. bei Brienzwiler im März 2026 an drei Tagen in
    // Folge vor – zwischen 5.0 °C und 2.6 °C. Für einen ganzen Tag ist das
    // unplausibel. Validierte Werte (Status 2 oder 3) behalten wir immer.
    if ($parameter === 'WT' && $value == 0.0 && ($releaseState === null || $releaseState === 1)) {
        $audit['sensor_zero']++;
        continue;
    }

    // Duplikate: derselbe Schlüssel wie die UNIQUE-Regel in der Datenbank.
    $measuredAt = $timestamp->format('Y-m-d H:i:s');
    $key = $stationNo . '|' . $parameter . '|' . $measuredAt;

    if (isset($observations[$key])) {
        $audit['duplicate']++;
        continue;
    }

    $observations[$key] = [
        'station_no' => $stationNo,
        'parameter_code' => $parameter,
        'measured_at' => $measuredAt,
        'obs_date' => $obsDate,
        'value' => round($value, 3),
        'release_state' => $releaseState,
    ];
}

$audit['output_rows'] = count($observations);

// ---------------------------------------------------------------------------
// 4. Ergebnis zurückgeben
// ---------------------------------------------------------------------------
//
// In die Datenbank kommen stations und data. question, rules und audit sind
// Begleitpapiere: Sie sagen, wie die Zahlen entstanden sind.

return [
    'question' => '2026 waren die Flüsse im Mittelland bisher wärmer und führten weniger Wasser als im Hitzesommer 2022.',
    'rules' => $parameterRules,
    'stations' => $stations,
    'data' => array_values($observations),
    'audit' => $audit,
    'extract_audit' => $rawData['audit'],
];
