<?php
/**
 * Vorlage für die Zugangsdaten zur Datenbank.
 *
 * So legst du deine eigene Fassung an – im Hauptordner des Projekts:
 *
 *     cp config.example.php config.php
 *
 * config.php steht in .gitignore und landet nie auf GitHub. PhpStorm lädt sie
 * trotzdem per FTP auf den Server, denn dort wird sie gebraucht. Diese Vorlage
 * ohne Werte bleibt im Repository, damit alle wissen, welche Angaben nötig sind.
 *
 * Eingebunden wird config.php von etl/load.php und unload.php.
 */

// --- Zugangsdaten -----------------------------------------------------------
//
// Die Datenbank läuft auf dem Webserver bei Hostpoint. Datenbank und Benutzer
// legst du im Control Panel von Hostpoint an, dort stehen auch alle Werte.
//
// Hostpoint setzt den Namen deines Kontos vor Datenbank und Benutzer.
// Fehlt dieser Vorsatz, meldet PDO «Access denied» oder «Unknown database».

$host     = '';
$dbname   = '';
$username = '';
$password = '';

// --- Token für den Cronjob --------------------------------------------------
//
// Der Cronjob ruft etl/load.php per URL auf: …/etl/load.php?token=…
// Ohne passendes Token startet kein Import. Einen langen Zufallswert eintragen,
// zum Beispiel aus dem Terminal:  openssl rand -hex 24
// Leer lassen = Import per URL gesperrt.

$etlToken = '';

// --- DSN: die Adresse der Datenbank -----------------------------------------
//
// DSN heisst Data Source Name. Er sagt PDO, welche Datenbank wo liegt.
// charset=utf8mb4 sorgt dafür, dass Umlaute und «°C» richtig ankommen.

$dsn = "mysql:host=$host;dbname=$dbname;charset=utf8mb4";

// --- Optionen für PDO -------------------------------------------------------

$options = [
    // Fehler brechen laut ab, statt still zu scheitern. Wichtigste Zeile hier.
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,

    // Zeilen kommen als assoziative Arrays zurück: $row['river_name'].
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,

    // Platzhalter werden von der Datenbank selbst eingesetzt, nicht von PHP.
    PDO::ATTR_EMULATE_PREPARES   => false,
];
