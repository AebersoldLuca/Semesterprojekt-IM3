<?php
/**
 * Load – die geprüften Werte in unsere eigene Datenbank speichern.
 *
 * Diese Datei ist der Startknopf für den ganzen Import. Jeden Morgen ruft
 * ein automatischer Zeitplan (ein «Cronjob») sie auf. Dann passiert:
 *
 *   load.php fragt transform.php → transform.php fragt extract.php
 *   → extract.php holt die Daten beim BAFU
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
// 10. Kontrolle: Hat alles geklappt?
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
