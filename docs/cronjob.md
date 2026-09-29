# Cronjob für den automatischen Import

`etl/load.php` startet die ganze Kette (Extract → Transform → Load) und läuft **einmal täglich**.
Tagesmittel entstehen einmal pro Tag; ein häufigerer Import bringt keine neuen Werte, belastet aber die BAFU-API.

Empfohlene Zeit: **06:30 Uhr**. Das Tagesmittel des Vortags ist dann sicher verfügbar.

## Einrichten bei Hostpoint

1. In `config.php` einen langen Zufallswert als Token eintragen, zum Beispiel aus dem Terminal:

   ```bash
   openssl rand -hex 24
   ```

   ```php
   $etlToken = '…';
   ```

2. Im Control Panel unter «Cronjobs» einen neuen Job anlegen:

   ```
   30 6 * * *  wget -q -O /dev/null "https://DEINE-DOMAIN/etl/load.php?token=DEIN-TOKEN"
   ```

Ohne gültiges Token antwortet `load.php` mit HTTP 403. Ist `$etlToken` leer, ist der Aufruf per URL gesperrt.

> Die URL mit Token ist geheim: nicht ins Repository, nicht auf Screenshots, nicht am Marktstand zeigen.

## Von Hand aufrufen

Dieselbe URL im Browser öffnen. `load.php` zeigt dann als Text, was passiert ist:
wie viele Zeilen die API geliefert hat, wie viele neu, geändert oder unverändert sind, und den jüngsten Messwert
pro Fluss.

Alles ab 2020 neu laden (z.B. nach einer Änderung an `transform.php`):

```
https://DEINE-DOMAIN/etl/load.php?token=DEIN-TOKEN&full=1
```

## Was passiert bei Fehlern?

| Situation | Verhalten |
|---|---|
| BAFU-API nicht erreichbar | 3 Wiederholungen (2 s, 4 s, 8 s), dann Abbruch. Der Lauf steht als `failed` in `import_runs`, **die gespeicherten Daten bleiben unverändert**, die Website zeigt sie weiter. |
| Einzelnes Zeitfenster fehlerhaft | Die übrigen Fenster werden trotzdem geladen, Lauf = `partial`. Der nächste Lauf holt die Lücke nach. |
| Zu viele Zeilen für ein Fenster | Das Fenster wird automatisch halbiert. |
| Datenbank nicht erreichbar | Abbruch vor dem Abruf der API mit der Meldung «Verbindung fehlgeschlagen». |
| Fehler beim Speichern | Die Transaktion wird zurückgerollt: Es landet keine halbe Lieferung in der Datenbank. |
