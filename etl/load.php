<?php
/**
 * Load – die geprüften Werte in unsere eigene Datenbank speichern.
 *
 * Diese Datei ist der Startknopf für den ganzen Import. Jeden Morgen ruft
 * ein automatischer Zeitplan (ein «Cronjob») sie auf. Dann passiert:
 *
 *   load.php fragt transform.php → transform.php fragt extract.php
 *   → extract.php holt die Flussdaten beim BAFU und den Regen bei MeteoSchweiz
 *
 * Danach speichert load.php alles in der Datenbank.
 *
 * Aufruf:
 *
 *   https://eure-domain.ch/etl/load.php?token=…          tägliches Update
 *   https://eure-domain.ch/etl/load.php?token=…&full=1   alles ab 2020 neu laden
 *
 * Ablauf:
 *
 *   1. Nachschauen, bis wann wir schon Daten haben (Flüsse und Regen)
 *   2. Ab dort (minus 60 Tage) neue Daten holen lassen
 *   3. Die sechs Flussstationen und ihre Messwerte speichern
 *   4. Den mittleren Wasserstand jeder Station neu ausrechnen
 *   5. Die sechs Wetterstationen und den Regen speichern
 *   6. Jeden Schritt im Protokoll (Tabelle import_runs) notieren
 *
 * Diese Datei gibt nichts an eine andere Datei zurück. Ihr Ergebnis steht
 * danach in der Datenbank.
 */

// ---------------------------------------------------------------------------
// 1. Vorbereiten
// ---------------------------------------------------------------------------

// Die Ausgabe ist einfacher Text (eine Art Bericht), keine Webseite.
header('Content-Type: text/plain; charset=utf-8');

// Die Zugangsdaten zur Datenbank stehen in config.php.
// Diese Datei ist geheim und liegt nicht auf GitHub.
require __DIR__ . '/../config.php';

// ---------------------------------------------------------------------------
// 2. Nur mit Passwort
// ---------------------------------------------------------------------------
//
// load.php ist im Internet erreichbar, sonst könnte der Zeitplan sie nicht
// starten. Damit nicht irgendwer einen Import auslöst, braucht es ein
// geheimes Passwort in der Adresse (das «Token» aus config.php).
// Ohne richtiges Token: «Kein Zugriff».

if (PHP_SAPI !== 'cli') {
    $token = (string) ($_GET['token'] ?? '');

    // hash_equals vergleicht die zwei Texte auf sichere Art.
    if ($etlToken === '' || !hash_equals($etlToken, $token)) {
        http_response_code(403);
        exit("Kein Zugriff.\n");
    }

    // Der allererste Import dauert länger: bis zu 5 Minuten erlauben.
    set_time_limit(300);
}

// Steht «full» in der Adresse, laden wir alles ab 2020 neu.
$fullImport = isset($_GET['full']) || in_array('--full', $argv ?? [], true);

// ---------------------------------------------------------------------------
// 3. Helfer, die mehrmals gebraucht werden
// ---------------------------------------------------------------------------
//
// Flussdaten und Regen werden gleich gespeichert und gleich im Protokoll
// notiert. Damit dieser Code nicht zweimal dasteht, steckt er in vier
// kleinen Funktionen.

/**
 * Ab welchem Tag holen wir Daten?
 *
 * Wir müssen nicht jeden Tag alles seit 2020 neu holen. Es reicht, ab dem
 * letzten gespeicherten Tag weiterzumachen. Wir gehen aber 60 Tage zurück:
 * BAFU und MeteoSchweiz kontrollieren ihre Werte im Nachhinein und
 * korrigieren manchmal etwas. So kommen auch diese Korrekturen bei uns an.
 *
 * - $latestDays: der letzte gespeicherte Tag jeder Zeitreihe
 * - $expected: wie viele Zeitreihen es geben müsste. Fehlt eine, holen wir
 *   alles ab dem 1. Januar 2020 (z.B. bei einer leeren Datenbank).
 */
function startDateFor(array $latestDays, int $expected, bool $fullImport): string {
    $firstDay = '2020-01-01';

    if ($fullImport || count($latestDays) < $expected) {
        return $firstDay;
    }

    return max($firstDay, date('Y-m-d', strtotime(min($latestDays) . ' -60 days')));
}

/**
 * Im Protokoll eine neue Zeile anlegen: «Import gestartet».
 * Gibt die Nummer dieser Zeile zurück, damit wir sie später ergänzen können.
 * $aggregation sagt, welche Werte: 'data_1day_mean' (BAFU) oder 'meteo_rka150d0' (Regen).
 */
function startRun(PDO $pdo, string $aggregation, bool $fullImport, string $from): int {
    $pdo->prepare(
        "INSERT INTO import_runs (started_at, status, mode, aggregation, window_from, window_to)
         VALUES (UTC_TIMESTAMP(), 'running', :mode, :aggregation, :window_from, CURDATE())"
    )->execute([
        'mode' => $fullImport ? 'full' : 'incremental',
        'aggregation' => $aggregation,
        'window_from' => $from,
    ]);

    return (int) $pdo->lastInsertId();
}

/** Im Protokoll notieren: «Import fertig», mit allen Zahlen. */
function finishRun(PDO $pdo, int $runId, string $status, array $numbers, ?string $message): void {
    $pdo->prepare(
        'UPDATE import_runs
         SET finished_at = UTC_TIMESTAMP(), status = :status,
             api_requests = :api_requests, rows_received = :rows_received,
             rows_inserted = :rows_inserted, rows_updated = :rows_updated,
             rows_unchanged = :rows_unchanged, rows_rejected = :rows_rejected, message = :message
         WHERE id = :id'
    )->execute($numbers + ['status' => $status, 'message' => $message, 'id' => $runId]);
}

/** Im Protokoll notieren: «Import fehlgeschlagen», mit der Fehlermeldung. */
function failRun(PDO $pdo, int $runId, string $message): void {
    $pdo->prepare("UPDATE import_runs SET finished_at = UTC_TIMESTAMP(), status = 'failed', message = ? WHERE id = ?")
        ->execute([mb_substr($message, 0, 1000), $runId]);
}

/**
 * Viele Zeilen auf einmal speichern: alles oder nichts.
 *
 * Entweder werden alle Werte gespeichert oder gar keiner. So steht nie eine
 * halbe Lieferung in der Datenbank. (Das nennt man eine «Transaktion». Sie
 * macht das Speichern ausserdem viel schneller.)
 *
 * - $statement: die vorbereitete Anweisung zum Speichern einer Zeile
 * - $toParams: macht aus einer Zeile die Werte für diese Anweisung
 *
 * Die Datenbank sagt nach jeder Zeile, was passiert ist: 1 = neu,
 * 2 = geändert, 0 = gleich geblieben. Das zählen wir für den Bericht.
 */
function saveRows(PDO $pdo, PDOStatement $statement, array $rows, callable $toParams): array {
    $counts = ['rows_inserted' => 0, 'rows_updated' => 0, 'rows_unchanged' => 0];

    $pdo->beginTransaction();

    try {
        foreach ($rows as $row) {
            $statement->execute($toParams($row));
            $changed = $statement->rowCount();

            if ($changed === 1) {
                $counts['rows_inserted']++;
            } elseif ($changed === 2) {
                $counts['rows_updated']++;
            } else {
                $counts['rows_unchanged']++;
            }
        }

        $pdo->commit(); // jetzt alles auf einmal festschreiben
    } catch (Throwable $e) {
        $pdo->rollBack(); // etwas ging schief: alles rückgängig machen
        throw $e;
    }

    return $counts;
}

// ---------------------------------------------------------------------------
// 4. Mit der Datenbank verbinden
// ---------------------------------------------------------------------------

try {
    $pdo = new PDO($dsn, $username, $password, $options);
    echo "Verbindung steht.\n\n";
} catch (PDOException $e) {
    exit('Verbindung fehlgeschlagen: ' . $e->getMessage() . "\n");
}

// ---------------------------------------------------------------------------
// 5. Ab welchem Tag holen wir Daten?
// ---------------------------------------------------------------------------

// Flüsse: der letzte gespeicherte Tag pro Station und Messgrösse.
// Es müssten 12 sein: 6 Stationen mal 2 Messgrössen.
$latestDays = $pdo->query(
    'SELECT MAX(o.obs_date)
     FROM observations AS o
     JOIN stations AS s ON s.id = o.station_id
     WHERE s.is_active = 1
     GROUP BY o.station_id, o.parameter_code'
)->fetchAll(PDO::FETCH_COLUMN);

// Regen: der letzte gespeicherte Tag pro Wetterstation. Es müssten 6 sein.
$latestRainDays = $pdo->query(
    'SELECT MAX(obs_date) FROM precipitation GROUP BY weather_station_id'
)->fetchAll(PDO::FETCH_COLUMN);

$startDate = startDateFor($latestDays, 12, $fullImport);
$meteoStartDate = startDateFor($latestRainDays, 6, $fullImport);

echo "Flüsse: lade ab {$startDate}. Regen: lade ab {$meteoStartDate}.\n";

// ---------------------------------------------------------------------------
// 6. Die geprüften Daten holen
// ---------------------------------------------------------------------------
//
// Hier läuft die Kette los: transform.php holt die Rohdaten bei extract.php,
// extract.php fragt beim BAFU und bei MeteoSchweiz. Die beiden Startdaten von
// oben ($startDate, $meteoStartDate) werden dabei mitgegeben.
//
// Ist das BAFU nicht erreichbar, brechen wir ab. Die Daten, die schon in
// unserer Datenbank sind, bleiben unverändert. Die Website läuft weiter.
// (Fällt nur MeteoSchweiz aus, geht es weiter, siehe Abschnitt 9.)

$runId = startRun($pdo, 'data_1day_mean', $fullImport, $startDate);

try {
    $result = include __DIR__ . '/transform.php';
} catch (Throwable $e) {
    failRun($pdo, $runId, $e->getMessage());
    exit('Extract/Transform fehlgeschlagen: ' . $e->getMessage() . "\nDie gespeicherten Daten bleiben unverändert.\n");
}

$audit = $result['audit'];

echo 'Die API liefert ' . $audit['input_rows'] . ' Zeilen in '
    . $result['extract_audit']['api_requests'] . " Abfragen.\n";
echo 'Der Transform liefert ' . count($result['data']) . ' gültige Messwerte, '
    . ($audit['input_rows'] - $audit['output_rows']) . " verworfen.\n\n";

// ---------------------------------------------------------------------------
// 7. Die Flussstationen speichern
// ---------------------------------------------------------------------------
//
// Für jede Station: Gibt es sie schon in der Datenbank?
// - Nein: neu anlegen.
// - Ja: ihre Angaben auffrischen (falls das BAFU etwas geändert hat).
// «ON DUPLICATE KEY UPDATE» erledigt beides in einem Schritt.
//
// Jede Station bekommt in der Datenbank eine interne Nummer (id). Die merken
// wir uns, denn jeder Messwert wird später mit dieser Nummer verknüpft.

$saveStation = $pdo->prepare(
    'INSERT INTO stations (station_no, name, river_name, site_name, catchment_name,
                           latitude, longitude, elevation, status, coverage_from, sort_order)
     VALUES (:station_no, :name, :river_name, :site_name, :catchment_name,
             :latitude, :longitude, :elevation, :status, :coverage_from, :sort_order)
     ON DUPLICATE KEY UPDATE
        name = VALUES(name), river_name = VALUES(river_name), site_name = VALUES(site_name),
        catchment_name = VALUES(catchment_name), latitude = VALUES(latitude), longitude = VALUES(longitude),
        elevation = VALUES(elevation), status = VALUES(status), coverage_from = VALUES(coverage_from),
        sort_order = VALUES(sort_order), is_active = 1'
);
$findStation = $pdo->prepare('SELECT id FROM stations WHERE station_no = ?');

// Ein Merkzettel: BAFU-Nummer → interne Nummer in der Datenbank.
$stationIds = [];

foreach ($result['stations'] as $stationNo => $station) {
    $saveStation->execute($station);
    $findStation->execute([$stationNo]);
    $stationIds[$stationNo] = (int) $findStation->fetchColumn();
}

// Stationen, die wir nicht mehr verwenden, werden ausgeblendet, nicht
// gelöscht. Ihre alten Messwerte bleiben so erhalten.
$placeholders = implode(',', array_fill(0, count($stationIds), '?'));
$pdo->prepare("UPDATE stations SET is_active = 0 WHERE station_no NOT IN ($placeholders)")
    ->execute(array_map('strval', array_keys($stationIds)));

echo 'Stationen in der Datenbank: ' . implode(', ', array_keys($stationIds)) . ".\n\n";

// ---------------------------------------------------------------------------
// 8. Die Messwerte speichern
// ---------------------------------------------------------------------------
//
// Damit nichts doppelt gespeichert wird, gibt es in der Datenbank eine Regel:
// Pro Station, Messgrösse und Zeitpunkt darf es nur eine Zeile geben.
// Kommt ein Wert, den wir schon haben, wird er überschrieben. So kommen
// Korrekturen des BAFU an. Das Änderungsdatum (updated_at) wird nur neu
// gesetzt, wenn sich der Wert wirklich geändert hat.

$saveObservation = $pdo->prepare(
    'INSERT INTO observations (station_id, parameter_code, measured_at, obs_date, value, release_state, import_run_id)
     VALUES (:station_id, :parameter_code, :measured_at, :obs_date, :value, :release_state, :import_run_id)
     ON DUPLICATE KEY UPDATE
        updated_at    = IF(value <=> VALUES(value) AND release_state <=> VALUES(release_state),
                           updated_at, CURRENT_TIMESTAMP),
        import_run_id = IF(value <=> VALUES(value) AND release_state <=> VALUES(release_state),
                           import_run_id, VALUES(import_run_id)),
        value         = VALUES(value),
        release_state = VALUES(release_state)'
);

try {
    $counts = saveRows($pdo, $saveObservation, $result['data'], fn ($row) => [
        'station_id' => $stationIds[$row['station_no']],
        'parameter_code' => $row['parameter_code'],
        'measured_at' => $row['measured_at'],
        'obs_date' => $row['obs_date'],
        'value' => $row['value'],
        'release_state' => $row['release_state'],
        'import_run_id' => $runId,
    ]);
} catch (Throwable $e) {
    failRun($pdo, $runId, $e->getMessage());
    exit('Speichern fehlgeschlagen: ' . $e->getMessage() . "\n");
}

echo "{$counts['rows_inserted']} neu, {$counts['rows_updated']} geändert, {$counts['rows_unchanged']} unverändert.\n";

// Den mittleren Wasserstand jeder Station neu ausrechnen und speichern.
// Er ist die «Null-Linie» der Website: Ein Fluss steht so viele Zentimeter
// über oder unter seinem Durchschnitt. Wir rechnen ihn hier einmal pro Import
// aus, statt bei jedem Besuch der Website (das spart Rechenzeit in unload.php).
$pdo->exec(
    "INSERT INTO station_baselines (station_id, mean_level)
     SELECT station_id, AVG(value) FROM observations WHERE parameter_code = 'W' GROUP BY station_id
     ON DUPLICATE KEY UPDATE mean_level = VALUES(mean_level)"
);

// Im Protokoll notieren: «Import fertig».
// «success» = alles geklappt.
// «partial» = eine Portion hat nicht geklappt, der Rest ist gespeichert.
//             Der nächste Import holt die Lücke nach.
$failedWindows = $result['extract_audit']['failed_windows'];
$status = $failedWindows === 0 ? 'success' : 'partial';

finishRun($pdo, $runId, $status, $counts + [
    'api_requests' => $result['extract_audit']['api_requests'],
    'rows_received' => $audit['input_rows'],
    'rows_rejected' => $audit['input_rows'] - $audit['output_rows'],
], $failedWindows > 0 ? "{$failedWindows} Zeitfenster fehlgeschlagen." : null);

// Protokolleinträge, die älter als ein Jahr sind, löschen. Die Messwerte bleiben.
$pdo->exec('DELETE FROM import_runs WHERE started_at < UTC_TIMESTAMP() - INTERVAL 365 DAY');

// ---------------------------------------------------------------------------
// 9. Der Regen von MeteoSchweiz
// ---------------------------------------------------------------------------
//
// Jetzt dasselbe für den Regen. Die Daten hat extract.php schon geholt und
// transform.php schon geprüft (unter «meteo»). Hier speichern wir sie.
//
// Klappt hier etwas nicht, ist das kein Weltuntergang: Die Flussdaten von
// oben sind schon gespeichert. Wir notieren den Fehler und machen weiter.

echo "\nRegen von MeteoSchweiz:\n";

$meteo = $result['meteo'];
$meteoRunId = startRun($pdo, 'meteo_rka150d0', $fullImport, $meteoStartDate);

try {
    // War MeteoSchweiz nicht erreichbar? Dann gibt es nichts zu speichern.
    if ($meteo['error'] !== null) {
        throw new RuntimeException($meteo['error']);
    }

    // Die Wetterstationen speichern: neu anlegen oder auffrischen.
    $saveWeatherStation = $pdo->prepare(
        'INSERT INTO weather_stations (abbr, name, river_station_no, latitude, longitude, elevation)
         VALUES (:abbr, :name, :river_station_no, :latitude, :longitude, :elevation)
         ON DUPLICATE KEY UPDATE
            name = VALUES(name), river_station_no = VALUES(river_station_no),
            latitude = VALUES(latitude), longitude = VALUES(longitude), elevation = VALUES(elevation)'
    );
    $findWeatherStation = $pdo->prepare('SELECT id FROM weather_stations WHERE abbr = ?');

    // Ein Merkzettel: Kürzel → interne Nummer, z.B. 'STG' → 2.
    $weatherIds = [];

    foreach ($meteo['stations'] as $abbr => $weatherStation) {
        $saveWeatherStation->execute($weatherStation);
        $findWeatherStation->execute([$abbr]);
        $weatherIds[$abbr] = (int) $findWeatherStation->fetchColumn();
    }

    // Die Regenwerte speichern. Gibt es den Tag schon, wird der Wert überschrieben.
    $saveRain = $pdo->prepare(
        'INSERT INTO precipitation (weather_station_id, obs_date, precipitation_mm, import_run_id)
         VALUES (:weather_station_id, :obs_date, :precipitation_mm, :import_run_id)
         ON DUPLICATE KEY UPDATE
            updated_at       = IF(precipitation_mm <=> VALUES(precipitation_mm), updated_at, CURRENT_TIMESTAMP),
            import_run_id    = IF(precipitation_mm <=> VALUES(precipitation_mm), import_run_id, VALUES(import_run_id)),
            precipitation_mm = VALUES(precipitation_mm)'
    );

    $rainCounts = saveRows($pdo, $saveRain, $meteo['data'], fn ($row) => [
        'weather_station_id' => $weatherIds[$row['station_abbr']],
        'obs_date' => $row['obs_date'],
        'precipitation_mm' => $row['precipitation_mm'],
        'import_run_id' => $meteoRunId,
    ]);

    // Im Protokoll notieren: «Regen-Import fertig».
    $failedFiles = $meteo['extract_audit']['failed_files'];
    $meteoStatus = $failedFiles === 0 ? 'success' : 'partial';

    finishRun($pdo, $meteoRunId, $meteoStatus, $rainCounts + [
        'api_requests' => $meteo['extract_audit']['api_requests'],
        'rows_received' => $meteo['audit']['input_rows'],
        'rows_rejected' => $meteo['audit']['input_rows'] - $meteo['audit']['output_rows'],
    ], $failedFiles > 0 ? "{$failedFiles} Dateien fehlgeschlagen." : null);

    echo "{$rainCounts['rows_inserted']} neu, {$rainCounts['rows_updated']} geändert, "
        . "{$rainCounts['rows_unchanged']} unverändert. Status: {$meteoStatus}.\n";
} catch (Throwable $e) {
    failRun($pdo, $meteoRunId, $e->getMessage());
    echo 'Regen-Import fehlgeschlagen: ' . $e->getMessage() . "\nDie Flussdaten sind trotzdem gespeichert.\n";
}

// ---------------------------------------------------------------------------
// 10. Kontrolle: Hat alles geklappt?
// ---------------------------------------------------------------------------
//
// Wir lesen die neuesten Werte wieder aus der Datenbank und schreiben sie in
// den Bericht. Genau diese Werte zeigt danach die Website.

$total = $pdo->query('SELECT COUNT(*) FROM observations')->fetchColumn();
echo "\nStatus: {$status}. In observations stehen jetzt {$total} Messwerte.\n\n";

$latestValues = $pdo->query(
    "SELECT s.river_name, o.obs_date, o.parameter_code, o.value
     FROM observations AS o
     JOIN stations AS s ON s.id = o.station_id
     WHERE s.is_active = 1
       AND o.obs_date = (SELECT MAX(obs_date) FROM observations WHERE station_id = s.id)
     ORDER BY s.sort_order, o.parameter_code"
);

foreach ($latestValues->fetchAll() as $value) {
    echo '  ' . $value['river_name'] . "\t" . $value['obs_date'] . "\t"
        . $value['parameter_code'] . "\t" . $value['value'] . "\n";
}

// Der neuste Regenwert pro Wetterstation.
echo "\nNeuster Regen:\n";

$latestRain = $pdo->query(
    'SELECT w.name, p.obs_date, p.precipitation_mm
     FROM precipitation AS p
     JOIN weather_stations AS w ON w.id = p.weather_station_id
     WHERE p.obs_date = (SELECT MAX(obs_date) FROM precipitation WHERE weather_station_id = w.id)
     ORDER BY w.name'
);

foreach ($latestRain->fetchAll() as $value) {
    echo '  ' . $value['name'] . "\t" . $value['obs_date'] . "\t" . $value['precipitation_mm'] . " mm\n";
}

// Zum Schluss: Welche Werte hat transform.php weggelassen, und warum?
echo "\nVerworfen im Transform:\n";

if ($audit['input_rows'] === $audit['output_rows']) {
    echo "  keine\n";
}

foreach ($audit as $reason => $count) {
    if ($count > 0 && $reason !== 'input_rows' && $reason !== 'output_rows') {
        echo "  {$reason}: {$count}\n";
    }
}
