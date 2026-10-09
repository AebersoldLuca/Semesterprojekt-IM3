<?php
/**
 * Transform – die Rohdaten prüfen und aufräumen.
 *
 * Was vom BAFU kommt, ist noch nicht ganz sauber: Es kann falsche Einheiten,
 * fehlende Werte oder Messfehler geben. Diese Datei prüft jeden einzelnen
 * Wert und bringt ihn in die Form, die unsere Datenbank braucht.
 *
 * Ein fertiger Messwert sieht zum Beispiel so aus:
 *
 *   ['station_no' => '2044', 'parameter_code' => 'WT',
 *    'measured_at' => '2026-09-20 23:00:00', 'obs_date' => '2026-09-21',
 *    'value' => 16.8, 'release_state' => 1]
 *
 * Unsere wichtigste Regel: Wir erfinden nichts. Ein Wert, der nicht stimmen
 * kann, wird weggelassen und gezählt. Auf der Website fehlt er dann einfach.
 * Wir raten nie, was dort hätte stehen können.
 */

// Zuerst die Rohdaten von extract.php holen.
$rawData = include __DIR__ . '/extract.php';

// ---------------------------------------------------------------------------
// 1. Unsere Prüfregeln
// ---------------------------------------------------------------------------
//
// Für jede Messgrösse: In welcher Einheit muss der Wert kommen, und welcher
// Bereich ist überhaupt möglich?
// - Wasserstand in Metern über Meer: zwischen 150 und 2500 m.
//   (Der tiefste Punkt der Schweiz liegt auf 193 m.)
// - Wassertemperatur in Grad: zwischen −0,5 und 35 °C.

$parameterRules = [
    'W' => ['unit' => 'm ü.M.', 'min' => 150.0, 'max' => 2500.0],
    'WT' => ['unit' => '°C', 'min' => -0.5, 'max' => 35.0],
];

// Schweizer Zeit und Weltzeit, wie in extract.php.
$dayZone = new DateTimeZone('Etc/GMT-1');
$utc = new DateTimeZone('UTC');

// Eine Strichliste: Wie viele Werte sind aus welchem Grund weggefallen?
$audit = [
    'input_rows' => 0,         // so viele Werte kamen an
    'unknown_station' => 0,    // fremde Station
    'unknown_parameter' => 0,  // fremde Messgrösse
    'wrong_unit' => 0,         // falsche Einheit
    'invalid_timestamp' => 0,  // Datum nicht lesbar
    'missing_value' => 0,      // kein Wert
    'not_numeric' => 0,        // keine Zahl
    'implausible_value' => 0,  // Wert unmöglich hoch oder tief
    'sensor_zero' => 0,        // vermutlich ein defekter Sensor
    'duplicate' => 0,          // doppelt geliefert
    'output_rows' => 0,        // so viele Werte sind gut
];

// ---------------------------------------------------------------------------
// 2. Die Messstationen aufräumen
// ---------------------------------------------------------------------------
//
// Das BAFU nennt die Felder etwas anders als wir (zum Beispiel «riverName»
// statt «river_name»). Hier werden sie umbenannt. Ein leeres Feld wird zu
// «unbekannt» (null), nicht zu einem leeren Text.

$stations = [];

foreach ($rawData['stations'] as $raw) {
    $stationNo = trim((string) ($raw['no'] ?? ''));

    // An welcher Stelle steht die Station in unserer Liste? (für die Reihenfolge)
    $position = array_search($stationNo, $rawData['station_order'], true);

    if ($position === false) {
        continue; // nicht eine unserer sechs Stationen
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
// 3. Jeden Messwert prüfen
// ---------------------------------------------------------------------------
//
// Jede Prüfung läuft gleich ab: Stimmt etwas nicht, machen wir einen Strich
// in der Strichliste und gehen zum nächsten Wert («continue»).
// So verschwindet kein Wert, ohne dass wir es wissen.

$observations = [];

foreach ($rawData['observations'] as $raw) {
    $audit['input_rows']++;

    // Gehört der Wert zu einer unserer sechs Stationen?
    $stationNo = (string) ($raw['station']['no'] ?? '');

    if (!isset($stations[$stationNo])) {
        $audit['unknown_station']++;
        continue;
    }

    // Ist es Wasserstand oder Wassertemperatur?
    $parameter = (string) ($raw['parameterName'] ?? '');

    if (!isset($parameterRules[$parameter])) {
        $audit['unknown_parameter']++;
        continue;
    }

    $rule = $parameterRules[$parameter];

    // Stimmt die Einheit? Sonst würden wir Äpfel mit Birnen vergleichen.
    if (($raw['unitSymbol'] ?? null) !== $rule['unit']) {
        $audit['wrong_unit']++;
        continue;
    }

    // Ist das Datum lesbar? Es muss genau so aussehen: 2026-09-20T23:00:00Z
    $timestamp = DateTimeImmutable::createFromFormat('Y-m-d\TH:i:s\Z', (string) ($raw['timestamp'] ?? ''), $utc);

    if ($timestamp === false) {
        $audit['invalid_timestamp']++;
        continue;
    }

    // Welcher Tag ist das in der Schweiz?
    // 20. September 23:00 Weltzeit ist in der Schweiz schon der 21. September.
    $obsDate = $timestamp->setTimezone($dayZone)->format('Y-m-d');

    // Gibt es einen Wert, und ist es eine Zahl?
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

    // Ist der Wert überhaupt möglich? (siehe Prüfregeln oben)
    if ($value < $rule['min'] || $value > $rule['max']) {
        $audit['implausible_value']++;
        continue;
    }

    // Hat das BAFU den Wert schon kontrolliert?
    // 1 = noch nicht geprüft, 2 = geprüft, 3 = endgültig. Sonst: unbekannt.
    $releaseState = $raw['releaseState'] ?? null;
    $releaseState = in_array((string) $releaseState, ['1', '2', '3'], true) ? (int) $releaseState : null;

    // Defekter Sensor: Bei der Aare in Brienzwiler stand im März 2026 an drei
    // Tagen genau 0.00 °C – davor 5.0 °C, danach 2.6 °C. Ein ganzer Tag mit
    // exakt 0 Grad ist unrealistisch. Solche ungeprüften Nullen lassen wir weg.
    // Hat das BAFU den Wert schon geprüft, behalten wir ihn.
    if ($parameter === 'WT' && $value == 0.0 && ($releaseState === null || $releaseState === 1)) {
        $audit['sensor_zero']++;
        continue;
    }

    // Doppelt geliefert? Jede Station, Messgrösse und Zeit darf es nur einmal geben.
    $measuredAt = $timestamp->format('Y-m-d H:i:s');
    $key = $stationNo . '|' . $parameter . '|' . $measuredAt;

    if (isset($observations[$key])) {
        $audit['duplicate']++;
        continue;
    }

    // Alle Prüfungen bestanden: Der Wert kommt auf die saubere Liste.
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
// 4. Das Ergebnis an load.php weitergeben
// ---------------------------------------------------------------------------
//
// In die Datenbank kommen nur die Stationen und die Messwerte («data»).
// Der Rest ist zum Nachlesen: unsere Frage, die Regeln und die Strichliste.

return [
    'question' => '2026 waren die Flüsse im Mittelland bisher wärmer und führten weniger Wasser als im Hitzesommer 2022.',
    'rules' => $parameterRules,
    'stations' => $stations,
    'data' => array_values($observations),
    'audit' => $audit,
    'extract_audit' => $rawData['audit'],
];
