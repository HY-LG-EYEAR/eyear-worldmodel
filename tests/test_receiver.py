"""수신측 규칙 (계약 10장) — 엔진 출력이 실제로 채택되는지까지 끝에서 끝으로."""

from __future__ import annotations

import copy
import uuid

import pytest

from tests.helpers import CONFIG, FakeNode, at, example, person
from worldmodel.config import load_config
from worldmodel.contract.models import WorldSnapshot
from worldmodel.contract.receiver import SnapshotReceiver, can_issue
from worldmodel.engine import WorldEngine


@pytest.fixture
def rx():
    r = SnapshotReceiver()
    r.register("home_demo_01", example()["world_session_id"])
    return r


def test_accept_and_idempotent(rx):
    assert rx.receive(example())[0] == 202
    code, body = rx.receive(example())
    assert code == 202 and body["duplicate"] is True and rx.decisions == 1   # 재판단 안 함


def test_same_revision_different_payload_conflicts(rx):
    rx.receive(example())
    d = example()
    d["rooms"][0]["occupancy"]["confidence"] = 0.5
    assert rx.receive(d)[0] == 409


def test_older_revision_conflicts(rx):
    rx.receive(example())
    d = example()
    d["world_revision"] = 101
    assert rx.receive(d)[0] == 409
    d["world_revision"] = 103
    assert rx.receive(d)[0] == 202


def test_unregistered_session_rejected_until_reset(rx):
    d = example()
    d["world_session_id"] = str(uuid.uuid4())
    assert rx.receive(d)[0] == 409                    # 임의 UUID로 세션을 바꾸지 않음
    rx.register("home_demo_01", d["world_session_id"])
    assert rx.receive(d)[0] == 202


def test_invalid_is_422(rx):
    d = example()
    d["people"][0]["room_id"] = "attic"
    code, body = rx.receive(d)
    assert code == 422 and any("없는 방" in e for e in body["errors"])
    assert rx.receive("{not json")[0] == 422


def test_live_window(rx):
    d = example()
    d["clock_mode"] = "live"
    assert rx.receive(copy.deepcopy(d), now=at(4 * 60 + 30 + 121))[0] == 422
    assert rx.receive(copy.deepcopy(d), now=at(4 * 60 + 30 + 1))[0] == 202


def test_same_occurrence_does_not_create_new_work(rx):
    rx.receive(example())
    d = example()
    d["world_revision"] = 103
    rx.receive(d)
    assert list(rx.work) == [("daily_clean_20261113_evening", "room1")]
    d = example()
    d["world_revision"] = 104
    d["routines"][0]["occurrence_id"] = "daily_clean_20261114_evening"
    rx.receive(d)
    assert len(rx.work) == 2                          # 회차가 바뀌면 새 작업


@pytest.mark.parametrize("device, action, params, ok", [
    ("vacuum_01", "set_mode", {"mode": "turbo"}, False),           # 없는 모드
    ("vacuum_01", "set_mode", {"mode": "quiet"}, True),
    ("washer_01", "set_power", {}, False),                         # 광고 안 한 동작
    ("light_room1", "set_airflow_target", {"person_id": "person_a"}, False),  # 풍향 없는 기기
    ("ac_room1", "set_airflow_target", {"person_id": "person_a"}, True),
    ("ac_room1", "set_airflow_target", {"person_id": "person_b"}, False),     # 다른 방 사람
    ("ac_room1", "set_target_temperature", {"target_c": 24.5}, False),        # 간격 밖
    ("ac_room1", "set_target_temperature", {"target_c": 31}, False),
    ("ac_room1", "set_target_temperature", {"target_c": 23}, True),
    ("vacuum_01", "start_cleaning", {"room_ids": ["room1"]}, True),
    ("tv_01", "set_power", {}, False),
])
def test_can_issue(device, action, params, ok):
    s = WorldSnapshot.model_validate(example())
    assert can_issue(s, device, action, params)[0] is ok


def test_engine_output_accepted_end_to_end():
    eng = WorldEngine(load_config(CONFIG))
    rx = SnapshotReceiver()
    rx.register(eng.cfg.home_id, eng.session_id)
    n = FakeNode()
    codes = []
    for t in range(0, 40):
        eng.ingest_node(n.msg(t, persons=[person()] if t < 20 else [], light="BRIGHT" if t < 20 else "DARK"), at(t))
        for dt in (0.0, 0.5):
            s = eng.poll(at(t + dt))
            if s is not None:
                codes.append(rx.receive(s.model_dump(mode="json"), now=at(t + dt))[0])
    assert codes and set(codes) == {202}
    final = rx.snapshots[eng.cfg.home_id]
    a = next(p for p in final.people if p.person_id == "person_a")
    assert a.room_id == "room1" and a.posture == "UNKNOWN"   # 어두워진 뒤에도 방 유지, 자세는 모름

    sid = eng.reset()
    s = eng.snapshot(at(41))
    assert rx.receive(s.model_dump(mode="json"), now=at(41))[0] == 409   # 등록 전
    rx.register(eng.cfg.home_id, sid)
    assert rx.receive(s.model_dump(mode="json"), now=at(41))[0] == 202


def test_session_clock_mode_must_match():
    rx = SnapshotReceiver()
    d = example()                                             # clock_mode replay
    rx.register("home_demo_01", d["world_session_id"], clock_mode="live")
    code, body = rx.receive(d)
    assert code == 409 and "clock_mode" in body["errors"][0]
    rx.register("home_demo_01", d["world_session_id"], clock_mode="replay")
    assert rx.receive(d)[0] == 202
    with pytest.raises(ValueError):
        rx.register("home_demo_01", d["world_session_id"], clock_mode="fast")


def _with(**changes):
    d = example()
    for k, v in changes.items():
        d[k] = v
    return d


def test_manual_override_blocks_commands():
    d = example()
    next(x for x in d["devices"] if x["device_id"] == "light_room1")["manual_override"] = True
    s = WorldSnapshot.model_validate(d)
    ok, why = can_issue(s, "light_room1", "set_power", {"power": "off"})
    assert not ok and "manual_override" in why
    assert can_issue(s, "curtain_room1", "set_curtain_position", {"position_pct": 0})[0]   # 다른 기기는 됨


def restriction(target_type, target_id, action=None, expires_at=None, rid="r1"):
    return {"restriction_id": rid, "target_type": target_type, "target_id": target_id, "action": action,
            "expires_at": expires_at, "reason": "테스트"}


@pytest.mark.parametrize("u, device, action, params, ok", [
    (restriction("room", "room1", "start_cleaning"), "vacuum_01", "start_cleaning", {"room_ids": ["room1"]}, False),
    (restriction("room", "room1", "start_cleaning"), "vacuum_01", "start_cleaning", {"room_ids": ["living"]}, True),
    (restriction("room", "room1"), "light_room1", "set_power", {"power": "off"}, False),        # action null = 전부
    (restriction("room", "room1", "start_cleaning"), "light_room1", "set_power", {"power": "off"}, True),
    (restriction("device", "ac_room1", "set_power"), "ac_room1", "set_power", {"power": "on"}, False),
    (restriction("device", "ac_room1", "set_power"), "ac_living", "set_power", {"power": "on"}, True),
    (restriction("room", "room1", None, "2026-11-13T21:00:00+09:00"), "light_room1", "set_power",
     {"power": "off"}, True),                                                                  # as_of 전에 만료
    (restriction("room", "room1", None, "2026-11-13T22:00:00+09:00"), "light_room1", "set_power",
     {"power": "off"}, False),
])
def test_user_restrictions(u, device, action, params, ok):
    s = WorldSnapshot.model_validate(_with(user_restrictions=[u]))
    got, why = can_issue(s, device, action, params)
    assert got is ok, why
    if not ok:
        assert "r1" in why
