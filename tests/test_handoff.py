"""B1 방을 옮긴 사람 이어 붙이기 (config handoff_s). 기본은 꺼져 있다.

방1에서 얼굴로 인식된 A가 나가고, 붙어 있는 거실에 얼굴 없는 사람이 1명 새로 잡히면 같은 person_id로 잇는다.
"""

from __future__ import annotations

from worldmodel.config import load_config
from worldmodel.engine import WorldEngine

from .helpers import CONFIG, FakeNode, at, person

ANON = dict(identity="UNKNOWN", source="UNKNOWN", posture="STANDING", activity="OTHER")


def make(handoff_s=10.0):
    cfg = load_config(CONFIG).model_copy(update={"handoff_s": handoff_s})
    return WorldEngine(cfg), FakeNode("node_room1", "room1"), FakeNode("node_living", "living")


def people(eng, t):
    return {p.person_id: p for p in eng.snapshot(at(t)).people}


def a_leaves_room1(eng, r1, until=5):
    """0~until초 A가 방1에 있다가 until초에 나감 (방1 EMPTY)"""
    for t in range(until):
        eng.ingest_node(r1.msg(t, persons=[person(1)]), at(t))
    eng.ingest_node(r1.msg(until, occupancy="EMPTY"), at(until))


def test_off_by_default_anonymous_stays_separate():
    eng, r1, lv = make(handoff_s=None)
    a_leaves_room1(eng, r1)
    eng.ingest_node(lv.msg(7, persons=[person(4, **ANON)]), at(7))
    ps = people(eng, 7.5)
    assert ps["person_a"].room_id is None                    # 위치 모름으로 기억만
    assert any(pid.startswith("anon_node_living") for pid in ps)


def test_member_who_left_is_carried_into_next_room():
    eng, r1, lv = make()
    a_leaves_room1(eng, r1)
    eng.ingest_node(lv.msg(7, persons=[person(4, **ANON)]), at(7))
    ps = people(eng, 7.5)
    assert set(ps) == {"person_a"}
    a = ps["person_a"]
    assert a.room_id == "living" and a.identity == "MEMBER_D" and a.identity_source == "TRACK_CARRIED"
    assert a.track_refs[0].node_id == "node_living" and a.posture == "STANDING"
    # 거실에서도 track이 끝나면 다시 구성원 기억으로 (익명처럼 사라지지 않음)
    eng.ingest_node(lv.msg(9, occupancy="EMPTY"), at(9))
    a = people(eng, 9.5)["person_a"]
    assert a.room_id is None and a.identity == "MEMBER_D"


def test_waits_for_left_room_to_turn_empty():
    """나간 방의 재실이 늦게 EMPTY가 되어도, 새 track이 생긴 지 handoff_s 안이면 그때 잇는다"""
    eng, r1, lv = make()
    for t in range(5):
        eng.ingest_node(r1.msg(t, persons=[person(1)]), at(t))
    eng.ingest_node(r1.msg(5, occupancy="OCCUPIED"), at(5))          # track은 끊겼지만 아직 OCCUPIED (HELD)
    eng.ingest_node(lv.msg(6, persons=[person(4, **ANON)]), at(6))
    ps = people(eng, 6.5)
    assert ps["person_a"].room_id == "room1" and len(ps) == 2       # 아직은 따로
    eng.ingest_node(r1.msg(8, occupancy="EMPTY"), at(8))
    eng.ingest_node(lv.msg(9, persons=[person(4, **ANON)]), at(9))
    ps = people(eng, 9.5)
    assert set(ps) == {"person_a"} and ps["person_a"].room_id == "living"


def test_ambiguous_or_late_is_not_carried():
    # 새 사람이 둘
    eng, r1, lv = make()
    a_leaves_room1(eng, r1)
    eng.ingest_node(lv.msg(7, persons=[person(4, **ANON), person(5, **ANON)]), at(7))
    assert people(eng, 7.5)["person_a"].room_id is None
    # 너무 늦게 나타남
    eng, r1, lv = make(handoff_s=3.0)
    a_leaves_room1(eng, r1)
    eng.ingest_node(lv.msg(9, persons=[person(4, **ANON)]), at(9))
    assert people(eng, 9.5)["person_a"].room_id is None
    # 붙어 있지 않은 방 (방1 → 방2는 room_links에 없음)
    eng, r1, _ = make()
    r2 = FakeNode("node_room2", "room2")
    a_leaves_room1(eng, r1)
    eng.ingest_node(r2.msg(7, persons=[person(4, **ANON)]), at(7))
    assert people(eng, 7.5)["person_a"].room_id is None


def test_two_members_left_is_ambiguous():
    eng, r1, lv = make()
    for t in range(5):
        eng.ingest_node(r1.msg(t, persons=[person(1), person(2, identity="MEMBER_B")]), at(t))
    eng.ingest_node(r1.msg(5, occupancy="EMPTY"), at(5))
    eng.ingest_node(lv.msg(7, persons=[person(4, **ANON)]), at(7))
    ps = people(eng, 7.5)
    assert ps["person_a"].room_id is None and ps["person_b"].room_id is None


def test_face_says_other_member_restores_original():
    """이어 붙인 사람이 얼굴로 B로 확인되면, A는 원래대로 위치 모름으로 돌아간다"""
    eng, r1, lv = make()
    a_leaves_room1(eng, r1)
    eng.ingest_node(lv.msg(7, persons=[person(4, **ANON)]), at(7))
    eng.ingest_node(lv.msg(8, persons=[person(4, identity="MEMBER_B")]), at(8))
    ps = people(eng, 8.5)
    assert ps["person_b"].room_id == "living" and ps["person_b"].identity_source == "FACE"
    assert ps["person_a"].room_id is None and ps["person_a"].identity == "MEMBER_D"


def test_face_seen_elsewhere_takes_the_id_back():
    """이어 붙인 뒤 A가 방1에서 얼굴로 다시 잡히면, 거실 track은 익명이 된다 (두 Node가 같은 ID를 번갈아 쓰지 않게)"""
    eng, r1, lv = make()
    a_leaves_room1(eng, r1)
    eng.ingest_node(lv.msg(7, persons=[person(4, **ANON)]), at(7))
    eng.ingest_node(r1.msg(8, persons=[person(2)]), at(8))
    for t in (9, 10):
        eng.ingest_node(lv.msg(t, persons=[person(4, **ANON)]), at(t))
        eng.ingest_node(r1.msg(t, persons=[person(2)]), at(t))
    ps = people(eng, 10.5)
    assert ps["person_a"].room_id == "room1" and ps["person_a"].identity_source == "FACE"
    assert any(pid.startswith("anon_node_living") for pid in ps)
