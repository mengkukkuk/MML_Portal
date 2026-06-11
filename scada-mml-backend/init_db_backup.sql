-- MML Portal – database initialisation script
-- PostgreSQL 15+
-- Run once against a fresh "postgres" database (or any target DB):
--   psql -h localhost -U postgres -d postgres -f init_db_backup.sql

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- ============================================================
-- TABLE: devices
-- ============================================================
CREATE TABLE IF NOT EXISTS public.devices (
    id          integer NOT NULL,
    name        text    NOT NULL,
    type        text    NOT NULL,
    location    text    NOT NULL DEFAULT '',
    status      text    NOT NULL DEFAULT 'online',
    created_at  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS public.devices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.devices_id_seq OWNED BY public.devices.id;
ALTER TABLE ONLY public.devices ALTER COLUMN id SET DEFAULT nextval('public.devices_id_seq'::regclass);

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_name_key UNIQUE (name);


-- ============================================================
-- TABLE: sensor_readings
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sensor_readings (
    id        bigint           NOT NULL,
    device_id integer          NOT NULL,
    metric    text             NOT NULL,
    value     double precision NOT NULL,
    unit      text             NOT NULL DEFAULT '',
    ts        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS public.sensor_readings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.sensor_readings_id_seq OWNED BY public.sensor_readings.id;
ALTER TABLE ONLY public.sensor_readings ALTER COLUMN id SET DEFAULT nextval('public.sensor_readings_id_seq'::regclass);

ALTER TABLE ONLY public.sensor_readings
    ADD CONSTRAINT sensor_readings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sensor_readings
    ADD CONSTRAINT sensor_readings_device_id_fkey
        FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_sensor_readings_device_ts
    ON public.sensor_readings USING btree (device_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_sensor_readings_ts
    ON public.sensor_readings USING btree (ts DESC);


-- ============================================================
-- TABLE: alarms
-- ============================================================
CREATE TABLE IF NOT EXISTS public.alarms (
    id              bigint NOT NULL,
    device_id       integer NOT NULL,
    severity        text    NOT NULL DEFAULT 'warning',
    message         text    NOT NULL,
    ts              timestamp with time zone NOT NULL DEFAULT now(),
    acknowledged_at timestamp with time zone
);

CREATE SEQUENCE IF NOT EXISTS public.alarms_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.alarms_id_seq OWNED BY public.alarms.id;
ALTER TABLE ONLY public.alarms ALTER COLUMN id SET DEFAULT nextval('public.alarms_id_seq'::regclass);

ALTER TABLE ONLY public.alarms
    ADD CONSTRAINT alarms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.alarms
    ADD CONSTRAINT alarms_device_id_fkey
        FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_alarms_ts
    ON public.alarms USING btree (ts DESC);


-- ============================================================
-- TABLE: users
-- ============================================================
CREATE TABLE IF NOT EXISTS public.users (
    id            integer NOT NULL,
    username      text    NOT NULL,
    password_hash text    NOT NULL,
    role          text    NOT NULL DEFAULT 'operator',
    display_name  text    NOT NULL,
    created_at    timestamp with time zone NOT NULL DEFAULT now(),
    email         text
);

CREATE SEQUENCE IF NOT EXISTS public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;
ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);

-- Case-insensitive unique index on email (NULLs are excluded)
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
    ON public.users USING btree (lower(email))
    WHERE email IS NOT NULL;
