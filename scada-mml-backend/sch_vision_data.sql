CREATE SCHEMA IF NOT EXISTS vision_data;

-- 1. Table: cameras
CREATE TABLE IF NOT EXISTS vision_data.cameras
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

ALTER TABLE vision_data.cameras OWNER TO postgres;

-- 2. Table: camera_defect (Current State)
CREATE TABLE IF NOT EXISTS vision_data.camera_defect
(
    id            serial PRIMARY KEY,
    code          text NOT NULL UNIQUE,
    name          text NOT NULL,
    station_code  text,
    station_label text,
    location      text,
    batch_id      integer DEFAULT 0 NOT NULL,
    defect_array  integer[] DEFAULT '{0,0,0,0,0}'::integer[],
    created_at    timestamptz DEFAULT now() NOT NULL,
    updated_at    timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE vision_data.camera_defect OWNER TO postgres;

CREATE INDEX IF NOT EXISTS idx_camera_defect_code_batch
    ON vision_data.camera_defect (lower(code) ASC, batch_id DESC);

-- 3. Table: camera_defect_logs (Historian Log)
CREATE TABLE IF NOT EXISTS vision_data.camera_defect_logs
(
    id            bigserial PRIMARY KEY,
    camera_id     integer REFERENCES vision_data.camera_defect(id) ON DELETE CASCADE,
    code          text NOT NULL,
    name          text NOT NULL,
    station_code  text,
    station_label text,
    location      text,
    batch_id      integer DEFAULT 0 NOT NULL,
    defect_array  integer[] NOT NULL,
    created_at    timestamptz DEFAULT now() NOT NULL,
    updated_at    timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE vision_data.camera_defect_logs OWNER TO postgres;

--4.
create table vision_data.camera_batch_work
(
    batch_id   bigint                   default nextval('vision_data.trn_batch_work_batch_id_seq'::regclass) not null
    constraint camera_batch_work_pk
    primary key,
    status     text,
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now(),
    camera_1   jsonb,
    camera_2   jsonb,
    camera_3   jsonb,
    camera_4   jsonb,
    camera_5   jsonb
);

alter table vision_data.camera_batch_work
    owner to postgres;

CREATE INDEX IF NOT EXISTS idx_camera_defect_logs_code_batch
    ON vision_data.camera_defect_logs (lower(code) ASC, batch_id DESC);

-- Shared Trigger Function: set_updated_at
CREATE OR REPLACE FUNCTION vision_data.set_updated_at()
    RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION vision_data.set_updated_at() OWNER TO postgres;

-- Dynamic Trigger Binding updated_at
DO $$
    DECLARE
        t text;
    BEGIN
        FOR t IN
            SELECT table_name
            FROM information_schema.columns
            WHERE table_schema = 'vision_data'
              AND column_name = 'updated_at'
              AND table_name IN ('cameras', 'camera_defect', 'camera_defect_logs','camera_batch_work')
            LOOP
                EXECUTE format('
                DROP TRIGGER IF EXISTS trg_set_updated_at ON vision_data.%I;
                CREATE TRIGGER trg_set_updated_at
                    BEFORE UPDATE ON vision_data.%I
                    FOR EACH ROW
                    EXECUTE FUNCTION vision_data.set_updated_at();
            ', t, t);
            END LOOP;
    END;
$$;

-- Historian Trigger Function
CREATE OR REPLACE FUNCTION vision_data.fn_log_camera_defect_history()
    RETURNS TRIGGER AS $$
DECLARE
    arr_len integer;
BEGIN
    IF NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
        INSERT INTO vision_data.camera_defect_logs (
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

ALTER FUNCTION vision_data.fn_log_camera_defect_history() OWNER TO postgres;

-- Historian Trigger
DROP TRIGGER IF EXISTS trg_camera_defect_history ON vision_data.camera_defect;
CREATE TRIGGER trg_camera_defect_history
    BEFORE UPDATE ON vision_data.camera_defect
    FOR EACH ROW
EXECUTE FUNCTION vision_data.fn_log_camera_defect_history();

-- VIEW .v_camera_defect_live
CREATE OR REPLACE VIEW vision_data.v_camera_defect_live AS
WITH slot AS (
    SELECT
        d.id                                      AS camera_defect_id,
        COALESCE(c.defect_labels[s.idx], 'defect_' || s.idx) AS label_name,
        COALESCE(d.defect_array[s.idx], 0)        AS defect_count
    FROM vision_data.camera_defect d
             LEFT JOIN vision_data.cameras c ON c.code = d.code
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
   --mapping defect_labels to defects
    COALESCE(j.defects, '{}'::jsonb) AS defects,

    (SELECT COALESCE(SUM(s), 0) FROM unnest(d.defect_array) s) AS total_defects,
    d.updated_at
FROM vision_data.camera_defect d
         LEFT JOIN defects j ON j.camera_defect_id = d.id;

-- Batch Work Trigger Function
CREATE OR REPLACE FUNCTION vision_data.fn_sync_camera_batch_work()
    RETURNS TRIGGER AS $$
DECLARE
    v_col_name TEXT;
    v_json_data JSONB;
BEGIN
    v_col_name := LOWER(REPLACE(NEW.name, ' ', '_'));
    v_json_data := to_jsonb(NEW.defect_array);

    EXECUTE format('
        INSERT INTO vision_data.camera_batch_work (batch_id, %I, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (batch_id) DO UPDATE
        SET %I = EXCLUDED.%I,
            updated_at = NOW();
    ', v_col_name, v_col_name, v_col_name)
        USING NEW.batch_id, v_json_data;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_camera_batch_work
    AFTER INSERT ON camera_defect_logs
    FOR EACH ROW
EXECUTE FUNCTION fn_sync_camera_batch_work();

-- insert to cameras
INSERT INTO vision_data.cameras (code, name, station_code, station_label, location, enabled)
VALUES ('CAM001-13', 'Camera 1', 'STATION001', 'Station 1', 'Line 13', true),
       ('CAM002-13', 'Camera 2', 'STATION002', 'Station 2', 'Line 13', true),
       ('CAM003-13', 'Camera 3', 'STATION003', 'Station 3', 'Line 13', true),
       ('CAM004-13', 'Camera 4', 'STATION004', 'Station 4', 'Line 13', true);

-- insert to camera_defect
insert into vision_data.camera_defect (code, name, station_code, station_label, location)
VALUES ('CAM001-13', 'Camera 1', 'STATION001', 'Station 1', 'Line 13'),
       ('CAM002-13', 'Camera 2', 'STATION002', 'Station 2', 'Line 13'),
       ('CAM003-13', 'Camera 3', 'STATION003', 'Station 3', 'Line 13'),
       ('CAM004-13', 'Camera 4', 'STATION004', 'Station 4', 'Line 13');

