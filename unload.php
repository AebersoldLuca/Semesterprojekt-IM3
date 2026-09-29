<?php
/**
 * Unload – der JSON-Endpunkt für die Story-Seite.
 *
 * Liest die gespeicherten Tagesmittel aus unserer Datenbank und liefert sie
 * nach dem Datenvertrag als JSON. Hier wird nie die BAFU-API gefragt: Die
 * Website läuft auch dann, wenn die API gerade nicht erreichbar ist.
 *
 * Datenfluss dieser Datei:
 *
 *   Anfrage aus dem Browser     GET /unload.php?years=2022,2026
 *     -> geprüfte Parameter     stations, parameter, years, from, to – sonst 400
 *       -> SELECT mit JOIN      observations + stations, pro Station und Tag eine Zeile
 *         -> Datenvertrag       normalizeRecord()
 *           -> JSON-Antwort     eine Liste von Datensätzen
 *
 * Datenvertrag (Version 1) – ein Datensatz ist eine Station an einem Tag:
 *
 *   {
 *     "station_no": "2044",               BAFU-Nummer der Station
 *     "river_name": "Thur",               Gewässer
 *     "station_name": "Andelfingen",      Ort der Station
 *     "date": "2026-09-27",               Kalendertag des Tagesmittels
 *     "water_temperature_c": 16.8,        Wassertemperatur in °C, sonst null
 *     "water_level_deviation_cm": -27,    Abweichung vom mittleren Pegel in cm, sonst null
 *     "release_state": 2                  1 provisorisch, 2 validiert, 3 definitiv, sonst null
 *   }
 *
 * Filter (alle optional, kombinierbar):
 *
 *   GET unload.php                              alle Flüsse, die letzten 365 Tage
 *   GET unload.php?stations=2044,2243           nur diese Stationen
 *   GET unload.php?parameter=WT                 nur Temperatur (W = nur Wasserstand)
 *   GET unload.php?years=2022,2026              nur diese Jahre
 *   GET unload.php?from=2026-01-01&to=2026-06-30  nur dieser Zeitraum
 */

header('Content-Type: application/json; charset=utf-8');

require __DIR__ . '/config.php';

// ---------------------------------------------------------------------------
// Der Datenvertrag
// ---------------------------------------------------------------------------
//
// An genau einer Stelle steht, welche Felder die Antwort hat und welchen Typ.
// DECIMAL kommt bei PDO als Text zurück – ohne (float) stünde im JSON "16.8"
// statt 16.8.
//
// Drei Felder werden hier erst berechnet:
//
// - station_name: Das BAFU schreibt manchmal «Rheinfelden, Messstation». Der
//   Ort ist der Teil vor dem Komma.
// - water_level_deviation_cm: Ein Pegel in m ü.M. ist zwischen zwei Flüssen
//   nicht vergleichbar (Rhein 260 m, Aare 570 m). Deshalb liefern wir die
//   Abweichung vom mittleren Pegel dieser Station, in Zentimetern.
// - release_state: Ein Datensatz enthält bis zu zwei Messwerte mit je eigenem
//   Prüfstatus. Wir liefern den vorsichtigeren: den tieferen der beiden, und
//   null, sobald einer der vorhandenen Werte gar keinen Status hat.

function normalizeRecord(array $row): array
{
    $hasTemperature = $row['wt'] !== null;
    $hasLevel = $row['w'] !== null && $row['mean_level'] !== null;

    $states = [];
    if ($hasTemperature) {
        $states[] = $row['wt_state'];
    }
    if ($hasLevel) {
        $states[] = $row['w_state'];
    }

    $releaseState = null;
    if (count($states) > 0 && !in_array(null, $states, true)) {
        $releaseState = (int) min($states);
    }

    return [
        'station_no' => (string) $row['station_no'],
        'river_name' => $row['river_name'],
        'station_name' => trim(explode(',', $row['station_name'])[0]),
        'date' => $row['date'],
        'water_temperature_c' => $hasTemperature
            ? round((float) $row['wt'], 2)
            : null,
        'water_level_deviation_cm' => $hasLevel
            ? round(((float) $row['w'] - (float) $row['mean_level']) * 100, 1)
            : null,
        'release_state' => $releaseState,
    ];
}

// ---------------------------------------------------------------------------
// Eine falsch gestellte Frage abweisen
// ---------------------------------------------------------------------------
//
// 400 heisst: Die Anfrage war falsch, nicht der Server. Die Meldung sagt, was
// erlaubt ist – das hilft der fragenden Seite weiter.

function rejectRequest(string $message): void
{
    http_response_code(400);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

// ---------------------------------------------------------------------------
// Filter aus $_GET lesen und prüfen
// ---------------------------------------------------------------------------
//
// Jeder Wert, der von aussen kommt, wird geprüft, bevor er in die Abfrage
// darf. Im SQL steht er danach trotzdem nur als Platzhalter.
//
// Listen kommen kommagetrennt: «2022,2026» wird zu ['2022', '2026'].

$stations = array_filter(array_map('trim', explode(',', $_GET['stations'] ?? '')));
$parameter = trim($_GET['parameter'] ?? '');
$years = array_filter(array_map('trim', explode(',', $_GET['years'] ?? '')));
$from = trim($_GET['from'] ?? '');
$to = trim($_GET['to'] ?? '');

// Stationen: vierstellige BAFU-Nummern. Eine Station, die es nicht gibt, ist
// kein Fehler – die Antwort ist dann einfach eine leere Liste.
foreach ($stations as $stationNo) {
    if (!preg_match('/^\d{4}$/', $stationNo)) {
        rejectRequest('Ungültige Stationsnummer. Beispiel: stations=2044,2243');
    }
}

// Messgrösse: genau einer von zwei bekannten Werten.
$allowedParameters = ['W', 'WT'];

if ($parameter !== '' && !in_array($parameter, $allowedParameters, true)) {
    rejectRequest('Unbekannte Messgrösse. Erlaubt: W, WT');
}

// Jahre: vierstellig, höchstens zehn auf einmal.
foreach ($years as $year) {
    if (!preg_match('/^(19|20)\d{2}$/', $year)) {
        rejectRequest('Ungültige Jahreszahl. Beispiel: years=2022,2026');
    }
}

if (count($stations) > 20 || count($years) > 10) {
    rejectRequest('Zu viele Werte auf einmal.');
}

// Datum: streng im Format JJJJ-MM-TT. Die zweite Prüfung weist auch einen
// 30. Februar ab, den PHP sonst still in den 2. März verwandeln würde.
foreach (['from' => $from, 'to' => $to] as $name => $date) {
    if ($date === '') {
        continue;
    }

    $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);

    if ($parsed === false || $parsed->format('Y-m-d') !== $date) {
        rejectRequest("Ungültiges Datum für {$name}. Format: JJJJ-MM-TT");
    }
}

if ($from !== '' && $to !== '' && $from > $to) {
    rejectRequest('from muss vor to liegen.');
}

// ---------------------------------------------------------------------------
// Aus der Datenbank lesen
// ---------------------------------------------------------------------------

try {
    $pdo = new PDO($dsn, $username, $password, $options);

    // Ohne Jahr und ohne Datum: die letzten 365 Tage bis zum jüngsten Messtag.
    if (count($years) === 0 && $from === '' && $to === '') {
        $latest = $pdo->query('SELECT MAX(obs_date) FROM observations')->fetchColumn();

        if ($latest === null) {
            echo '[]';
            exit;
        }

        $to = $latest;
        $from = date('Y-m-d', strtotime($latest . ' -364 days'));
    }

    // Die Bedingungen wachsen mit den Filtern. Für jede Liste braucht es so
    // viele Fragezeichen, wie sie Werte hat: IN (?, ?).
    $where = ['s.is_active = 1'];
    $params = [];

    if (count($stations) > 0) {
        $where[] = 's.station_no IN (' . implode(',', array_fill(0, count($stations), '?')) . ')';
        $params = array_merge($params, array_values($stations));
    }

    if ($parameter !== '') {
        $where[] = 'o.parameter_code = ?';
        $params[] = $parameter;
    }

    if (count($years) > 0) {
        $where[] = 'YEAR(o.obs_date) IN (' . implode(',', array_fill(0, count($years), '?')) . ')';
        $params = array_merge($params, array_map('intval', $years));
    }

    if ($from !== '') {
        $where[] = 'o.obs_date >= ?';
        $params[] = $from;
    }

    if ($to !== '') {
        $where[] = 'o.obs_date <= ?';
        $params[] = $to;
    }

    // In observations steht jeder Messwert in einer eigenen Zeile. Der
    // Datenvertrag will pro Station und Tag EINE Zeile mit beiden Werten.
    // GROUP BY fasst die zwei Zeilen zusammen, MAX(CASE …) holt je den
    // passenden Wert heraus.
    //
    // Der LEFT JOIN auf b liefert pro Station den mittleren Pegel über alle
    // gespeicherten Tage – die Nulllinie für water_level_deviation_cm.
    $sql = "SELECT s.station_no,
                   s.river_name,
                   s.name AS station_name,
                   o.obs_date AS date,
                   MAX(CASE WHEN o.parameter_code = 'WT' THEN o.value END) AS wt,
                   MAX(CASE WHEN o.parameter_code = 'WT' THEN o.release_state END) AS wt_state,
                   MAX(CASE WHEN o.parameter_code = 'W' THEN o.value END) AS w,
                   MAX(CASE WHEN o.parameter_code = 'W' THEN o.release_state END) AS w_state,
                   b.mean_level
            FROM observations AS o
            JOIN stations AS s ON s.id = o.station_id
            LEFT JOIN (
                SELECT station_id, AVG(value) AS mean_level
                FROM observations
                WHERE parameter_code = 'W'
                GROUP BY station_id
            ) AS b ON b.station_id = s.id
            WHERE " . implode(' AND ', $where) . '
            GROUP BY s.id, o.obs_date
            ORDER BY s.sort_order, o.obs_date';

    $statement = $pdo->prepare($sql);
    $statement->execute($params);

    $rows = $statement->fetchAll();

    $data = array_map('normalizeRecord', $rows);

    echo json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
} catch (Throwable $error) {
    http_response_code(500);
    error_log('unload.php: ' . $error->getMessage());

    echo json_encode([
        'error' => 'Daten konnten nicht geladen werden.',
    ]);
}
