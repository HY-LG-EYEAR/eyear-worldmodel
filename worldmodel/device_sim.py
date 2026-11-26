"""가전 시뮬레이터: 실제 가전 대신 MQTT로 상태를 보내고 중앙의 명령을 받아 결과를 돌려준다.

    중앙 ──eyear/v0/device/{id}/command──▶ 이 시뮬레이터 ──/state·/result──▶ World Model ──HTTP──▶ 중앙

중앙은 World Model 스냅샷에 들어 있는 기기에만 명령하므로, 가전 상태를 보내는 쪽이 없으면
조명 끄기·청소 같은 명령이 아예 나오지 않는다. 실제 가전 어댑터가 생기기 전까지 이것이 그 역할을 한다.
중앙은 DEVICE_TRANSPORT=mqtt로 띄운다 (mock이면 명령이 여기로 오지 않는다).

기기 목록·능력은 중앙 fixtures와 같다. 청소기는 방마다 --room-s초 동안 청소하고 도크로 돌아오면 completed를 보낸다.

    python -m worldmodel.device_sim --mqtt localhost
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

log = logging.getLogger("worldmodel.device_sim")

Out = list[tuple[str, str]]   # (토픽, JSON) 보낼 것들


def _caps(actions, modes=(), temperature=None, airflow=None) -> dict:
    return {"actions": list(actions), "modes": list(modes), "temperature": temperature, "airflow_target": airflow}


AC_CAPS = _caps(["set_power", "set_mode", "set_target_temperature", "set_airflow_target"], ["cool"],
                {"min_c": 18, "max_c": 30, "step_c": 1}, "person")

# device_id: (room_id, kind, 처음 상태, 능력)
DEMO_DEVICES: dict[str, tuple[str, str, dict, dict]] = {
    "vacuum_01": ("kitchen", "vacuum",
                  {"status": "docked", "mode": "normal", "target_room_ids": [], "dock_room_id": "kitchen"},
                  _caps(["start_cleaning", "pause_cleaning", "resume_cleaning", "return_to_dock", "set_mode"],
                        ["normal"])),
    "washer_01": ("laundry", "washer", {"status": "running", "mode": "normal"},
                  _caps(["set_mode"], ["normal", "low_noise"])),
    "ac_room1": ("room1", "ac", {"power": "off", "mode": "cool", "target_c": 24, "airflow_target_person_id": None},
                 AC_CAPS),
    "ac_living": ("living", "ac", {"power": "off", "mode": "cool", "target_c": 27, "airflow_target_person_id": None},
                  AC_CAPS),
    "light_room1": ("room1", "light", {"power": "on"}, _caps(["set_power"])),
    "curtain_room1": ("room1", "curtain", {"position_pct": 100, "status": "stationary"},
                      _caps(["set_curtain_position"])),
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(t: datetime) -> str:
    return t.isoformat().replace("+00:00", "Z")


class DeviceSim:
    """MQTT 없이도 쓸 수 있게 입력(명령·시각) → 보낼 메시지 목록으로만 동작한다. live에서는 잠금으로 감싼다."""

    def __init__(self, devices: dict | None = None, *, room_s: float = 20.0, return_s: float = 5.0):
        self.devices = {k: {"room_id": r, "kind": kind, "state": copy.deepcopy(st), "capabilities": copy.deepcopy(c)}
                        for k, (r, kind, st, c) in (devices or DEMO_DEVICES).items()}
        self.room_s, self.return_s = room_s, return_s
        self.cleaning_cmd: str | None = None     # 접수했고 아직 끝나지 않은 청소 명령
        self.next_step_at: datetime | None = None
        self.log: list[tuple[str, str, str]] = []   # (device_id, action, status)

    # ── 보낼 메시지 ──
    def state_msg(self, device_id: str, t: datetime) -> tuple[str, str]:
        d = self.devices[device_id]
        body = {"device_id": device_id, "kind": d["kind"], "room_id": d["room_id"], "online": True,
                "manual_override": False, "state": d["state"], "capabilities": d["capabilities"],
                "timestamp": _iso(t)}
        return f"eyear/v0/device/{device_id}/state", json.dumps(body, ensure_ascii=False)

    def all_states(self, t: datetime) -> Out:
        return [self.state_msg(k, t) for k in self.devices]

    def _result(self, device_id: str, command_id: str, status: str, t: datetime, reason: str | None = None) -> Out:
        d = self.devices.get(device_id)
        body = {"event_id": str(uuid.uuid4()), "command_id": command_id, "device_id": device_id, "status": status,
                "timestamp": _iso(t), "state": copy.deepcopy(d["state"]) if d else None, "reason": reason}
        self.log.append((device_id, command_id, status))
        out = [(f"eyear/v0/device/{device_id}/result", json.dumps(body, ensure_ascii=False))]
        if d is not None and status != "rejected":
            out.append(self.state_msg(device_id, t))      # 상태도 바로 갱신 (결과보다 늦게 와도 됨)
        return out

    # ── 명령 ──
    def handle_command(self, device_id: str, payload: bytes | str | dict, t: datetime | None = None) -> Out:
        t = t or now_utc()
        try:
            cmd = json.loads(payload) if isinstance(payload, (bytes, bytearray, str)) else payload
            command_id, action, p = cmd["command_id"], cmd["action"], cmd.get("params") or {}
        except (ValueError, KeyError, TypeError) as e:
            log.warning("명령 형식 오류 %s: %s", device_id, e)
            return []
        if cmd.get("device_id", device_id) != device_id:
            return self._result(device_id, command_id, "rejected", t, "DEVICE_ID_MISMATCH")
        d = self.devices.get(device_id)
        if d is None:
            return self._result(device_id, command_id, "rejected", t, "UNKNOWN_DEVICE")
        if action not in d["capabilities"]["actions"]:
            return self._result(device_id, command_id, "rejected", t, "ACTION_NOT_SUPPORTED")
        reason = self._apply(d, command_id, action, p, t)
        if reason:
            return self._result(device_id, command_id, "rejected", t, reason)
        log.info("명령 %s %s %s → %s", device_id, action, p, d["state"])
        status = "accepted" if action == "start_cleaning" else "completed"   # 청소 완료는 도크 도착 때
        return self._result(device_id, command_id, status, t)

    def _apply(self, d: dict, command_id: str, action: str, p: dict, t: datetime) -> str | None:
        st, caps = d["state"], d["capabilities"]
        if action == "start_cleaning":
            rooms = p.get("room_ids")
            if not isinstance(rooms, list) or not rooms:
                return "BAD_ROOMS"
            if "mode" in p and p["mode"] not in caps["modes"]:
                return "MODE_NOT_SUPPORTED"
            st.update(status="cleaning", target_room_ids=list(rooms), mode=p.get("mode", st["mode"]))
            self.cleaning_cmd, self.next_step_at = command_id, t + timedelta(seconds=self.room_s)
        elif action == "pause_cleaning":
            st["status"] = "paused"
            self.next_step_at = None
        elif action == "resume_cleaning":
            if st["status"] != "paused":
                return "NOT_PAUSED"
            st["status"] = "cleaning" if st["target_room_ids"] else "returning"
            self.next_step_at = t + timedelta(seconds=self.room_s if st["target_room_ids"] else self.return_s)
        elif action == "return_to_dock":
            st.update(status="returning", target_room_ids=[])
            self.next_step_at = t + timedelta(seconds=self.return_s)
        elif action == "set_mode":
            if p.get("mode") not in caps["modes"]:
                return "MODE_NOT_SUPPORTED"
            st["mode"] = p["mode"]
        elif action == "set_power":
            if p.get("power") not in ("on", "off"):
                return "BAD_POWER"
            st["power"] = p["power"]
        elif action == "set_target_temperature":
            rng, v = caps["temperature"], p.get("target_c")
            if rng is None or not isinstance(v, (int, float)) or not rng["min_c"] <= v <= rng["max_c"]:
                return "TEMPERATURE_OUT_OF_RANGE"
            st["target_c"] = v
        elif action == "set_airflow_target":
            st["airflow_target_person_id"] = p.get("person_id")
        elif action == "set_curtain_position":
            v = p.get("position_pct")
            if not isinstance(v, (int, float)) or not 0 <= v <= 100:
                return "BAD_POSITION"
            st["position_pct"] = v
        return None

    # ── 시간이 지나며 바뀌는 것 (청소기) ──
    def tick(self, t: datetime | None = None) -> Out:
        t = t or now_utc()
        out: Out = []
        for device_id, d in self.devices.items():
            if d["kind"] != "vacuum" or self.next_step_at is None or t < self.next_step_at:
                continue
            st = d["state"]
            if st["status"] == "cleaning":
                done = st["target_room_ids"].pop(0) if st["target_room_ids"] else None
                log.info("청소기: %s 청소 끝, 남은 방 %s", done, st["target_room_ids"])
                if not st["target_room_ids"]:
                    st["status"] = "returning"
                self.next_step_at = t + timedelta(seconds=self.room_s if st["target_room_ids"] else self.return_s)
                out.append(self.state_msg(device_id, t))
            elif st["status"] == "returning":
                st["status"] = "docked"
                self.next_step_at = None
                log.info("청소기: 도크 도착")
                if self.cleaning_cmd is not None:
                    cmd, self.cleaning_cmd = self.cleaning_cmd, None
                    out += self._result(device_id, cmd, "completed", t)
                else:
                    out.append(self.state_msg(device_id, t))
        return out


# ── 실행 ─────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> None:
    import paho.mqtt.client as mqtt

    from worldmodel.live import parse_broker

    ap = argparse.ArgumentParser(description="EYEAR 가전 시뮬레이터 (MQTT)")
    ap.add_argument("--mqtt", default="localhost", help="브로커 host[:port]")
    ap.add_argument("--every", type=float, default=3.0, help="상태를 다시 보내는 주기(초). World Model 기기 TTL 10초보다 짧게")
    ap.add_argument("--room-s", type=float, default=20.0, help="청소기가 방 하나를 청소하는 시간(초)")
    ap.add_argument("--return-s", type=float, default=5.0, help="청소기가 도크로 돌아가는 시간(초)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    sim = DeviceSim(room_s=a.room_s, return_s=a.return_s)
    lock = threading.Lock()
    host, port = parse_broker(a.mqtt)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"eyear-devsim-{uuid.uuid4().hex[:8]}")

    def publish(msgs: Out) -> None:
        for topic, body in msgs:
            client.publish(topic, body, qos=1)

    def on_connect(c, _u, _f, rc, _p):
        if rc.is_failure:
            log.error("브로커 접속 실패: %s", rc)
            return
        c.subscribe("eyear/v0/device/+/command", qos=1)
        log.info("브로커 접속 %s:%s, 기기 %d대: %s", host, port, len(sim.devices), ", ".join(sim.devices))
        with lock:
            publish(sim.all_states(now_utc()))

    def on_message(_c, _u, msg):
        parts = msg.topic.split("/")
        if len(parts) != 5:
            return
        try:
            with lock:
                publish(sim.handle_command(parts[3], msg.payload))
        except Exception:
            log.exception("명령 처리 오류: %s", msg.topic)

    client.on_connect, client.on_message = on_connect, on_message
    client.reconnect_delay_set(1, 10)
    client.connect_async(host, port, keepalive=30)
    client.loop_start()
    stop = threading.Event()
    last_full = now_utc()
    try:
        while not stop.wait(0.5):
            t = now_utc()
            with lock:
                msgs = sim.tick(t)
                if (t - last_full).total_seconds() >= a.every:
                    msgs += sim.all_states(t)
                    last_full = t
            publish(msgs)   # 끊겨 있으면 paho가 QoS 1 메시지를 쌓아 두었다가 다시 붙을 때 보낸다
    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
