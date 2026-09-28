-- =====================================================================
-- Update für bestehende Datenbanken (einmalig ausführen)
--
-- Seit dem Datenvertrag v1 liefert unload.php die redaktionellen Texte
-- nicht mehr aus; sie stehen nur noch im Frontend (script.js). Die zwei
-- Spalten werden deshalb nicht mehr gebraucht.
--
-- Neue Installationen brauchen dieses Script nicht – etl/schema.sql
-- enthält die Spalten bereits nicht mehr.
-- =====================================================================

ALTER TABLE stations
    DROP COLUMN display_name,
    DROP COLUMN story_role;
