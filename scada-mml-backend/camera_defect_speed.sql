CREATE TABLE camera_defect_speed (
     id BIGSERIAL PRIMARY KEY,
     code VARCHAR(50) NOT NULL unique,
     location text NOT NULL,
     createdAt TIMESTAMPTZ DEFAULT NOW(),
     updatedAt TIMESTAMPTZ DEFAULT NOW(),
     defect_1 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(defect_1, 1) = 6 ),
     defect_2 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(defect_2, 1) = 6 ),
     defect_3 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(defect_3, 1) = 6 ),
     defect_4 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(defect_4, 1) = 6 ),
     defect_5 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(defect_5, 1) = 6 )
);

CREATE TABLE camera_count_speed (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL unique,
    location text NOT NULL,
    createdAt TIMESTAMPTZ DEFAULT NOW(),
    updatedAt TIMESTAMPTZ DEFAULT NOW(),
    count_spd1 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(count_spd1, 1) = 6 ),
    count_spd2 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(count_spd2, 1) = 6 ),
    count_spd3 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(count_spd3, 1) = 6 ),
    count_spd4 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(count_spd4, 1) = 6 ),
    count_spd5 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(count_spd5, 1) = 6 )
);

--INSERT
INSERT INTO camera_defect_speed (code,location)
VALUES  ('CAM001-13','Line 13'),
        ('CAM002-13','Line 13'),
        ('CAM003-13','Line 13'),
        ('CAM004-13','Line 13')
ON CONFLICT (code) DO NOTHING;

INSERT INTO camera_count_speed (code,location)
VALUES  ('CAM001-13','Line 13'),
        ('CAM002-13','Line 13'),
        ('CAM003-13','Line 13'),
        ('CAM004-13','Line 13')
ON CONFLICT (code) DO NOTHING;

--SELECT SUM every interval time (10s), unit = defects/min
--SELECT (SELECT SUM(elem) FROM unnest(defect_1) AS elem) AS total_sum FROM camera_defect_speed WHERE code = 'CAM001-13';
--ALTER TABLE camera_defect_speed
--ADD COLUMN speed_in_time INT GENERATED ALWAYS AS (
--   (defect_1[1] + defect_1[2] + defect_1[3] + defect_1[4] + defect_1[5] + defect_1[6])
--) STORED;
--SELECT * FROM camera_defect_speed cs ;

CREATE OR REPLACE FUNCTION array_sum(arr int[])
    RETURNS int AS $$
SELECT COALESCE(SUM(x)::int, 0) FROM unnest(arr) AS x;
$$ LANGUAGE sql IMMUTABLE STRICT;

-- Add 'speed_in_time' as an INT[] storing array sums
ALTER TABLE camera_count_speed
    ADD COLUMN speed_in_time INT[] GENERATED ALWAYS AS (
        ARRAY[
            array_sum(count_spd1),
            array_sum(count_spd2),
            array_sum(count_spd3),
            array_sum(count_spd4),
            array_sum(count_spd5)
            ]
        ) STORED;

ALTER TABLE camera_defect_speed
    ADD COLUMN speed_in_time INT[] GENERATED ALWAYS AS (
        ARRAY[
            array_sum(defect_1),
            array_sum(defect_2),
            array_sum(defect_3),
            array_sum(defect_4),
            array_sum(defect_5)
            ]
        ) STORED;

--UPDATE at index[1]+1 when any defect_n is counted
UPDATE camera_defect_speed SET defect_1 = ARRAY [
    defect_1[1] + 1,
    defect_1[2],
    defect_1[3],
    defect_1[4],
    defect_1[5],
    defect_1[6] ]
WHERE code = 'CAM001-13';

-- Shift []-> every interval time (10s)
UPDATE camera_defect_speed SET defect_1 = ARRAY [
    0,
    defect_1[1],
    defect_1[2],
    defect_1[3],
    defect_1[4],
    defect_1[5] ]
WHERE code = 'CAM001-13';