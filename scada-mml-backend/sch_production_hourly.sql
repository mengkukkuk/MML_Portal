-- Reference DDL for an hourly production log on a PLANT (vision) datasource.
-- Run by an operator against the plant database, never by the app. The schema
-- name below is only an example: the app reads whatever datasources.db_schema says.
-- Safe to re-run: every statement is idempotent.
--
-- One row per camera per hour. period_start is the start of the hour the row
-- covers (08:00 holds 08:00-09:00); count_total and defect_total are what was
-- counted DURING that hour, not running counters. Bind it in Monitor > Edit >
-- Production Log with layout "Hourly totals": hour start = period_start,
-- count = count_total, defect = defect_total, filter = line_code (camera code).

CREATE TABLE IF NOT EXISTS vision_data.production_hourly_log (
    id            bigserial   PRIMARY KEY,
    line_code     text        NOT NULL,           -- camera code, e.g. CAM001-13
    period_start  timestamp   NOT NULL,
    period_end    timestamp   GENERATED ALWAYS AS (period_start + interval '1 hour') STORED,
    count_total   integer     NOT NULL DEFAULT 0 CHECK (count_total  >= 0),
    defect_total  integer     NOT NULL DEFAULT 0 CHECK (defect_total >= 0),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- One row per camera per hour: writers add to the open hour rather than
    -- appending, so the chart never shows the same hour twice.
    CONSTRAINT production_hourly_log_hour_start CHECK (date_trunc('hour', period_start) = period_start),
    CONSTRAINT production_hourly_log_line_hour UNIQUE (line_code, period_start)
);
ALTER TABLE vision_data.production_hourly_log ADD COLUMN IF NOT EXISTS location text;

-- The unique constraint's index already serves (line_code, period_start) reads;
-- this one serves the unfiltered "today's shift" read.
CREATE INDEX IF NOT EXISTS production_hourly_log_period_idx
    ON vision_data.production_hourly_log (period_start);


-- ---------------------------------------------------------------------------
-- Feeding it from camera_count_speed / camera_defect_speed
-- ---------------------------------------------------------------------------
-- Those tables hold ONE row per camera, updated in place. Each count_spdN /
-- defect_N is a 7-slot shift register: slot [1] is the running total for the
-- current batch (it only grows, and reset_*_on_batch_change zeroes it when
-- batch_id changes); slots [2..7] are copies shifted every 10 s for speed.
-- There is no history, so the hourly figure has to be captured as it happens:
-- on every update, the growth of slot [1] is added to the current hour.
--
--   count_total  += sum over N of growth(count_spdN[1])
--   defect_total += sum over N of growth(defect_N[1])
--
-- growth(new, old) = new - old, or new itself when the counter went DOWN (a
-- batch reset or PLC restart: everything after the reset is new production).
-- A batch reset to 0 therefore adds 0, and counting then resumes from 0.
-- The 10 s shift leaves slot [1] unchanged, so it adds nothing and writes nothing.
--
-- period_start uses localtimestamp, i.e. the WRITER session's TimeZone. Keep
-- the database default TimeZone plant-local (ALTER DATABASE ... SET timezone =
-- 'Asia/Bangkok') so a gateway connecting with a UTC session files hours correctly.

CREATE OR REPLACE FUNCTION vision_data.counter_growth(new_val integer, old_val integer)
    RETURNS integer
    LANGUAGE sql IMMUTABLE AS $$
SELECT CASE
           WHEN new_val IS NULL THEN 0
           WHEN old_val IS NULL OR new_val < old_val THEN GREATEST(new_val, 0)
           ELSE new_val - old_val
       END;
$$;

CREATE OR REPLACE FUNCTION vision_data.fn_log_production_hourly()
    RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    v_count  integer := 0;
    v_defect integer := 0;
BEGIN
    IF TG_TABLE_NAME = 'camera_count_speed' THEN
        v_count := vision_data.counter_growth(NEW.count_spd1[1], OLD.count_spd1[1])
                 + vision_data.counter_growth(NEW.count_spd2[1], OLD.count_spd2[1])
                 + vision_data.counter_growth(NEW.count_spd3[1], OLD.count_spd3[1])
                 + vision_data.counter_growth(NEW.count_spd4[1], OLD.count_spd4[1])
                 + vision_data.counter_growth(NEW.count_spd5[1], OLD.count_spd5[1]);
    ELSE
        v_defect := vision_data.counter_growth(NEW.defect_1[1], OLD.defect_1[1])
                  + vision_data.counter_growth(NEW.defect_2[1], OLD.defect_2[1])
                  + vision_data.counter_growth(NEW.defect_3[1], OLD.defect_3[1])
                  + vision_data.counter_growth(NEW.defect_4[1], OLD.defect_4[1])
                  + vision_data.counter_growth(NEW.defect_5[1], OLD.defect_5[1]);
    END IF;

    IF v_count = 0 AND v_defect = 0 THEN
        RETURN NULL;                       -- speed shift / no new counts
    END IF;

    BEGIN
        INSERT INTO vision_data.production_hourly_log AS log
            (line_code, location, period_start, count_total, defect_total)
        VALUES (NEW.code, NEW.location, date_trunc('hour', localtimestamp), v_count, v_defect)
        ON CONFLICT (line_code, period_start) DO UPDATE
            SET count_total  = log.count_total  + EXCLUDED.count_total,
                defect_total = log.defect_total + EXCLUDED.defect_total,
                location     = EXCLUDED.location,
                updated_at   = now();
    EXCEPTION WHEN OTHERS THEN
        -- The log is a by-product. A failure here must never roll back the
        -- camera's own counter update, or the vision station stops recording.
        RAISE WARNING 'production_hourly_log not updated for %: %', NEW.code, SQLERRM;
    END;
    RETURN NULL;
END;
$$;

-- AFTER, so the growth is measured on the row as finally stored — i.e. after
-- the BEFORE-UPDATE batch reset trigger has zeroed the counters.
DROP TRIGGER IF EXISTS trg_log_production_hourly ON vision_data.camera_count_speed;
CREATE TRIGGER trg_log_production_hourly
    AFTER UPDATE ON vision_data.camera_count_speed
    FOR EACH ROW EXECUTE FUNCTION vision_data.fn_log_production_hourly();

DROP TRIGGER IF EXISTS trg_log_production_hourly ON vision_data.camera_defect_speed;
CREATE TRIGGER trg_log_production_hourly
    AFTER UPDATE ON vision_data.camera_defect_speed
    FOR EACH ROW EXECUTE FUNCTION vision_data.fn_log_production_hourly();
