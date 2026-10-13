"""Suite-wide fixtures."""
import pytest

import db


@pytest.fixture(autouse=True)
def _fresh_schema_cache():
    """Tests create and drop plant tables freely, often under the same names.

    The introspection cache (db/tables.py) is keyed by database + schema + table,
    so a column list cached by one test would otherwise describe a table that a
    later test re-created with different columns.
    """
    db.forget_schema_cache()
    yield
    db.forget_schema_cache()
