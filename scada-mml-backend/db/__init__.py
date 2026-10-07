"""PostgreSQL access layer, split by domain.

Everything that talks to Postgres lives in this package; routers and tests keep
doing ``import db`` and calling ``db.<name>`` exactly as before. Modules:

    pool         connection pools, per-datasource health/fast-fail, ``get_connection``
    fanout       parallel reads across the selected datasources
    users        users table and CRUD
    readings     devices, metrics, sensor readings
    dashboards   Live dashboards          panels   Live panels
    tags         ``variables_tag`` columns and the in-memory tag buffer
    alarms       recent events / alarms / acknowledge
    tables       plant-table access: introspection, per-source connection, latest
    series       windowed series queries, production-log aggregation
    datasources  saved datasources and their credential encryption
    selection    per-user datasource selection
    mimic        mimic layouts, assets, custom symbols
    cameras      camera link settings and the vision/camera report queries
    reports      report templates/settings and state/alarm/event-log queries
    license      license event log

Two rules keep this package behaving like the single module it replaced:

* **Cross-module calls are module-qualified at call time** —
  ``from . import pool as _pool`` then ``_pool.get_connection()`` — never
  ``from .pool import get_connection``. A copied name would freeze the function
  and a test (or caller) replacing it on ``db`` would not reach the code that
  uses it.
* **Setting an attribute on ``db`` writes through to the module that owns it**
  (see ``_Facade``). That is what makes ``db.SCHEMA_READY = True`` (main.py) and
  ``monkeypatch.setattr(db, "describe_table", fake)`` (tests) take effect where
  the name is actually used, not just on this namespace.

Every module lists its names in ``__all__`` (private ones included, so tests and
tools that reach for ``db._table_source_conn`` keep working), and this file
re-exports them.
"""
import sys
import types

from . import (
    alarms, cameras, dashboards, datasources, fanout, license, mimic, panels, pool, readings,
    reports, selection, series, tables, tags, users,
)
from .alarms import *  # noqa: F401,F403
from .cameras import *  # noqa: F401,F403
from .dashboards import *  # noqa: F401,F403
from .datasources import *  # noqa: F401,F403
from .fanout import *  # noqa: F401,F403
from .license import *  # noqa: F401,F403
from .mimic import *  # noqa: F401,F403
from .panels import *  # noqa: F401,F403
from .pool import *  # noqa: F401,F403
from .readings import *  # noqa: F401,F403
from .reports import *  # noqa: F401,F403
from .selection import *  # noqa: F401,F403
from .series import *  # noqa: F401,F403
from .tables import *  # noqa: F401,F403
from .tags import *  # noqa: F401,F403
from .users import *  # noqa: F401,F403

_MODULES = (
    pool, fanout, users, readings, dashboards, panels, tags, alarms, tables, series,
    datasources, selection, mimic, cameras, reports, license,
)

#: exported name -> the module that defines it
_OWNERS = {name: module for module in _MODULES for name in module.__all__}
assert len(_OWNERS) == sum(len(m.__all__) for m in _MODULES), "a name is exported by two db modules"


class _Facade(types.ModuleType):
    """``db`` itself: attribute writes go to the owning submodule as well."""

    def __setattr__(self, name, value):
        owner = _OWNERS.get(name)
        if owner is not None:
            setattr(owner, name, value)
        super().__setattr__(name, value)

    def __delattr__(self, name):
        owner = _OWNERS.get(name)
        if owner is not None:
            delattr(owner, name)
        super().__delattr__(name)


sys.modules[__name__].__class__ = _Facade
