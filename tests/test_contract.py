"""계약 2.0 모델·의미 검증·JSON Schema."""

from __future__ import annotations

import copy
import json

import jsonschema
import pytest
from pydantic import ValidationError

from tests.helpers import example
from worldmodel.contract.export import schema
from worldmodel.contract.models import WorldSnapshot
from worldmodel.contract.semantic import check


def bad(mutate) -> dict:
    d = copy.deepcopy(example())
    mutate(d)
    return d


def dev(d, device_id):
    return next(x for x in d["devices"] if x["device_id"] == device_id)


# ---------- 정상 입력 ----------

def test_example_passes_model_and_semantic():
    s = WorldSnapshot.model_validate(example())
    assert check(s) == []


def test_example_passes_json_schema():
    jsonschema.Draft202012Validator(schema()).validate(example())


def test_roundtrip_is_stable():
    s = WorldSnapshot.model_validate(example())
    again = WorldSnapshot.model_validate_json(s.model_dump_json())
    assert again == s


# ---------- 형식 (422) ----------

@pytest.mark.parametrize("mutate", [
    lambda d: d.update(extra=1),                                        # 모르는 키
    lambda d: d.pop("room_links"),                                      # 키 누락 (빈 배열이라도 보내야 함)
    lambda d: d["people"][0].pop("position"),                           # null도 키는 남김
    lambda d: d.update(schema_version="0.1"),                           # Node 버전으로 덮지 않음
    lambda d: d.update(rooms=[]),                                       # 방 최소 1개
    lambda d: d["rooms"][0]["occupancy"].update(confidence=float("nan")),
    lambda d: d["rooms"][0]["temperature_c"].update(value=99),          # 범위 밖
    lambda d: d["rooms"][0]["temperature_c"]["evidence"].update(freshness="current"),  # current인데 observed_at 없음
    lambda d: d["people"][0].update(identity_source="UNKNOWN"),         # MEMBER_A + UNKNOWN 출처
    lambda d: d["people"][0].update(identity="GUEST", identity_source="FACE"),  # GUEST에 profile 연결
    lambda d: d["people"][0]["activity"].update(label="unknown"),       # unknown인데 confirmed
    lambda d: d["people"][0].update(room_id=None),                      # 방 없이 room_local 좌표
    lambda d: dev(d, "washer_01")["capabilities"]["actions"].append("set_power"),  # 세탁기에 없는 동작
    lambda d: dev(d, "ac_room1")["capabilities"].update(temperature=None),  # 온도 동작인데 범위 없음
    lambda d: dev(d, "ac_room1")["capabilities"].update(airflow_target=None),
    lambda d: dev(d, "washer_01")["state"].update(mode="turbo"),        # modes에 없는 현재 모드
    lambda d: dev(d, "light_room1")["state"].update(mode="x"),          # light state에 없는 키
    lambda d: d["profiles"][0].update(preferred_max_c=None),            # 둘 중 하나만 null
    lambda d: d["routines"][0].update(deadline_at="2026-11-13T20:00:00+09:00"),
])
def test_format_errors_rejected(mutate):
    with pytest.raises(ValidationError):
        WorldSnapshot.model_validate(bad(mutate))


# ---------- 의미 (422) ----------

@pytest.mark.parametrize("mutate, expect", [
    (lambda d: d["people"][1].update(person_id="person_a"), "people.person_id 중복"),
    (lambda d: d["people"][1]["track_refs"].__setitem__(0, {"node_id": "node_room1", "track_id": 1}),
     "동시에 연결"),
    (lambda d: d["people"][0]["evidence"].update(node_ids=["node_x"]), "없는 Node"),
    (lambda d: d["people"][0].update(room_id="attic"), "없는 방"),
    (lambda d: d["people"][0].update(profile_id="profile_b"), "identity"),
    (lambda d: dev(d, "ac_room1")["state"].update(target_c=24.5), "범위·간격"),
    (lambda d: dev(d, "ac_room1")["state"].update(airflow_target_person_id="person_z"), "people에 없는"),
    (lambda d: d["routines"][0].update(device_id="ac_room1"), "vacuum만"),
    (lambda d: d["room_influence"]["laundry"].update(laundry=1.0), "같은 방"),
    (lambda d: d["room_links"].append({"room_a": "living", "room_b": "room1", "passable": False}), "중복"),
    (lambda d: d["user_restrictions"].append({"restriction_id": "r1", "target_type": "device",
       "target_id": "tv_01", "action": None, "expires_at": None, "reason": ""}), "없는 기기"),
])
def test_semantic_errors(mutate, expect):
    errs = check(WorldSnapshot.model_validate(bad(mutate)))
    assert any(expect in e for e in errs), errs


def test_same_track_number_on_two_nodes_is_fine():
    """track 1이 두 Node에 있어도 다른 사람이다 (예제가 이미 그렇다)."""
    s = WorldSnapshot.model_validate(example())
    assert {(t.node_id, t.track_id) for p in s.people for t in p.track_refs} == {
        ("node_room1", 1), ("mock_living", 1)}
    assert check(s) == []


def test_schema_rejects_wrong_state_for_kind():
    d = bad(lambda d: dev(d, "light_room1").update(state={"status": "docked", "mode": None,
                                                          "target_room_ids": [], "dock_room_id": None}))
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.Draft202012Validator(schema()).validate(d)
    with pytest.raises(ValidationError):
        WorldSnapshot.model_validate(d)


def test_exported_schema_file_is_current():
    from worldmodel.contract.export import OUT
    assert json.loads(OUT.read_text(encoding="utf-8")) == schema(), "py -m worldmodel.contract.export 다시 실행"
