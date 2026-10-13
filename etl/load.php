<?php
/**
 * Load – die geprüften Werte in unsere eigene Datenbank speichern.
 *
 * Diese Datei ist der Startknopf für den ganzen Import. Jeden Morgen ruft
 * ein automatischer Zeitplan (ein «Cronjob») sie auf. Dann passiert:
 *
 *   load.php fragt transform.php → transform.php fragt extract.php
 *   → extract.php holt die Flussdaten beim BAFU
 *
 *   load.php fragt transform_meteo.php → transform_meteo.php fragt extract_meteo.php
 *   → extract_meteo.php holt den Regen bei MeteoSchweiz
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
 *   1. Nachschauen, bis wann wir schon Daten haben
 *   2. Ab dort (minus 60 Tage) neue Daten holen lassen
 *   3. Die sechs Stationen speichern
 *   4. Die Messwerte speichern: neue dazu, korrigierte überschreiben
 *   5. Notieren, wie der Import gelaufen ist
 *   6. Dasselbe nochmals für den Regen von MeteoSchweiz
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
// 3. Mit der Datenbank verbinden
// ---------------------------------------------------------------------------

try {
    $pdo = new PDO($dsn, $username, $password, $options);
    echo "Verbindung steht.\n\n";
} catch (PDOException $e) {
    exit('Verbindung fehlgeschlagen: ' . $e->getMessage() . "\n");
}

// ---------------------------------------------------------------------------
// 4. Ab welchem Tag holen wir Daten?
// ---------------------------------------------------------------------------
//
// Wir müssen nicht jeden Tag alles seit 2020 neu holen. Es reicht, ab dem
// letzten gespeicherten Tag weiterzumachen.
//
// Wir gehen aber 60 Tage zurück: Das BAFU kontrolliert seine Werte im
// Nachhinein und korrigiert manchmal etwas. So kommen auch diese
// Korrekturen bei uns an.
//
// Ist die Datenbank noch leer, holen wir alles ab dem 1. Januar 2020.

$firstDay = '2020-01-01';
$revisionDays = 60;

// Pro Station und Messgrösse: Was ist der letzte gespeicherte Tag?
$latestDays = $pdo->query(
    'SELECT MAX(o.obs_date)
     FROM observations AS o
     JOIN stations AS s ON s.id = o.station_id
     WHERE s.is_active = 1
     GROUP BY o.station_id, o.parameter_code'
)->fetchAll(PDO::FETCH_COLUMN);

// Es müssten 12 sein: 6 Stationen mal 2 Messgrössen. Fehlt etwas, alles neu holen.
if ($fullImport || count($latestDays) < 12) {
    $startDate = $firstDay;
} else {
    $startDate = date('Y-m-d', strtotime(min($latestDays) . " -{$revisionDays} days"));
    $startDate = max($firstDay, $startDate);
}

echo "Lade ab {$startDate}.\n";

// ---------------------------------------------------------------------------
// 5. Im Protokoll notieren: «Import gestartet»
// ---------------------------------------------------------------------------
//
// Jeder Import bekommt eine Zeile in der Tabelle import_runs. So sieht man
// später, wann was geladen wurde, und auch, wenn etwas schiefging.

$pdo->prepare(
    "INSERT INTO import_runs (started_at, status, mode, aggregation, window_from, window_to)
     VALUES (UTC_TIMESTAMP(), 'running', :mode, 'data_1day_mean', :window_from, CURDATE())"
)->execute([
    'mode' => $fullImport ? 'full' : 'incremental',
    'window_from' => $startDate,
]);

$runId = (int) $pdo->lastInsertId(); // die Nummer dieses Imports

// ---------------------------------------------------------------------------
// 6. Die geprüften Daten holen
// ---------------------------------------------------------------------------
//
// Hier läuft die Kette los: transform.php holt die Rohdaten bei extract.php,
// extract.php fragt beim BAFU. Das Startdatum von oben wird dabei mitgegeben.
//
// Ist das BAFU nicht erreichbar, brechen wir ab. Die Daten, die schon in
// unserer Datenbank sind, bleiben unverändert. Die Website läuft weiter.

try {
    $result = include __DIR__ . '/transform.php';
} catch (Throwable $e) {
    $pdo->prepare("UPDATE import_runs SET finished_at = UTC_TIMESTAMP(), status = 'failed', message = ? WHERE id = ?")
        ->execute([mb_substr($e->getMessage(), 0, 1000), $runId]);

    exit('Extract/Transform fehlgeschlagen: ' . $e->getMessage() . "\nDie gespeicherten Daten bleiben unverändert.\n");
}

$stations = $result['stations'];
$rows = $result['data'];
$audit = $result['audit'];

echo 'Die API liefert ' . $audit['input_rows'] . ' Zeilen in '
    . $result['extract_audit']['api_requests'] . " Abfragen.\n";
echo 'Der Transform liefert ' . count($rows) . ' gültige Messwerte, '
    . ($audit['input_rows'] - $audit['output_rows']) . " verworfen.\n\n";

// ---------------------------------------------------------------------------
// 7. Die Messstationen speichern
// ---------------------------------------------------------------------------
//
// Für jede Station: Gibt es sie schon in der Datenbank?
// - Nein: neu anlegen.
// - Ja: ihre Angaben auffrischen (falls das BAFU etwas geändert hat).
//
// Jede Station bekommt in der Datenbank eine interne Nummer (id). Die merken
// wir uns, denn jeder Messwert wird später mit dieser Nummer verknüpft.

$findStation = $pdo->prepare('SELECT id FROM stations WHERE station_no = ?');

$insertStation = $pdo->prepare(
    'INSERT INTO stations (station_no, name, river_name, site_name, catchment_name,
                           latitude, longitude, elevation, status, coverage_from, sort_order)
     VALUES (:station_no, :name, :river_name, :site_name, :catchment_name,
             :latitude, :longitude, :elevation, :status, :coverage_from, :sort_order)'
);

$updateStation = $pdo->prepare(
    'UPDATE stations
     SET name = :name, river_name = :river_name, site_name = :site_name,
         catchment_name = :catchment_name, latitude = :latitude, longitude = :longitude,
         elevation = :elevation, status = :status, coverage_from = :coverage_from,
         sort_order = :sort_order, is_active = 1
     WHERE station_no = :station_no'
);

// Ein Merkzettel: BAFU-Nummer → interne Nummer in der Datenbank.
$stationIds = [];

foreach ($stations as $stationNo => $station) {
    $findStation->execute([$stationNo]);
    $id = $findStation->fetchColumn();

    if ($id === false) {
        $insertStation->execute($station); // neu anlegen
        $id = $pdo->lastInsertId();
    } else {
        $updateStation->execute($station); // auffrischen
    }

    $stationIds[$stationNo] = (int) $id;
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
// Wir sammeln jeden Tag dazu, die alten Werte bleiben also stehen.
//
// Damit nichts doppelt gespeichert wird, gibt es in der Datenbank eine Regel:
// Pro Station, Messgrösse und Zeitpunkt darf es nur eine Zeile geben.
//
// Kommt ein Wert, den wir schon haben, wird er überschrieben. So kommen
// Korrekturen des BAFU an. («ON DUPLICATE KEY UPDATE» heisst: Gibt es die
// Zeile schon, dann aktualisieren statt doppelt einfügen.)
//
// Das Änderungsdatum (updated_at) wird nur neu gesetzt, wenn sich der Wert
// wirklich geändert hat.
//
// Danach sagt die Datenbank, was passiert ist: 1 = neu, 2 = geändert, 0 = gleich.

$insertObservation = $pdo->prepare(
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

// Zähler für den Bericht am Schluss.
$inserted = 0;
$updated = 0;
$unchanged = 0;

// Alles oder nichts: Entweder werden alle Werte gespeichert oder gar keiner.
// So steht nie eine halbe Lieferung in der Datenbank. (Das nennt man eine
// «Transaktion». Sie macht das Speichern ausserdem viel schneller.)
$pdo->beginTransaction();

try {
    foreach ($rows as $row) {
        $insertObservation->execute([
            'station_id' => $stationIds[$row['station_no']],
            'parameter_code' => $row['parameter_code'],
            'measured_at' => $row['measured_at'],
            'obs_date' => $row['obs_date'],
            'value' => $row['value'],
            'release_state' => $row['release_state'],
            'import_run_id' => $runId,
        ]);

        $changed = $insertObservation->rowCount();

        if ($changed === 1) {
            $inserted++;
        } elseif ($changed === 2) {
            $updated++;
        } else {
            $unchanged++;
        }
    }

    $pdo->commit(); // jetzt alles auf einmal festschreiben
} catch (Throwable $e) {
    $pdo->rollBack(); // etwas ging schief: alles rückgängig machen

    $pdo->prepare("UPDATE import_runs SET finished_at = UTC_TIMESTAMP(), status = 'failed', message = ? WHERE id = ?")
        ->execute([mb_substr($e->getMessage(), 0, 1000), $runId]);

    exit('Speichern fehlgeschlagen: ' . $e->getMessage() . "\n");
}

echo "{$inserted} neu, {$updated} geändert, {$unchanged} unverändert.\n\n";

// ---------------------------------------------------------------------------
// 9. Im Protokoll notieren: «Import fertig»
// ---------------------------------------------------------------------------
//
// «success» = alles geklappt.
// «partial» = eine Portion hat nicht geklappt, der Rest ist gespeichert.
//             Der nächste Import holt die Lücke nach.

$failedWindows = $result['extract_audit']['failed_windows'];
$status = $failedWindows === 0 ? 'success' : 'partial';

$pdo->prepare(
    'UPDATE import_runs
     SET finished_at = UTC_TIMESTAMP(), status = :status,
         api_requests = :api_requests, rows_received = :rows_received,
         rows_inserted = :rows_inserted, rows_updated = :rows_updated,
         rows_unchanged = :rows_unchanged, rows_rejected = :rows_rejected, message = :message
     WHERE id = :id'
)->execute([
    'status' => $status,
    'api_requests' => $result['extract_audit']['api_requests'],
    'rows_received' => $audit['input_rows'],
    'rows_inserted' => $inserted,
    'rows_updated' => $updated,
    'rows_unchanged' => $unchanged,
    'rows_rejected' => $audit['input_rows'] - $audit['output_rows'],
    'message' => $failedWindows > 0 ? "{$failedWindows} Zeitfenster fehlgeschlagen." : null,
    'id' => $runId,
]);

// Protokolleinträge, die älter als ein Jahr sind, löschen. Die Messwerte bleiben.
$pdo->exec('DELETE FROM import_runs WHERE started_at < UTC_TIMESTAMP() - INTERVAL 365 DAY');

// ---------------------------------------------------------------------------
// 10. Der Regen von MeteoSchweiz
// ---------------------------------------------------------------------------
//
// Jetzt dasselbe für den Regen, in fünf kurzen Schritten:
//   a) ab welchem Tag holen?   b) im Protokoll notieren
//   c) Daten holen lassen      d) Wetterstationen speichern
//   e) Regenwerte speichern
//
// Klappt hier etwas nicht, ist das kein Weltuntergang: Die Flussdaten von
// oben sind schon gespeichert. Wir notieren den Fehler und machen weiter.

echo "\nRegen von MeteoSchweiz:\n";

// Für den Regen gibt es nochmals bis zu 5 Minuten Zeit (die Uhr startet neu).
if (PHP_SAPI !== 'cli') {
    set_time_limit(300);
}

// a) Ab welchem Tag holen? Wie oben: ab dem letzten gespeicherten Tag minus
//    60 Tage, denn auch MeteoSchweiz korrigiert manchmal nachträglich.
//    Ist noch kein Regen gespeichert, holen wir alles ab dem 1. Januar 2020.
$latestRainDays = $pdo->query(
    'SELECT MAX(obs_date) FROM precipitation GROUP BY weather_station_id'
)->fetchAll(PDO::FETCH_COLUMN);

if ($fullImport || count($latestRainDays) < 6) {
    $meteoStartDate = $firstDay;
} else {
    $meteoStartDate = date('Y-m-d', strtotime(min($latestRainDays) . " -{$revisionDays} days"));
    $meteoStartDate = max($firstDay, $meteoStartDate);
}

echo "Lade ab {$meteoStartDate}.\n";

// b) Im Protokoll notieren: «Regen-Import gestartet».
$pdo->prepare(
    "INSERT INTO import_runs (started_at, status, mode, aggregation, window_from, window_to)
     VALUES (UTC_TIMESTAMP(), 'running', :mode, 'meteo_rka150d0', :window_from, CURDATE())"
)->execute([
    'mode' => $fullImport ? 'full' : 'incremental',
    'window_from' => $meteoStartDate,
]);

$meteoRunId = (int) $pdo->lastInsertId();

try {
    // c) Die geprüften Regendaten holen lassen.
    $meteo = include __DIR__ . '/transform_meteo.php';

    // d) Die Wetterstationen speichern: neu anlegen oder auffrischen.
    //    «ON DUPLICATE KEY UPDATE» erledigt beides in einem Schritt.
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

    // e) Die Regenwerte speichern, wieder alles oder nichts (Transaktion).
    //    Gibt es den Tag schon, wird der Wert überschrieben.
    $insertRain = $pdo->prepare(
        'INSERT INTO precipitation (weather_station_id, obs_date, precipitation_mm, import_run_id)
         VALUES (:weather_station_id, :obs_date, :precipitation_mm, :import_run_id)
         ON DUPLICATE KEY UPDATE
            updated_at       = IF(precipitation_mm <=> VALUES(precipitation_mm), updated_at, CURRENT_TIMESTAMP),
            import_run_id    = IF(precipitation_mm <=> VALUES(precipitation_mm), import_run_id, VALUES(import_run_id)),
            precipitation_mm = VALUES(precipitation_mm)'
    );

    $rainInserted = 0;
    $rainUpdated = 0;
    $rainUnchanged = 0;

    $pdo->beginTransaction();

    foreach ($meteo['data'] as $row) {
        $insertRain->execute([
            'weather_station_id' => $weatherIds[$row['station_abbr']],
            'obs_date' => $row['obs_date'],
            'precipitation_mm' => $row['precipitation_mm'],
            'import_run_id' => $meteoRunId,
        ]);

        // Wieder: 1 = neu, 2 = geändert, 0 = gleich.
        $changed = $insertRain->rowCount();

        if ($changed === 1) {
            $rainInserted++;
        } elseif ($changed === 2) {
            $rainUpdated++;
        } else {
            $rainUnchanged++;
        }
    }

    $pdo->commit();

    // Im Protokoll notieren: «Regen-Import fertig».
    $meteoFailed = $meteo['extract_audit']['failed_files'];
    $meteoStatus = $meteoFailed === 0 ? 'success' : 'partial';

    $pdo->prepare(
        'UPDATE import_runs
         SET finished_at = UTC_TIMESTAMP(), status = :status,
             api_requests = :api_requests, rows_received = :rows_received,
             rows_inserted = :rows_inserted, rows_updated = :rows_updated,
             rows_unchanged = :rows_unchanged, rows_rejected = :rows_rejected, message = :message
         WHERE id = :id'
    )->execute([
        'status' => $meteoStatus,
        'api_requests' => $meteo['extract_audit']['api_requests'],
        'rows_received' => $meteo['audit']['input_rows'],
        'rows_inserted' => $rainInserted,
        'rows_updated' => $rainUpdated,
        'rows_unchanged' => $rainUnchanged,
        'rows_rejected' => $meteo['audit']['input_rows'] - $meteo['audit']['output_rows'],
        'message' => $meteoFailed > 0 ? "{$meteoFailed} Dateien fehlgeschlagen." : null,
        'id' => $meteoRunId,
    ]);

    echo "{$rainInserted} neu, {$rainUpdated} geändert, {$rainUnchanged} unverändert. Status: {$meteoStatus}.\n";
} catch (Throwable $e) {
    // Etwas ging schief: halb Gespeichertes rückgängig machen und notieren.
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }

    $pdo->prepare("UPDATE import_runs SET finished_at = UTC_TIMESTAMP(), status = 'failed', message = ? WHERE id = ?")
        ->execute([mb_substr($e->getMessage(), 0, 1000), $meteoRunId]);

    echo 'Regen-Import fehlgeschlagen: ' . $e->getMessage() . "\nDie Flussdaten sind trotzdem gespeichert.\n";
}

echo "\n";

// ---------------------------------------------------------------------------
// 11. Kontrolle: Hat alles geklappt?
// ---------------------------------------------------------------------------
//
// Wir lesen die neuesten Werte wieder aus der Datenbank und schreiben sie in
// den Bericht. Genau diese Werte zeigt danach die Website.

$total = $pdo->query('SELECT COUNT(*) FROM observations')->fetchColumn();
echo "Status: {$status}. In observations stehen jetzt {$total} Messwerte.\n\n";

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

$rejected = $audit['input_rows'] - $audit['output_rows'];

if ($rejected === 0) {
    echo "  keine\n";
}

foreach ($audit as $reason => $count) {
    if ($count > 0 && $reason !== 'input_rows' && $reason !== 'output_rows') {
        echo "  {$reason}: {$count}\n";
    }
}
