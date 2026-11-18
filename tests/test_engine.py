"""World Model 엔진 — Node 메시지 → 2.0 스냅샷. 계약 12쪽 인수 테스트의 WM 쪽."""

from __future__ import annotations

import pytest

from tests.helpers import CONFIG, FakeNode, at, person
from worldmodel.config import load_config
from worldmodel.contract.semantic import check
from worldmodel.engine import WorldEngine

PROFILES = [
    {"profile_id": "profile_a", "identity": "MEMBER_A", "preferred_min_c": 23, "preferred_max_c": 25,
     "quiet_rest": True, "quiet_meeting": True},
    {"profile_id": "profile_b", "identity": "MEMBER_B", "preferred_min_c": None, "preferred_max_c": None,
     "quiet_rest": None, "quiet_meeting": None},
]


@pytest.fixture
def eng() -> WorldEngine:
    e = WorldEngine(load_config(CONFIG))
    e.set_profiles(PROFILES)
    return e


def room(s, rid):
    return next(r for r in s.rooms if r.room_id == rid)


def who(s, pid):
    return next((p for p in s.people if p.person_id == pid), None)


def node(s, nid):
    return next(n for n in s.nodes if n.node_id == nid)


# ---------- 시작 상태: 모르는 건 모른다고 ----------

def test_empty_engine_is_all_unknown(eng):
    s = eng.snapshot(at(0))
    assert check(s) == []
    assert s.world_revision == 1 and s.schema_version == "2.0"
    assert all(r.occupancy.state == "UNKNOWN" and r.occupancy.evidence.freshness == "unavailable" for r in s.rooms)
    assert all(n.availability == "unknown" and n.last_seq is None for n in s.nodes)
    assert s.people == [] and s.devices == []          # 공급되지 않은 기기를 만들어 넣지 않음
    assert all(r.temperature_c.value is None for r in s.rooms)  # 0으로 채우지 않음


def test_basic_mapping(eng):
    n = FakeNode()
    assert eng.ingest_node(n.msg(0, persons=[person()]), at(0)) == "accepted"
    s = eng.snapshot(at(0.2))
    r1 = room(s, "room1")
    assert r1.occupancy.state == "OCCUPIED" and r1.occupancy.confidence == 0.95
    assert r1.occupancy.evidence.source == "node" and r1.occupancy.evidence.node_ids == ["node_room1"]
    assert r1.light.level == "BRIGHT" and r1.light.confidence is None  # Node light엔 confidence 없음
    a = who(s, "person_a")
    assert a.profile_id == "profile_a" and a.room_id == "room1"
    assert a.identity_source == "FACE"
    assert a.activity.label == "resting" and a.activity.confirmed is False  # 아직 3초 안 됨
    assert a.position.frame == "room_local" and (a.position.x, a.position.y) == (2.4, 2.67)
    assert [(t.node_id, t.track_id) for t in a.track_refs] == [("node_room1", 1)]
    nd = node(s, "node_room1")
    assert nd.availability == "online" and nd.last_seq == 1 and nd.schema_version == "0.1"
    assert nd.received_at == at(0) and nd.supports_speak is True
    # Node가 없는 부엌은 여전히 모름
    assert room(s, "kitchen").occupancy.state == "UNKNOWN"


def test_activity_confirmed_and_stable_for_s(eng):
    n = FakeNode()
    for t in range(0, 5):
        eng.ingest_node(n.msg(t, persons=[person()]), at(t))
    s = eng.snapshot(at(4))
    a = who(s, "person_a")
    assert a.activity.confirmed is True and a.activity.stable_for_s == 4
    assert room(s, "room1").occupancy.stable_for_s == 4
    eng.ingest_node(n.msg(5, persons=[person(activity="OTHER", posture="SITTING")]), at(5))
    a = who(eng.snapshot(at(5)), "person_a")
    assert a.activity.label == "other" and a.activity.confirmed is False and a.activity.stable_for_s == 0


# ---------- 재실 보존 ----------

def test_occupied_with_no_persons_is_not_empty(eng):
    """추적 소실을 빈방으로 바꾸지 않는다."""
    n = FakeNode()
    eng.ingest_node(n.msg(0, persons=[]), at(0))
    s = eng.snapshot(at(0))
    assert room(s, "room1").occupancy.state == "OCCUPIED"
    assert s.people == []


def test_held_person_when_tracking_lost(eng):
    n = FakeNode()
    eng.ingest_node(n.msg(0, persons=[person()]), at(0))
    eng.ingest_node(n.msg(1, persons=[], light="DARK"), at(1))   # 어두워져 추적 끊김, 레이더는 재실
    s = eng.snapshot(at(1.5))
    a = who(s, "person_a")
    assert a is not None and a.room_id == "room1"                # 같은 방에 있는 것으로 유지
    assert a.posture == "UNKNOWN" and a.posture_confidence is None  # LYING을 유지하지 않음
    assert a.position is None and a.track_refs == []
    assert a.evidence.source == "world_inference" and a.evidence.freshness == "stale"
    assert a.evidence.observed_at == at(0)                       # 마지막으로 실제 본 시각
    assert a.activity.confirmed is False and a.activity.confidence is None
    assert a.identity_source == "FACE"                           # 예전 얼굴 관측을 새 관측처럼 쓰지 않음(stale)

    # 방이 비면 위치 미상으로 (다른 방에 넣지 않음)
    eng.ingest_node(n.msg(2, occupancy="EMPTY", conf=0.5), at(2))
    a = who(eng.snapshot(at(2)), "person_a")
    assert a.room_id is None and a.evidence.freshness == "stale"
    # 다시 OCCUPIED가 돼도 이미 끊긴 뒤라 자동으로 다시 넣지 않음
    eng.ingest_node(n.msg(3), at(3))
    assert who(eng.snapshot(at(3)), "person_a").room_id is None
    # forget TTL 지나면 사라짐
    for t in range(4, 1810, 2):
        eng.ingest_node(n.msg(t, occupancy="EMPTY", conf=0.5), at(t))
    assert who(eng.snapshot(at(1810)), "person_a") is None


def test_anonymous_track_dropped_when_lost(eng):
    n = FakeNode()
    eng.ingest_node(n.msg(0, persons=[person(identity="UNKNOWN", source="UNKNOWN", posture="UNKNOWN",
                                             activity="UNKNOWN", position=None)]), at(0))
    s = eng.snapshot(at(0))
    [p] = s.people
    assert p.person_id.startswith("anon_") and p.profile_id is None
    assert p.identity_confidence is None and p.posture_confidence is None  # 0을 그대로 싣지 않음
    assert p.activity.label == "unknown" and p.activity.confidence is None and p.position is None
    eng.ingest_node(n.msg(1, persons=[]), at(1))
    assert eng.snapshot(at(1)).people == []


def test_same_track_id_on_two_nodes_are_different_people(eng):
    r1, lv = FakeNode(), FakeNode("node_living", "living")
    u = dict(identity="UNKNOWN", source="UNKNOWN")
    eng.ingest_node(r1.msg(0, persons=[person(1, **u)]), at(0))
    eng.ingest_node(lv.msg(0, persons=[person(1, **u)]), at(0))
    s = eng.snapshot(at(0))
    assert len(s.people) == 2 and len({p.person_id for p in s.people}) == 2
    assert check(s) == []


def test_guest_has_no_profile(eng):
    eng.ingest_node(FakeNode().msg(0, persons=[person(identity="GUEST")]), at(0))
    [p] = eng.snapshot(at(0)).people
    assert p.identity == "GUEST" and p.profile_id is None and p.person_id.startswith("anon_")


def test_member_without_profile_has_null_profile(eng):
    eng.set_profiles(PROFILES[:1])
    eng.ingest_node(FakeNode().msg(0, persons=[person(identity="MEMBER_B")]), at(0))
    p = who(eng.snapshot(at(0)), "person_b")
    assert p.profile_id is None


def test_anon_becomes_member_when_recognised(eng):
    n = FakeNode()
    eng.ingest_node(n.msg(0, persons=[person(identity="UNKNOWN", source="UNKNOWN")]), at(0))
    eng.ingest_node(n.msg(1, persons=[person()]), at(1))
    s = eng.snapshot(at(1))
    assert [p.person_id for p in s.people] == ["person_a"]


def test_person_moves_between_rooms(eng):
    r1, lv = FakeNode(), FakeNode("node_living", "living")
    eng.ingest_node(r1.msg(0, persons=[person()]), at(0))
    eng.ingest_node(lv.msg(1, persons=[person(1, posture="WALKING", activity="OTHER")]), at(1))
    eng.ingest_node(r1.msg(1.5, persons=[]), at(1.5))
    a = who(eng.snapshot(at(1.5)), "person_a")
    assert a.room_id == "living" and a.evidence.freshness == "current"
    assert [t.node_id for t in a.track_refs] == ["node_living"]


# ---------- 신선도 ----------

def test_node_expiry_without_new_messages(eng):
    """새 메시지가 없어도 WM이 만료를 감지한다."""
    n = FakeNode()
    eng.ingest_node(n.msg(0, occupancy="EMPTY", conf=0.5), at(0))
    s = eng.snapshot(at(3))
    assert room(s, "room1").occupancy.state == "EMPTY"           # TTL 3초 안
    s = eng.snapshot(at(3.5))
    r1 = room(s, "room1")
    assert node(s, "node_room1").availability == "stale"
    assert r1.occupancy.state == "UNKNOWN" and r1.occupancy.evidence.freshness == "stale"
    assert r1.occupancy.evidence.observed_at == at(0)            # 과거 근거는 보존


def test_person_on_stale_node_loses_room(eng):
    n = FakeNode()
    eng.ingest_node(n.msg(0, persons=[person()]), at(0))
    a = who(eng.snapshot(at(5)), "person_a")
    assert a.room_id is None and a.posture == "UNKNOWN" and a.evidence.freshness == "stale"


def test_offline_node(eng):
    eng.ingest_node(FakeNode().msg(0), at(0))
    eng.mark_node_offline("node_room1")
    s = eng.snapshot(at(0.5))
    assert node(s, "node_room1").availability == "offline"
    assert room(s, "room1").occupancy.state == "UNKNOWN"


def test_measurement_freshness(eng):
    eng.ingest_measurement("room1", "temperature_c", 26.5, observed_at=at(0), received_at=at(0))
    assert room(eng.snapshot(at(10)), "room1").temperature_c.evidence.freshness == "current"
    m = room(eng.snapshot(at(200)), "room1").temperature_c
    assert m.value == 26.5 and m.evidence.freshness == "stale"   # stale 값을 current로 올리지 않음
    assert room(eng.snapshot(at(200)), "room1").humidity_pct.value is None


# ---------- 메시지 순서 ----------

def test_duplicate_and_out_of_order(eng):
    n = FakeNode()
    m5 = n.msg(5, seq=5)
    assert eng.ingest_node(m5, at(5)) == "accepted"
    assert eng.ingest_node(m5, at(5.1)) == "duplicate"
    old = n.msg(4, seq=4, occupancy="EMPTY")
    assert eng.ingest_node(old, at(5.2)) == "out_of_order"
    s = eng.snapshot(at(5.3))
    assert room(s, "room1").occupancy.state == "OCCUPIED" and node(s, "node_room1").last_seq == 5


def test_node_restart_resets_tracks_and_stability(eng):
    n = FakeNode()
    for t in range(0, 10):
        eng.ingest_node(n.msg(t, persons=[person()]), at(t))
    assert room(eng.snapshot(at(9)), "room1").occupancy.stable_for_s == 9
    assert eng.ingest_node(n.msg(10, seq=0, persons=[]), at(10)) == "restart"
    s = eng.snapshot(at(10))
    assert room(s, "room1").occupancy.stable_for_s == 0
    a = who(s, "person_a")
    assert a.room_id == "room1" and a.track_refs == []           # 이전 track 연결은 끊고 HELD
    eng.ingest_node(n.msg(11, persons=[person(1, identity="UNKNOWN", source="UNKNOWN")]), at(11))
    ids = {p.person_id for p in eng.snapshot(at(11)).people}
    assert "person_a" in ids and any(i.startswith("anon_node_room1_e1_") for i in ids)  # 같은 track 1이라도 이전 사람에 붙이지 않음


def test_bad_inputs(eng):
    n = FakeNode()
    assert eng.ingest_node({"schema_version": "0.1"}, at(0)) == "invalid"
    assert eng.ingest_node(FakeNode("node_x", "room1").msg(0), at(0)) == "unknown_node"
    assert eng.ingest_node(FakeNode("node_room1", "living").msg(0), at(0)) == "room_mismatch"
    assert eng.snapshot(at(0)).nodes[0].availability == "unknown"
    assert n  # unused


# ---------- 발행 주기·revision ----------

def test_publish_policy(eng):
    n = FakeNode()
    eng.ingest_node(n.msg(0, persons=[person()]), at(0))
    s1 = eng.poll(at(0))
    assert s1.world_revision == 1
    assert eng.poll(at(0.3)) is None                             # 바뀐 것 없음
    eng.ingest_node(n.msg(0.5, persons=[person(position=(2.5, 2.6))]), at(0.5))
    assert eng.poll(at(0.6)) is None                             # 좌표만 바뀜 → 1초 안엔 안 보냄
    s2 = eng.poll(at(1.0))
    assert s2.world_revision == 2 and who(s2, "person_a").position.x == 2.5
    eng.ingest_node(n.msg(1.2, occupancy="EMPTY", conf=0.5), at(1.2))
    s3 = eng.poll(at(1.2))                                       # 의미 변화 → 즉시
    assert s3.world_revision == 3


def test_keepalive_and_expiry_published(eng):
    eng.ingest_node(FakeNode().msg(0, occupancy="EMPTY", conf=0.5), at(0))
    assert eng.poll(at(0)).world_revision == 1
    assert eng.poll(at(0.5)) is None
    assert eng.poll(at(2)) is not None                           # 관측 중엔 stable_for_s가 늘어 1초 주기로 나감
    s = eng.poll(at(3.5))                                        # 만료 자체가 의미 변화
    assert s is not None and room(s, "room1").occupancy.state == "UNKNOWN"
    assert eng.poll(at(20)) is None
    assert eng.poll(at(34)) is not None                          # keepalive


def test_reset_makes_new_session(eng):
    eng.ingest_node(FakeNode().msg(0, persons=[person()]), at(0))
    old = eng.snapshot(at(0))
    sid = eng.reset()
    s = eng.snapshot(at(1))
    assert s.world_session_id == sid != old.world_session_id
    assert s.world_revision == 1 and s.people == []
    assert [p.profile_id for p in s.profiles] == ["profile_a", "profile_b"]  # 앱 설정은 유지


# ---------- 기기·앱 데이터 ----------

AC = dict(device_id="ac_room1", kind="ac", room_id="room1", online=True, manual_override=False,
          state={"power": "on", "mode": "cool", "target_c": 24, "airflow_target_person_id": "person_a"},
          capabilities={"actions": ["set_power", "set_mode", "set_target_temperature", "set_airflow_target"],
                        "modes": ["cool"], "temperature": {"min_c": 18, "max_c": 30, "step_c": 1},
                        "airflow_target": "person"})


def test_device_state_revision_and_freshness(eng):
    assert eng.upsert_device(**AC, observed_at=at(0), received_at=at(0)) == 1
    assert eng.upsert_device(**AC, observed_at=at(1), received_at=at(1)) == 1   # 같은 상태 → 그대로
    st = {**AC["state"], "target_c": 25}
    assert eng.upsert_device(**{**AC, "state": st}, observed_at=at(2), received_at=at(2)) == 2
    s = eng.snapshot(at(13))
    [d] = s.devices
    assert d.evidence.freshness == "stale" and d.evidence.source == "device_sensor" and d.online is True


def test_device_with_unsupported_mode_rejected(eng):
    with pytest.raises(Exception):
        eng.upsert_device(**{**AC, "state": {**AC["state"], "mode": "turbo"}}, observed_at=at(0), received_at=at(0))


def test_airflow_target_not_in_people_becomes_null(eng):
    eng.upsert_device(**AC, observed_at=at(0), received_at=at(0))
    s = eng.snapshot(at(0))
    assert s.devices[0].state["airflow_target_person_id"] is None and check(s) == []
    eng.ingest_node(FakeNode().msg(0, persons=[person()]), at(0))
    assert eng.snapshot(at(0)).devices[0].state["airflow_target_person_id"] == "person_a"


def test_device_result_event_dedup(eng):
    eng.upsert_device(**AC, observed_at=at(0), received_at=at(0))
    ev = {"event_id": "e1", "command_id": "c1", "device_id": "ac_room1", "status": "completed",
          "timestamp": at(1).isoformat(), "state": {**AC["state"], "target_c": 26}, "reason": None}
    assert eng.ingest_device_result(ev, at(1)) == "accepted"
    assert eng.ingest_device_result(ev, at(1.1)) == "duplicate"
    assert eng.ingest_device_result({**ev, "event_id": "e2", "device_id": "tv"}, at(1)) == "unknown_device"
    [d] = eng.snapshot(at(1)).devices
    assert d.state["target_c"] == 26 and d.state_revision == 2


def test_routine_occurrence_is_passed_through(eng):
    r = {"routine_id": "daily_clean", "occurrence_id": "daily_clean_20261113_evening", "device_id": "vacuum_01",
         "room_ids": ["room1"], "due": True, "requested_at": at(0).isoformat(), "deadline_at": at(7200).isoformat()}
    eng.upsert_device(device_id="vacuum_01", kind="vacuum", room_id="kitchen", online=True, manual_override=False,
                      state={"status": "docked", "mode": "normal", "target_room_ids": [], "dock_room_id": "kitchen"},
                      capabilities={"actions": ["start_cleaning", "pause_cleaning", "resume_cleaning",
                                                "return_to_dock", "set_mode"], "modes": ["quiet", "normal"],
                                    "temperature": None, "airflow_target": None},
                      observed_at=at(0), received_at=at(0))
    eng.set_routines([r])
    a, b = eng.snapshot(at(0)), eng.snapshot(at(60))
    assert a.routines[0].occurrence_id == b.routines[0].occurrence_id == r["occurrence_id"]


def test_expired_restriction_dropped(eng):
    eng.set_restrictions([{"restriction_id": "r1", "target_type": "room", "target_id": "room1",
                           "action": "start_cleaning", "expires_at": at(60).isoformat(), "reason": "시험 공부"}])
    assert len(eng.snapshot(at(0)).user_restrictions) == 1
    assert eng.snapshot(at(61)).user_restrictions == []


def test_no_decisions_in_snapshot(eng):
    """WM은 우선순위·판단 필드를 내지 않는다 (extra=forbid라 실을 곳도 없음)."""
    eng.ingest_node(FakeNode().msg(0, persons=[person()]), at(0))
    d = eng.snapshot(at(0)).model_dump()
    flat = str(d)
    for word in ("priority", "decision", "allowed", "blocked", "should"):
        assert word not in flat
