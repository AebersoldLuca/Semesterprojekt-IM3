<?php
/**
 * ============================================================
 *  3) L O A D   –   transformierte Daten  →  MySQL
 * ============================================================
 *
 * Diese Datei ist der Einstiegspunkt für den Cronjob. Sie führt den ganzen
 * ETL-Prozess aus:
 *
 *   BAFU-API → extract.php → transform.php → load.php → MySQL
 *
 * Aufruf:
 *   php etl/load.php              inkrementell (Standard, täglich per Cronjob)
 *   php etl/load.php --full       alles ab IMPORT_START_DATE neu laden
 *   php etl/load.php --from=2025-01-01
 *   https://…/etl/load.php?token=…   nur falls in config.php ein etl_token gesetzt ist
 *
 * Inkrementell heisst: Es werden nur die Tage ab dem jüngsten gespeicherten
 * Wert geladen – plus REVISION_DAYS davor, damit nachträgliche Korrekturen und
 * Validierungen des BAFU übernommen werden. Ist die Datenbank leer, wird
 * automatisch alles ab IMPORT_START_DATE geladen.
 *
 * Duplikate: Der UNIQUE-Key (station_id, parameter_code, measured_at) lässt
 * pro Messung nur eine Zeile zu. «INSERT … ON DUPLICATE KEY UPDATE» fügt neue
 * Werte ein und ändert bestehende nur, wenn sich Wert oder Freigabestatus
 * geändert haben. MySQL meldet pro Zeile: 1 = eingefügt, 2 = geändert, 0 = gleich.
 *
 * Exit-Codes: 0 = Erfolg, 1 = teilweise erfolgreich, 2 = fehlgeschlagen
 */

require_once __DIR__ . '/extract.php';   // 1) Extract
require_once __DIR__ . '/transform.php'; // 2) Transform

const IMPORT_START_DATE = '2020-01-01'; // erster importierter Tag
const REVISION_DAYS     = 60;           // so viele Tage werden jeweils neu geladen

// ==================================================================
// Datenbank-Funktionen (CREATE / READ / UPDATE / DELETE)
// ==================================================================

/**
 * Stationen einfügen bzw. aktualisieren.
 * @return array<string,int> station_no → stations.id
 */
function load_stations(PDO $pdo, array $stations): array
{
    $stmt = $pdo->prepare(
        'INSERT INTO stations
            (station_no, name, river_name, site_name, catchment_name, latitude, longitude,
             elevation, status, coverage_from, display_name, story_role, sort_order, is_active)
         VALUES
            (:station_no, :name, :river_name, :site_name, :catchment_name, :latitude, :longitude,
             :elevation, :status, :coverage_from, :display_name, :story_role, :sort_order, 1)
         ON DUPLICATE KEY UPDATE
            name = VALUES(name), river_name = VALUES(river_name), site_name = VALUES(site_name),
            catchment_name = VALUES(catchment_name), latitude = VALUES(latitude),
            longitude = VALUES(longitude), elevation = VALUES(elevation), status = VALUES(status),
            coverage_from = VALUES(coverage_from), display_name = VALUES(display_name),
            story_role = VALUES(story_role), sort_order = VALUES(sort_order), is_active = 1'
    );
    foreach ($stations as $row) {
        $stmt->execute($row);
    }

    // Stationen, die nicht mehr in STATIONS (extract.php) stehen, deaktivieren
    // (UPDATE statt DELETE: ihre historischen Messwerte bleiben erhalten).
    $nos = array_map('strval', array_keys($stations));
    $in  = implode(',', array_fill(0, count($nos), '?'));
    $pdo->prepare("UPDATE stations SET is_active = 0 WHERE station_no NOT IN ($in)")->execute($nos);

    $sel = $pdo->prepare("SELECT station_no, id FROM stations WHERE station_no IN ($in)");
    $sel->execute($nos);
    return array_map('intval', $sel->fetchAll(PDO::FETCH_KEY_PAIR));
}

/**
 * Messwerte per Upsert speichern – eine Transaktion für alle Zeilen.
 * @return array{inserted:int, updated:int, unchanged:int}
 */
function load_observations(PDO $pdo, array $rows, array $stationIds, int $importRunId): array
{
    // Reihenfolge im UPDATE-Teil ist wichtig: updated_at/import_run_id werden
    // ZUERST gesetzt, solange value/release_state noch die alten Werte haben.
    $stmt = $pdo->prepare(
        'INSERT INTO observations
            (station_id, parameter_code, measured_at, obs_date, value, release_state, import_run_id)
         VALUES
            (:station_id, :parameter_code, :measured_at, :obs_date, :value, :release_state, :import_run_id)
         ON DUPLICATE KEY UPDATE
            updated_at    = IF(value <=> VALUES(value) AND release_state <=> VALUES(release_state),
                               updated_at, CURRENT_TIMESTAMP),
            import_run_id = IF(value <=> VALUES(value) AND release_state <=> VALUES(release_state),
                               import_run_id, VALUES(import_run_id)),
            value         = VALUES(value),
            release_state = VALUES(release_state)'
    );

    $stats = ['inserted' => 0, 'updated' => 0, 'unchanged' => 0];
    $pdo->beginTransaction();
    try {
        foreach ($rows as $row) {
            $stmt->execute([
                'station_id'     => $stationIds[$row['station_no']],
                'parameter_code' => $row['parameter_code'],
                'measured_at'    => $row['measured_at'],
                'obs_date'       => $row['obs_date'],
                'value'          => $row['value'],
                'release_state'  => $row['release_state'],
                'import_run_id'  => $importRunId,
            ]);
            match ($stmt->rowCount()) {
                1       => $stats['inserted']++,
                2       => $stats['updated']++,
                default => $stats['unchanged']++,
            };
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack(); // alles oder nichts
        throw $e;
    }
    return $stats;
}

/** Import-Lauf beginnen (Protokoll). */
function start_import_run(PDO $pdo, string $mode): int
{
    $pdo->prepare(
        "INSERT INTO import_runs (started_at, status, mode, aggregation) VALUES (UTC_TIMESTAMP(), 'running', ?, ?)"
    )->execute([$mode, BAFU_AGGREGATION]);
    return (int) $pdo->lastInsertId();
}

/** Import-Lauf abschliessen. */
function finish_import_run(PDO $pdo, int $id, string $status, array $s, ?string $message): void
{
    $pdo->prepare(
        'UPDATE import_runs SET finished_at = UTC_TIMESTAMP(), status = ?, window_from = ?, window_to = ?,
            api_requests = ?, rows_received = ?, rows_inserted = ?, rows_updated = ?,
            rows_unchanged = ?, rows_rejected = ?, message = ?
         WHERE id = ?'
    )->execute([
        $status, $s['window_from'], $s['window_to'], $s['api_requests'], $s['received'],
        $s['inserted'], $s['updated'], $s['unchanged'], $s['rejected'], $message, $id,
    ]);
}

/** Protokolleinträge älter als ein Jahr löschen – Messwerte bleiben unberührt. */
function prune_import_runs(PDO $pdo, int $keepDays = 365): void
{
    $pdo->prepare('DELETE FROM import_runs WHERE started_at < UTC_TIMESTAMP() - INTERVAL ? DAY')->execute([$keepDays]);
}

/** Ab welchem Tag muss geladen werden? (READ) */
function import_start(PDO $pdo, string $mode, ?string $fromOption, int $expectedSeries): DateTimeImmutable
{
    $zone  = new DateTimeZone(DAY_TIMEZONE);
    $start = new DateTimeImmutable(IMPORT_START_DATE, $zone);

    if ($mode === 'full') {
        return $start;
    }
    if ($mode === 'from') {
        return max($start, new DateTimeImmutable($fromOption, $zone));
    }

    // Inkrementell: jüngster Tag pro aktiver Station & Messgrösse. Fehlt eine
    // Kombination (z.B. neue Station), wird ab IMPORT_START_DATE geladen.
    $latest = $pdo->query(
        'SELECT MAX(o.obs_date) AS last_date
         FROM observations o JOIN stations s ON s.id = o.station_id
         WHERE s.is_active = 1
         GROUP BY o.station_id, o.parameter_code'
    )->fetchAll(PDO::FETCH_COLUMN);

    if (count($latest) < $expectedSeries) {
        return $start;
    }
    $oldest = new DateTimeImmutable(min($latest), $zone);
    return max($start, $oldest->modify('-' . REVISION_DAYS . ' days'));
}

// ==================================================================
// ETL-Ablauf
// ==================================================================

// Aufruf nur per Kommandozeile – oder per URL mit gültigem Token
if (PHP_SAPI !== 'cli') {
    $token = app_config()['etl_token'];
    if ($token === '' || !hash_equals($token, (string) ($_GET['token'] ?? ''))) {
        http_response_code(403);
        exit('Forbidden');
    }
    header('Content-Type: text/plain; charset=utf-8');
    set_time_limit(300);
}

$say = function (string $line): void {
    echo $line, PHP_EOL;
    if (PHP_SAPI !== 'cli') {
        @ob_flush();
        flush();
    }
};

// Gleichzeitige Läufe verhindern (z.B. wenn ein Cronjob hängt)
$lock = fopen(__DIR__ . '/data/load.lock', 'c');
if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
    $say('Ein anderer Import läuft bereits.');
    exit(1);
}

$options = PHP_SAPI === 'cli' ? getopt('', ['full', 'from:']) : [];
$mode    = isset($options['full']) ? 'full' : (isset($options['from']) ? 'from' : 'incremental');
$stats   = ['api_requests' => 0, 'received' => 0, 'inserted' => 0, 'updated' => 0,
            'unchanged' => 0, 'rejected' => 0, 'window_from' => null, 'window_to' => null];

$say('BAFU-Import gestartet (' . gmdate('Y-m-d H:i:s') . " UTC, Modus: $mode)");

try {
    $pdo   = db();
    $runId = start_import_run($pdo, $mode);
} catch (Throwable $e) {
    log_message('error', 'Datenbank nicht erreichbar: ' . $e->getMessage(), 'etl');
    $say('FEHLER: Datenbank nicht erreichbar – ' . $e->getMessage());
    exit(2);
}

try {
    $selection = selected_stations();
    $zone      = new DateTimeZone(DAY_TIMEZONE);
    $utc       = new DateTimeZone('UTC');

    // --- Zeitraum bestimmen (nicht blind alles laden) ----------------------
    $from = import_start($pdo, $mode, $options['from'] ?? null, count($selection) * count(BAFU_PARAMETERS));
    $to   = new DateTimeImmutable('tomorrow', $zone); // bis und mit heute (exklusiv morgen 00:00)
    $stats['window_from'] = $from->format('Y-m-d');
    $stats['window_to']   = $to->modify('-1 day')->format('Y-m-d');
    $say("Zeitraum: {$stats['window_from']} bis {$stats['window_to']} (" . BAFU_AGGREGATION . ')');

    // --- 1) EXTRACT ---------------------------------------------------------
    $say('');
    $say('1) Extract: BAFU-API abfragen');
    $extract = run_extract($selection, $from->setTimezone($utc), $to->setTimezone($utc), $say);
    $stats['api_requests'] = $extract['api_requests'];
    $stats['received']     = count($extract['rows']);
    if ($extract['missing_stations']) {
        // Keine Station erfinden: fehlt eine in der API, wird sie übersprungen
        log_message('warning', 'Stationen nicht in der API: ' . implode(', ', $extract['missing_stations']), 'etl');
        $say('   WARNUNG: nicht gefunden: ' . implode(', ', $extract['missing_stations']));
    }
    $say(sprintf('   %d Stationen, %d Rohzeilen', count($extract['stations']), count($extract['rows'])));

    // --- 2) TRANSFORM -------------------------------------------------------
    $say('');
    $say('2) Transform: prüfen und aufbereiten');
    $transformed = run_transform($extract, $selection);
    $stats['rejected'] = array_sum($transformed['rejected']);
    $say(sprintf('   %d gültige Messwerte, %d verworfen', count($transformed['observations']), $stats['rejected']));
    foreach ($transformed['rejected'] as $reason => $n) {
        $say("   - $reason: $n");
    }

    // --- 3) LOAD ------------------------------------------------------------
    $say('');
    $say('3) Load: in MySQL speichern');
    $stationIds = load_stations($pdo, $transformed['stations']);
    $loaded     = load_observations($pdo, $transformed['observations'], $stationIds, $runId);
    $stats      = array_merge($stats, $loaded);
    prune_import_runs($pdo);

    $status  = $extract['failed_windows'] === 0 ? 'success' : 'partial';
    $message = $transformed['rejected']
        ? 'Verworfen: ' . json_encode($transformed['rejected'], JSON_UNESCAPED_UNICODE) : null;
    if ($extract['failed_windows']) {
        $message = trim("{$extract['failed_windows']} Zeitfenster fehlgeschlagen. " . $message);
    }
    finish_import_run($pdo, $runId, $status, $stats, $message);
} catch (Throwable $e) {
    // Z.B. BAFU-API nicht erreichbar: Die bestehenden Daten in der Datenbank
    // bleiben unangetastet – die Website funktioniert weiter.
    log_message('error', get_class($e) . ': ' . $e->getMessage(), 'etl');
    finish_import_run($pdo, $runId, 'failed', $stats, mb_substr($e->getMessage(), 0, 1000));
    $say('FEHLER: ' . $e->getMessage());
    $say('Die bereits gespeicherten Daten bleiben unverändert.');
    exit(2);
}

// --- Zusammenfassung --------------------------------------------------------
$total = (int) $pdo->query('SELECT COUNT(*) FROM observations')->fetchColumn();
$say('');
$say('Zusammenfassung');
$say('---------------');
$say("Status:           $status");
$say("API-Requests:     {$stats['api_requests']}");
$say("Empfangen:        {$stats['received']}");
$say("Neu eingefügt:    {$stats['inserted']}");
$say("Aktualisiert:     {$stats['updated']}");
$say("Unverändert:      {$stats['unchanged']}");
$say("Verworfen:        {$stats['rejected']}");
$say("Messwerte total:  $total");

log_message('info', sprintf('Import #%d %s: %d empfangen, %d neu, %d aktualisiert, %d verworfen',
    $runId, $status, $stats['received'], $stats['inserted'], $stats['updated'], $stats['rejected']), 'etl');

exit($status === 'success' ? 0 : 1);
