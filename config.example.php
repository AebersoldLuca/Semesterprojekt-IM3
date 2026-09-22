<?php
/**
 * VORLAGE für die Zugangsdaten.
 *
 * 1. Diese Datei kopieren nach:  config.php
 * 2. Die Platzhalter durch die echten Werte ersetzen.
 *
 * config.php steht in .gitignore und wird NIE ins (öffentliche) Repository
 * committed. So können lokal und auf dem Hosting unterschiedliche
 * Zugangsdaten verwendet werden. Verwendet wird die Datei nur von db.php.
 */

// Datenbank (MySQL / MariaDB)
$host     = 'DB_HOST';        // z.B. localhost oder der Host aus dem Hosting-Control-Panel
$port     = 3306;
$dbname   = 'DB_NAME';
$username = 'DB_USERNAME';
$password = 'DB_PASSWORD';

// Nur nötig, wenn der Cronjob etl/load.php per URL statt per Kommandozeile
// aufruft: https://…/etl/load.php?token=…  (langen Zufallswert eintragen,
// z.B. mit «openssl rand -hex 24»). Leer lassen = Aufruf per URL gesperrt.
$etlToken = '';
