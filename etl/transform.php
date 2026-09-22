<?php
/**
 * ============================================================
 *  2) T R A N S F O R M   –   Rohdaten  →  saubere Datensätze
 * ============================================================
 *
 * Übernimmt die Rohdaten von extract.php (PHP-Array), prüft und bereinigt sie
 * und bringt sie in die Struktur der MySQL-Tabellen «stations» und
 * «observations». Transform braucht keine Datenbank – gespeichert wird erst
 * in load.php.
 *
 * Grundsatz: Es werden KEINE Werte erfunden, geschätzt oder interpoliert.
 * Ungültige Werte werden verworfen und mit Grund gezählt – in der Grafik
 * erscheinen sie als Lücke.
 *
 * Zum Testen alleine ausführbar (holt die letzten 7 Tage, schreibt NICHTS in die DB):
 *   php etl/transform.php
 */

require_once __DIR__ . '/extract.php';

/**
 * Messgrössen mit erwarteter Einheit (exakt wie API-Feld «unitSymbol») und
 * Plausibilitätsgrenzen. Werte ausserhalb werden verworfen.
 */
const PARAMETERS = [
    // Tiefster Punkt der Schweiz ~193 m (Lago Maggiore), BAFU-Pegel liegen unter 2500 m ü.M.
    'W'  => ['label' => 'Wasserstand',      'unit' => 'm ü.M.', 'min' => 150.0, 'max' => 2500.0],
    'WT' => ['label' => 'Wassertemperatur', 'unit' => '°C',     'min' => -0.5,  'max' => 35.0],
];

/**
 * BAFU-Zeitstempel sind UTC und markieren den Intervallbeginn. Ein Tagesmittel
 * beginnt um 00:00 MEZ (= 23:00 UTC am Vortag). «Etc/GMT-1» ist die feste
 * Zone UTC+1 (das Vorzeichen ist in dieser Schreibweise invertiert).
 */
const DAY_TIMEZONE = 'Etc/GMT-1';

/**
 * Kompletter Transform-Schritt.
 *
 * @param array $extract   Ergebnis von run_extract(): ['stations' => …, 'rows' => …]
 * @param array $selection station_no → Angaben aus STATIONS (extract.php)
 * @return array{stations: array, observations: array, rejected: array<string,int>}
 */
function run_transform(array $extract, array $selection): array
{
    $stations = [];
    foreach ($extract['stations'] as $raw) {
        $station = transform_station($raw, $selection);
        if ($station !== null) {
            $stations[$station['station_no']] = $station;
        }
    }

    $t = transform_observations($extract['rows'], array_map('strval', array_keys($stations)));
    return ['stations' => $stations, 'observations' => $t['rows'], 'rejected' => $t['rejected']];
}

/** Stations-Stammdaten aus der API + redaktionelle Angaben → Zeile für «stations». */
function transform_station(array $raw, array $selection): ?array
{
    $no = trim((string) ($raw['no'] ?? ''));
    if (!isset($selection[$no])) {
        return null;
    }
    return [
        'station_no'     => $no,
        'name'           => trim((string) $raw['name']),
        'river_name'     => trim((string) $raw['riverName']),
        'site_name'      => nullable_string($raw['siteName'] ?? null),
        'catchment_name' => nullable_string($raw['catchmentName'] ?? null),
        'latitude'       => is_numeric($raw['latitude'] ?? null) ? round((float) $raw['latitude'], 7) : null,
        'longitude'      => is_numeric($raw['longitude'] ?? null) ? round((float) $raw['longitude'], 7) : null,
        'elevation'      => is_numeric($raw['elevation'] ?? null) ? (float) $raw['elevation'] : null,
        'status'         => nullable_string($raw['status'] ?? null),
        'coverage_from'  => !empty($raw['coverageFrom']) ? substr($raw['coverageFrom'], 0, 10) : null,
        'display_name'   => $selection[$no]['display_name'],
        'story_role'     => $selection[$no]['story_role'],
        'sort_order'     => $selection[$no]['sort_order'],
    ];
}

/**
 * Messwerte validieren und umwandeln.
 * @param string[] $stationNos gültige Stationsnummern
 * @return array{rows: array, rejected: array<string,int>}
 */
function transform_observations(array $rawRows, array $stationNos): array
{
    $utc      = new DateTimeZone('UTC');
    $dayZone  = new DateTimeZone(DAY_TIMEZONE);
    $rows     = [];
    $rejected = [];
    $reject   = function (string $reason) use (&$rejected) {
        $rejected[$reason] = ($rejected[$reason] ?? 0) + 1;
    };

    foreach ($rawRows as $raw) {
        // 1) Station eindeutig zuordnen (BAFU-Stationsnummer)
        $stationNo = (string) ($raw['station']['no'] ?? '');
        if (!in_array($stationNo, $stationNos, true)) {
            $reject('unbekannte Station');
            continue;
        }

        // 2) Parameter W / WT unterscheiden
        $param = (string) ($raw['parameterName'] ?? '');
        if (!isset(PARAMETERS[$param])) {
            $reject('unerwarteter Parameter');
            continue;
        }

        // 3) Einheit prüfen – passt sie nicht, wären Werte nicht vergleichbar
        if (($raw['unitSymbol'] ?? null) !== PARAMETERS[$param]['unit']) {
            $reject("falsche Einheit für $param");
            continue;
        }

        // 4) Zeitstempel streng parsen (ISO-8601, UTC) und Kalendertag bestimmen
        $ts = DateTimeImmutable::createFromFormat('Y-m-d\TH:i:s\Z', (string) ($raw['timestamp'] ?? ''), $utc);
        if ($ts === false) {
            $reject('ungültiger Zeitstempel');
            continue;
        }
        $obsDate = $ts->setTimezone($dayZone)->format('Y-m-d'); // 2026-09-20T23:00Z → 2026-09-21

        // 5) Messwert: vorhanden, numerisch, endlich, plausibel?
        $value = $raw['value'] ?? null;
        if ($value === null) {
            $reject('fehlender Messwert');
            continue;
        }
        if (!is_numeric($value) || !is_finite((float) $value)) {
            $reject('nicht numerisch');
            continue;
        }
        $value = (float) $value;
        if ($value < PARAMETERS[$param]['min'] || $value > PARAMETERS[$param]['max']) {
            $reject("$param ausserhalb Plausibilitätsbereich");
            continue;
        }

        // 6) Freigabestatus: '1' provisorisch, '2' validiert, '3' definitiv, sonst NULL
        $release = $raw['releaseState'] ?? null;
        $release = in_array((string) $release, ['1', '2', '3'], true) ? (int) $release : null;

        // 7) Sensor-Platzhalter: Ein Tagesmittel von exakt 0.00 °C ohne Validierung
        //    (Status NULL oder 1) kommt z.B. bei Brienzwiler im März 2026 an drei
        //    Tagen in Folge vor – eingerahmt von 5.0 °C und 2.6 °C. Für ein ganzes
        //    Tagesmittel ist das unplausibel und deutet auf einen Messausfall hin.
        //    Solche Werte werden NICHT gespeichert. Validierte Werte (2/3) immer.
        if ($param === 'WT' && $value == 0.0 && ($release === null || $release === 1)) {
            $reject('WT = 0.00 °C, nicht validiert (vermuteter Sensorausfall)');
            continue;
        }

        // 8) Duplikate innerhalb der Antwort verhindern (gleicher Schlüssel wie
        //    der UNIQUE-Key in der Datenbank)
        $key = $stationNo . '|' . $param . '|' . $ts->format('Y-m-d H:i:s');
        if (isset($rows[$key])) {
            $reject('Duplikat in API-Antwort');
            continue;
        }

        $rows[$key] = [
            'station_no'     => $stationNo,
            'parameter_code' => $param,
            'measured_at'    => $ts->format('Y-m-d H:i:s'),
            'obs_date'       => $obsDate,
            'value'          => round($value, 3),
            'release_state'  => $release,
        ];
    }

    return ['rows' => array_values($rows), 'rejected' => $rejected];
}

function nullable_string($value): ?string
{
    $value = trim((string) $value);
    return $value === '' ? null : $value;
}

// ------------------------------------------------------------------
// Direkter Aufruf: letzte 7 Tage abrufen und Prüfbericht ausgeben
// ------------------------------------------------------------------
if (PHP_SAPI === 'cli' && realpath($_SERVER['argv'][0] ?? '') === __FILE__) {
    $say  = fn(string $l) => print($l . PHP_EOL);
    $zone = new DateTimeZone(DAY_TIMEZONE);
    $utc  = new DateTimeZone('UTC');
    $extract = run_extract(
        selected_stations(),
        (new DateTimeImmutable('-7 days midnight', $zone))->setTimezone($utc),
        (new DateTimeImmutable('tomorrow', $zone))->setTimezone($utc),
        $say
    );
    $t = run_transform($extract, selected_stations());
    $say(sprintf('%d Rohzeilen → %d gültige Messwerte für %d Stationen',
        count($extract['rows']), count($t['observations']), count($t['stations'])));
    foreach ($t['rejected'] as $reason => $n) {
        $say("  verworfen – $reason: $n");
    }
    $say('Beispiel: ' . json_encode($t['observations'][0] ?? null, JSON_UNESCAPED_UNICODE));
}
