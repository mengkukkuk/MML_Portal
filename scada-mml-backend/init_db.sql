-- ==========================================================
-- MML Dashboard Platform
-- init_db.sql
--
-- PostgreSQL 18+
-- UUID Primary Keys
-- Asia/Bangkok Timezone
-- Site-Based Architecture
-- ==========================================================

SET timezone = 'Asia/Bangkok';

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ==========================================================
-- SCHEMAS
-- ==========================================================

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS asset;
CREATE SCHEMA IF NOT EXISTS historian;
CREATE SCHEMA IF NOT EXISTS alarm;
CREATE SCHEMA IF NOT EXISTS dashboard;
CREATE SCHEMA IF NOT EXISTS report;
CREATE SCHEMA IF NOT EXISTS integration;
CREATE SCHEMA IF NOT EXISTS audit;

-- ==========================================================
-- CORE
-- ==========================================================

CREATE TABLE IF NOT EXISTS  core.site (
    site_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,

    description TEXT,
    address TEXT,

    timezone VARCHAR(50)
        NOT NULL DEFAULT 'Asia/Bangkok',

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS  core.role (
    role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    role_name VARCHAR(50) UNIQUE NOT NULL,

    description TEXT
);

CREATE TABLE IF NOT EXISTS  core.permission (
    permission_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    permission_code VARCHAR(100)
        UNIQUE NOT NULL,

    description TEXT
);

CREATE TABLE IF NOT EXISTS  core.role_permission (
    role_id UUID NOT NULL,
    permission_id UUID NOT NULL,

    PRIMARY KEY(role_id, permission_id),

    FOREIGN KEY(role_id)
        REFERENCES core.role(role_id),

    FOREIGN KEY(permission_id)
        REFERENCES core.permission(permission_id)
);

CREATE TABLE IF NOT EXISTS  core.app_user (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    role_id UUID NOT NULL,

    username VARCHAR(100)
        UNIQUE NOT NULL,

    email VARCHAR(255),

    password_hash TEXT NOT NULL,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    last_login_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(role_id)
        REFERENCES core.role(role_id)
);

CREATE TABLE IF NOT EXISTS  core.user_site (
    user_id UUID NOT NULL,
    site_id UUID NOT NULL,

    PRIMARY KEY(user_id, site_id),

    FOREIGN KEY(user_id)
        REFERENCES core.app_user(user_id)
        ON DELETE CASCADE,

    FOREIGN KEY(site_id)
        REFERENCES core.site(site_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS  core.refresh_token (
    token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,

    token_hash TEXT NOT NULL,

    expires_at TIMESTAMPTZ NOT NULL,

    revoked BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id)
        REFERENCES core.app_user(user_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS  core.api_key (
    api_key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(100) NOT NULL,

    key_hash TEXT NOT NULL,

    expires_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS  core.system_setting (
    setting_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    setting_key VARCHAR(100)
        UNIQUE NOT NULL,

    setting_value TEXT,

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS  core.file_attachment (
    file_attachment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    file_name VARCHAR(255) NOT NULL,

    original_file_name VARCHAR(255),

    content_type VARCHAR(100),

    file_size BIGINT,

    storage_path TEXT NOT NULL,

    uploaded_by UUID,

    uploaded_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================================
-- ASSET
-- ==========================================================

CREATE TABLE IF NOT EXISTS  asset.device_group (
    device_group_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    site_id UUID NOT NULL,

    name VARCHAR(100) NOT NULL,

    description TEXT,

    FOREIGN KEY(site_id)
        REFERENCES core.site(site_id)
);

CREATE TABLE IF NOT EXISTS  asset.device_template (
    device_template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(100) UNIQUE NOT NULL,

    manufacturer VARCHAR(100),

    model VARCHAR(100),

    protocol VARCHAR(50),

    description TEXT
);

CREATE TABLE IF NOT EXISTS  asset.channel_template (
    channel_template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    device_template_id UUID NOT NULL,

    tag_name VARCHAR(200) NOT NULL,

    display_name VARCHAR(200),

    data_type VARCHAR(20),

    unit VARCHAR(20),

    scale_min DOUBLE PRECISION,
    scale_max DOUBLE PRECISION,

    scan_rate_ms INTEGER DEFAULT 1000,

    is_historized BOOLEAN DEFAULT TRUE,

    FOREIGN KEY(device_template_id)
        REFERENCES asset.device_template(device_template_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS  asset.device (
    device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    site_id UUID NOT NULL,

    device_group_id UUID,

    name VARCHAR(200) NOT NULL,

    protocol VARCHAR(50),

    ip_address INET,

    model VARCHAR(100),

    status VARCHAR(30) DEFAULT 'ONLINE',

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(site_id)
        REFERENCES core.site(site_id),

    FOREIGN KEY(device_group_id)
        REFERENCES asset.device_group(device_group_id)
);

CREATE TABLE IF NOT EXISTS  asset.device_connection_profile (
    profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    device_id UUID NOT NULL,

    profile_type VARCHAR(50) NOT NULL,

    config JSONB NOT NULL,

    FOREIGN KEY(device_id)
        REFERENCES asset.device(device_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS  asset.channel (
    channel_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    device_id UUID NOT NULL,

    tag_name VARCHAR(200) NOT NULL,

    display_name VARCHAR(200),

    data_type VARCHAR(20),

    unit VARCHAR(20),

    scale_min DOUBLE PRECISION,
    scale_max DOUBLE PRECISION,

    scan_rate_ms INTEGER DEFAULT 1000,

    is_historized BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(device_id)
        REFERENCES asset.device(device_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS  asset.tag_mapping (
    tag_mapping_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    channel_id UUID NOT NULL,

    business_tag VARCHAR(200) NOT NULL,

    description TEXT,

    FOREIGN KEY(channel_id)
        REFERENCES asset.channel(channel_id)
        ON DELETE CASCADE
);

-- ==========================================================
-- HISTORIAN
-- ==========================================================

CREATE TABLE IF NOT EXISTS  historian.channel_value (
    value_id UUID NOT NULL DEFAULT gen_random_uuid(),

    channel_id UUID NOT NULL,

    value_numeric DOUBLE PRECISION,

    value_text TEXT,

    value_boolean BOOLEAN,

    quality_code SMALLINT DEFAULT 1,

    ts TIMESTAMPTZ NOT NULL,

    PRIMARY KEY(value_id, ts),

    FOREIGN KEY(channel_id)
        REFERENCES asset.channel(channel_id)
)
PARTITION BY RANGE (ts);

CREATE TABLE IF NOT EXISTS  historian.channel_snapshot (
    channel_id UUID PRIMARY KEY,

    value_numeric DOUBLE PRECISION,

    value_text TEXT,

    value_boolean BOOLEAN,

    quality_code SMALLINT,

    ts TIMESTAMPTZ NOT NULL,

    FOREIGN KEY(channel_id)
        REFERENCES asset.channel(channel_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS  historian.data_retention_policy (
    policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    keep_raw_days INTEGER NOT NULL,

    keep_hourly_days INTEGER,

    keep_daily_days INTEGER
);

-- ==========================================================
-- ALARM
-- ==========================================================

CREATE TABLE IF NOT EXISTS  alarm.alarm_rule (
    rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    channel_id UUID NOT NULL,

    rule_name VARCHAR(100) NOT NULL,

    operator VARCHAR(10) NOT NULL,

    threshold_value DOUBLE PRECISION NOT NULL,

    severity SMALLINT DEFAULT 1,

    delay_seconds INTEGER DEFAULT 0,

    is_enabled BOOLEAN DEFAULT TRUE,

    FOREIGN KEY(channel_id)
        REFERENCES asset.channel(channel_id)
);

CREATE TABLE IF NOT EXISTS  alarm.alarm_event (
    alarm_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    rule_id UUID NOT NULL,

    start_time TIMESTAMPTZ NOT NULL,

    end_time TIMESTAMPTZ,

    actual_value DOUBLE PRECISION,

    acknowledged BOOLEAN DEFAULT FALSE,

    acknowledged_by UUID,

    acknowledged_at TIMESTAMPTZ,

    message TEXT,

    FOREIGN KEY(rule_id)
        REFERENCES alarm.alarm_rule(rule_id)
);

CREATE TABLE IF NOT EXISTS  alarm.alarm_comment (
    comment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    alarm_event_id UUID NOT NULL,

    user_id UUID NOT NULL,

    comment_text TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS  alarm.notification_rule (
    notification_rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    channel VARCHAR(50),

    destination TEXT,

    is_enabled BOOLEAN DEFAULT TRUE
);

-- ==========================================================
-- DASHBOARD
-- ==========================================================

CREATE TABLE IF NOT EXISTS  dashboard.dashboard (
    dashboard_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(200) NOT NULL,

    grafana_uid VARCHAR(100)
        UNIQUE NOT NULL,

    description TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS  dashboard.dashboard_permission (
    dashboard_id UUID NOT NULL,

    role_id UUID NOT NULL,

    can_view BOOLEAN DEFAULT TRUE,

    can_edit BOOLEAN DEFAULT FALSE,

    PRIMARY KEY(dashboard_id, role_id)
);

CREATE TABLE IF NOT EXISTS  dashboard.dashboard_favorite (
    user_id UUID NOT NULL,

    dashboard_id UUID NOT NULL,

    PRIMARY KEY(user_id, dashboard_id)
);

-- ==========================================================
-- REPORT
-- ==========================================================

CREATE TABLE IF NOT EXISTS  report.report_template (
    report_template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(200) NOT NULL,

    description TEXT
);

CREATE TABLE IF NOT EXISTS  report.report_schedule (
    report_schedule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    report_template_id UUID NOT NULL,

    cron_expression VARCHAR(100) NOT NULL,

    output_format VARCHAR(20) NOT NULL,

    enabled BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS  report.report_history (
    report_history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    report_template_id UUID,

    status VARCHAR(30),

    duration_ms BIGINT,

    file_attachment_id UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================================
-- INTEGRATION
-- ==========================================================

CREATE TABLE IF NOT EXISTS  integration.integration_endpoint (
    endpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(100) NOT NULL,

    endpoint_type VARCHAR(50),

    config JSONB
);

CREATE TABLE IF NOT EXISTS  integration.integration_log (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    endpoint_id UUID,

    request_payload JSONB,

    response_payload JSONB,

    status_code INTEGER,

    duration_ms BIGINT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================================
-- AUDIT
-- ==========================================================

CREATE TABLE IF NOT EXISTS  audit.audit_log (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID,

    action VARCHAR(100),

    entity_name VARCHAR(100),

    entity_id VARCHAR(100),

    old_data JSONB,

    new_data JSONB,

    ip_address INET,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================================
-- INDEXES
-- ==========================================================

CREATE INDEX idx_device_site
ON asset.device(site_id);

CREATE INDEX idx_channel_device
ON asset.channel(device_id);

CREATE INDEX idx_alarm_start
ON alarm.alarm_event(start_time DESC);

CREATE INDEX idx_audit_created
ON audit.audit_log(created_at DESC);

CREATE INDEX idx_snapshot_ts
ON historian.channel_snapshot(ts DESC);

-- ==========================================================
-- SEED DATA
-- ==========================================================

INSERT INTO core.role(role_name, description)
VALUES
('ADMIN','System Administrator'),
('ENGINEER','Maintenance Engineer'),
('OPERATOR','Production Operator'),
('VIEWER','Read Only User');

INSERT INTO core.permission(permission_code)
VALUES
('USER_CREATE'),
('USER_EDIT'),
('DEVICE_EDIT'),
('ALARM_ACK'),
('REPORT_EXPORT');