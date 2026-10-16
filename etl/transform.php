<?php
/**
 * Transform – die Rohdaten beider Quellen prüfen und aufräumen.
 *
 * Was vom BAFU und von MeteoSchweiz kommt, ist noch nicht ganz sauber: Es kann
 * falsche Einheiten, fehlende Werte oder Messfehler geben. Diese Datei prüft
 * jeden einzelnen Wert und bringt ihn in die Form, die unsere Datenbank braucht.
 *
 *   Teil A  Wassertemperatur und Wasserstand (BAFU), zum Beispiel:
 *           ['station_no' => '2044', 'parameter_code' => 'WT',
 *            'measured_at' => '2026-09-20 23:00:00', 'obs_date' => '2026-09-21',
 *            'value' => 16.8, 'release_state' => 1]
 *
 *   Teil B  Regen (MeteoSchweiz), zum Beispiel:
 *           ['station_abbr' => 'STG', 'obs_date' => '2026-09-21', 'precipitation_mm' => 12.4]
 *
 * Unsere wichtigste Regel: Wir erfinden nichts. Ein Wert, der nicht stimmen
 * kann, wird weggelassen und gezählt. Auf der Website fehlt er dann einfach.
 * Wir raten nie, was dort hätte stehen können. Ein Tag ohne Regenmessung
 * bleibt deshalb leer: «nicht gemessen» ist etwas anderes als «0 mm».
 */

// Zuerst die Rohdaten beider Quellen von extract.php holen.
$rawData = include __DIR__ . '/extract.php';

// ===========================================================================
// TEIL A: Wassertemperatur und Wasserstand vom BAFU
// ===========================================================================

// ---------------------------------------------------------------------------
// A1. Unsere Prüfregeln
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
// A2. Die Messstationen aufräumen
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
// A3. Jeden Messwert prüfen
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

// ===========================================================================
// TEIL B: Regen von MeteoSchweiz
// ===========================================================================

// Die Rohdaten des Regens. War MeteoSchweiz nicht erreichbar, sind die
// Listen leer, und hier passiert einfach nichts.
$rawMeteo = $rawData['meteo'];

// ---------------------------------------------------------------------------
// B1. Unsere Prüfregel
// ---------------------------------------------------------------------------
//
// Regen pro Tag: zwischen 0 und 500 mm. Der Schweizer Rekord liegt bei
// etwas über 400 mm an einem Tag. Alles darüber muss ein Messfehler sein.

$precipitationRule = ['unit' => 'mm', 'min' => 0.0, 'max' => 500.0];

// Eine Strichliste: Wie viele Werte sind aus welchem Grund weggefallen?
$meteoAudit = [
    'input_rows' => 0,         // so viele Werte kamen an
    'unknown_station' => 0,    // fremde Station
    'invalid_timestamp' => 0,  // Datum nicht lesbar
    'missing_value' => 0,      // kein Wert (an diesem Tag nicht gemessen)
    'not_numeric' => 0,        // keine Zahl
    'implausible_value' => 0,  // unmöglich viel oder weniger als 0
    'duplicate' => 0,          // doppelt geliefert
    'output_rows' => 0,        // so viele Werte sind gut
];

// ---------------------------------------------------------------------------
// B2. Die Wetterstationen aufräumen
// ---------------------------------------------------------------------------
//
// Wir übernehmen Name, Koordinaten und Höhe und notieren, zu welchem Fluss
// die Station gehört. Aus «Zürich / Fluntern» wird dabei nichts gekürzt.

$riverByAbbr = array_flip($rawMeteo['station_map']); // 'STG' → '2044'
$cleanStations = [];

foreach ($rawMeteo['stations'] as $raw) {
    $abbr = trim((string) ($raw['station_abbr'] ?? ''));

    if (!isset($riverByAbbr[$abbr])) {
        continue; // nicht eine unserer sechs Stationen
    }

    $cleanStations[$abbr] = [
        'abbr' => $abbr,
        'name' => trim((string) ($raw['station_name'] ?? $abbr)),
        'river_station_no' => (string) $riverByAbbr[$abbr],
        'latitude' => is_numeric($raw['station_coordinates_wgs84_lat'] ?? null) ? round((float) $raw['station_coordinates_wgs84_lat'], 7) : null,
        'longitude' => is_numeric($raw['station_coordinates_wgs84_lon'] ?? null) ? round((float) $raw['station_coordinates_wgs84_lon'], 7) : null,
        'elevation' => is_numeric($raw['station_height_masl'] ?? null) ? (float) $raw['station_height_masl'] : null,
    ];
}

// ---------------------------------------------------------------------------
// B3. Jeden Regenwert prüfen
// ---------------------------------------------------------------------------
//
// Wie in Teil A: Stimmt etwas nicht, machen wir einen Strich in der
// Strichliste und gehen zum nächsten Wert («continue»).

$precipitation = [];

foreach ($rawMeteo['observations'] as $raw) {
    $meteoAudit['input_rows']++;

    // Gehört der Wert zu einer unserer sechs Wetterstationen?
    $abbr = (string) ($raw['station_abbr'] ?? '');

    if (!isset($cleanStations[$abbr])) {
        $meteoAudit['unknown_station']++;
        continue;
    }

    // Ist das Datum lesbar? Es muss genau so aussehen: 21.09.2026 00:00
    $date = DateTimeImmutable::createFromFormat('!d.m.Y H:i', (string) ($raw['reference_timestamp'] ?? ''));

    if ($date === false) {
        $meteoAudit['invalid_timestamp']++;
        continue;
    }

    // Gibt es einen Wert? Ein leeres Feld heisst: an diesem Tag nicht gemessen.
    $value = trim((string) ($raw['value'] ?? ''));

    if ($value === '') {
        $meteoAudit['missing_value']++;
        continue;
    }

    if (!is_numeric($value)) {
        $meteoAudit['not_numeric']++;
        continue;
    }

    $value = (float) $value;

    // Ist der Wert überhaupt möglich? (siehe Prüfregel oben)
    if ($value < $precipitationRule['min'] || $value > $precipitationRule['max']) {
        $meteoAudit['implausible_value']++;
        continue;
    }

    // Doppelt geliefert? Jede Station und jeden Tag darf es nur einmal geben.
    $obsDate = $date->format('Y-m-d');
    $key = $abbr . '|' . $obsDate;

    if (isset($precipitation[$key])) {
        $meteoAudit['duplicate']++;
        continue;
    }

    // Alle Prüfungen bestanden: Der Wert kommt auf die saubere Liste.
    $precipitation[$key] = [
        'station_abbr' => $abbr,
        'obs_date' => $obsDate,
        'precipitation_mm' => round($value, 1),
    ];
}

$meteoAudit['output_rows'] = count($precipitation);

// ---------------------------------------------------------------------------
// Das Ergebnis an load.php weitergeben
// ---------------------------------------------------------------------------
//
// In die Datenbank kommen die Stationen und die Messwerte («data»).
// Die Strichlisten («audit») schreibt load.php in seinen Bericht und ins Protokoll.

return [
    'stations' => $stations,
    'data' => array_values($observations),
    'audit' => $audit,
    'extract_audit' => $rawData['audit'],
    'meteo' => [
        'stations' => $cleanStations,
        'data' => array_values($precipitation),
        'audit' => $meteoAudit,
        'extract_audit' => $rawMeteo['audit'],
        'error' => $rawMeteo['error'], // Fehlermeldung, falls MeteoSchweiz nicht erreichbar war
    ],
];
