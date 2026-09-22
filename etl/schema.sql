-- =====================================================================
-- Schema: DataStory «Schweizer Flüsse im Jahreslauf»
-- Datenbank: MySQL 5.7+ / MariaDB 10.3+ (utf8mb4)
--
-- Vier Tabellen:
--   parameters    Messgrössen (W = Wasserstand, WT = Wassertemperatur)
--   stations      Messstationen des BAFU (Stammdaten aus der API)
--   observations  Tagesmittelwerte (eine Zeile = ein Messwert)
--   import_runs   Protokoll jedes ETL-Laufs (Transparenz für die Website)
--
-- Ausführen in der bestehenden Datenbank, z.B. in phpMyAdmin (Reiter «SQL»)
-- oder per Kommandozeile:  mysql -u USER -p DBNAME < etl/schema.sql
-- Das Script ist wiederholbar (CREATE TABLE IF NOT EXISTS / Upsert).
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- Messgrössen. Die Einheit ist eine Eigenschaft der Messgrösse, nicht
-- des einzelnen Messwerts – deshalb steht sie hier und nicht 30'000-mal
-- in observations. Der ETL prüft, ob die API-Einheit dazu passt.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parameters (
    code        VARCHAR(4)   NOT NULL,               -- BAFU parameterName, z.B. 'W'
    label       VARCHAR(60)  NOT NULL,               -- 'Wasserstand'
    unit        VARCHAR(20)  NOT NULL,               -- 'm ü.M.' bzw. '°C'
    description VARCHAR(255) NULL,
    PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Messstationen. station_no ist die offizielle BAFU-Stationsnummer
-- (z.B. '2019') und damit der fachliche Schlüssel; id ist der technische
-- Primärschlüssel für Fremdschlüssel.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stations (
    id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    station_no     VARCHAR(10)   NOT NULL,           -- BAFU «no»
    name           VARCHAR(120)  NOT NULL,           -- BAFU «name»,  z.B. 'Brienzwiler'
    river_name     VARCHAR(120)  NOT NULL,           -- BAFU «riverName», z.B. 'Aare'
    site_name      VARCHAR(60)   NULL,               -- BAFU «siteName»
    catchment_name VARCHAR(120)  NULL,               -- BAFU «catchmentName», z.B. 'Aaregebiet'
    latitude       DECIMAL(10,7) NULL,               -- WGS84
    longitude      DECIMAL(10,7) NULL,
    elevation      DECIMAL(7,2)  NULL,               -- BAFU liefert oft NULL
    status         VARCHAR(30)   NULL,               -- 'Aufgebaut' = in Betrieb
    coverage_from  DATE          NULL,               -- frühestes Datum mit Daten (laut BAFU)
    -- Redaktionelle Angaben aus STATIONS in etl/extract.php (keine Messdaten):
    display_name   VARCHAR(160)  NOT NULL,           -- 'Aare – Brienzwiler'
    story_role     VARCHAR(255)  NULL,               -- warum diese Station in der Story ist
    sort_order     SMALLINT      NOT NULL DEFAULT 0, -- bestimmt auch die Farbe im Chart
    is_active      TINYINT(1)    NOT NULL DEFAULT 1, -- 0 = nicht mehr in der Auswahl
    created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_stations_no (station_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Import-Protokoll. Jeder Lauf von etl/load.php schreibt hier
-- eine Zeile – die Website zeigt daraus «zuletzt aktualisiert».
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_runs (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    started_at      DATETIME     NOT NULL,           -- UTC
    finished_at     DATETIME     NULL,               -- UTC
    status          ENUM('running','success','partial','failed') NOT NULL DEFAULT 'running',
    mode            VARCHAR(20)  NOT NULL,           -- 'incremental' | 'full'
    aggregation     VARCHAR(40)  NOT NULL,           -- z.B. 'data_1day_mean'
    window_from     DATE         NULL,               -- angefragter Zeitraum
    window_to       DATE         NULL,
    api_requests    INT UNSIGNED NOT NULL DEFAULT 0,
    rows_received   INT UNSIGNED NOT NULL DEFAULT 0,
    rows_inserted   INT UNSIGNED NOT NULL DEFAULT 0,
    rows_updated    INT UNSIGNED NOT NULL DEFAULT 0, -- z.B. neuer Freigabestatus
    rows_unchanged  INT UNSIGNED NOT NULL DEFAULT 0,
    rows_rejected   INT UNSIGNED NOT NULL DEFAULT 0, -- Transform-Validierung
    message         TEXT         NULL,
    PRIMARY KEY (id),
    KEY idx_import_runs_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Messwerte (Tagesmittel aus BAFU «data_1day_mean»).
--
-- measured_at  Startzeitpunkt des Aggregationsintervalls in UTC, exakt
--              so wie ihn die API liefert (z.B. 2026-09-20 23:00:00).
-- obs_date     Der Kalendertag, zu dem der Wert gehört, in Schweizer
--              Normalzeit (MEZ, UTC+1): 2026-09-20 23:00 UTC → 2026-09-21.
--              Wird im Transform berechnet und fürs Frontend verwendet.
-- release_state  BAFU-Freigabestatus: 1 = provisorisch, 2 = validiert,
--              3 = definitiv. NULL = von der API ohne Status geliefert
--              (betrifft vor allem die jüngsten Werte).
--
-- Der UNIQUE-Key verhindert Duplikate: pro Station, Messgrösse und
-- Zeitpunkt existiert genau ein Wert. Der ETL nutzt ihn für ein
-- «INSERT … ON DUPLICATE KEY UPDATE» (Upsert).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observations (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    station_id      INT UNSIGNED    NOT NULL,
    parameter_code  VARCHAR(4)      NOT NULL,
    measured_at     DATETIME        NOT NULL,
    obs_date        DATE            NOT NULL,
    value           DECIMAL(9,3)    NOT NULL,
    release_state   TINYINT UNSIGNED NULL,
    import_run_id   INT UNSIGNED    NULL,        -- welcher Lauf hat die Zeile zuletzt geschrieben
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_obs_station_param_time (station_id, parameter_code, measured_at),
    KEY idx_obs_param_date (parameter_code, obs_date),
    CONSTRAINT fk_obs_station   FOREIGN KEY (station_id)     REFERENCES stations (id)   ON DELETE CASCADE,
    CONSTRAINT fk_obs_parameter FOREIGN KEY (parameter_code) REFERENCES parameters (code),
    CONSTRAINT fk_obs_import    FOREIGN KEY (import_run_id)  REFERENCES import_runs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Stammdaten: die beiden Messgrössen. Einheiten exakt wie im API-Feld
-- «unitSymbol». Stationen und Messwerte kommen AUSSCHLIESSLICH über den
-- ETL-Prozess aus der BAFU-API – hier werden keine Daten erfunden.
-- ---------------------------------------------------------------------
INSERT INTO parameters (code, label, unit, description) VALUES
    ('W',  'Wasserstand',      'm ü.M.', 'Pegelhöhe der Wasseroberfläche in Metern über Meer (Tagesmittel)'),
    ('WT', 'Wassertemperatur', '°C',     'Temperatur des Wassers in Grad Celsius (Tagesmittel)')
ON DUPLICATE KEY UPDATE
    label = VALUES(label),
    unit = VALUES(unit),
    description = VALUES(description);
