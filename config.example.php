<?php
/**
 * Vorlage für die Zugangsdaten zur Datenbank.
 *
 * Die Datenbank ist wie ein abgeschlossener Raum: Man braucht eine Adresse,
 * einen Benutzernamen und ein Passwort. Diese Angaben sind geheim.
 *
 * Deshalb gibt es zwei Dateien:
 * - config.example.php (diese Datei): die leere Vorlage. Sie ist öffentlich
 *   auf GitHub, damit man sieht, welche Angaben nötig sind.
 * - config.php: die Kopie mit den echten Angaben. Sie ist nie auf GitHub,
 *   nur auf dem eigenen Computer und auf dem Webserver.
 *
 * So legst du die echte Datei an, im Hauptordner des Projekts:
 *
 *     cp config.example.php config.php
 *
 * Danach die leeren Felder unten ausfüllen.
 */

// --- Zugangsdaten -----------------------------------------------------------
//
// Alle Werte stehen im Control Panel von Hostpoint, wo die Datenbank liegt.
// Hostpoint setzt den Namen des Kontos vor Datenbank und Benutzer.

$host     = ''; // Adresse des Datenbank-Servers
$dbname   = ''; // Name der Datenbank
$username = ''; // Benutzername
$password = ''; // Passwort

// --- Passwort für den täglichen Import -------------------------------------
//
// Der tägliche Import ruft etl/load.php über eine Web-Adresse auf:
// …/etl/load.php?token=…
// Nur wer dieses Passwort («Token») kennt, kann einen Import starten.
// Einen langen Zufallswert eintragen, zum Beispiel aus dem Terminal:
//     openssl rand -hex 24
// Bleibt das Feld leer, ist der Import über die Web-Adresse gesperrt.

$etlToken = '';

// --- Die Adresse der Datenbank, zusammengesetzt ----------------------------
//
// PHP braucht die Angaben von oben in einer bestimmten Form.
// «utf8mb4» sorgt dafür, dass Umlaute und «°C» richtig ankommen.

$dsn = "mysql:host=$host;dbname=$dbname;charset=utf8mb4";

// --- Einstellungen für die Verbindung --------------------------------------

$options = [
    // Wenn etwas schiefgeht, gibt es eine klare Fehlermeldung statt Stille.
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,

    // Jede Zeile kommt als Liste mit Namen zurück, z.B. $row['river_name'].
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,

    // Schutz vor Angriffen: Die Datenbank setzt die Werte selbst ein.
    PDO::ATTR_EMULATE_PREPARES   => false,
];
