<?php
/**
 * Unload – die Daten an die Website ausliefern.
 *
 * Die Website fragt diese Datei: «Gib mir die Messwerte.» unload.php liest
 * sie aus unserer eigenen Datenbank und schickt sie als Liste zurück, in
 * einem Format, das JavaScript direkt versteht (JSON).
 *
 * Wichtig: Hier wird nie beim BAFU gefragt. Deshalb läuft die Website auch
 * dann, wenn das BAFU gerade nicht erreichbar ist.
 *
 * Ablauf:
 *
 *   1. Die Website fragt, z.B.: unload.php?years=2022,2026
 *   2. Prüfen, ob die Frage gültig ist (sonst: Fehler 400)
 *   3. Passende Werte aus der Datenbank lesen
 *   4. In die vereinbarte Form bringen (den «Datenvertrag»)
 *   5. Als JSON zurückschicken
 *
 * Der Datenvertrag ist die Abmachung zwischen Backend und Frontend: So sieht
 * jeder Datensatz aus. Ein Datensatz ist eine Station an einem Tag:
 *
 *   {
 *     "station_no": "2044",               Nummer der Station beim BAFU
 *     "river_name": "Thur",               Name des Flusses
 *     "station_name": "Andelfingen",      Ort der Station
 *     "date": "2026-09-27",               Tag
 *     "water_temperature_c": 16.8,        Wassertemperatur in °C (oder null = kein Wert)
 *     "water_level_deviation_cm": -27,    Wasserstand: so viele cm über/unter normal (oder null)
 *     "release_state": 2                  vom BAFU geprüft? 1 nein, 2 ja, 3 endgültig (oder null)
 *   }
 *
 * Mögliche Fragen (alle freiwillig und kombinierbar):
 *
 *   unload.php                                 alle Flüsse, letzte 365 Tage
 *   unload.php?stations=2044,2243              nur diese Flüsse
 *   unload.php?parameter=WT                    nur Temperatur (W = nur Wasserstand)
 *   unload.php?years=2022,2026                 nur diese Jahre
 *   unload.php?from=2026-01-01&to=2026-06-30   nur dieser Zeitraum
 */

// Die Antwort ist JSON, nicht eine Webseite.
header('Content-Type: application/json; charset=utf-8');

// Die Zugangsdaten zur Datenbank (geheim, nicht auf GitHub).
require __DIR__ . '/config.php';

// ---------------------------------------------------------------------------
// Einen Datensatz in die vereinbarte Form bringen
// ---------------------------------------------------------------------------
//
// Hier steht an einer einzigen Stelle, wie ein Datensatz aussieht.
// Drei Dinge werden dabei noch ausgerechnet:
//
// - Der Ort: Das BAFU schreibt manchmal «Rheinfelden, Messstation».
//   Wir nehmen nur den Teil vor dem Komma.
// - Der Wasserstand: Die Flüsse liegen unterschiedlich hoch (Rhein 260 m,
//   Aare 570 m über Meer). Das kann man nicht vergleichen. Deshalb zeigen
//   wir, wie viele Zentimeter ein Fluss über oder unter seinem eigenen
//   Durchschnitt liegt.
// - Der Prüfstatus: Temperatur und Wasserstand haben je einen eigenen.
//   Wir nehmen den vorsichtigeren der beiden.

function normalizeRecord(array $row): array
{
    $hasTemperature = $row['wt'] !== null;
    $hasLevel = $row['w'] !== null && $row['mean_level'] !== null;

    // Prüfstatus der vorhandenen Werte sammeln.
    $states = [];
    if ($hasTemperature) {
        $states[] = $row['wt_state'];
    }
    if ($hasLevel) {
        $states[] = $row['w_state'];
    }

    // Den tieferen (vorsichtigeren) Status nehmen. Fehlt einer: unbekannt.
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
        // Abweichung vom Durchschnitt, von Metern in Zentimeter umgerechnet.
        'water_level_deviation_cm' => $hasLevel
            ? round(((float) $row['w'] - (float) $row['mean_level']) * 100, 1)
            : null,
        'release_state' => $releaseState,
    ];
}

// ---------------------------------------------------------------------------
// Eine ungültige Frage freundlich ablehnen
// ---------------------------------------------------------------------------
//
// Fehler 400 heisst: «Die Frage war falsch gestellt.» Die Meldung sagt, was
// erlaubt wäre.

function rejectRequest(string $message): void
{
    http_response_code(400);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

// ---------------------------------------------------------------------------
// Die Frage der Website lesen und prüfen
// ---------------------------------------------------------------------------
//
// Alles, was von aussen kommt, wird zuerst kontrolliert. So kann niemand
// über die Adresse Unsinn oder Schadcode in die Datenbank schmuggeln.
//
// Listen kommen mit Komma getrennt: «2022,2026» wird zu zwei Jahren.

$stations = array_filter(array_map('trim', explode(',', $_GET['stations'] ?? '')));
$parameter = trim($_GET['parameter'] ?? '');
$years = array_filter(array_map('trim', explode(',', $_GET['years'] ?? '')));
$from = trim($_GET['from'] ?? '');
$to = trim($_GET['to'] ?? '');

// Stationen: genau vier Ziffern. Gibt es die Station nicht, kommt einfach
// eine leere Liste zurück.
foreach ($stations as $stationNo) {
    if (!preg_match('/^\d{4}$/', $stationNo)) {
        rejectRequest('Ungültige Stationsnummer. Beispiel: stations=2044,2243');
    }
}

// Messgrösse: nur W oder WT.
$allowedParameters = ['W', 'WT'];

if ($parameter !== '' && !in_array($parameter, $allowedParameters, true)) {
    rejectRequest('Unbekannte Messgrösse. Erlaubt: W, WT');
}

// Jahre: vierstellige Jahreszahlen.
foreach ($years as $year) {
    if (!preg_match('/^(19|20)\d{2}$/', $year)) {
        rejectRequest('Ungültige Jahreszahl. Beispiel: years=2022,2026');
    }
}

// Nicht zu viel auf einmal.
if (count($stations) > 20 || count($years) > 10) {
    rejectRequest('Zu viele Werte auf einmal.');
}

// Datum: genau im Format Jahr-Monat-Tag, und es muss den Tag wirklich geben
// (einen 30. Februar zum Beispiel nicht).
foreach (['from' => $from, 'to' => $to] as $name => $date) {
    if ($date === '') {
        continue;
    }

    $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);

    if ($parsed === false || $parsed->format('Y-m-d') !== $date) {
        rejectRequest("Ungültiges Datum für {$name}. Format: JJJJ-MM-TT");
    }
}

// Der Anfang muss vor dem Ende liegen.
if ($from !== '' && $to !== '' && $from > $to) {
    rejectRequest('from muss vor to liegen.');
}

// ---------------------------------------------------------------------------
// Die Werte aus der Datenbank lesen
// ---------------------------------------------------------------------------

try {
    $pdo = new PDO($dsn, $username, $password, $options);

    // Ohne Jahr und ohne Datum: die letzten 365 Tage.
    if (count($years) === 0 && $from === '' && $to === '') {
        $latest = $pdo->query('SELECT MAX(obs_date) FROM observations')->fetchColumn();

        // Noch gar keine Daten: leere Liste zurückgeben.
        if ($latest === null) {
            echo '[]';
            exit;
        }

        $to = $latest;
        $from = date('Y-m-d', strtotime($latest . ' -364 days'));
    }

    // Die Datenbank-Frage Stück für Stück zusammensetzen, je nach Filter.
    // Die Werte selbst kommen nie direkt in die Frage, sondern als
    // Platzhalter (?). Das schützt die Datenbank vor Angriffen.
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

    // In der Datenbank stehen Temperatur und Wasserstand in getrennten
    // Zeilen. Für die Website legen wir sie zusammen: eine Zeile pro Station
    // und Tag, mit beiden Werten nebeneinander.
    //
    // Zusätzlich rechnen wir für jede Station den durchschnittlichen
    // Wasserstand aus. Das ist die «Null-Linie» für den Vergleich.
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

    // Jede Zeile in die vereinbarte Form bringen ...
    $data = array_map('normalizeRecord', $rows);

    // ... und als JSON an die Website schicken.
    echo json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
} catch (Throwable $error) {
    // Etwas ist schiefgegangen. Die genaue Meldung kommt ins Server-Protokoll,
    // auf der Website erscheint nur ein kurzer, harmloser Satz (Fehler 500).
    http_response_code(500);
    error_log('unload.php: ' . $error->getMessage());

    echo json_encode([
        'error' => 'Daten konnten nicht geladen werden.',
    ]);
}
