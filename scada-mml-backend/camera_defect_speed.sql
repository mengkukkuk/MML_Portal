CREATE TABLE camera_defect_speed (
     id BIGSERIAL PRIMARY KEY,
     code VARCHAR(50) NOT NULL unique,
     location text NOT NULL,
     defect_1 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(defect_1, 1) = 6 ),
     defect_2 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(defect_1, 1) = 6 ),
     defect_3 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(defect_1, 1) = 6 ),
     defect_4 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(defect_1, 1) = 6 ),
     defect_5 INT[] default array[0, 0, 0, 0, 0, 0]::INT[] check ( array_length(defect_1, 1) = 6 )
);

INSERT INTO camera_defect_speed (code,location) VALUES ('CAM001-13','Line 13');
INSERT INTO camera_defect_speed (code,location) VALUES ('CAM002-13','Line 13');
INSERT INTO camera_defect_speed (code,location) VALUES ('CAM003-13','Line 13');
INSERT INTO camera_defect_speed (code,location) VALUES ('CAM004-13','Line 13');

UPDATE camera_defect_speed SET defect_1 = ARRAY [
    defect_1[1] + 1,
    defect_1[2],
    defect_1[3],
    defect_1[4],
    defect_1[5],
    defect_1[6] ]
WHERE code = 'CAM001-13';

UPDATE camera_defect_speed SET defect_1 = ARRAY [
    0,
    defect_1[1],
    defect_1[2],
    defect_1[3],
    defect_1[4],
    defect_1[5] ]
WHERE code = 'CAM001-13';

SELECT (SELECT SUM(elem) FROM unnest(counter_array) AS elem) AS total_sum FROM count_speed WHERE sensor_name = 'Reject_1';
--ALTER TABLE count_speed
--ADD COLUMN speed_in_time INT GENERATED ALWAYS AS (
--    (counter_array[1] + counter_array[2] + counter_array[3] + counter_array[4] + counter_array[5] + counter_array[6])
--) STORED;
--SELECT * FROM count_speed cs ;

