"""Machine families detected from column names, and slot rules within them.

A straight port of the frontend's `groupByFamily`
(scada-frontend/src/utils/nameFamilies.js). The Reports trend groups a wide
table's columns into devices with that function, and the management blocks
detect their machines with this one — the two must never disagree about what a
machine is, so tests/test_name_families.py carries the JS tests verbatim.
"""
from __future__ import annotations

from fnmatch import fnmatchcase


def _parent(name: str) -> str:
    split = name.rfind("-")
    return name[:split] if 0 < split < len(name) - 1 else ""


def group_by_family(names: list[str] | None = None) -> list[dict]:
    """[{key, names}] in first-seen order; ungrouped names collect under ''.

    A name whose parent (everything before its last '-') is itself present
    belongs to that parent's family (a named base, e.g. "CAM001-13"). Otherwise
    a shared hyphen prefix needs at least two siblings before it counts.
    """
    seen: list[str] = list(dict.fromkeys(names or []))
    known = set(seen)
    inferred: dict[str, int] = {}
    for name in seen:
        prefix = _parent(name)
        if prefix:
            inferred[prefix] = inferred.get(prefix, 0) + 1

    def family_for(name: str) -> str:
        prefix = _parent(name)
        while prefix:
            if prefix in known:
                return prefix
            prefix = _parent(prefix)
        sibling = _parent(name)
        return sibling if inferred.get(sibling, 0) > 1 else ""

    bases = {f for f in map(family_for, seen) if f in known}
    buckets: dict[str, list[str]] = {}
    for name in seen:
        key = name if name in bases else family_for(name)
        buckets.setdefault(key, []).append(name)
    return [{"key": key, "names": members} for key, members in buckets.items()]


def resolve_slot(family: str, names: list[str], rule: str) -> list[str]:
    """The columns of `family` a slot rule picks, in column order.

    The rule is a suffix after "<family>-": an exact name (`count_1`) or a glob
    (`defect_*`). Matching is case-sensitive, as column names are.
    """
    prefix = f"{family}-"
    return [
        n for n in names
        if n.startswith(prefix) and fnmatchcase(n[len(prefix):], rule)
    ]
