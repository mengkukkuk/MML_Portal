CREATE SCHEMA IF NOT EXISTS vision_data2;

-- 1. Table: cameras
CREATE TABLE IF NOT EXISTS vision_data2.cameras
(
    id             serial PRIMARY KEY,
    code           text NOT NULL UNIQUE,
    name           text NOT NULL,
    station_code   text,
    station_label  text,
    location       text,
    enabled        boolean DEFAULT true NOT NULL,
    defect_labels  text[] DEFAULT ARRAY['defect_1', 'defect_2', 'defect_3', 'defect_4', 'defect_5']::text[],
    created_at     timestamptz DEFAULT now() NOT NULL,
    updated_at     timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE vision_data2.cameras OWNER TO postgres;

-- 2. Table: camera_defect (Current State)
CREATE TABLE IF NOT EXISTS vision_data2.camera_defect
(
    id            serial PRIMARY KEY,
    code          text NOT NULL UNIQUE,
    name          text NOT NULL,
    station_code  text,
    station_label text,
    location      text,
    batch_id      integer DEFAULT 1 NOT NULL,
    defect_array  integer[] DEFAULT '{0,0,0,0,0}'::integer[],
    created_at    timestamptz DEFAULT now() NOT NULL,
    updated_at    timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE vision_data2.camera_defect OWNER TO postgres;

CREATE INDEX IF NOT EXISTS idx_camera_defect_code_batch
    ON vision_data2.camera_defect (lower(code) ASC, batch_id DESC);

-- 3. Table: camera_defect_logs (Historian Log)
CREATE TABLE IF NOT EXISTS vision_data2.camera_defect_logs
(
    id            bigserial PRIMARY KEY,
    camera_id     integer REFERENCES vision_data2.camera_defect(id) ON DELETE CASCADE,
    code          text NOT NULL,
    name          text NOT NULL,
    station_code  text,
    station_label text,
    location      text,
    batch_id      bigserial NOT NULL,
    defect_array  integer[] NOT NULL,
    created_at    timestamptz DEFAULT now() NOT NULL,
    updated_at    timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE vision_data2.camera_defect_logs OWNER TO postgres;

CREATE INDEX IF NOT EXISTS idx_camera_defect_logs_code_batch
    ON vision_data2.camera_defect_logs (lower(code) ASC, batch_id DESC);

-- 4. Shared Trigger Function: set_updated_at
CREATE OR REPLACE FUNCTION vision_data2.set_updated_at()
    RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION vision_data2.set_updated_at() OWNER TO postgres;

-- Dynamic Trigger Binding updated_at
DO $$
    DECLARE
        t text;
    BEGIN
        FOR t IN
            SELECT table_name
            FROM information_schema.columns
            WHERE table_schema = 'vision_data2'
              AND column_name = 'updated_at'
              AND table_name IN ('cameras', 'camera_defect', 'camera_defect_logs')
            LOOP
                EXECUTE format('
                DROP TRIGGER IF EXISTS trg_set_updated_at ON vision_data2.%I;
                CREATE TRIGGER trg_set_updated_at
                    BEFORE UPDATE ON vision_data2.%I
                    FOR EACH ROW
                    EXECUTE FUNCTION vision_data2.set_updated_at();
            ', t, t);
            END LOOP;
    END;
$$;

-- 5. Historian Trigger Function
CREATE OR REPLACE FUNCTION vision_data2.fn_log_camera_defect_history()
    RETURNS TRIGGER AS $$
DECLARE
    arr_len integer;
BEGIN
    IF NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
        INSERT INTO vision_data2.camera_defect_logs (
            camera_id, code, name, station_code, station_label, location,
            batch_id, defect_array, created_at, updated_at
        )
        VALUES (
                   OLD.id, OLD.code, OLD.name, OLD.station_code, OLD.station_label, OLD.location,
                   OLD.batch_id, OLD.defect_array, OLD.created_at, NOW()
               );

        arr_len := array_length(OLD.defect_array, 1);
        IF arr_len IS NOT NULL AND arr_len > 0 THEN
            NEW.defect_array := array_fill(0, ARRAY[arr_len]);
        ELSE
            NEW.defect_array := '{0,0,0,0,0}'::integer[];
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION vision_data2.fn_log_camera_defect_history() OWNER TO postgres;

-- Historian Trigger
DROP TRIGGER IF EXISTS trg_camera_defect_history ON vision_data2.camera_defect;
CREATE TRIGGER trg_camera_defect_history
    BEFORE UPDATE ON vision_data2.camera_defect
    FOR EACH ROW
EXECUTE FUNCTION vision_data2.fn_log_camera_defect_history();

-- VIEW .v_camera_defect_live
--
-- A convenience/reporting view. The application does NOT read it: `defects` is
-- keyed by label, which throws away the slot index, and NG frames on disk live
-- at <root>/<code>/NG/defect_<slot>/ -- so the camera rail reads the two arrays
-- directly and pairs them by position instead.
--
-- Invariant maintained here: the values of `defects` always sum to
-- `total_defects`. Three ways that could break, and how each is handled:
--   1. camera_defect row with no matching cameras row -> defect_labels is NULL.
--      Driving the join off generate_series (not off unnest(defect_labels))
--      means idx is never NULL, so the 'defect_' || idx fallback is never NULL
--      either. A NULL jsonb key would abort the query for EVERY camera, not
--      just the orphan.
--   2. Two slots sharing a label -> their counts are SUMmed into one key rather
--      than one silently overwriting the other.
--   3. defect_array longer than defect_labels (they are separate columns on
--      separate tables, with no constraint tying their lengths) -> the series
--      runs to the longer of the two, so trailing counts still get a key.
CREATE OR REPLACE VIEW vision_data2.v_camera_defect_live AS
WITH slot AS (
    -- แตก Label และ Count ตามลำดับ Index (1, 2, 3, ...)
    -- Out-of-range subscripts return NULL, which is what the COALESCEs absorb:
    -- an unnamed slot falls back to 'defect_N', an uncounted one to 0.
    SELECT
        d.id                                      AS camera_defect_id,
        COALESCE(c.defect_labels[s.idx], 'defect_' || s.idx) AS label_name,
        COALESCE(d.defect_array[s.idx], 0)        AS defect_count
    FROM vision_data2.camera_defect d
             LEFT JOIN vision_data2.cameras c ON c.code = d.code
             CROSS JOIN LATERAL generate_series(
            1,
            GREATEST(
                    COALESCE(array_length(c.defect_labels, 1), 0),
                    COALESCE(array_length(d.defect_array, 1), 0)
            )
                       ) AS s(idx)
),
     defects AS (
         SELECT camera_defect_id, jsonb_object_agg(label_name, defect_count) AS defects
         FROM (
                  SELECT camera_defect_id, label_name, SUM(defect_count)::integer AS defect_count
                  FROM slot
                  GROUP BY camera_defect_id, label_name
              ) folded
         GROUP BY camera_defect_id
     )
SELECT
    d.id AS camera_defect_id,
    d.code AS camera_code,
    d.name AS camera_name,
    d.batch_id,
    -- '{}' when both arrays are empty: generate_series(1, 0) yields no rows, so
    -- there is no `defects` row to join. A camera with nothing recorded is a
    -- normal camera and must still appear in the view.
    COALESCE(j.defects, '{}'::jsonb) AS defects,
    -- คำนวณผลรวม Defect ทั้งหมดใน Batch นี้ให้อัตโนมัติ
    (SELECT COALESCE(SUM(s), 0) FROM unnest(d.defect_array) s) AS total_defects,
    d.updated_at
FROM vision_data2.camera_defect d
         LEFT JOIN defects j ON j.camera_defect_id = d.id;

-- INSERT EXAMPLE DATA
INSERT INTO vision_data2.cameras (code, name, station_code, station_label, location, enabled)
VALUES ('CAM001-9', 'Camera 1', 'STATION001', 'Station 1', 'Line 9', true),
       ('CAM002-9', 'Camera 2', 'STATION002', 'Station 2', 'Line 9', true),
       ('CAM003-9', 'Camera 3', 'STATION003', 'Station 3', 'Line 9', true),
       ('CAM004-9', 'Camera 4', 'STATION004', 'Station 4', 'Line 9', true),
       ('CAM005-9', 'Camera 5', 'STATION005', 'Station 5', 'Line 9', true);

-- insert to defect_array
insert into vision_data2.camera_defect (code, name, station_code, station_label, location)
VALUES ('CAM001-9', 'Camera 1', 'STATION001', 'Station 1', 'Line 9'),
       ('CAM002-9', 'Camera 2', 'STATION002', 'Station 2', 'Line 9'),
       ('CAM003-9', 'Camera 3', 'STATION003', 'Station 3', 'Line 9'),
       ('CAM004-9', 'Camera 4', 'STATION004', 'Station 4', 'Line 9'),
       ('CAM005-9', 'Camera 5', 'STATION005', 'Station 5', 'Line 9');

