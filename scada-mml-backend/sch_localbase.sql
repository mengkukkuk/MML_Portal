create table localbase.alert_source_settings
(
    id            integer                  default 1     not null
        primary key
        constraint alert_source_settings_singleton
            check (id = 1),
    datasource_id integer                                not null
        references localbase.datasources
            on delete cascade,
    table_name    text                                   not null,
    ts_col        text                                   not null,
    message_col   text                                   not null,
    severity_col  text,
    match_col     text,
    match_filter  text
        constraint alert_source_settings_filter
            check ((match_filter IS NULL) OR (match_filter = ANY (ARRAY ['location'::text, 'camera'::text]))),
    updated_at    timestamp with time zone default now() not null,
    role_col      text,
    constraint alert_source_settings_match
        check ((match_col IS NULL) = (match_filter IS NULL))
);

alter table localbase.alert_source_settings
    owner to postgres;

create table if not exists localbase.users
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

create table if not exists localbase.dashboards
(
    id         serial
        primary key,
    title      text                                   not null,
    position   integer                  default 0     not null,
    created_at timestamp with time zone default now() not null
);

alter table localbase.dashboards
    owner to postgres;

create table if not exists localbase.dashboard_panels
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

create table if not exists localbase.datasources
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

-- Monitor camera identity and defect data stay in the selected datasource.
-- This singleton stores only that required datasource choice in the app DB.
create table if not exists localbase.camera_link_settings
(
    id            integer default 1 not null
        primary key,
    datasource_id integer
        references localbase.datasources
            on delete set null,
    updated_at    timestamp with time zone default now() not null,
    constraint camera_link_settings_singleton check (id = 1)
);

alter table localbase.camera_link_settings
    owner to postgres;

-- The one alert message source (singleton): which connection, table and
-- columns hold the alerts the report trend marks — for every trend, whichever
-- connection its readings come from. No row means no source. The named table
-- may not exist yet; reads report it as unavailable rather than failing.
create table if not exists localbase.alert_source_settings
(
    id            integer default 1                      not null
        primary key,
    datasource_id integer                                not null
        references localbase.datasources
            on delete cascade,
    table_name    text                                   not null,
    ts_col        text                                   not null,
    message_col   text                                   not null,
    severity_col  text,
    match_col     text,
    match_filter  text,
    role_col      text,
    updated_at    timestamp with time zone default now() not null,
    constraint alert_source_settings_singleton
        check (id = 1),
    constraint alert_source_settings_match
        check ((match_col is null) = (match_filter is null)),
    constraint alert_source_settings_filter
        check (match_filter is null or match_filter in ('location', 'camera'))
);

alter table localbase.alert_source_settings
    owner to postgres;

-- Who has to act on an alert: one rule per row (role code + Thai/English names,
-- optional location / message keyword), tried by priority, first match wins;
-- no conditions = catch-all. An alert row tagged with a role id (the source's
-- role column, e.g. alert_messages.role_id) skips the rules. Edited in Settings.
create table if not exists localbase.response_role
(
    id         serial                                 primary key,
    code       text                                   not null,
    name_th    text                                   not null,
    name_en    text                                   not null,
    location   text,
    keyword    text,
    priority   integer                  default 100   not null,
    updated_at timestamp with time zone default now() not null
);

alter table localbase.response_role
    owner to postgres;

create table if not exists localbase.mimic_assets
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

create table if not exists localbase.mimic_symbols
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

create table if not exists localbase.user_datasource_selection
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

create table if not exists localbase.mimic_layouts
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

create table if not exists localbase.report_templates
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

create table if not exists localbase.report_settings
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

create table if not exists localbase.license_events
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

create table localbase.response_role
(
    id         serial
        primary key,
    code       text                                   not null,
    name_th    text                                   not null,
    name_en    text                                   not null,
    location   text,
    keyword    text,
    priority   integer                  default 100   not null,
    updated_at timestamp with time zone default now() not null
);

alter table localbase.response_role
    owner to postgres;

