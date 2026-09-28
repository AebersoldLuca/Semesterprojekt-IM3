<?php
/**
 * ============================================================
 *  4) U N L O A D   –   MySQL  →  JSON  →  script.js
 * ============================================================
 *
 * Liest die gespeicherten Daten aus der EIGENEN Datenbank und gibt sie als
 * JSON an das Frontend. Hier wird NIE die BAFU-API aufgerufen – deshalb
 * funktioniert die Website auch, wenn die BAFU-API gerade nicht erreichbar ist.
 *
 * Aufruf: unload.php?type=…
 *
 *   type=stations      aktive Messstationen inkl. verfügbarem Zeitraum
 *   type=observations  Tagesmittel für die Hauptgrafik
 *                        stations=2019,2243   (optional, Standard: alle aktiven)
 *                        parameter=W|WT       (optional, Standard: beide)
 *                        from=YYYY-MM-DD      (optional, Standard: to − 364 Tage)
 *                        to=YYYY-MM-DD        (optional, Standard: jüngster Tag in der DB)
 *   type=seasonal      typischer Jahresgang (Monatsmittel), parameter=W|WT
 *   type=insights      Kennzahlen für die Texte der DataStory
 *   type=compare       Vergleich zweier Jahre, z.B. years=2022,2026 (Hypothese der Story)
 *   type=meta          Quelle, Zeitraum, letzter Import, Freigabestatus
 *
 * Beispiel: unload.php?type=observations&stations=2019,2243&parameter=WT&from=2026-01-01&to=2026-09-21
 *
 * Sicherheit: Alle Eingaben werden gegen eine Whitelist bzw. ein festes
 * Format geprüft und nur als Prepared-Statement-Parameter an MySQL übergeben.
 */

require_once __DIR__ . '/db.php';

/** Messgrössen, die das Frontend anfragen darf. */
const UNLOAD_PARAMETERS = ['W' => 'm ü.M.', 'WT' => '°C'];

/** Fehler, deren Meldung dem Besucher gezeigt werden darf (z.B. ungültiger Parameter). */
class UnloadException extends RuntimeException
{
    public function __construct(string $message, public int $status = 400)
    {
        parent::__construct($message);
    }
}

// ==================================================================
// Ablauf: Anfrage prüfen → passende Funktion → JSON
// ==================================================================

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
    $data = match ($_GET['type'] ?? '') {
        'stations'     => unload_stations($pdo),
        'observations' => unload_observations($pdo),
        'seasonal'     => unload_seasonal($pdo),
        'insights'     => unload_insights($pdo),
        'compare'      => unload_compare($pdo),
        'meta'         => unload_meta($pdo),
        default        => throw new UnloadException('Unbekannter oder fehlender Parameter «type». Erlaubt: stations, observations, seasonal, insights, compare, meta.'),
    };
    send_json($data);
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
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    // Daten ändern sich höchstens einmal täglich → 5 Minuten Browser-Cache
    header('Cache-Control: ' . ($status === 200 ? 'public, max-age=300' : 'no-store'));
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
}

// ==================================================================
// Endpunkte
// ==================================================================

/** type=stations */
function unload_stations(PDO $pdo): array
{
    $stations = fetch_stations($pdo);

    // Verfügbarkeit pro Station und Messgrösse
    $coverage = [];
    $stmt = $pdo->query(
        'SELECT station_id, parameter_code, COUNT(*) AS n, MIN(obs_date) AS first_date, MAX(obs_date) AS last_date
         FROM observations GROUP BY station_id, parameter_code'
    );
    foreach ($stmt as $r) {
        $coverage[(int) $r['station_id']][$r['parameter_code']] =
            ['count' => (int) $r['n'], 'first' => $r['first_date'], 'last' => $r['last_date']];
    }

    $out = [];
    foreach ($stations as $s) {
        $s['coverage'] = $coverage[$s['id']] ?? (object) [];
        unset($s['id']);
        $out[] = $s;
    }
    return ['stations' => $out];
}

/**
 * type=observations – Tagesmittel für die Hauptgrafik.
 *
 * Antwort kompakt, eine Zeile pro Station und Tag:
 *   columns: ["date","W","W_release","WT","WT_release"]
 *   series:  { "2019": [["2026-09-21", 569.96, null, 9.23, null], …], … }
 * Fehlende Tage fehlen auch in der Antwort – es wird nichts aufgefüllt.
 */
function unload_observations(PDO $pdo): array
{
    // 1) Eingaben validieren
    $parameter = input_parameter($_GET['parameter'] ?? null);
    $stations  = fetch_stations($pdo, input_stations($_GET['stations'] ?? null));
    $to        = input_date($_GET['to'] ?? null, 'to') ?? latest_obs_date($pdo);
    if ($to === null || !$stations) {
        throw new UnloadException('Es sind noch keine Messwerte in der Datenbank.', 404);
    }
    $from = input_date($_GET['from'] ?? null, 'from')
        ?? (new DateTimeImmutable($to))->modify('-364 days')->format('Y-m-d');
    if ($from > $to) {
        throw new UnloadException('«from» muss vor «to» liegen.');
    }
    if ((new DateTimeImmutable($from))->diff(new DateTimeImmutable($to))->days > 3700) {
        throw new UnloadException('Zeitraum zu lang (max. ca. 10 Jahre).');
    }

    $ids    = array_column($stations, 'id');
    $params = $parameter ? [$parameter] : array_keys(UNLOAD_PARAMETERS);

    // 2) Messwerte lesen: pro Station und Tag eine Zeile, W und WT nebeneinander
    //    (Pivot mit CASE). Alle Werte gehen als Prepared-Statement-Parameter rein.
    $stmt = $pdo->prepare(
        'SELECT s.station_no, o.obs_date,
                MAX(CASE WHEN o.parameter_code = \'W\'  THEN o.value END)         AS w,
                MAX(CASE WHEN o.parameter_code = \'W\'  THEN o.release_state END) AS w_rs,
                MAX(CASE WHEN o.parameter_code = \'WT\' THEN o.value END)         AS wt,
                MAX(CASE WHEN o.parameter_code = \'WT\' THEN o.release_state END) AS wt_rs
         FROM observations o
         JOIN stations s ON s.id = o.station_id
         WHERE o.station_id IN (' . placeholders($ids) . ')
           AND o.parameter_code IN (' . placeholders($params) . ')
           AND o.obs_date BETWEEN ? AND ?
         GROUP BY s.station_no, o.obs_date
         ORDER BY s.station_no, o.obs_date'
    );
    $stmt->execute([...$ids, ...$params, $from, $to]);

    $series = [];
    foreach ($stations as $s) {
        $series[$s['station_no']] = [];
    }
    foreach ($stmt as $r) {
        $series[$r['station_no']][] = [
            $r['obs_date'],
            $r['w']     !== null ? (float) $r['w'] : null,
            $r['w_rs']  !== null ? (int) $r['w_rs'] : null,
            $r['wt']    !== null ? (float) $r['wt'] : null,
            $r['wt_rs'] !== null ? (int) $r['wt_rs'] : null,
        ];
    }

    // 3) Mittlerer Pegel pro Station über den GESAMTEN gespeicherten Zeitraum.
    //    Absolute Pegel (m ü.M.) sind zwischen Stationen nicht vergleichbar –
    //    das Frontend zeigt die Abweichung von diesem festen Mittelwert in cm.
    $baseline = w_baselines($pdo, $ids);

    $meta = [];
    foreach ($stations as $s) {
        $meta[] = [
            'station_no'   => $s['station_no'],
            'display_name' => $s['display_name'],
            'river_name'   => $s['river_name'],
            'name'         => $s['name'],
            'sort_order'   => $s['sort_order'],
            'w_mean_level' => isset($baseline[$s['id']]) ? round($baseline[$s['id']], 3) : null,
        ];
    }

    return [
        'source'    => 'Eigene MySQL-Datenbank (Import aus BAFU «Hydrologische Beobachtungen», Tagesmittel)',
        'from'      => $from,
        'to'        => $to,
        'parameter' => $parameter,
        'units'     => UNLOAD_PARAMETERS,
        'columns'   => ['date', 'W', 'W_release', 'WT', 'WT_release'],
        'stations'  => $meta,
        'series'    => (object) $series,
    ];
}

/**
 * type=seasonal – typischer Jahresgang: pro Monat das Mittel der Monatsmittel
 * aller VOLLSTÄNDIGEN Kalenderjahre, dazu tiefstes/höchstes Monatsmittel als
 * Spannweite. Wasserstand als Abweichung vom mittleren Pegel in cm.
 */
function unload_seasonal(PDO $pdo): array
{
    $parameter = input_parameter($_GET['parameter'] ?? null) ?? 'WT';
    $stations  = fetch_stations($pdo, input_stations($_GET['stations'] ?? null));
    $years     = complete_years($pdo);
    if (!$stations || !$years) {
        throw new UnloadException('Noch nicht genug Daten für einen Jahresgang (mind. ein volles Kalenderjahr).', 404);
    }

    $ids       = array_column($stations, 'id');
    $baselines = $parameter === 'W' ? w_baselines($pdo, $ids) : [];

    $byStationMonth = [];
    foreach (fetch_monthly($pdo, $ids) as $r) {
        // nur vollständige Jahre und weitgehend vollständige Monate (≥ 25 Tage)
        if ($r['param'] !== $parameter || !in_array($r['y'], $years, true) || $r['n'] < 25) {
            continue;
        }
        $v = $parameter === 'W' ? ($r['mean'] - $baselines[$r['station_id']]) * 100 : $r['mean'];
        $byStationMonth[$r['station_id']][$r['m']][] = $v;
    }

    $out = [];
    foreach ($stations as $s) {
        $months = [];
        for ($m = 1; $m <= 12; $m++) {
            $vals = $byStationMonth[$s['id']][$m] ?? [];
            $months[] = $vals ? [
                'month' => $m,
                'mean'  => round(array_sum($vals) / count($vals), 2),
                'min'   => round(min($vals), 2),
                'max'   => round(max($vals), 2),
                'years' => count($vals),
            ] : ['month' => $m, 'mean' => null, 'min' => null, 'max' => null, 'years' => 0];
        }
        $out[] = ['station_no' => $s['station_no'], 'display_name' => $s['display_name'], 'months' => $months];
    }

    return [
        'parameter' => $parameter,
        'unit'      => $parameter === 'W' ? 'cm (Abweichung vom mittleren Pegel)' : '°C',
        'years'     => [$years[0], end($years)],
        'stations'  => $out,
    ];
}

/**
 * type=insights – Kennzahlen für die Texte der DataStory. Das Frontend baut
 * daraus Sätze wie «Die Limmat erreichte am … 27.0 °C». So stammen alle Zahlen
 * in der Story aus MySQL und aktualisieren sich nach jedem Import von selbst.
 */
function unload_insights(PDO $pdo): array
{
    $stations = fetch_stations($pdo);
    $years    = complete_years($pdo);
    $latest   = latest_obs_date($pdo);
    if (!$stations || $latest === null) {
        throw new UnloadException('Es sind noch keine Messwerte in der Datenbank.', 404);
    }
    $ids       = array_column($stations, 'id');
    $in        = placeholders($ids);
    $baselines = w_baselines($pdo, $ids);

    // 1) Extremwerte mit Datum (bei Gleichstand der früheste Tag)
    $extremes = [];
    foreach (['MAX' => 'max', 'MIN' => 'min'] as $fn => $key) {
        $stmt = $pdo->prepare(
            "SELECT o.station_id, o.parameter_code, MIN(o.obs_date) AS obs_date, o.value
             FROM observations o
             JOIN (SELECT station_id, parameter_code, $fn(value) AS v
                   FROM observations WHERE station_id IN ($in)
                   GROUP BY station_id, parameter_code) e
               ON e.station_id = o.station_id AND e.parameter_code = o.parameter_code AND e.v = o.value
             GROUP BY o.station_id, o.parameter_code, o.value"
        );
        $stmt->execute($ids);
        foreach ($stmt as $r) {
            $extremes[(int) $r['station_id']][$r['parameter_code']][$key] =
                ['date' => $r['obs_date'], 'value' => (float) $r['value']];
        }
    }

    // 2) Jüngster Messwert pro Station und Messgrösse
    $stmt = $pdo->prepare(
        "SELECT o.station_id, o.parameter_code, o.obs_date, o.value, o.release_state
         FROM observations o
         JOIN (SELECT station_id, parameter_code, MAX(obs_date) AS d
               FROM observations WHERE station_id IN ($in) GROUP BY station_id, parameter_code) l
           ON l.station_id = o.station_id AND l.parameter_code = o.parameter_code AND l.d = o.obs_date"
    );
    $stmt->execute($ids);
    $latestValues = [];
    foreach ($stmt as $r) {
        $latestValues[(int) $r['station_id']][$r['parameter_code']] = [
            'date' => $r['obs_date'], 'value' => (float) $r['value'],
            'release_state' => $r['release_state'] !== null ? (int) $r['release_state'] : null,
        ];
    }

    // 3) Monats- und Jahresstatistik
    $monthly = []; // [station][param][month] = Monatsmittel der vollständigen Jahre
    $yearly  = []; // [station][year] = max, Tage ≥ 20 °C, Anzahl Tage (WT)
    foreach (fetch_monthly($pdo, $ids) as $r) {
        $sid = $r['station_id'];
        if (in_array($r['y'], $years, true) && $r['n'] >= 25) {
            $monthly[$sid][$r['param']][$r['m']][] = $r['mean'];
        }
        if ($r['param'] === 'WT') {
            $y = $yearly[$sid][$r['y']] ?? ['max' => -INF, 'days_ge_20' => 0, 'days' => 0];
            $yearly[$sid][$r['y']] = [
                'max'        => max($y['max'], $r['max']),
                'days_ge_20' => $y['days_ge_20'] + $r['days_ge_20'],
                'days'       => $y['days'] + $r['n'],
            ];
        }
    }

    // 4) Faire Jahresvergleiche: Das laufende Jahr ist unvollständig. Damit Jahre
    //    vergleichbar sind, wird für JEDES Jahr nur der Zeitraum 1.1. bis
    //    Tag/Monat des jüngsten Messwerts gemittelt (z.B. jeweils 1.1.–21.9.).
    $cutoff = substr($latest, 5); // 'MM-DD'
    $stmt = $pdo->prepare(
        "SELECT station_id, parameter_code, YEAR(obs_date) AS y, AVG(value) AS mean, COUNT(*) AS n
         FROM observations
         WHERE station_id IN ($in) AND DATE_FORMAT(obs_date, '%m-%d') <= ?
         GROUP BY station_id, parameter_code, y ORDER BY y"
    );
    $stmt->execute([...$ids, $cutoff]);
    $ytd = [];
    foreach ($stmt as $r) {
        $sid = (int) $r['station_id'];
        $y   = (int) $r['y'];
        $p   = $r['parameter_code'];
        $ytd[$sid][$y]['year'] = $y;
        $ytd[$sid][$y]["days_$p"] = (int) $r['n'];
        $ytd[$sid][$y][$p] = $p === 'W'
            ? round(((float) $r['mean'] - $baselines[$sid]) * 100, 1) // cm Abweichung vom mittleren Pegel
            : round((float) $r['mean'], 2);                          // °C
    }

    $out = [];
    foreach ($stations as $s) {
        $sid = $s['id'];

        // Typischer Jahresgang (Mittel der Monatsmittel): höchster/tiefster Monat
        $season = [];
        foreach (['W', 'WT'] as $p) {
            $means = [];
            foreach ($monthly[$sid][$p] ?? [] as $m => $vals) {
                $means[$m] = array_sum($vals) / count($vals);
            }
            if (!$means) {
                $season[$p] = null;
                continue;
            }
            $hi = array_search(max($means), $means, true);
            $lo = array_search(min($means), $means, true);
            $toUnit = fn($v) => $p === 'W' ? round(($v - $baselines[$sid]) * 100, 1) : round($v, 2);
            $season[$p] = [
                'high_month' => $hi, 'high' => $toUnit($means[$hi]),
                'low_month'  => $lo, 'low'  => $toUnit($means[$lo]),
                'amplitude'  => round(($means[$hi] - $means[$lo]) * ($p === 'W' ? 100 : 1), 1),
            ];
        }

        $byYear = [];
        foreach ($yearly[$sid] ?? [] as $year => $y) {
            $byYear[] = [
                'year' => $year, 'max' => round($y['max'], 2), 'days_ge_20' => $y['days_ge_20'],
                'days' => $y['days'], 'complete' => in_array($year, $years, true),
            ];
        }

        $w  = $extremes[$sid]['W'] ?? null;
        $lw = $latestValues[$sid]['W'] ?? null;
        $out[] = [
            'station_no'   => $s['station_no'],
            'display_name' => $s['display_name'],
            'river_name'   => $s['river_name'],
            'story_role'   => $s['story_role'],
            'ytd'          => array_values($ytd[$sid] ?? []),
            'WT' => [
                'max'     => $extremes[$sid]['WT']['max'] ?? null,
                'min'     => $extremes[$sid]['WT']['min'] ?? null,
                'latest'  => $latestValues[$sid]['WT'] ?? null,
                'season'  => $season['WT'],
                'by_year' => $byYear,
            ],
            'W' => [
                'mean_level' => isset($baselines[$sid]) ? round($baselines[$sid], 3) : null,
                'max'        => $w['max'] ?? null,
                'min'        => $w['min'] ?? null,
                'range_cm'   => $w ? round(($w['max']['value'] - $w['min']['value']) * 100) : null,
                'latest'     => $lw ? $lw + ['deviation_cm' => round(($lw['value'] - $baselines[$sid]) * 100, 1)] : null,
                'season'     => $season['W'],
            ],
        ];
    }

    return [
        'latest_date'    => $latest,
        'complete_years' => $years ? [$years[0], end($years)] : null,
        'ytd_cutoff'     => $cutoff,
        'stations'       => $out,
    ];
}

/**
 * type=compare&years=2022,2026 – Vergleich zweier Jahre für die Hypothese
 * «2026 waren die Flüsse im Mittelland bisher wärmer und führten weniger Wasser
 * als im Hitzesommer 2022».
 *
 * Fair verglichen wird immer derselbe Zeitraum: 1. Januar bis zum Stichtag
 * (Tag/Monat des jüngsten Messwerts, falls das jüngere Jahr noch läuft).
 *
 * Pro Station und Jahr:
 *   summary  Kennzahlen bis zum Stichtag (Mittel, Maximum, Tage ≥ 20/25 °C,
 *            mittlerer und tiefster Pegel, Anteil geprüfter Werte)
 *   series   alle Tageswerte des Jahres: [MM-DD, Wassertemperatur, Pegel in cm]
 * Pegel = Abweichung vom mittleren Pegel der Station (gesamter Zeitraum) in cm.
 */
function unload_compare(PDO $pdo): array
{
    // 1) Eingaben prüfen: genau zwei Jahreszahlen
    $years = array_values(array_unique(array_map('trim', explode(',', (string) ($_GET['years'] ?? '2022,2026')))));
    if (count($years) !== 2 || !preg_match('/^\d{4}$/', $years[0]) || !preg_match('/^\d{4}$/', $years[1])) {
        throw new UnloadException('Parameter «years» muss zwei Jahreszahlen enthalten, z.B. years=2022,2026.');
    }
    $years = array_map('intval', $years);
    sort($years);

    $stations = fetch_stations($pdo);
    $latest   = latest_obs_date($pdo);
    if (!$stations || $latest === null) {
        throw new UnloadException('Es sind noch keine Messwerte in der Datenbank.', 404);
    }
    $ids       = array_column($stations, 'id');
    $in        = placeholders($ids);
    $baselines = w_baselines($pdo, $ids);

    // Stichtag: Läuft das jüngere Jahr noch, wird bis zu dessen letztem Messtag verglichen
    $cutoff = (int) substr($latest, 0, 4) === $years[1] ? substr($latest, 5) : '12-31';

    // 2) Kennzahlen bis zum Stichtag – in SQL aggregiert
    $stmt = $pdo->prepare(
        "SELECT station_id, YEAR(obs_date) AS y, parameter_code AS p,
                COUNT(*) AS n, AVG(value) AS mean, MIN(value) AS min, MAX(value) AS max,
                SUM(value >= 20) AS ge20, SUM(value >= 25) AS ge25,
                SUM(release_state IN (2, 3)) AS checked
         FROM observations
         WHERE station_id IN ($in) AND YEAR(obs_date) IN (?, ?) AND DATE_FORMAT(obs_date, '%m-%d') <= ?
         GROUP BY station_id, y, p"
    );
    $stmt->execute([...$ids, $years[0], $years[1], $cutoff]);
    $agg = [];
    foreach ($stmt as $r) {
        $agg[(int) $r['station_id']][(int) $r['y']][$r['p']] = $r;
    }

    // Datum des Maximums (Temperatur) bzw. Minimums (Pegel) bis zum Stichtag
    $extremeDate = $pdo->prepare(
        "SELECT MIN(obs_date) FROM observations
         WHERE station_id = ? AND parameter_code = ? AND YEAR(obs_date) = ? AND value = ?
           AND DATE_FORMAT(obs_date, '%m-%d') <= ?"
    );
    $dateOf = function (int $sid, string $p, int $y, $value) use ($extremeDate, $cutoff) {
        $extremeDate->execute([$sid, $p, $y, $value, $cutoff]);
        return $extremeDate->fetchColumn() ?: null;
    };

    // 3) Tageswerte beider Jahre (für die Grafik, ganzes Jahr)
    $stmt = $pdo->prepare(
        "SELECT station_id, YEAR(obs_date) AS y, DATE_FORMAT(obs_date, '%m-%d') AS md,
                MAX(CASE WHEN parameter_code = 'WT' THEN value END) AS wt,
                MAX(CASE WHEN parameter_code = 'W'  THEN value END) AS w
         FROM observations
         WHERE station_id IN ($in) AND YEAR(obs_date) IN (?, ?)
         GROUP BY station_id, obs_date ORDER BY station_id, obs_date"
    );
    $stmt->execute([...$ids, $years[0], $years[1]]);
    $series = [];
    foreach ($stmt as $r) {
        $sid = (int) $r['station_id'];
        $series[$sid][(int) $r['y']][] = [
            $r['md'],
            $r['wt'] !== null ? round((float) $r['wt'], 2) : null,
            $r['w'] !== null ? round(((float) $r['w'] - $baselines[$sid]) * 100, 1) : null,
        ];
    }

    // 4) Antwort zusammenbauen
    $out = [];
    foreach ($stations as $s) {
        $sid = $s['id'];
        $perYear = [];
        foreach ($years as $y) {
            $wt = $agg[$sid][$y]['WT'] ?? null;
            $w  = $agg[$sid][$y]['W'] ?? null;
            $cm = fn($v) => round(((float) $v - $baselines[$sid]) * 100, 1);
            $perYear[$y] = [
                'summary' => [
                    'wt_mean'      => $wt ? round((float) $wt['mean'], 2) : null,
                    'wt_max'       => $wt ? round((float) $wt['max'], 2) : null,
                    'wt_max_date'  => $wt ? $dateOf($sid, 'WT', $y, $wt['max']) : null,
                    'days_ge_20'   => $wt ? (int) $wt['ge20'] : null,
                    'days_ge_25'   => $wt ? (int) $wt['ge25'] : null,
                    'days_wt'      => $wt ? (int) $wt['n'] : 0,
                    'w_mean_cm'    => $w ? $cm($w['mean']) : null,
                    'w_min_cm'     => $w ? $cm($w['min']) : null,
                    'w_min_date'   => $w ? $dateOf($sid, 'W', $y, $w['min']) : null,
                    'days_w'       => $w ? (int) $w['n'] : 0,
                    // Anteil vom BAFU geprüfter Werte (Status 2 oder 3)
                    'checked_share' => ($wt || $w)
                        ? round(((int) ($wt['checked'] ?? 0) + (int) ($w['checked'] ?? 0)) / max(1, (int) ($wt['n'] ?? 0) + (int) ($w['n'] ?? 0)), 3)
                        : null,
                ],
                'series' => $series[$sid][$y] ?? [],
            ];
        }
        $out[] = [
            'station_no'   => $s['station_no'],
            'display_name' => $s['display_name'],
            'river_name'   => $s['river_name'],
            'name'         => $s['name'],
            'sort_order'   => $s['sort_order'],
            'years'        => (object) $perYear,
        ];
    }

    return [
        'years'       => $years,
        'cutoff'      => $cutoff,           // 'MM-DD'
        'latest_date' => $latest,
        'columns'     => ['MM-DD', 'WT', 'W_cm'],
        'stations'    => $out,
    ];
}

/** type=meta – Transparenz-Angaben für die Website. */
function unload_meta(PDO $pdo): array
{
    $range = $pdo->query('SELECT MIN(obs_date) AS first, MAX(obs_date) AS last, COUNT(*) AS total FROM observations')->fetch();

    $lastSuccess = $pdo->query(
        "SELECT finished_at, aggregation, rows_inserted, rows_updated FROM import_runs
         WHERE status IN ('success','partial') ORDER BY finished_at DESC LIMIT 1"
    )->fetch() ?: null;
    $lastAttempt = $pdo->query('SELECT started_at, status FROM import_runs ORDER BY started_at DESC LIMIT 1')->fetch() ?: null;

    // Anzahl nach Freigabestatus (NULL = von der API ohne Status geliefert)
    $release = [];
    foreach ($pdo->query('SELECT release_state, COUNT(*) AS n FROM observations GROUP BY release_state') as $r) {
        $release[$r['release_state'] === null ? 'none' : (string) $r['release_state']] = (int) $r['n'];
    }

    // Verworfene Werte im jüngsten Lauf, der den ganzen Zeitraum geladen hat
    $rejected = $pdo->query(
        "SELECT rows_rejected, message FROM import_runs WHERE status IN ('success','partial')
         ORDER BY (window_from <= (SELECT MIN(obs_date) FROM observations)) DESC, finished_at DESC LIMIT 1"
    )->fetch() ?: null;

    // DATETIME (UTC) → ISO-8601, damit der Browser in Lokalzeit umrechnen kann
    $toIso = fn($dt) => $dt ? str_replace(' ', 'T', $dt) . 'Z' : null;

    return [
        'source' => [
            'publisher'   => 'Bundesamt für Umwelt BAFU',
            'dataset'     => 'Hydrologische Beobachtungen',
            'platform'    => 'https://api.data-platform.cloud.bafu.admin.ch/',
            'dataset_url' => 'https://api.data-platform.cloud.bafu.admin.ch/dataproduct-water-observations',
            'license'     => 'Freie Nutzung. Quellenangabe ist Pflicht. (opendata.swiss)',
        ],
        'aggregation'  => $lastSuccess['aggregation'] ?? null,
        'data_range'   => ['from' => $range['first'], 'to' => $range['last']],
        'observations' => (int) $range['total'],
        'last_import'  => $lastSuccess ? [
            'finished_at' => $toIso($lastSuccess['finished_at']),
            'inserted'    => (int) $lastSuccess['rows_inserted'],
            'updated'     => (int) $lastSuccess['rows_updated'],
        ] : null,
        'last_attempt' => $lastAttempt ? ['started_at' => $toIso($lastAttempt['started_at']), 'status' => $lastAttempt['status']] : null,
        'release_states' => $release,
        'rejected'       => $rejected ? ['count' => (int) $rejected['rows_rejected'], 'details' => $rejected['message']] : null,
    ];
}

// ==================================================================
// Eingaben prüfen (Whitelist / festes Format statt SQL-Strings bauen)
// ==================================================================

/** W oder WT; null = beide. */
function input_parameter(?string $value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    if (!isset(UNLOAD_PARAMETERS[$value])) {
        throw new UnloadException('Ungültiger Parameter. Erlaubt: W, WT');
    }
    return $value;
}

/** Kommagetrennte vierstellige BAFU-Nummern, z.B. "2019,2243". Leer = alle aktiven. */
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

// ==================================================================
// Gemeinsame Datenbank-Abfragen (READ)
// ==================================================================

/**
 * Aktive Stationen (optional gefiltert). Unbekannte Nummern → 404.
 * Achtung: PHP macht aus Array-Keys wie '2019' einen int – deshalb wird die
 * Nummer immer aus $station['station_no'] gelesen, nie aus dem Key.
 */
function fetch_stations(PDO $pdo, array $nos = []): array
{
    $sql = 'SELECT id, station_no, name, river_name, catchment_name, latitude, longitude,
                   status, display_name, story_role, sort_order
            FROM stations WHERE is_active = 1';
    if ($nos) {
        $sql .= ' AND station_no IN (' . placeholders($nos) . ')';
    }
    $stmt = $pdo->prepare($sql . ' ORDER BY sort_order');
    $stmt->execute($nos);

    $stations = [];
    foreach ($stmt as $row) {
        $stations[$row['station_no']] = [
            'id'             => (int) $row['id'],
            'station_no'     => $row['station_no'],
            'display_name'   => $row['display_name'],
            'river_name'     => $row['river_name'],
            'name'           => $row['name'],
            'catchment_name' => $row['catchment_name'],
            'latitude'       => $row['latitude'] !== null ? (float) $row['latitude'] : null,
            'longitude'      => $row['longitude'] !== null ? (float) $row['longitude'] : null,
            'status'         => $row['status'],
            'story_role'     => $row['story_role'],
            'sort_order'     => (int) $row['sort_order'],
        ];
    }

    $unknown = array_diff($nos, array_column($stations, 'station_no'));
    if ($unknown) {
        throw new UnloadException('Unbekannte Station: ' . implode(', ', $unknown), 404);
    }
    return $stations;
}

/** Jüngster Tag mit Messwerten (oder null bei leerer Datenbank). */
function latest_obs_date(PDO $pdo): ?string
{
    return $pdo->query('SELECT MAX(obs_date) FROM observations')->fetchColumn() ?: null;
}

/** "?,?,?" für IN (...) */
function placeholders(array $values): string
{
    return implode(',', array_fill(0, count($values), '?'));
}

/** Mittlerer Pegel (m ü.M.) pro Station über den gesamten gespeicherten Zeitraum. */
function w_baselines(PDO $pdo, array $stationIds): array
{
    $stmt = $pdo->prepare(
        'SELECT station_id, AVG(value) FROM observations
         WHERE parameter_code = \'W\' AND station_id IN (' . placeholders($stationIds) . ')
         GROUP BY station_id'
    );
    $stmt->execute($stationIds);
    return array_map('floatval', $stmt->fetchAll(PDO::FETCH_KEY_PAIR));
}

/**
 * Vollständige Kalenderjahre in der Datenbank (für faire Vergleiche von
 * Monatsmitteln: ein angebrochenes Jahr würde einzelne Monate bevorzugen).
 */
function complete_years(PDO $pdo): array
{
    $r = $pdo->query('SELECT MIN(obs_date) AS first, MAX(obs_date) AS last FROM observations')->fetch();
    if (!$r || !$r['first']) {
        return [];
    }
    $first = (int) substr($r['first'], 0, 4) + (substr($r['first'], 5) === '01-01' ? 0 : 1);
    $last  = (int) substr($r['last'], 0, 4) - (substr($r['last'], 5) === '12-31' ? 0 : 1);
    return $first <= $last ? range($first, $last) : [];
}

/** Monatsstatistik pro Station, Messgrösse, Jahr und Monat – in SQL aggregiert. */
function fetch_monthly(PDO $pdo, array $stationIds): array
{
    $stmt = $pdo->prepare(
        'SELECT station_id, parameter_code, YEAR(obs_date) AS y, MONTH(obs_date) AS m,
                COUNT(*) AS n, AVG(value) AS mean, MIN(value) AS min, MAX(value) AS max,
                SUM(parameter_code = \'WT\' AND value >= 20) AS days_ge_20
         FROM observations
         WHERE station_id IN (' . placeholders($stationIds) . ')
         GROUP BY station_id, parameter_code, y, m
         ORDER BY station_id, parameter_code, y, m'
    );
    $stmt->execute($stationIds);
    return array_map(fn($r) => [
        'station_id' => (int) $r['station_id'],
        'param'      => $r['parameter_code'],
        'y'          => (int) $r['y'],
        'm'          => (int) $r['m'],
        'n'          => (int) $r['n'],
        'mean'       => (float) $r['mean'],
        'min'        => (float) $r['min'],
        'max'        => (float) $r['max'],
        'days_ge_20' => (int) $r['days_ge_20'],
    ], $stmt->fetchAll());
}
