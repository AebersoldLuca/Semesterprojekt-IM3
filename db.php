<?php
/**
 * Zentrale Datenbankverbindung (PDO).
 *
 * Alle Skripte, die MySQL brauchen (etl/load.php und unload.php), holen sich
 * die Verbindung über db(). Die Zugangsdaten stehen an genau EINER Stelle:
 * config.php (nicht im Repository, Vorlage: config.example.php).
 *
 * - ERRMODE_EXCEPTION: jeder SQL-Fehler wird zur PDOException, die wir
 *   kontrolliert abfangen und loggen.
 * - EMULATE_PREPARES = false: echte Prepared Statements auf dem Server.
 * - charset utf8mb4: volles UTF-8 (Umlaute, «m ü.M.», «°C» …).
 * - Session-Zeitzone UTC, damit Zeitstempel unverändert gespeichert werden.
 */

declare(strict_types=1);

date_default_timezone_set('UTC');

/** Liest config.php und gibt die Werte als Array zurück. */
function app_config(): array
{
    static $config = null;
    if ($config === null) {
        $file = __DIR__ . '/config.php';
        if (!is_readable($file)) {
            throw new RuntimeException('config.php fehlt – bitte config.example.php kopieren und ausfüllen.');
        }
        require $file; // definiert $host, $port, $dbname, $username, $password, $etlToken
        $config = [
            'host'      => $host ?? 'DB_HOST',
            'port'      => (int) ($port ?? 3306),
            'dbname'    => $dbname ?? '',
            'username'  => $username ?? '',
            'password'  => $password ?? '',
            'etl_token' => (string) ($etlToken ?? ''),
        ];
    }
    return $config;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $cfg = app_config();
    if ($cfg['host'] === 'DB_HOST' || $cfg['password'] === 'DB_PASSWORD') {
        throw new RuntimeException('config.php enthält noch die Platzhalter DB_HOST / DB_PASSWORD.');
    }

    $dsn = "mysql:host={$cfg['host']};port={$cfg['port']};dbname={$cfg['dbname']};charset=utf8mb4";

    $pdo = new PDO($dsn, $cfg['username'], $cfg['password'], [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ]);
    $pdo->exec("SET time_zone = '+00:00'");

    return $pdo;
}

/** Einfaches Datei-Logging nach logs/ (statt Fehlermeldungen im Browser). */
function log_message(string $level, string $message, string $channel = 'app'): void
{
    $line = sprintf("[%s UTC] %s: %s\n", gmdate('Y-m-d H:i:s'), strtoupper($level), $message);
    // Monatliche Datei, z.B. logs/etl-2026-09.log – so wachsen Logs nicht endlos.
    @file_put_contents(__DIR__ . "/logs/$channel-" . gmdate('Y-m') . '.log', $line, FILE_APPEND | LOCK_EX);
}
