"""name_families.py must agree with the frontend's groupByFamily.

The first six cases are scada-frontend/src/utils/nameFamilies.test.js, ported
one for one. If one of these fails, the Reports trend and the management blocks
would disagree about which columns make a machine.
"""
from name_families import group_by_family, resolve_slot


def keys(groups):
    return [g["key"] for g in groups]


def test_groups_names_under_a_named_base_column():
    names = ["CAM001-13", "CAM002-13", "Pressure1", "Tanklevel",
             "CAM001-13-count_1", "CAM001-13-count_2", "CAM001-13-defect_1",
             "CAM002-13-count_1", "CAM002-13-defect_1"]
    groups = group_by_family(names)
    assert keys(groups) == ["CAM001-13", "CAM002-13", ""]
    assert groups[0]["names"] == ["CAM001-13", "CAM001-13-count_1", "CAM001-13-count_2", "CAM001-13-defect_1"]
    assert sorted(n for g in groups for n in g["names"]) == sorted(names)


def test_detects_repeated_suffix_families_without_a_base_column():
    groups = group_by_family(["Pump-A-count_1", "Pump-A-defect_1", "Pump-B-count_1"])
    assert keys(groups) == ["Pump-A", ""]
    assert groups[0]["names"] == ["Pump-A-count_1", "Pump-A-defect_1"]


def test_a_lone_hyphenated_name_does_not_group_by_itself():
    groups = group_by_family(["Pump-A-count_1", "Pump-B-count_1"])
    assert keys(groups) == [""]


def test_keeps_numbered_devices_and_delimiter_boundaries_intact():
    groups = group_by_family(["CAM001-13", "CAM001-14", "CAM001-13-count_1",
                              "CAM001-14-count_1", "CAM001-130-count_1", "Pressure1", "Pressure10"])
    assert keys(groups) == ["CAM001-13", "CAM001-14", ""]
    assert "CAM001-130-count_1" in next(g for g in groups if g["key"] == "")["names"]


def test_empty_and_unrelated_names_stay_flat():
    assert group_by_family() == []
    groups = group_by_family(["Pressure1", "Pressure2", "Tanklevel", "Temperature1"])
    assert keys(groups) == [""]


def test_prefers_the_closest_existing_base_for_nested_names():
    groups = group_by_family(["Pump", "Pump-A", "Pump-A-count_1"])
    assert next(g for g in groups if g["key"] == "Pump-A")["names"] == ["Pump-A", "Pump-A-count_1"]


# --- the real Line 13 table -------------------------------------------------

SENSOR_LOG1 = ["recorded_at"] + [
    f"CAM00{c}-13-{kind}_{n}" for c in range(1, 5) for kind in ("count", "defect") for n in range(1, 6)
] + ["Temparature1", "Temparature2", "Temparature3", "Temparature4"] + [
    f"CAM005-13-{kind}_{n}" for kind in ("count", "defect") for n in range(1, 6)
]


def test_sensor_log1_has_five_camera_families():
    groups = group_by_family(SENSOR_LOG1)
    assert [g["key"] for g in groups if g["key"]] == [f"CAM00{c}-13" for c in range(1, 6)]
    assert "Temparature1" in next(g for g in groups if g["key"] == "")["names"]


def test_slot_rules_pick_by_suffix():
    assert resolve_slot("CAM003-13", SENSOR_LOG1, "count_1") == ["CAM003-13-count_1"]
    assert resolve_slot("CAM003-13", SENSOR_LOG1, "defect_*") == [f"CAM003-13-defect_{n}" for n in range(1, 6)]
    assert resolve_slot("CAM003-13", SENSOR_LOG1, "nope") == []
    # a family prefix never leaks into a longer sibling
    assert resolve_slot("CAM001-1", ["CAM001-13-count_1"], "*") == []
