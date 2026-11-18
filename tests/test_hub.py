"""NodeHub: 여러 방 메시지를 방별 줄로 나눠 엔진 하나에 넣는다."""

from __future__ import annotations

import json
import threading
import time

from worldmodel.config import load_config
from worldmodel.engine import WorldEngine
from worldmodel.hub import NodeHub, room_from_topic

from .helpers import CONFIG, FakeNode, at, person

ROOMS = {"room1": "node_room1", "room2": "node_room2", "living": "node_living", "laundry": "node_laundry"}


def topic(room: str) -> str:
    return f"eyear/v0/{room}/state"


def make(sink=None, **kw):
    sent = []
    hub = NodeHub(WorldEngine(load_config(CONFIG)), sink=sink or sent.append, **kw)
    return hub, sent


def test_topic_parsing():
    assert room_from_topic("eyear/v0/room1/state") == "room1"
    for bad in ["eyear/v0/room1", "eyear/v1/room1/state", "x/v0/room1/state", "eyear/v0//state"]:
        assert room_from_topic(bad) is None


def test_routes_each_room_to_its_own_lane_and_merges_into_one_snapshot():
    hub, sent = make()
    nodes = {r: FakeNode(n, r) for r, n in ROOMS.items()}
    hub.submit(topic("room1"), nodes["room1"].msg(0, persons=[person()]), at(0))
    hub.submit(topic("living"), nodes["living"].msg(0, occupancy="EMPTY", conf=0.9), at(0.1))
    hub.submit(topic("room2"), json.dumps(nodes["room2"].msg(0, occupancy="EMPTY")).encode(), at(0.1))  # bytes도 됨
    assert hub.pump() == 3
    snap = hub.tick(at(0.2))
    assert snap is not None and sent == [snap]
    occ = {r.room_id: r.occupancy.state for r in snap.rooms}
    assert occ["room1"] == "OCCUPIED" and occ["living"] == "EMPTY" and occ["room2"] == "EMPTY"
    assert occ["laundry"] == "UNKNOWN"
    s = hub.stats()["lanes"]
    assert s["room1"]["accepted"] == s["living"]["accepted"] == s["room2"]["accepted"] == 1


def test_same_track_number_in_two_rooms_stays_two_people():
    hub, _ = make()
    hub.submit(topic("room1"), FakeNode("node_room1", "room1").msg(0, persons=[person(track_id=1)]), at(0))
    hub.submit(topic("living"), FakeNode("node_living", "living").msg(
        0, persons=[person(track_id=1, identity="UNKNOWN", source="UNKNOWN", posture="STANDING")]), at(0))
    hub.pump()
    snap = hub.tick(at(0.1))
    assert sorted(p.person_id for p in snap.people) == ["anon_node_living_e0_t1", "person_a"]


def test_broken_node_does_not_affect_others():
    hub, _ = make()
    room1 = FakeNode("node_room1", "room1")
    for i in range(5):
        hub.submit(topic("living"), b"{not json", at(i))
        hub.submit(topic("room1"), room1.msg(i), at(i))
    hub.pump()
    s = hub.stats()["lanes"]
    assert s["living"]["invalid"] == 5
    assert s["room1"]["accepted"] == 5


def test_topic_and_payload_room_must_agree():
    hub, _ = make()
    hub.submit(topic("living"), FakeNode("node_room1", "room1").msg(0), at(0))
    hub.pump()
    assert hub.stats()["lanes"]["living"]["topic_mismatch"] == 1


def test_unknown_room_or_bad_topic_is_counted_not_queued():
    hub, _ = make()
    assert hub.submit(topic("kitchen"), {}, at(0)) is False     # 부엌은 Node 없음
    assert hub.submit("garbage", {}, at(0)) is False
    assert hub.stats()["unrouted"] == 2


def test_received_at_is_stamped_on_arrival_not_on_processing():
    """줄에서 오래 기다려도 받은 시각은 도착 시각. TTL 3초가 지나면 처리 직후라도 stale."""
    hub, _ = make()
    hub.submit(topic("room1"), FakeNode("node_room1", "room1").msg(0), at(0))
    hub.pump()                                   # 나중에 처리해도
    snap = hub.tick(at(5))
    room1 = next(r for r in snap.rooms if r.room_id == "room1")
    assert room1.occupancy.state == "UNKNOWN"
    node = next(n for n in snap.nodes if n.node_id == "node_room1")
    assert node.availability == "stale"


def test_full_lane_drops_oldest():
    hub, _ = make(lane_size=3)
    n = FakeNode("node_room1", "room1")
    msgs = [n.msg(i) for i in range(5)]
    for i, m in enumerate(msgs):
        hub.submit(topic("room1"), m, at(i))
    hub.pump()
    s = hub.stats()["lanes"]["room1"]
    assert s["overflow"] == 2 and s["accepted"] == 3
    assert hub.engine.nodes["node_room1"].last.seq == 5        # 최신 것은 남는다


def test_order_within_one_node_is_kept():
    hub, _ = make()
    n = FakeNode("node_room1", "room1")
    a, b = n.msg(0), n.msg(1)
    hub.submit(topic("room1"), a, at(0))
    hub.submit(topic("room1"), b, at(1))
    hub.pump()
    assert hub.engine.nodes["node_room1"].last.seq == 2
    assert hub.stats()["lanes"]["room1"]["out_of_order"] == 0


def test_sink_failure_does_not_stop_hub():
    def boom(_):
        raise ConnectionError("orchestrator down")
    hub, _ = make(sink=boom)
    hub.submit(topic("room1"), FakeNode("node_room1", "room1").msg(0), at(0))
    hub.pump()
    assert hub.tick(at(0.1)) is not None
    assert hub.sink_errors == 1 and "orchestrator down" in hub.last_sink_error


def test_node_offline_marks_room_unknown_immediately():
    hub, _ = make()
    hub.submit(topic("room1"), FakeNode("node_room1", "room1").msg(0, occupancy="EMPTY"), at(0))
    hub.pump()
    hub.tick(at(0.1))
    hub.node_offline("room1")
    snap = hub.tick(at(0.5))
    assert next(r for r in snap.rooms if r.room_id == "room1").occupancy.state == "UNKNOWN"


def test_threads_many_nodes_at_once():
    """4개 Node가 각자 스레드에서 동시에 50개씩 쏜다. 순서·개수가 맞고 revision은 계속 오른다."""
    sent = []
    lock = threading.Lock()

    def sink(s):
        time.sleep(0.01)          # 느린 수신측
        with lock:
            sent.append(s.world_revision)

    clock_t = [0.0]
    hub = NodeHub(WorldEngine(load_config(CONFIG)), sink=sink, clock=lambda: at(clock_t[0]), tick_s=0.01)
    hub.start()

    def fire(room, node_id):
        n = FakeNode(node_id, room)
        for i in range(50):
            hub.submit(topic(room), n.msg(i * 0.02, occupancy="OCCUPIED" if i % 2 else "EMPTY"))

    workers = [threading.Thread(target=fire, args=rn) for rn in ROOMS.items()]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    clock_t[0] = 1.0
    time.sleep(0.2)
    hub.stop()

    st = hub.stats()
    for room in ROOMS:
        lane = st["lanes"][room]
        assert lane["received"] == 50 and lane["depth"] == 0
        assert lane["accepted"] + lane["overflow"] == 50
        assert lane["out_of_order"] == 0 and lane["invalid"] == 0
        assert hub.engine.nodes[ROOMS[room]].last.seq == 50
    assert sent and sent == sorted(sent) and len(set(sent)) == len(sent)
    assert st["sent"] + st["superseded"] == st["published"]
