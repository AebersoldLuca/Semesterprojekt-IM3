<?php
/**
 * ============================================================
 *  4) U N L O A D   –   MySQL  →  JSON  →  script.js
 * ============================================================
 *
 * Liest die gespeicherten Tagesmittel aus der EIGENEN Datenbank und gibt sie
 * als JSON an das Frontend. Hier wird NIE die BAFU-API aufgerufen – deshalb
 * funktioniert die Website auch, wenn die BAFU-API gerade nicht erreichbar ist.
 *
 * Die Antwort entspricht 1:1 unserem DATENVERTRAG (Version 1):
 *
 *   Ein Datensatz steht für: eine Messstation (ein Fluss) an einem Tag – das Tagesmittel.
 *
 *   Feldname                  Typ     Beispiel       Bedeutung und Einheit                               darf fehlen?
 *   station_no                String  "2044"         BAFU-Nummer der Messstation                          nein
 *   river_name                String  "Thur"         Name des Gewässers                                   nein
 *   station_name              String  "Andelfingen"  Ort der Messstation                                  nein
 *   date                      String  "2026-09-27"   Kalendertag des Tagesmittels                         nein
 *   water_temperature_c       Number  16.8           Wassertemperatur, Tagesmittel in °C                  ja, dann null
 *   water_level_deviation_cm  Number  -27            Wasserstand: Abweichung vom mittleren Pegel in cm    ja, dann null
 *   release_state             Number  2              Prüfstatus BAFU: 1 provisorisch, 2 validiert,        ja, dann null
 *                                                    3 definitiv
 *
 *   Filter (alle optional, kombinierbar):
 *   stations   unload.php?stations=2044              nur bestimmte Flüsse (kommagetrennt)
 *   parameter  unload.php?parameter=WT               WT = Wassertemperatur, W = Wasserstand
 *                                                    (die andere Messgrösse ist dann null)
 *   years      unload.php?years=2022,2026            nur diese Kalenderjahre
 *   from / to  unload.php?from=2026-01-01&to=2026-09-27   nur dieser Zeitraum
 *
 *   Ohne Filter: alle Flüsse, die letzten 365 Tage bis zum jüngsten Messtag.
 *
 * Antwort: ein JSON-Array von Datensätzen, sortiert nach Station und Datum.
 * Bei Fehlern: {"error": "…"} mit passendem HTTP-Status (400, 404, 405, 503, 500).
 */

require_once __DIR__ . '/db.php';

/** Erlaubte Werte für «parameter» */
const PARAMETERS = ['W', 'WT'];

/** Fehler, deren Meldung dem Besucher gezeigt werden darf (z.B. ungültiger Filter). */
class UnloadException extends RuntimeException
{
    public function __construct(string $message, public int $status = 400)
    {
        parent::__construct($message);
    }
}

ini_set('display_errors', '0'); // PHP-Warnungen würden das JSON zerstören

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        header('Allow: GET');
        throw new UnloadException('Nur GET-Anfragen sind erlaubt.', 405);
    }
    try {
        $pdo = db();
    } catch (Throwable $e) { // Server down, falsche Zugangsdaten oder config.php fehlt
        log_message('error', 'DB-Verbindung: ' . $e->getMessage(), 'unload');
        throw new UnloadException('Die Datenbank ist momentan nicht erreichbar.', 503);
    }
    send_json(unload_records($pdo));
} catch (UnloadException $e) {
    send_json(['error' => $e->getMessage()], $e->status);
} catch (PDOException $e) {
    log_message('error', 'DB: ' . $e->getMessage(), 'unload');
    send_json(['error' => 'Die Datenbank ist momentan nicht erreichbar.'], 503);
} catch (Throwable $e) {
    log_message('error', get_class($e) . ': ' . $e->getMessage(), 'unload');
    send_json(['error' => 'Interner Fehler. Bitte später erneut versuchen.'], 500);
}

function send_json(array $data, int $status = 200): void
{
    // Komprimiert senden, falls möglich (die Antwort kann einige tausend Datensätze enthalten)
    if (!headers_sent() && extension_loaded('zlib') && !ini_get('zlib.output_compression')) {
        ob_start('ob_gzhandler');
    }
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    // Daten ändern sich höchstens einmal täglich → 5 Minuten Browser-Cache
    header('Cache-Control: ' . ($status === 200 ? 'public, max-age=300' : 'no-store'));
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
}

// ==================================================================
// Datensätze gemäss Datenvertrag
// ==================================================================

function unload_records(PDO $pdo): array
{
    // 1) Filter prüfen (Whitelist / festes Format – nie ungeprüft ins SQL)
    $stations  = input_stations($_GET['stations'] ?? null);
    $parameter = input_parameter($_GET['parameter'] ?? null);
    $years     = input_years($_GET['years'] ?? null);
    $from      = input_date($_GET['from'] ?? null, 'from');
    $to        = input_date($_GET['to'] ?? null, 'to');

    // Ohne Jahres- und Datumsfilter: die letzten 365 Tage bis zum jüngsten Messtag
    if (!$years && $from === null && $to === null) {
        $latest = $pdo->query('SELECT MAX(obs_date) FROM observations')->fetchColumn();
        if (!$latest) {
            return [];
        }
        $to   = $latest;
        $from = (new DateTimeImmutable($latest))->modify('-364 days')->format('Y-m-d');
    }
    if ($from !== null && $to !== null && $from > $to) {
        throw new UnloadException('«from» muss vor «to» liegen.');
    }

    // 2) Unbekannte Stationen melden
    if ($stations) {
        $stmt = $pdo->prepare('SELECT station_no FROM stations WHERE is_active = 1 AND station_no IN (' . placeholders($stations) . ')');
        $stmt->execute($stations);
        $unknown = array_diff($stations, $stmt->fetchAll(PDO::FETCH_COLUMN));
        if ($unknown) {
            throw new UnloadException('Unbekannte Station: ' . implode(', ', $unknown), 404);
        }
    }

    // 3) SQL mit Prepared-Statement-Parametern zusammensetzen
    $where  = ['s.is_active = 1'];
    $params = [];
    if ($stations) {
        $where[] = 's.station_no IN (' . placeholders($stations) . ')';
        array_push($params, ...$stations);
    }
    if ($parameter) {
        $where[]  = 'o.parameter_code = ?';
        $params[] = $parameter;
    }
    if ($years) {
        $where[] = 'YEAR(o.obs_date) IN (' . placeholders($years) . ')';
        array_push($params, ...$years);
    }
    if ($from !== null) {
        $where[]  = 'o.obs_date >= ?';
        $params[] = $from;
    }
    if ($to !== null) {
        $where[]  = 'o.obs_date <= ?';
        $params[] = $to;
    }

    // Pro Station und Tag eine Zeile: Wassertemperatur und Wasserstand nebeneinander (Pivot).
    // Der Wasserstand wird als Abweichung vom mittleren Pegel der Station über den
    // gesamten gespeicherten Zeitraum berechnet (absolute m ü.M. sind zwischen
    // Stationen nicht vergleichbar).
    $sql = 'SELECT s.station_no, s.river_name, s.name AS station_name, o.obs_date AS date,
                   MAX(CASE WHEN o.parameter_code = \'WT\' THEN o.value END)         AS wt,
                   MAX(CASE WHEN o.parameter_code = \'WT\' THEN o.release_state END) AS wt_state,
                   MAX(CASE WHEN o.parameter_code = \'W\'  THEN o.value END)         AS w,
                   MAX(CASE WHEN o.parameter_code = \'W\'  THEN o.release_state END) AS w_state,
                   b.mean_level
            FROM observations o
            JOIN stations s ON s.id = o.station_id
            LEFT JOIN (SELECT station_id, AVG(value) AS mean_level
                       FROM observations WHERE parameter_code = \'W\' GROUP BY station_id) b
                   ON b.station_id = s.id
            WHERE ' . implode(' AND ', $where) . '
            GROUP BY s.id, o.obs_date
            ORDER BY s.sort_order, o.obs_date';
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    // 4) In die Form des Datenvertrags bringen
    $records = [];
    foreach ($stmt as $r) {
        $hasWt = $r['wt'] !== null;
        $hasW  = $r['w'] !== null && $r['mean_level'] !== null;
        $records[] = [
            'station_no'               => (string) $r['station_no'],
            'river_name'               => $r['river_name'],
            'station_name'             => station_place($r['station_name']),
            'date'                     => $r['date'],
            'water_temperature_c'      => $hasWt ? round((float) $r['wt'], 2) : null,
            'water_level_deviation_cm' => $hasW ? round(((float) $r['w'] - (float) $r['mean_level']) * 100, 1) : null,
            'release_state'            => record_release_state($hasWt ? $r['wt_state'] : false, $hasW ? $r['w_state'] : false),
        ];
    }
    return $records;
}

/**
 * «Andelfingen» statt z.B. «Rheinfelden, Messstation»: Der Ort ist der Teil
 * vor dem ersten Komma im BAFU-Stationsnamen.
 */
function station_place(string $name): string
{
    return trim(explode(',', $name)[0]);
}

/**
 * Ein Datensatz enthält bis zu zwei Messwerte mit je eigenem BAFU-Prüfstatus.
 * Im Datensatz steht der vorsichtigere Status: der tiefere der beiden, und null,
 * sobald einer der vorhandenen Werte gar keinen Status hat.
 * (false = dieser Messwert ist im Datensatz nicht vorhanden)
 */
function record_release_state($a, $b): ?int
{
    $states = array_filter([$a, $b], fn($s) => $s !== false);
    if (!$states || in_array(null, $states, true)) {
        return null;
    }
    return (int) min($states);
}

// ==================================================================
// Filter prüfen
// ==================================================================

/** Kommagetrennte vierstellige BAFU-Nummern, z.B. "2019,2243". */
function input_stations(?string $value): array
{
    if ($value === null || $value === '') {
        return [];
    }
    $nos = array_values(array_unique(array_filter(array_map('trim', explode(',', $value)), 'strlen')));
    foreach ($nos as $no) {
        if (!preg_match('/^\d{4}$/', $no)) {
            throw new UnloadException('Ungültige Stationsnummer: ' . mb_substr($no, 0, 20));
        }
    }
    if (count($nos) > 20) {
        throw new UnloadException('Zu viele Stationen angefragt.');
    }
    return $nos;
}

/** WT oder W; null = beide Messgrössen. */
function input_parameter(?string $value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    if (!in_array($value, PARAMETERS, true)) {
        throw new UnloadException('Ungültiger Parameter. Erlaubt: WT, W');
    }
    return $value;
}

/** Kommagetrennte Jahreszahlen, z.B. "2022,2026" (höchstens 10 Jahre). */
function input_years(?string $value): array
{
    if ($value === null || $value === '') {
        return [];
    }
    $years = array_values(array_unique(array_filter(array_map('trim', explode(',', $value)), 'strlen')));
    foreach ($years as $y) {
        if (!preg_match('/^(19|20)\d{2}$/', $y)) {
            throw new UnloadException('Ungültige Jahreszahl: ' . mb_substr($y, 0, 20));
        }
    }
    if (count($years) > 10) {
        throw new UnloadException('Höchstens 10 Jahre auf einmal.');
    }
    return array_map('intval', $years);
}

/** Datum im Format YYYY-MM-DD (streng geprüft, z.B. kein 30. Februar). */
function input_date(?string $value, string $name): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    $d = DateTimeImmutable::createFromFormat('!Y-m-d', $value);
    if ($d === false || $d->format('Y-m-d') !== $value) {
        throw new UnloadException("Ungültiges Datum für «{$name}». Format: YYYY-MM-DD");
    }
    return $value;
}

/** "?,?,?" für IN (...) */
function placeholders(array $values): string
{
    return implode(',', array_fill(0, count($values), '?'));
}
