"""The shared per-source report attached to every fanned-out response.

Lives in its own module so the six routers that fan out agree on one shape.
A response carrying rows from several plants is only interpretable alongside
the list of plants that were asked: "no alarms" from three healthy sources and
"no alarms" because two of them were unreachable look identical otherwise, and
that difference is the whole point of an alarm page.

`error` is the first line of the failure, which for a connection failure names
the host. Every route that returns it is already behind `get_current_user`, and
`GET /api/datasources` exposes the same hosts to the same audience.
"""
from datetime import datetime, timezone

from pydantic import BaseModel


class SourceReport(BaseModel):
    datasource_id: int | None = None
    datasource_name: str | None = None
    ok: bool = True
    error: str | None = None


_EPOCH = datetime.min.replace(tzinfo=timezone.utc)


def sort_key(field: str):
    """A timestamp sort key that survives merging plants.

    Two plants can disagree about whether their timestamp column is tz-aware,
    and comparing an aware datetime to a naive one raises TypeError — which,
    inside a route, is a 500 that only appears once a second source is selected.
    Naive values are read as UTC and NULLs sort oldest.
    """
    def key(row):
        value = row.get(field)
        if not isinstance(value, datetime):
            return _EPOCH
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return key
