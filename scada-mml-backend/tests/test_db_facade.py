"""The `db` package must behave like the single module it replaced.

`db.py` was split into db/ (pool, tables, mimic, ...). Routers and tests still do
`import db` and call or patch `db.<name>`, so two things must hold: every name that
module exposed is still on `db`, and *setting* a name on `db` reaches the module
that uses it (otherwise `monkeypatch.setattr(db, "get_connection", fake)` would
change a copy nothing calls).
"""
import pytest

import db

# Every top-level name the old db.py defined (minus the two globals that are
# rebound inside their module and so cannot be mirrored: _last_evict_log,
# _credential_security). A name dropped in a refactor fails here.
EXPECTED_NAMES = (
    "MAX_BATCH_WORK_ROWS", "PERIOD_BUCKETS", "REPORT_LAYOUT_VERSION", "SCHEMA_READY",
    "SENSITIVE_TABLES", "_BOOL_TYPES", "_CATALOG_TTL_SECONDS", "_DASH_COLS", "_DATETIME_TYPES",
    "_DB_COLUMN_FIELD", "_DEFAULT_STATE_RULES", "_DEFAULT_TEMPLATE_BLOCKS", "_DS_PUBLIC_COLS",
    "_DS_RETRY_AFTER_S", "_FIELD_DB_COLUMN", "_LAYOUT_V2_BLOCKS", "_NUMERIC_ARRAY_UDTS",
    "_NUMERIC_TYPES", "_PANEL_COLS", "_SELECTION_COLS", "_SLOT_LABEL", "_SYMBOL_COLS",
    "_TEMPLATE_COLS", "_TEXT_TYPES", "_TS_TYPES", "_TYPE_BADGES", "_allowed_tables",
    "_buffer_maxlen", "_build_pool", "_camera_filter", "_camera_scope", "_catalog_cache",
    "_claim_probe", "_credential_states", "_db_state", "_discover_tag_fields", "_ds_down_lock",
    "_ds_down_until", "_ds_errors", "_ds_probing", "_evict_excess_keys", "_fanout_pool",
    "_first_line", "_is_array_type", "_is_orderable_reading", "_is_recovery_error",
    "_machine_filter", "_mark_reachable", "_metric_select", "_migrate_plaintext_passwords",
    "_outage_logged", "_pool_for", "_pool_lock", "_pool_schemas", "_pools",
    "_primary_key_columns", "_probe_done", "_record", "_refresh_credential_state_after_write",
    "_safe_identifiers", "_series_window_query", "_slot_label", "_table_columns",
    "_table_source_conn", "_tag_buffer", "_tag_buffer_lock", "_tag_fields_cache",
    "_tag_sampled_at", "_type_badge", "_upgrade_report_templates", "_vision_catalog_cache",
    "acknowledge_alarm", "all_selected_datasource_ids", "buffered_tag_latest",
    "buffered_tag_series", "camera_defect_latest", "close_all_pools", "count_admins",
    "count_camera_defect_logs", "count_datasources", "count_event_log", "count_users",
    "create_dashboard", "create_datasource", "create_panel", "create_report_template",
    "create_user", "datasource_credential_security", "datasource_credential_state",
    "datasource_health", "datasource_names", "datasource_reachable", "db_state",
    "default_datasource", "delete_dashboard", "delete_datasource", "delete_mimic_asset",
    "delete_mimic_layout", "delete_mimic_symbol", "delete_panel", "delete_report_template",
    "delete_user", "describe_table", "distinct_column_values", "drop_pool",
    "encrypt_legacy_datasource_passwords", "ensure_app_schema", "fan_out", "fan_out_rows",
    "fetch_alarms_for_window", "fetch_camera_batch_work", "fetch_camera_defect_logs_page",
    "fetch_camera_defect_periods", "fetch_camera_hourly", "fetch_camera_log_summary",
    "fetch_event_log_page", "fetch_state_events", "find_mimic_asset_by_hash",
    "get_camera_link_source", "get_connection", "get_datasource", "get_datasource_secret",
    "get_default_report_template", "get_mimic_asset", "get_mimic_layout", "get_mimic_symbol",
    "get_remote_camera_option_by_code", "get_report_settings", "get_report_template",
    "get_user_by_email", "get_user_by_id", "get_user_by_username", "get_user_selection",
    "init_camera_link_settings_table", "init_dashboards_table", "init_datasources_table",
    "init_license_events_table", "init_mimic_assets_table", "init_mimic_symbols_table",
    "init_mimic_table", "init_panels_table", "init_report_tables",
    "init_user_datasource_selection_table", "init_users_table", "insert_license_event",
    "insert_mimic_asset", "insert_mimic_symbol", "is_tag_buffered", "latest_reading",
    "latest_tag", "list_active_alarms", "list_dashboards", "list_datasources", "list_devices",
    "list_metrics", "list_mimic_assets", "list_mimic_layouts", "list_mimic_symbols",
    "list_panels", "list_recent_alarms", "list_recent_events", "list_remote_camera_options",
    "list_report_templates", "list_schema_tables", "list_tags", "list_users", "logger",
    "mimic_asset_users", "probe", "production_log_hourly", "reading_series",
    "reconcile_datasource_credentials", "report_catalog", "sampled_datasource_ids",
    "series_step", "set_camera_link_source", "set_password", "set_user_selection",
    "snapshot_variables_tag", "table_latest", "table_rows", "table_series",
    "tag_buffer_stale_after", "tag_fields", "update_dashboard", "update_datasource",
    "update_mimic_symbol", "update_panel", "update_panel_poll_interval",
    "update_report_settings", "update_report_template", "update_user", "upsert_mimic_layout",
    "vision_report_catalog"
)


def test_every_name_the_old_module_exposed_is_still_there():
    missing = [name for name in EXPECTED_NAMES if not hasattr(db, name)]
    assert not missing, f"db lost: {missing}"


def test_every_export_is_defined_by_exactly_one_module():
    owners = db._OWNERS
    assert set(EXPECTED_NAMES) <= set(owners), "a name is on db but owned by no module"
    for name, module in owners.items():
        assert hasattr(module, name), f"{module.__name__} lists {name} but does not define it"
        assert getattr(db, name) is getattr(module, name), f"db.{name} is not {module.__name__}.{name}"
    module_names = {m.__name__.rsplit(".", 1)[-1] for m in db._MODULES}
    assert not module_names & set(owners), "an exported name shadows a submodule"


def test_setting_a_name_on_db_reaches_the_module_that_owns_it(monkeypatch):
    sentinel = object()
    original = db.get_connection
    monkeypatch.setattr(db, "get_connection", sentinel)
    assert db.pool.get_connection is sentinel
    monkeypatch.undo()
    assert db.get_connection is original
    assert db.pool.get_connection is original


def test_a_patch_on_db_is_seen_by_callers_in_other_modules(monkeypatch):
    """users.count_users reaches the pool as `_pool.get_connection()`, so patching
    `db.get_connection` must change what it calls — the property a plain re-export
    facade would silently lose."""
    class Boom(Exception):
        pass

    def boom():
        raise Boom

    monkeypatch.setattr(db, "get_connection", boom)
    with pytest.raises(Boom):
        db.count_users()


def test_state_set_on_db_is_what_the_owner_reads(monkeypatch):
    """main.py writes `db.SCHEMA_READY`; `db_state()` (in pool) must report it."""
    monkeypatch.setattr(db, "SCHEMA_READY", True)
    assert db.pool.SCHEMA_READY is True
    assert db.db_state()["schema_ready"] is True
    monkeypatch.setattr(db, "SCHEMA_READY", False)
    assert db.db_state()["schema_ready"] is False


def test_rebinding_private_state_through_db_reaches_the_owner(monkeypatch):
    fresh = {"ok": True, "checked_at": "sentinel"}
    monkeypatch.setattr(db, "_db_state", fresh)
    assert db.pool._db_state is fresh
    assert db.db_state()["checked_at"] == "sentinel"
