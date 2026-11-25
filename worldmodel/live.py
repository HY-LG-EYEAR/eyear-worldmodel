"""live 실행: MQTT 구독 → NodeHub → WorldEngine → HTTP로 중앙(Orchestrator)에 보내기.

    python -m worldmodel.live --mqtt <브로커>[:포트] --orchestrator http://<중앙>:8765
    python -m worldmodel.live --mqtt localhost --no-http        # 중앙 없이 받기만 (화면에 요약)

받는 토픽 (팀 연결도 ①⑥)
- eyear/v0/{room_id}/state           Node 방 상태 0.1·0.2 → NodeHub.submit
- eyear/v0/{room_id}/status          Node 켜짐·꺼짐 (보관 메시지, LWT). online=false면 TTL을 기다리지 않고 UNKNOWN
- eyear/v0/device/{device_id}/state  기기 상태 (주기 보고) → engine.upsert_device
- eyear/v0/device/{device_id}/result 명령 실행 결과 → engine.ingest_device_result → 중앙으로 전달 (⑦)

보내는 곳 (②⑦, 중앙 :8765)
- POST /v2/world/sessions        시작할 때, 그리고 중앙이 "등록되지 않은 세션"(409)이라고 하면 다시
- POST /v2/world/snapshots       NodeHub가 발행한 스냅샷 (의미 변화 즉시, 값 변화 초당 1회, 30초 keepalive)
- POST /v2/world/device-results  결과에 world_session_id·world_revision을 붙이고 state → observed_state

MQTT 아이디·비밀번호는 eyear-node와 같은 환경 변수 EYEAR_MQTT_USER / EYEAR_MQTT_PASSWORD (없으면 익명).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import signal
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from worldmodel.config import load_config
from worldmodel.engine import WorldEngine
from worldmodel.hub import NodeHub

log = logging.getLogger("worldmodel.live")

RESULT_STATUSES = {"accepted", "rejected", "completed", "failed"}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_broker(value: str) -> tuple[str, int]:
    """'HOST[:PORT]' → (host, port). 포트가 없으면 1883. (eyear-node와 같은 규칙)"""
    host, _, port = value.partition(":")
    return host or "localhost", int(port or 1883)


def _ts(value: Any, default: datetime) -> datetime:
    if isinstance(value, str):
        t = datetime.fromisoformat(value)
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    return default


# ── HTTP: 중앙으로 보내기 ───────────────────────────────────────

def _detail(text: str) -> str:
    """응답 본문의 detail (\\uXXXX로 이스케이프돼 와도 비교할 수 있게 JSON을 풀어 본다)."""
    try:
        d = json.loads(text)
        return str(d.get("detail", text)) if isinstance(d, dict) else text
    except ValueError:
        return text


class OrchestratorClient:
    """중앙 HTTP 클라이언트. 표준 라이브러리만 쓴다.

    - 세션 등록은 시작할 때 시도하고, 실패했거나 중앙이 재시작돼 409(등록 안 된 세션)를 주면 다시 등록한다.
    - 보내기에 실패한 스냅샷은 하나만 들고 있다가 retry_pending()이 다시 보낸다.
      그 사이 더 새 스냅샷이 성공하면 버린다 (중앙은 지난 revision을 409로 거절하므로).
    """

    def __init__(self, base_url: str, engine: WorldEngine, timeout: float = 5.0):
        self.base = base_url.rstrip("/")
        self.engine = engine
        self.timeout = timeout
        self.registered_session: str | None = None
        self._lock = threading.Lock()          # 스냅샷 보내기는 한 번에 하나 (revision 순서 유지)
        self._failed = None                     # 보내지 못한 최신 스냅샷
        self.stats = {"snapshots_ok": 0, "snapshots_rejected": 0, "snapshot_errors": 0,
                      "results_ok": 0, "result_errors": 0, "sessions": 0}
        self.last_error: str | None = None

    def _post(self, path: str, body: dict) -> tuple[int, str]:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")

    def register(self, snap_session: str | None = None) -> bool:
        e = self.engine
        sid = str(snap_session or e.session_id)
        body = {"home_id": e.cfg.home_id, "world_session_id": sid,
                "clock_mode": getattr(e.cfg.clock_mode, "value", e.cfg.clock_mode),
                "started_at": now_utc().isoformat()}
        code, text = self._post("/v2/world/sessions", body)
        if code in (200, 201):
            self.registered_session = sid
            self.stats["sessions"] += 1
            log.info("중앙에 세션 등록: %s", sid)
            return True
        self.last_error = f"세션 등록 {code}: {text[:200]}"
        log.warning(self.last_error)
        return False

    def send_snapshot(self, snap) -> None:
        """NodeHub의 sink. 실패하면 예외 (NodeHub가 sink_errors로 센다)."""
        with self._lock:
            try:
                self._send_locked(snap)
            except Exception:
                if self._failed is None or self._failed.world_revision < snap.world_revision:
                    self._failed = snap
                raise
            if self._failed is not None and self._failed.world_revision <= snap.world_revision:
                self._failed = None

    def _send_locked(self, snap) -> None:
        sid = str(snap.world_session_id)
        if self.registered_session != sid and not self.register(sid):
            self.stats["snapshot_errors"] += 1
            raise RuntimeError(self.last_error)
        body = snap.model_dump(mode="json")
        code, text = self._post("/v2/world/snapshots", body)
        if code == 409 and "등록되지 않은 세션" in _detail(text):      # 중앙이 재시작됨
            if self.register(sid):
                code, text = self._post("/v2/world/snapshots", body)
        if code == 202:
            self.stats["snapshots_ok"] += 1
            return
        if code in (409, 422):
            # 내용 문제라 다시 보내도 같다. 기록만 하고 다시 보내지 않는다.
            self.stats["snapshots_rejected"] += 1
            self.last_error = f"스냅샷 rev {snap.world_revision} 거절 {code}: {text[:300]}"
            log.warning(self.last_error)
            return
        self.stats["snapshot_errors"] += 1
        self.last_error = f"스냅샷 rev {snap.world_revision} {code}: {text[:200]}"
        raise RuntimeError(self.last_error)

    def retry_pending(self) -> None:
        with self._lock:
            snap = self._failed
            if snap is None:
                return
            try:
                self._send_locked(snap)
                self._failed = None
                log.info("보내지 못했던 스냅샷 rev %s 재전송 성공", snap.world_revision)
            except Exception as e:  # 다음 주기에 다시
                self.last_error = f"{type(e).__name__}: {e}"

    def send_result(self, body: dict) -> None:
        try:
            code, text = self._post("/v2/world/device-results", body)
        except Exception as e:
            self.stats["result_errors"] += 1
            self.last_error = f"결과 전달 실패 {type(e).__name__}: {e}"
            log.warning(self.last_error)
            return
        if code == 202:
            self.stats["results_ok"] += 1
        else:
            self.stats["result_errors"] += 1
            self.last_error = f"결과 전달 {code}: {text[:200]}"
            log.warning(self.last_error)


# ── MQTT 입력 ─────────────────────────────────────────────────

class LiveBridge:
    """MQTT 메시지를 토픽별로 나눠 허브·엔진에 넣고, 결과는 중앙으로 넘긴다.
    on_message는 MQTT 네트워크 스레드에서 불리므로 HTTP는 여기서 하지 않는다 (결과는 줄에 넣어 따로 보냄)."""

    def __init__(self, hub: NodeHub, client: OrchestratorClient | None):
        self.hub = hub
        self.client = client
        self.results: queue.Queue[dict] = queue.Queue(maxsize=200)
        self.stats = {"node_status": 0, "node_offline": 0, "device_state": 0, "device_state_invalid": 0,
                      "device_result": 0, "device_result_invalid": 0, "device_result_duplicate": 0,
                      "results_dropped": 0, "ignored": 0}
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    # 토픽 하나 처리. 테스트에서는 이것만 직접 부른다.
    def handle(self, topic: str, payload: bytes | str, received_at: datetime | None = None) -> str:
        t = received_at or now_utc()
        parts = topic.split("/")
        if len(parts) == 4 and parts[:2] == ["eyear", "v0"] and parts[3] == "state":
            return "queued" if self.hub.submit(topic, payload, t) else "unrouted"
        if len(parts) == 4 and parts[:2] == ["eyear", "v0"] and parts[3] == "status":
            return self._status(parts[2], payload)
        if len(parts) == 5 and parts[:3] == ["eyear", "v0", "device"]:
            if parts[4] == "state":
                return self._device_state(parts[3], payload, t)
            if parts[4] == "result":
                return self._device_result(parts[3], payload, t)
        self.stats["ignored"] += 1
        return "ignored"

    def _status(self, room_id: str, payload) -> str:
        self.stats["node_status"] += 1
        try:
            p = json.loads(payload)
        except (ValueError, TypeError):
            return "invalid"
        if p.get("room_id") not in (None, room_id):
            return "topic_mismatch"
        if p.get("online") is False:
            self.stats["node_offline"] += 1
            self.hub.node_offline(room_id)
            log.info("Node 꺼짐 알림: %s", room_id)
            return "offline"
        return "online"

    def _device_state(self, device_id: str, payload, t: datetime) -> str:
        try:
            p = json.loads(payload)
            if p.get("device_id", device_id) != device_id:
                raise ValueError("토픽과 device_id가 다름")
            kw = dict(device_id=device_id, kind=p.get("kind") or p.get("type"), room_id=p.get("room_id"),
                      online=p.get("online", True), manual_override=p.get("manual_override", False),
                      state=p["state"], capabilities=p.get("capabilities", {}),
                      observed_at=_ts(p.get("timestamp"), t), received_at=t)
            self.hub.call_engine(lambda e: e.upsert_device(**kw))
        except Exception as e:  # 형식 오류 (KeyError, ValueError, ValidationError …)
            self.stats["device_state_invalid"] += 1
            log.warning("기기 상태 거절 %s: %s", device_id, str(e).splitlines()[0][:200])
            return "invalid"
        self.stats["device_state"] += 1
        return "accepted"

    def _device_result(self, device_id: str, payload, t: datetime) -> str:
        try:
            p = json.loads(payload)
            if p.get("device_id", device_id) != device_id:
                raise ValueError("토픽과 device_id가 다름")
            if p.get("status") not in RESULT_STATUSES or not p.get("command_id"):
                raise ValueError(f"status/command_id 이상: {p.get('status')!r}")
            event = {"event_id": p.get("event_id") or str(uuid.uuid4()), "command_id": p["command_id"],
                     "device_id": device_id, "status": p["status"],
                     "timestamp": _ts(p.get("timestamp"), t).isoformat(),
                     "state": p.get("state"), "reason": p.get("reason")}
            res, sid, rev = self.hub.call_engine(
                lambda e: (e.ingest_device_result(event, t), str(e.session_id), e.revision or None))
        except Exception as e:
            self.stats["device_result_invalid"] += 1
            log.warning("기기 결과 거절 %s: %s", device_id, str(e).splitlines()[0][:200])
            return "invalid"
        if res == "duplicate":
            self.stats["device_result_duplicate"] += 1
            return res
        # unknown_device(상태 보고 전 결과)도 중앙의 명령 추적에는 필요하므로 전달한다
        self.stats["device_result"] += 1
        body = {"world_session_id": sid, "world_revision": rev, "event_id": event["event_id"],
                "command_id": event["command_id"], "device_id": device_id, "status": event["status"],
                "timestamp": event["timestamp"], "observed_state": event["state"], "reason": event["reason"]}
        if self.client is not None:
            try:
                self.results.put_nowait(body)
            except queue.Full:
                self.stats["results_dropped"] += 1
        return res

    # ── 스레드 ──
    def start(self) -> None:
        if self.client is None:
            return
        for target, name in ((self._result_loop, "wm-results"), (self._retry_loop, "wm-retry")):
            th = threading.Thread(target=target, name=name, daemon=True)
            th.start()
            self._threads.append(th)

    def stop(self) -> None:
        self._stop.set()
        for th in self._threads:
            th.join(2.0)

    def _result_loop(self) -> None:
        while not self._stop.is_set():
            try:
                body = self.results.get(timeout=0.5)
            except queue.Empty:
                continue
            self.client.send_result(body)

    def _retry_loop(self) -> None:
        while not self._stop.wait(2.0):
            self.client.retry_pending()


SUBSCRIPTIONS = ["eyear/v0/+/state", "eyear/v0/+/status",
                 "eyear/v0/device/+/state", "eyear/v0/device/+/result"]


def make_mqtt(bridge: LiveBridge, host: str, port: int):
    import paho.mqtt.client as mqtt  # live에서만 필요

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"eyear-worldmodel-{uuid.uuid4().hex[:8]}")
    user = os.environ.get("EYEAR_MQTT_USER")
    if user:
        client.username_pw_set(user, os.environ.get("EYEAR_MQTT_PASSWORD"))

    def on_connect(c, _userdata, _flags, reason_code, _props):
        if reason_code.is_failure:
            log.error("브로커 접속 실패: %s", reason_code)
            return
        c.subscribe([(t, 1) for t in SUBSCRIPTIONS])   # 다시 붙을 때마다 구독
        log.info("브로커 접속 %s:%s, 구독 %s", host, port, ", ".join(SUBSCRIPTIONS))

    def on_disconnect(_c, _userdata, _flags, reason_code, _props):
        log.warning("브로커 연결 끊김 (%s), 자동으로 다시 붙습니다", reason_code)

    def on_message(_c, _userdata, msg):
        try:
            bridge.handle(msg.topic, msg.payload)
        except Exception:  # 콜백 예외로 네트워크 스레드가 죽으면 안 된다
            log.exception("메시지 처리 오류: %s", msg.topic)

    client.on_connect, client.on_disconnect, client.on_message = on_connect, on_disconnect, on_message
    client.reconnect_delay_set(1, 10)
    client.connect_async(host, port, keepalive=30)
    return client


# ── 실행 ─────────────────────────────────────────────────────

def load_app_data(engine: WorldEngine, path: str | Path) -> None:
    """앱 연결(⑧)이 정해지기 전까지 프로필·루틴·제한을 파일에서 읽는다."""
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    engine.set_profiles(d.get("profiles", []))
    engine.set_routines(d.get("routines", []))
    engine.set_restrictions(d.get("user_restrictions", []))


def summary(hub: NodeHub, bridge: LiveBridge, client: OrchestratorClient | None) -> str:
    s = hub.stats()
    lanes = " ".join(f"{r}:{v['accepted']}+{v['restart']}r/{v['received']}"
                     + (f"(거절{v['invalid'] + v['unknown_node'] + v['room_mismatch'] + v['topic_mismatch']}"
                        f",중복{v['duplicate']},순서{v['out_of_order']})"
                        if v["received"] - v["accepted"] - v["restart"] else "")
                     for r, v in s["lanes"].items() if v["received"])
    snap = hub.engine.last_snapshot
    rooms = ""
    if snap is not None:
        rooms = " ".join(f"{r.room_id}={str(r.occupancy.state)[:3]}" for r in snap.rooms)
        rooms += f" 사람{len(snap.people)} 기기{len(snap.devices)}"
    line = f"rev {hub.engine.revision} | Node {lanes or '-'} | {rooms}"
    if client is not None:
        c = client.stats
        line += f" | 중앙 202:{c['snapshots_ok']} 거절:{c['snapshots_rejected']} 오류:{c['snapshot_errors']}"
        line += f" 결과:{c['results_ok']}/{c['results_ok'] + c['result_errors']}"
    b = bridge.stats
    if b["device_state"] or b["device_result"] or b["node_offline"]:
        line += f" | 기기상태 {b['device_state']} 결과 {b['device_result']} 꺼짐알림 {b['node_offline']}"
    return line


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m worldmodel.live", description=__doc__.splitlines()[0])
    ap.add_argument("--mqtt", required=True, help="브로커 HOST[:PORT] (기본 포트 1883)")
    ap.add_argument("--orchestrator", default=os.environ.get("EYEAR_ORCHESTRATOR", "http://localhost:8765"),
                    help="중앙 주소 (기본 http://localhost:8765)")
    ap.add_argument("--no-http", action="store_true", help="중앙에 보내지 않고 받기만")
    ap.add_argument("--config", default="config/home_demo.json")
    ap.add_argument("--app-data", default="config/app_demo.json",
                    help="프로필·루틴·제한 JSON (앱 연결 전 임시). 없으면 건너뜀")
    ap.add_argument("--tick", type=float, default=0.2, help="발행 확인 주기(초)")
    ap.add_argument("--status-every", type=float, default=5.0, help="상태 요약 출력 주기(초), 0이면 끔")
    ap.add_argument("--dump", help="보낸 스냅샷을 JSONL로 저장할 파일")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname).1s %(message)s", datefmt="%H:%M:%S")
    engine = WorldEngine(load_config(a.config))
    if a.app_data and Path(a.app_data).exists():
        load_app_data(engine, a.app_data)
        log.info("프로필 %d개, 루틴 %d개 읽음 (%s)", len(engine.profiles), len(engine.routines), a.app_data)

    client = None if a.no_http else OrchestratorClient(a.orchestrator, engine)
    dump = open(a.dump, "a", encoding="utf-8") if a.dump else None

    def sink(snap):
        if dump is not None:
            dump.write(snap.model_dump_json() + "\n")
            dump.flush()
        if client is not None:
            client.send_snapshot(snap)

    hub = NodeHub(engine, sink=sink, tick_s=a.tick)
    bridge = LiveBridge(hub, client)
    log.info("World Model 세션 %s (home %s, %s)", engine.session_id, engine.cfg.home_id,
             getattr(engine.cfg.clock_mode, "value", engine.cfg.clock_mode))
    if client is not None:
        try:
            client.register()
        except Exception as e:
            log.warning("중앙에 아직 연결 안 됨 (%s: %s). 스냅샷을 보낼 때 다시 시도합니다.", type(e).__name__, e)

    host, port = parse_broker(a.mqtt)
    mq = make_mqtt(bridge, host, port)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda *_: stop.set())

    hub.start()
    bridge.start()
    mq.loop_start()
    last_err = None
    try:
        while not stop.wait(a.status_every or 1.0):
            if a.status_every:
                log.info(summary(hub, bridge, client))
            err = hub.last_sink_error or hub.last_tick_error
            if err and err != last_err:
                log.warning("보내기 오류: %s", err)
                last_err = err
    finally:
        mq.loop_stop()
        mq.disconnect()
        hub.stop()
        bridge.stop()
        if dump is not None:
            dump.close()
        log.info("종료. %s", summary(hub, bridge, client))


if __name__ == "__main__":
    main()
