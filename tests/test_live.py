"""live 실행부: MQTT 토픽 분배(LiveBridge)와 중앙 HTTP 클라이언트(OrchestratorClient).
브로커·중앙 없이: 토픽 처리는 handle()을 직접 부르고, 중앙은 이 파일의 작은 HTTP 서버가 흉내 낸다."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from worldmodel.config import load_config
from worldmodel.engine import WorldEngine
from worldmodel.hub import NodeHub
from worldmodel.live import LiveBridge, OrchestratorClient, load_app_data, parse_broker

from .helpers import CONFIG, ROOT, FakeNode, at, person

LIGHT = {"device_id": "light_room1", "kind": "light", "room_id": "room1", "online": True,
         "manual_override": False, "state": {"power": "on"},
         "capabilities": {"actions": ["set_power"], "modes": [], "temperature": None, "airflow_target": None}}
VACUUM = {"device_id": "vacuum_01", "kind": "vacuum", "room_id": "kitchen", "online": True,
          "manual_override": False,
          "state": {"status": "docked", "mode": "normal", "target_room_ids": [], "dock_room_id": "kitchen"},
          "capabilities": {"actions": ["start_cleaning", "return_to_dock"], "modes": ["normal"],
                           "temperature": None, "airflow_target": None}}


class FakeOrchestrator:
    """중앙 HTTP의 필요한 부분만: 세션 등록, 스냅샷 202/409, 결과 202."""

    def __init__(self):
        self.sessions: set[str] = set()
        self.snapshots: list[dict] = []
        self.results: list[dict] = []
        self.down = False
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _reply(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if outer.down:
                    return self._reply(503, {"detail": "down"})
                if self.path == "/v2/world/sessions":
                    outer.sessions.add(body["world_session_id"])
                    return self._reply(201, {"ok": True})
                if self.path == "/v2/world/snapshots":
                    if body["world_session_id"] not in outer.sessions:
                        return self._reply(409, {"detail": "등록되지 않은 세션. POST /v2/world/sessions 먼저"})
                    outer.snapshots.append(body)
                    return self._reply(202, {"accepted": True})
                if self.path == "/v2/world/device-results":
                    outer.results.append(body)
                    return self._reply(202, {"accepted": True})
                self._reply(404, {})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


@pytest.fixture
def orc():
    o = FakeOrchestrator()
    yield o
    o.close()


def make(client_url=None):
    engine = WorldEngine(load_config(CONFIG))
    client = OrchestratorClient(client_url, engine, timeout=2) if client_url else None
    hub = NodeHub(engine, sink=client.send_snapshot if client else None)
    return engine, hub, LiveBridge(hub, client), client


def test_parse_broker():
    assert parse_broker("192.168.0.5") == ("192.168.0.5", 1883)
    assert parse_broker("broker:1884") == ("broker", 1884)


def test_node_state_goes_through_hub_and_unknown_topics_are_ignored():
    engine, hub, bridge, _ = make()
    n = FakeNode()
    assert bridge.handle("eyear/v0/room1/state", json.dumps(n.msg(0, persons=[person()])), at(0)) == "queued"
    assert bridge.handle("eyear/v0/nowhere/state", b"{}", at(0)) == "unrouted"
    assert bridge.handle("eyear/v0/room1/speak", b"{}", at(0)) == "ignored"
    hub.pump()
    snap = hub.tick(at(0.2))
    assert hub.stats()["lanes"]["room1"]["accepted"] == 1
    assert [p.room_id for p in snap.people] == ["room1"]


def test_offline_status_marks_room_unknown_before_ttl():
    engine, hub, bridge, _ = make()
    bridge.handle("eyear/v0/room1/state", json.dumps(FakeNode().msg(0)), at(0))
    hub.pump()
    status = {"type": "NODE_STATUS", "online": False, "node_id": "node_room1", "room_id": "room1"}
    assert bridge.handle("eyear/v0/room1/status", json.dumps(status)) == "offline"
    room1 = next(r for r in engine.snapshot(at(0.5)).rooms if r.room_id == "room1")
    assert room1.occupancy.state == "UNKNOWN"
    assert bridge.handle("eyear/v0/room1/status", json.dumps({**status, "online": True})) == "online"
    assert bridge.handle("eyear/v0/room1/status", json.dumps({**status, "room_id": "room2"})) == "topic_mismatch"


def test_device_state_enters_snapshot_and_bad_state_is_counted():
    engine, hub, bridge, _ = make()
    msg = {**LIGHT, "timestamp": at(0).isoformat()}
    assert bridge.handle("eyear/v0/device/light_room1/state", json.dumps(msg), at(0)) == "accepted"
    # 시뮬레이터 형식처럼 kind 대신 type으로 와도 받는다
    sim_style = {k: v for k, v in msg.items() if k != "kind"} | {"type": "light"}
    assert bridge.handle("eyear/v0/device/light_room1/state", json.dumps(sim_style), at(1)) == "accepted"
    assert bridge.handle("eyear/v0/device/light_room1/state", json.dumps({"device_id": "light_room1"}), at(1)) == "invalid"
    assert bridge.handle("eyear/v0/device/other/state", json.dumps(msg), at(1)) == "invalid"
    assert [d.device_id for d in engine.snapshot(at(1)).devices] == ["light_room1"]
    assert bridge.stats["device_state"] == 2 and bridge.stats["device_state_invalid"] == 2


def test_routine_waits_until_its_vacuum_reports_state():
    engine, hub, bridge, _ = make()
    load_app_data(engine, ROOT / "config" / "app_demo.json")
    snap = engine.snapshot(at(0))                     # 청소기 없음 → 루틴 빼고 발행 (계약 위반 없음)
    assert snap.routines == [] and {p.identity for p in snap.profiles} == {"MEMBER_D", "MEMBER_B"}
    bridge.handle("eyear/v0/device/vacuum_01/state", json.dumps({**VACUUM, "timestamp": at(0).isoformat()}), at(0))
    assert [r.device_id for r in engine.snapshot(at(1)).routines] == ["vacuum_01"]


def test_snapshots_register_session_and_reregister_after_orchestrator_restart(orc):
    engine, hub, bridge, client = make(orc.url)
    bridge.handle("eyear/v0/room1/state", json.dumps(FakeNode().msg(0)), at(0))
    hub.pump()
    hub.tick(at(0.2))
    assert orc.sessions == {str(engine.session_id)} and len(orc.snapshots) == 1
    orc.sessions.clear()                               # 중앙 재시작: 세션을 잊음
    hub._send(engine.snapshot(at(5)))
    assert len(orc.snapshots) == 2 and client.stats["sessions"] == 2
    assert [s["world_revision"] for s in orc.snapshots] == [1, 2]


def test_failed_snapshot_is_retried_until_a_newer_one_succeeds(orc):
    engine, hub, bridge, client = make(orc.url)
    orc.down = True
    hub.tick(at(0))
    assert hub.sink_errors == 1 and client._failed is not None
    orc.down = False
    client.retry_pending()
    assert [s["world_revision"] for s in orc.snapshots] == [1] and client._failed is None
    client.retry_pending()                             # 더 보낼 것 없음
    assert len(orc.snapshots) == 1


def test_device_result_updates_state_and_is_forwarded_with_session(orc):
    engine, hub, bridge, client = make(orc.url)
    bridge.handle("eyear/v0/device/light_room1/state", json.dumps({**LIGHT, "timestamp": at(0).isoformat()}), at(0))
    hub.tick(at(0.2))
    result = {"event_id": "e1", "command_id": "c1", "device_id": "light_room1", "status": "completed",
              "timestamp": at(1).isoformat(), "state": {"power": "off"}, "reason": None}
    assert bridge.handle("eyear/v0/device/light_room1/result", json.dumps(result), at(1)) == "accepted"
    assert bridge.handle("eyear/v0/device/light_room1/result", json.dumps(result), at(1)) == "duplicate"
    assert bridge.handle("eyear/v0/device/light_room1/result",
                         json.dumps({**result, "event_id": "e2", "status": "done"}), at(1)) == "invalid"
    assert engine.devices["light_room1"].data["state"] == {"power": "off"}
    bridge.start()
    try:
        for _ in range(40):
            if orc.results:
                break
            threading.Event().wait(0.05)
    finally:
        bridge.stop()
    [body] = orc.results
    assert body["world_session_id"] == str(engine.session_id) and body["world_revision"] == 1
    assert body["observed_state"] == {"power": "off"} and "state" not in body
    assert body["command_id"] == "c1" and body["status"] == "completed"
