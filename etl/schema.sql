-- =====================================================================
-- Der Bauplan unserer Datenbank: «Wenn Flüsse Durst haben»
--
-- Eine Datenbank ist wie ein Ordner mit mehreren Tabellen. Unsere hat vier:
--
--   parameters    Was wir messen: Wasserstand (W) und Wassertemperatur (WT)
--   stations      Die sechs Messstationen an den Flüssen
--   observations  Die Messwerte, ein Wert pro Zeile (rund 30 000 Zeilen)
--   import_runs   Ein Protokoll: Wann wurde importiert, hat es geklappt?
--
-- Diese Datei wird nur einmal ausgeführt, um die leeren Tabellen anzulegen,
-- zum Beispiel in phpMyAdmin im Reiter «SQL». Gefüllt werden die Tabellen
-- danach automatisch von etl/load.php.
-- Man kann die Datei gefahrlos mehrmals ausführen: Was es schon gibt, bleibt.
-- =====================================================================

-- Damit Umlaute und «°C» richtig gespeichert werden.
SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- Tabelle 1: Was wir messen
--
-- Die Einheit (°C oder Meter) steht nur einmal hier und nicht bei jedem
-- der 30 000 Messwerte. Das spart Platz und verhindert Tippfehler.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parameters (
    code        VARCHAR(4)   NOT NULL,               -- Kürzel, z.B. 'W'
    label       VARCHAR(60)  NOT NULL,               -- Name, z.B. 'Wasserstand'
    unit        VARCHAR(20)  NOT NULL,               -- Einheit: 'm ü.M.' oder '°C'
    description VARCHAR(255) NULL,                   -- kurze Beschreibung
    PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Tabelle 2: Die Messstationen
--
-- Jede Station hat zwei Nummern:
-- - station_no: die offizielle Nummer beim BAFU, z.B. '2044' für die Thur
-- - id: eine interne Nummer, die die Datenbank selbst vergibt
-- Alle Angaben kommen direkt vom BAFU, nichts ist von Hand abgetippt.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stations (
    id             INT UNSIGNED  NOT NULL AUTO_INCREMENT, -- interne Nummer (zählt automatisch hoch)
    station_no     VARCHAR(10)   NOT NULL,           -- Nummer beim BAFU
    name           VARCHAR(120)  NOT NULL,           -- Name der Station, z.B. 'Brienzwiler'
    river_name     VARCHAR(120)  NOT NULL,           -- Fluss, z.B. 'Aare'
    site_name      VARCHAR(60)   NULL,               -- Ortsname laut BAFU
    catchment_name VARCHAR(120)  NULL,               -- Flussgebiet, z.B. 'Aaregebiet'
    latitude       DECIMAL(10,7) NULL,               -- Koordinaten auf der Weltkarte
    longitude      DECIMAL(10,7) NULL,
    elevation      DECIMAL(7,2)  NULL,               -- Höhe über Meer (fehlt oft)
    status         VARCHAR(30)   NULL,               -- 'Aufgebaut' = Station misst
    coverage_from  DATE          NULL,               -- seit wann es Daten gibt
    sort_order     SMALLINT      NOT NULL DEFAULT 0, -- Reihenfolge auf der Website
    is_active      TINYINT(1)    NOT NULL DEFAULT 1, -- 1 = in Gebrauch, 0 = ausgeblendet
    created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP, -- wann angelegt
    updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, -- wann zuletzt geändert
    PRIMARY KEY (id),
    UNIQUE KEY uq_stations_no (station_no)           -- jede BAFU-Nummer nur einmal
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Tabelle 3: Das Protokoll der Importe
--
-- Jeder Import schreibt hier eine Zeile: wann er lief, wie viele Werte
-- neu, geändert oder weggelassen wurden, und ob alles geklappt hat.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_runs (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    started_at      DATETIME     NOT NULL,           -- Start (Weltzeit)
    finished_at     DATETIME     NULL,               -- Ende (Weltzeit)
    status          ENUM('running','success','partial','failed') NOT NULL DEFAULT 'running', -- läuft / geklappt / teilweise / fehlgeschlagen
    mode            VARCHAR(20)  NOT NULL,           -- 'incremental' = nur Neues, 'full' = alles
    aggregation     VARCHAR(40)  NOT NULL,           -- welche Werte: 'data_1day_mean' = Tagesmittel
    window_from     DATE         NULL,               -- abgefragter Zeitraum: von …
    window_to       DATE         NULL,               -- … bis
    api_requests    INT UNSIGNED NOT NULL DEFAULT 0, -- so oft beim BAFU gefragt
    rows_received   INT UNSIGNED NOT NULL DEFAULT 0, -- so viele Werte bekommen
    rows_inserted   INT UNSIGNED NOT NULL DEFAULT 0, -- davon neu
    rows_updated    INT UNSIGNED NOT NULL DEFAULT 0, -- davon vom BAFU korrigiert
    rows_unchanged  INT UNSIGNED NOT NULL DEFAULT 0, -- davon gleich geblieben
    rows_rejected   INT UNSIGNED NOT NULL DEFAULT 0, -- davon weggelassen (unplausibel)
    message         TEXT         NULL,               -- Fehlermeldung, falls etwas schiefging
    PRIMARY KEY (id),
    KEY idx_import_runs_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Tabelle 4: Die Messwerte – das Herzstück
--
-- Jede Zeile ist ein Tagesmittel: eine Station, eine Messgrösse, ein Tag.
--
-- measured_at    Zeitpunkt, so wie ihn das BAFU liefert (in Weltzeit)
-- obs_date       Der Tag in Schweizer Zeit, zu dem der Wert gehört
-- release_state  Hat das BAFU den Wert schon kontrolliert?
--                1 = noch nicht, 2 = ja, 3 = endgültig, leer = unbekannt
--
-- Die Regel «uq_obs_station_param_time» sorgt dafür, dass es jeden Wert nur
-- einmal gibt. Kommt er nochmals, wird er überschrieben statt verdoppelt.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observations (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    station_id      INT UNSIGNED    NOT NULL,        -- welche Station (interne Nummer)
    parameter_code  VARCHAR(4)      NOT NULL,        -- W oder WT
    measured_at     DATETIME        NOT NULL,        -- Zeitpunkt laut BAFU
    obs_date        DATE            NOT NULL,        -- Tag in Schweizer Zeit
    value           DECIMAL(9,3)    NOT NULL,        -- der Messwert, z.B. 16.850
    release_state   TINYINT UNSIGNED NULL,           -- vom BAFU geprüft?
    import_run_id   INT UNSIGNED    NULL,            -- welcher Import ihn zuletzt geändert hat
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_obs_station_param_time (station_id, parameter_code, measured_at), -- keine doppelten Werte
    KEY idx_obs_param_date (parameter_code, obs_date), -- macht die Suche nach Datum schnell
    -- Verknüpfungen zu den anderen Tabellen: Ein Messwert gehört immer zu einer
    -- bestehenden Station und Messgrösse.
    CONSTRAINT fk_obs_station   FOREIGN KEY (station_id)     REFERENCES stations (id)   ON DELETE CASCADE,
    CONSTRAINT fk_obs_parameter FOREIGN KEY (parameter_code) REFERENCES parameters (code),
    CONSTRAINT fk_obs_import    FOREIGN KEY (import_run_id)  REFERENCES import_runs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Die zwei Messgrössen gleich eintragen.
--
-- Nur diese zwei Zeilen schreiben wir von Hand. Stationen und Messwerte
-- kommen ausschliesslich vom BAFU über den Import – hier wird nichts erfunden.
-- ---------------------------------------------------------------------
INSERT INTO parameters (code, label, unit, description) VALUES
    ('W',  'Wasserstand',      'm ü.M.', 'Pegelhöhe der Wasseroberfläche in Metern über Meer (Tagesmittel)'),
    ('WT', 'Wassertemperatur', '°C',     'Temperatur des Wassers in Grad Celsius (Tagesmittel)')
ON DUPLICATE KEY UPDATE
    label = VALUES(label),
    unit = VALUES(unit),
    description = VALUES(description);
