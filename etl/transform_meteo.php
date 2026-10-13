<?php
/**
 * Transform (Regen) – die Regenwerte prüfen und aufräumen.
 *
 * Gleich wie transform.php, nur für den Regen von MeteoSchweiz: Jeder Wert
 * wird geprüft und in die Form gebracht, die unsere Datenbank braucht.
 *
 * Ein fertiger Regenwert sieht zum Beispiel so aus:
 *
 *   ['station_abbr' => 'STG', 'obs_date' => '2026-09-21', 'precipitation_mm' => 12.4]
 *
 * Auch hier gilt: Wir erfinden nichts. Ein Tag ohne Messung bleibt leer.
 * Wir setzen dort nie «0 mm» ein, denn «nicht gemessen» ist etwas anderes
 * als «nicht geregnet».
 */

// Zuerst die Rohdaten von extract_meteo.php holen.
$rawMeteo = include __DIR__ . '/extract_meteo.php';

// ---------------------------------------------------------------------------
// 1. Unsere Prüfregel
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
// 2. Die Wetterstationen aufräumen
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
// 3. Jeden Regenwert prüfen
// ---------------------------------------------------------------------------
//
// Wie in transform.php: Stimmt etwas nicht, machen wir einen Strich in der
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
// 4. Das Ergebnis an load.php weitergeben
// ---------------------------------------------------------------------------

return [
    'rule' => $precipitationRule,
    'stations' => $cleanStations,
    'data' => array_values($precipitation),
    'audit' => $meteoAudit,
    'extract_audit' => $rawMeteo['audit'],
];
