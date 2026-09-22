# Cronjob für den automatischen Import

Der ETL-Prozess (`etl/load.php`) wird **einmal täglich** ausgeführt. Tagesmittel entstehen einmal pro Tag;
ein häufigerer Import bringt keine neuen Werte, belastet aber die BAFU-API unnötig.

Empfohlene Zeit: **06:30 Uhr**. Das Tagesmittel des Vortags ist dann sicher verfügbar.

## Variante A – Kommandozeile (empfohlen, z.B. Hostpoint)

Im Hosting-Control-Panel unter «Cronjobs» einen neuen Job anlegen:

```
30 6 * * *  php /home/BENUTZER/www/PFAD-ZUM-PROJEKT/etl/load.php >> /home/BENUTZER/www/PFAD-ZUM-PROJEKT/logs/cron.log 2>&1
```

- `BENUTZER` und `PFAD-ZUM-PROJEKT` durch die eigenen Werte ersetzen.
- Je nach Hoster muss statt `php` der vollständige Pfad zu einer bestimmten PHP-Version angegeben werden.
  Den korrekten Pfad zeigt das Control Panel bzw. per SSH der Befehl `which php`. Benötigt wird PHP 8.1 oder neuer.
- Die Ausgabe (Import-Zusammenfassung) landet in `logs/cron.log`, Fehler zusätzlich in `logs/etl-JJJJ-MM.log`.

## Variante B – Aufruf per URL

Falls der Hoster nur URL-Cronjobs erlaubt (oder ein externer Dienst wie cron-job.org verwendet wird):

1. In `config.php` einen langen Zufallswert setzen: `$etlToken = '…';` (z.B. `openssl rand -hex 24`).
2. Cronjob auf folgende URL einrichten:

```
https://DEINE-DOMAIN/etl/load.php?token=DEIN-TOKEN
```

Ohne gültiges Token antwortet `load.php` mit HTTP 403. Ist `$etlToken` leer, ist der Aufruf per URL komplett gesperrt.

## Weitere Aufrufe (manuell, per SSH)

```
php etl/load.php                     # inkrementell (wie der Cronjob)
php etl/load.php --full              # alles ab 2020-01-01 neu laden (z.B. einmal im Monat,
                                     # um nachträgliche BAFU-Validierungen älterer Werte zu übernehmen)
php etl/load.php --from=2025-01-01   # ab einem bestimmten Datum
php etl/extract.php --candidates     # prüfen, welche Stationen W und WT liefern
```

Optionaler zweiter Cronjob für den monatlichen Voll-Abgleich (1. des Monats, 05:00 Uhr):

```
0 5 1 * *  php /home/BENUTZER/www/PFAD-ZUM-PROJEKT/etl/load.php --full >> /home/BENUTZER/www/PFAD-ZUM-PROJEKT/logs/cron.log 2>&1
```

## Was passiert bei Fehlern?

| Situation | Verhalten |
|---|---|
| BAFU-API nicht erreichbar | 3 Wiederholungen (2 s, 4 s, 8 s), dann Abbruch mit Exit-Code 2. Import-Lauf wird als `failed` protokolliert, **bestehende Daten bleiben unverändert**, die Website zeigt weiter die gespeicherten Daten. |
| Einzelnes Zeitfenster fehlerhaft | Übrige Fenster werden trotzdem geladen, Lauf = `partial`. |
| Zu viele Zeilen für ein Fenster | Fenster wird automatisch halbiert. |
| Datenbank nicht erreichbar | Abbruch vor dem Abruf der API, Eintrag in `logs/etl-JJJJ-MM.log`. |
| Zwei Läufe gleichzeitig | Der zweite bricht ab (Lock-Datei `etl/data/load.lock`). |
