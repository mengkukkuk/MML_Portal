create table localbase.devices
(
    id         serial
        primary key,
    name       text                                            not null
        unique,
    type       text                                            not null,
    location   text                     default ''::text       not null,
    status     text                     default 'online'::text not null,
    created_at timestamp with time zone default now()          not null
);

alter table localbase.devices
    owner to postgres;

create table localbase.alarms
(
    id              bigserial
        primary key,
    device_id       integer                                          not null
        references localbase.devices
            on delete cascade,
    severity        text                     default 'warning'::text not null,
    message         text                                             not null,
    ts              timestamp with time zone default now()           not null,
    acknowledged_at timestamp with time zone
);

alter table localbase.alarms
    owner to postgres;

create index idx_alarms_ts
    on localbase.alarms (ts desc);

create table localbase.users
(
    id            serial
        primary key,
    username      text                                              not null
        unique,
    password_hash text                                              not null,
    role          text                     default 'operator'::text not null,
    display_name  text                                              not null,
    created_at    timestamp with time zone default now()            not null,
    email         text
);

alter table localbase.users
    owner to postgres;

create unique index users_email_lower_key
    on localbase.users (lower(email))
    where (email IS NOT NULL);

create unique index uq_users_email
    on localbase.users (email);

create index ix_users_email
    on localbase.users (email);

create table localbase.dashboards
(
    id         serial
        primary key,
    title      text                                   not null,
    position   integer                  default 0     not null,
    created_at timestamp with time zone default now() not null
);

alter table localbase.dashboards
    owner to postgres;

create table localbase.dashboard_panels
(
    id                    serial
        primary key,
    title                 text                                            not null,
    device_id             integer,
    metric                text,
    window_minutes        integer                  default 15             not null,
    chart_type            text                     default 'line'::text   not null,
    position              integer                  default 0              not null,
    created_at            timestamp with time zone default now()          not null,
    options               jsonb                    default '{}'::jsonb    not null,
    source                text                     default 'device'::text not null,
    tag_name              text,
    poll_interval_seconds integer                  default 5              not null,
    table_name            text,
    filter_col            text,
    ts_col                text,
    datasource_id         integer,
    dashboard_id          integer
        references localbase.dashboards
            on delete cascade
);

alter table localbase.dashboard_panels
    owner to postgres;

create table localbase.datasources
(
    id         serial
        primary key,
    name       text                                              not null
        unique,
    type       text                     default 'postgres'::text not null,
    host       text                     default ''::text         not null,
    port       integer                  default 5432             not null,
    dbname     text                     default ''::text         not null,
    username   text                     default ''::text         not null,
    password   text                     default ''::text         not null,
    sslmode    text                     default 'prefer'::text   not null,
    db_schema  text                     default 'localbase'::text   not null,
    created_at timestamp with time zone default now()            not null,
    updated_at timestamp with time zone default now()            not null
);

alter table localbase.datasources
    owner to postgres;

create table localbase.mimic_assets
(
    id          serial
        primary key,
    name        text                                   not null,
    mime        text                                   not null,
    bytes       bytea                                  not null,
    size_bytes  integer                                not null,
    sha256      text                                   not null
        unique,
    uploaded_by integer,
    created_at  timestamp with time zone default now() not null
);

alter table localbase.mimic_assets
    owner to postgres;

create table localbase.mimic_symbols
(
    id         serial
        primary key,
    name       text                                            not null,
    asset_id   integer                                         not null
        references localbase.mimic_assets
            on delete restrict,
    w          integer                                         not null,
    h          integer                                         not null,
    ports      jsonb                    default '{}'::jsonb    not null,
    dynamics   jsonb                    default '[]'::jsonb    not null,
    binding    text                     default 'analog'::text not null,
    bubble     jsonb,
    created_at timestamp with time zone default now()          not null,
    updated_at timestamp with time zone default now()          not null
);

alter table localbase.mimic_symbols
    owner to postgres;

create table localbase.user_datasource_selection
(
    user_id       integer                                not null
        references localbase.users
            on delete cascade,
    datasource_id integer                                not null
        references localbase.datasources
            on delete cascade,
    position      integer                  default 0     not null,
    updated_at    timestamp with time zone default now() not null,
    primary key (user_id, datasource_id)
);

alter table localbase.user_datasource_selection
    owner to postgres;

create index idx_uds_user
    on localbase.user_datasource_selection (user_id, position);

create table localbase.mimic_layouts
(
    id         serial
        primary key,
    slug       text                                         not null
        unique,
    name       text                                         not null,
    doc        jsonb                    default '{}'::jsonb not null,
    updated_at timestamp with time zone default now()       not null,
    created_at timestamp with time zone default now()       not null
);

alter table localbase.mimic_layouts
    owner to postgres;

create table localbase.report_templates
(
    id              serial
        primary key,
    name            text                                         not null,
    description     text                     default ''::text    not null,
    blocks          jsonb                    default '[]'::jsonb not null,
    default_filters jsonb                    default '{}'::jsonb not null,
    is_default      boolean                  default false       not null,
    created_at      timestamp with time zone default now()       not null,
    updated_at      timestamp with time zone default now()       not null
);

alter table localbase.report_templates
    owner to postgres;

create table localbase.report_settings
(
    id                 integer                  default 1           not null
        primary key
        constraint report_settings_id_check
            check (id = 1),
    state_rules        jsonb                    default '{}'::jsonb not null,
    alarm_lead_seconds integer                  default 60          not null,
    updated_at         timestamp with time zone default now()       not null
);

alter table localbase.report_settings
    owner to postgres;

create table localbase.license_events
(
    id            serial
        primary key,
    event_type    text                                   not null,
    state         text                                   not null,
    license_id    text,
    tier          text,
    expires_at    timestamp with time zone,
    actor_user_id integer
                                                         references localbase.users
                                                             on delete set null,
    detail        text,
    created_at    timestamp with time zone default now() not null
);

alter table localbase.license_events
    owner to postgres;

create table localbase.cameras
(
    id             serial
        primary key,
    code           text                                   not null
        unique,
    name           text                                   not null,
    station_code   text,
    station_label  text,
    location       text,
    enabled        boolean                  default true  not null,
    -- One name per camera_defect slot: slot N means the same defect on both
    -- tables and in the image folder's defect_N directory. Null shows as a
    -- generic numbered bar rather than hiding the slot.
    defect_1_label text,
    defect_2_label text,
    defect_3_label text,
    defect_4_label text,
    defect_5_label text,
    created_at     timestamp with time zone default now() not null,
    updated_at     timestamp with time zone default now() not null
);

alter table localbase.cameras
    owner to postgres;

create table localbase.camera_defect
(
    id         serial
        constraint camera_defect_pk
            primary key,
    camera_id  text,
    updated_at timestamp default now(),
    batch_id   integer,
    defect_1   integer   default 0,
    defect_2   integer   default 0,
    defect_3   integer   default 0,
    defect_4   integer   default 0,
    defect_5   integer   default 0
);

alter table localbase.camera_defect
    owner to postgres;

-- camera_id holds the camera's printed code, not cameras.id: the inspection
-- system writes these rows and knows the code. Matched case-insensitively,
-- which needs an expression index -- a plain btree cannot serve lower(camera_id).
create index if not exists camera_defect_latest
    on localbase.camera_defect (lower(camera_id), batch_id desc);



create table localbase.camera_snapshots
(
    id          serial
        primary key,
    camera_id   integer                                      not null
        references localbase.cameras
            on delete cascade,
    captured_at timestamp with time zone default now()       not null,
    cause       text,
    verdict     text                     default 'ng'::text  not null,
    mime        text                                         not null,
    bytes       bytea                                        not null,
    size_bytes  integer                                      not null,
    sha256      text                                         not null,
    meta        jsonb                    default '{}'::jsonb not null,
    uploaded_by integer,
    created_at  timestamp with time zone default now()       not null,
    unique (camera_id, sha256)
);

alter table localbase.camera_snapshots
    owner to postgres;

create index camera_snapshots_recent
    on localbase.camera_snapshots (camera_id asc, captured_at desc);


