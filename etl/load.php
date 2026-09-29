<?php
/**
 * Load – das Ergebnis des Transforms in die Datenbank schreiben.
 *
 * Diese Datei startet die ganze Kette. Der Cronjob ruft sie einmal am Tag auf:
 *
 *   load.php -> include transform.php -> include extract.php -> BAFU-API
 *
 * Aufruf:
 *
 *   https://eure-domain.ch/etl/load.php?token=…          tägliches Update
 *   https://eure-domain.ch/etl/load.php?token=…&full=1   alles ab 2020 neu laden
 *
 * Datenfluss dieser Datei:
 *
 *   jüngster Messtag in der Datenbank     (SELECT)
 *     -> Startdatum für extract.php       (60 Tage davor)
 *       -> 6 Zeilen in stations           (suchen, sonst anlegen)
 *         -> n Zeilen in observations     (neu, geändert oder gleich)
 *           -> 1 Zeile in import_runs     (Protokoll für die Website)
 *
 * Anders als Extract und Transform gibt diese Datei nichts zurück. Ihr
 * Ergebnis steht nach dem Aufruf in der Datenbank und bleibt dort.
 */

// ---------------------------------------------------------------------------
// 1. Ausgabe als reiner Text, Zugangsdaten laden
// ---------------------------------------------------------------------------
//
// config.php liegt im Hauptordner, eine Ebene über etl/.

header('Content-Type: text/plain; charset=utf-8');

require __DIR__ . '/../config.php';

// ---------------------------------------------------------------------------
// 2. Nur mit Token
// ---------------------------------------------------------------------------
//
// load.php liegt auf dem Webserver und ist per URL erreichbar – sonst könnte
// der Cronjob sie nicht aufrufen. Damit nicht jede Person im Netz einen Import
// starten kann, braucht der Aufruf das geheime Token aus config.php.
//
// hash_equals() vergleicht wie ===, verrät aber über die Antwortzeit nicht,
// wie viele Zeichen schon gestimmt haben.
//
// Über die Kommandozeile (php etl/load.php) braucht es kein Token.

if (PHP_SAPI !== 'cli') {
    $token = (string) ($_GET['token'] ?? '');

    if ($etlToken === '' || !hash_equals($etlToken, $token)) {
        http_response_code(403);
        exit("Kein Zugriff.\n");
    }

    // Der erste Import (alles ab 2020) dauert länger als die üblichen 30 s.
    set_time_limit(300);
}

$fullImport = isset($_GET['full']) || in_array('--full', $argv ?? [], true);

// ---------------------------------------------------------------------------
// 3. Verbindung aufbauen
// ---------------------------------------------------------------------------
//
// Wortgleich wie in unload.php.

try {
    $pdo = new PDO($dsn, $username, $password, $options);
    echo "Verbindung steht.\n\n";
} catch (PDOException $e) {
    exit('Verbindung fehlgeschlagen: ' . $e->getMessage() . "\n");
}

// ---------------------------------------------------------------------------
// 4. Ab welchem Tag laden?
// ---------------------------------------------------------------------------
//
// Wir sammeln täglich dazu. Alles ab 2020 jeden Tag neu zu holen, wäre
// unnötig: Es genügt, ab dem jüngsten gespeicherten Tag zu laden.
//
// Plus 60 Tage davor. Das BAFU prüft seine Werte nachträglich und ändert dabei
// manchmal den Wert oder den Freigabestatus. So kommen diese Korrekturen auch
// bei uns an.
//
// Ist die Datenbank leer, oder fehlt einer Station eine Messgrösse, laden wir
// alles ab 2020.

$firstDay = '2020-01-01';
$revisionDays = 60;

$latestDays = $pdo->query(
    'SELECT MAX(o.obs_date)
     FROM observations AS o
     JOIN stations AS s ON s.id = o.station_id
     WHERE s.is_active = 1
     GROUP BY o.station_id, o.parameter_code'
)->fetchAll(PDO::FETCH_COLUMN);

// 6 Stationen × 2 Messgrössen = 12 Reihen
if ($fullImport || count($latestDays) < 12) {
    $startDate = $firstDay;
} else {
    $startDate = date('Y-m-d', strtotime(min($latestDays) . " -{$revisionDays} days"));
    $startDate = max($firstDay, $startDate);
}

echo "Lade ab {$startDate}.\n";

// ---------------------------------------------------------------------------
// 5. Protokoll-Zeile anlegen
// ---------------------------------------------------------------------------
//
// Jeder Lauf bekommt eine Zeile in import_runs. Die Website liest daraus nicht,
// aber so lässt sich später nachvollziehen, wann was geladen wurde – auch wenn
// ein Lauf fehlschlägt.

$pdo->prepare(
    "INSERT INTO import_runs (started_at, status, mode, aggregation, window_from, window_to)
     VALUES (UTC_TIMESTAMP(), 'running', :mode, 'data_1day_mean', :window_from, CURDATE())"
)->execute([
    'mode' => $fullImport ? 'full' : 'incremental',
    'window_from' => $startDate,
]);

$runId = (int) $pdo->lastInsertId();

// ---------------------------------------------------------------------------
// 6. Das Ergebnis des Transforms holen
// ---------------------------------------------------------------------------
//
// transform.php holt sich die Rohdaten selbst aus extract.php. extract.php
// sieht dabei die Variable $startDate von oben.
//
// Ist die BAFU-API nicht erreichbar, bricht der Extract ab. Die Daten in der
// Datenbank bleiben dann unverändert, und die Website läuft weiter.

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
// 7. Stationen suchen, sonst anlegen
// ---------------------------------------------------------------------------
//
// In observations steht nicht «2044», sondern die id dieser Station. Das
// Muster «suchen, sonst anlegen» kennen wir aus Code-Along 12.
//
// Neu: Gibt es die Station schon, aktualisieren wir ihre Stammdaten. Ändert
// das BAFU zum Beispiel einen Namen, steht er so auch bei uns richtig.

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

// $stationIds ist ein Merkzettel: Stationsnummer => id.
$stationIds = [];

foreach ($stations as $stationNo => $station) {
    $findStation->execute([$stationNo]);
    $id = $findStation->fetchColumn();

    if ($id === false) {
        $insertStation->execute($station);
        $id = $pdo->lastInsertId();
    } else {
        $updateStation->execute($station);
    }

    $stationIds[$stationNo] = (int) $id;
}

// Stationen, die nicht mehr in extract.php stehen, blenden wir aus. Gelöscht
// wird nichts: Ihre Messwerte bleiben in der Datenbank.
$placeholders = implode(',', array_fill(0, count($stationIds), '?'));
$pdo->prepare("UPDATE stations SET is_active = 0 WHERE station_no NOT IN ($placeholders)")
    ->execute(array_map('strval', array_keys($stationIds)));

echo 'Stationen in der Datenbank: ' . implode(', ', array_keys($stationIds)) . ".\n\n";

// ---------------------------------------------------------------------------
// 8. Messwerte schreiben
// ---------------------------------------------------------------------------
//
// Wir sammeln die Daten laufend. Den alten Stand löschen (Muster 1) wäre
// deshalb falsch. Wir brauchen Muster 2: dazuschreiben ohne Duplikate.
//
// Die UNIQUE-Regel (station_id, parameter_code, measured_at) in schema.sql
// lässt pro Messung nur eine Zeile zu. INSERT IGNORE würde eine vorhandene
// Zeile einfach überspringen – eine Korrektur des BAFU käme dann nie an.
// Deshalb ON DUPLICATE KEY UPDATE: Gibt es die Zeile schon, werden Wert und
// Freigabestatus überschrieben.
//
// updated_at und import_run_id ändern sich nur, wenn sich wirklich etwas
// geändert hat. Sie stehen zuerst, weil sie value und release_state noch mit
// den alten Werten vergleichen müssen. (<=> ist ein Vergleich, der auch NULL
// mit NULL vergleichen kann.)
//
// rowCount() verrät, was passiert ist: 1 = neu, 2 = geändert, 0 = gleich.

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

$inserted = 0;
$updated = 0;
$unchanged = 0;

// Eine Transaktion um alle Zeilen: Entweder landen alle in der Datenbank oder
// keine. Nebenbei ist das bei 30 000 Zeilen viel schneller, weil die Datenbank
// nur einmal am Schluss speichert.
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

    $pdo->commit();
} catch (Throwable $e) {
    $pdo->rollBack();

    $pdo->prepare("UPDATE import_runs SET finished_at = UTC_TIMESTAMP(), status = 'failed', message = ? WHERE id = ?")
        ->execute([mb_substr($e->getMessage(), 0, 1000), $runId]);

    exit('Speichern fehlgeschlagen: ' . $e->getMessage() . "\n");
}

echo "{$inserted} neu, {$updated} geändert, {$unchanged} unverändert.\n\n";

// ---------------------------------------------------------------------------
// 9. Protokoll abschliessen
// ---------------------------------------------------------------------------
//
// «partial» heisst: Ein Zeitfenster ist beim Extract fehlgeschlagen, die
// anderen sind gespeichert. Der nächste Lauf holt die Lücke nach.

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

// Protokollzeilen älter als ein Jahr löschen. Die Messwerte bleiben.
$pdo->exec('DELETE FROM import_runs WHERE started_at < UTC_TIMESTAMP() - INTERVAL 365 DAY');

// ---------------------------------------------------------------------------
// 10. Kontrolle
// ---------------------------------------------------------------------------
//
// Zählen allein genügt nicht. Deshalb lesen wir pro Station den jüngsten Tag
// zurück – genau diese Werte zeigt am nächsten Morgen die Website.

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
