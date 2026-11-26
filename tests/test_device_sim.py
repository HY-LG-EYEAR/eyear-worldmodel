"""가전 시뮬레이터: 보낸 상태·결과가 live(LiveBridge)를 거쳐 엔진·중앙까지 그대로 들어가는지.
MQTT 없이 시뮬레이터가 만든 (토픽, JSON)을 bridge.handle()에 바로 넣는다."""

from __future__ import annotations

import json
from datetime import timedelta

from worldmodel.config import load_config
from worldmodel.device_sim import DeviceSim
from worldmodel.engine import WorldEngine
from worldmodel.hub import NodeHub
from worldmodel.live import LiveBridge, load_app_data

from .helpers import CONFIG, ROOT, at


def make():
    engine = WorldEngine(load_config(CONFIG))
    load_app_data(engine, ROOT / "config" / "app_demo.json")
    bridge = LiveBridge(NodeHub(engine), None)
    return engine, bridge


def feed(bridge, msgs, t):
    return [bridge.handle(topic, body, t) for topic, body in msgs]


def cmd(device_id, action, params=None, command_id="c1"):
    return json.dumps({"schema_version": "2.0", "command_id": command_id, "plan_id": "p1",
                       "issued_at": "2026-11-26T10:00:00Z", "world_session_id": "s", "based_on_revision": 1,
                       "device_id": device_id, "action": action, "params": params or {}, "reason_codes": []})


def test_all_demo_devices_enter_snapshot_and_routine_appears():
    engine, bridge = make()
    sim = DeviceSim()
    assert set(feed(bridge, sim.all_states(at(0)), at(0))) == {"accepted"}
    snap = engine.snapshot(at(1))
    assert {d.device_id for d in snap.devices} == set(sim.devices)
    assert [r.device_id for r in snap.routines] == ["vacuum_01"]      # 청소기가 보고해야 루틴이 들어감


def test_light_off_command_updates_world_model():
    engine, bridge = make()
    sim = DeviceSim()
    feed(bridge, sim.all_states(at(0)), at(0))
    out = sim.handle_command("light_room1", cmd("light_room1", "set_power", {"power": "off"}), at(1))
    result = json.loads(out[0][1])
    assert out[0][0] == "eyear/v0/device/light_room1/result"
    assert result["status"] == "completed" and result["command_id"] == "c1" and result["state"] == {"power": "off"}
    assert feed(bridge, out, at(1)) == ["accepted", "accepted"]
    light = next(d for d in engine.snapshot(at(2)).devices if d.device_id == "light_room1")
    assert light.state == {"power": "off"} and light.state_revision == 2


def test_vacuum_cleans_each_room_then_reports_completed_at_dock():
    sim = DeviceSim(room_s=20, return_s=5)
    t0 = at(0)
    out = sim.handle_command("vacuum_01", cmd("vacuum_01", "start_cleaning", {"room_ids": ["room2", "room1"]}, "cv"), t0)
    assert json.loads(out[0][1])["status"] == "accepted"
    vac = sim.devices["vacuum_01"]["state"]
    assert vac["status"] == "cleaning" and vac["target_room_ids"] == ["room2", "room1"]
    assert sim.tick(t0 + timedelta(seconds=19)) == []
    sim.tick(t0 + timedelta(seconds=20))
    assert vac["target_room_ids"] == ["room1"]
    sim.tick(t0 + timedelta(seconds=40))
    assert vac["status"] == "returning" and vac["target_room_ids"] == []
    out = sim.tick(t0 + timedelta(seconds=45))
    done = json.loads(out[0][1])
    assert vac["status"] == "docked" and done["status"] == "completed" and done["command_id"] == "cv"
    assert sim.tick(t0 + timedelta(seconds=60)) == []


def test_return_to_dock_stops_cleaning_and_completes_the_start_command():
    sim = DeviceSim(room_s=20, return_s=5)
    sim.handle_command("vacuum_01", cmd("vacuum_01", "start_cleaning", {"room_ids": ["room1"]}, "cv"), at(0))
    out = sim.handle_command("vacuum_01", cmd("vacuum_01", "return_to_dock", {}, "cr"), at(3))
    assert json.loads(out[0][1])["status"] == "completed"
    assert sim.devices["vacuum_01"]["state"]["status"] == "returning"
    done = json.loads(sim.tick(at(8))[0][1])
    assert done["command_id"] == "cv" and sim.devices["vacuum_01"]["state"]["status"] == "docked"


def test_bad_commands_are_rejected_without_changing_state():
    sim = DeviceSim()
    out = sim.handle_command("light_room1", cmd("light_room1", "set_mode", {"mode": "x"}), at(0))
    assert [json.loads(b)["reason"] for _, b in out] == ["ACTION_NOT_SUPPORTED"]
    out = sim.handle_command("ac_room1", cmd("ac_room1", "set_target_temperature", {"target_c": 40}), at(0))
    assert json.loads(out[0][1])["reason"] == "TEMPERATURE_OUT_OF_RANGE"
    assert sim.devices["ac_room1"]["state"]["target_c"] == 24
    assert json.loads(sim.handle_command("tv", cmd("tv", "set_power", {"power": "on"}), at(0))[0][1])["reason"] \
        == "UNKNOWN_DEVICE"
    assert sim.handle_command("light_room1", b"not json", at(0)) == []
