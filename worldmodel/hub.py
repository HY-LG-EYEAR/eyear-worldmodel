"""여러 방 Node 메시지를 동시에 받아 엔진 하나에 안전하게 넣는 입구 (NodeHub).

    MQTT 콜백(아무 스레드) ──submit()──▶ [방1 줄] ─┐
                                        [거실 줄] ─┼─▶ 엔진 (한 번에 하나) ─▶ tick: poll() ─▶ 보낼 칸 ─▶ sink
                                        [방2 줄] ─┘     engine_lock                      (최신 1장만)

원칙
1. 받은 시각(received_at)은 줄에 넣는 순간 찍는다. 줄에서 기다린 시간 때문에 관측이 더 최신처럼 보이면 안 된다.
2. 방(Node)마다 줄이 따로다. 한 Node가 깨진 메시지를 쏟아내거나 밀려도 다른 방은 영향이 없다.
3. 같은 Node 안에서는 도착 순서를 지킨다. 서로 다른 Node 사이의 순서는 보장하지 않는다 (네트워크도 보장 안 함).
4. 해석(JSON·형식 검사)은 줄마다 따로, 엔진 반영만 엔진 잠금 안에서 한 번에 하나.
5. 줄이 가득 차면 가장 오래된 메시지를 버린다. Node 메시지는 매번 방 전체 상태라 최신이 옛것을 대신한다.
6. 발행은 tick 주기(기본 0.2초)로 묶는다. 동시에 온 방 메시지 여러 개가 스냅샷 1장으로 합쳐진다.
7. 보내는 쪽(sink)이 느리면 밀린 스냅샷 대신 최신 1장만 보낸다. revision은 계속 오르므로 중간을 건너뛰어도 수신측은 202.

테스트·replay에서는 스레드 없이 pump()/tick(now)를 직접 부른다. live에서는 start()/stop().
"""

from __future__ import annotations

import json
import threading
from collections import deque
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from pydantic import ValidationError

from worldmodel.engine import WorldEngine
from worldmodel.node_input import NodeStateMessage

TOPIC_PREFIX = "eyear/v0"


def room_from_topic(topic: str) -> str | None:
    """'eyear/v0/{room_id}/state' → room_id. 형식이 다르면 None."""
    parts = topic.split("/")
    if len(parts) == 4 and f"{parts[0]}/{parts[1]}" == TOPIC_PREFIX and parts[3] == "state" and parts[2]:
        return parts[2]
    return None


@dataclass
class _Envelope:
    topic: str
    payload: Any
    received_at: datetime


@dataclass
class LaneStats:
    received: int = 0          # 줄에 들어온 수
    accepted: int = 0
    restart: int = 0
    duplicate: int = 0
    out_of_order: int = 0
    invalid: int = 0           # JSON 깨짐 또는 Node 0.1 형식 아님
    unknown_node: int = 0
    room_mismatch: int = 0     # 설정상 그 Node의 방이 아님
    topic_mismatch: int = 0    # 토픽의 방과 메시지 안 room_id가 다름
    overflow: int = 0          # 줄이 가득 차 버린 수
    last_received_at: datetime | None = None
    last_result: str | None = None


class _Lane:
    def __init__(self, node_id: str, room_id: str, maxlen: int):
        self.node_id, self.room_id, self.maxlen = node_id, room_id, maxlen
        self.q: deque[_Envelope] = deque()
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.stats = LaneStats()


class NodeHub:
    def __init__(self, engine: WorldEngine, *, sink: Callable[[Any], None] | None = None,
                 clock: Callable[[], datetime] | None = None, lane_size: int = 20, tick_s: float = 0.2):
        self.engine = engine
        self.sink = sink
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.tick_s = tick_s
        self.lanes = {n.room_id: _Lane(n.node_id, n.room_id, lane_size) for n in engine.cfg.nodes}
        self._engine_lock = threading.Lock()
        self._misc_lock = threading.Lock()
        self.unrouted = 0           # 토픽이 이상하거나 Node 없는 방
        self.published = 0          # 엔진이 만든 스냅샷 수
        self.sent = 0               # sink까지 간 수
        self.superseded = 0         # sink가 느려 최신 것으로 대체된 수
        self.sink_errors = 0
        self.last_sink_error: str | None = None
        self._outbox: Any = None
        self._outbox_ready = threading.Event()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    # ── 입구: 아무 스레드에서나 불러도 됨 ──────────────────────────
    def submit(self, topic: str, payload: bytes | str | dict, received_at: datetime | None = None) -> bool:
        """MQTT 콜백 등에서 그대로 넘긴다. 줄에 넣었으면 True."""
        t = received_at or self.clock()
        room = room_from_topic(topic)
        lane = self.lanes.get(room) if room else None
        if lane is None:
            with self._misc_lock:
                self.unrouted += 1
            return False
        with lane.lock:
            if len(lane.q) >= lane.maxlen:
                lane.q.popleft()
                lane.stats.overflow += 1
            lane.q.append(_Envelope(topic, payload, t))
            lane.stats.received += 1
            lane.stats.last_received_at = t
        lane.ready.set()
        return True

    def node_offline(self, room_id: str) -> None:
        """MQTT LWT 등으로 Node가 끊겼다고 확실히 알 때. TTL을 기다리지 않고 UNKNOWN으로."""
        lane = self.lanes.get(room_id)
        if lane is not None:
            with self._engine_lock:
                self.engine.mark_node_offline(lane.node_id)

    # ── 처리 ───────────────────────────────────────────────────
    def _parse(self, lane: _Lane, env: _Envelope) -> NodeStateMessage | str:
        p = env.payload
        try:
            if isinstance(p, (bytes, bytearray)):
                p = p.decode("utf-8")
            if isinstance(p, str):
                p = json.loads(p)
            msg = NodeStateMessage.model_validate(p)
        except (UnicodeDecodeError, json.JSONDecodeError, ValidationError, TypeError):
            return "invalid"
        if msg.room_id != lane.room_id:
            return "topic_mismatch"
        return msg

    def _drain(self, lane: _Lane) -> int:
        n = 0
        while True:
            with lane.lock:
                if not lane.q:
                    return n
                env = lane.q.popleft()
            parsed = self._parse(lane, env)             # 잠금 밖: 방마다 따로
            if isinstance(parsed, str):
                result = parsed
            else:
                with self._engine_lock:                 # 엔진은 한 번에 하나
                    result = self.engine.ingest_node(parsed, env.received_at)
            with lane.lock:
                setattr(lane.stats, result, getattr(lane.stats, result) + 1)
                lane.stats.last_result = result
            n += 1

    def pump(self) -> int:
        """스레드 없이 모든 줄을 비운다 (테스트·replay용). 처리한 메시지 수."""
        return sum(self._drain(lane) for lane in self.lanes.values())

    def tick(self, now: datetime | None = None):
        """엔진에 발행할 때인지 묻고, 나왔으면 보낼 칸에 넣는다. 나온 스냅샷 반환."""
        with self._engine_lock:
            snap = self.engine.poll(now or self.clock())
            if snap is None:
                return None
            self.published += 1
            if self._threads:
                with self._misc_lock:
                    if self._outbox is not None:
                        self.superseded += 1
                    self._outbox = snap
                self._outbox_ready.set()
        if not self._threads:
            self._send(snap)
        return snap

    def _send(self, snap) -> None:
        if self.sink is None:
            return
        try:
            self.sink(snap)
            self.sent += 1
        except Exception as e:  # 보내기 실패가 엔진을 멈추면 안 된다
            self.sink_errors += 1
            self.last_sink_error = f"{type(e).__name__}: {e}"

    # ── live: 스레드 ──────────────────────────────────────────
    def start(self) -> None:
        if self._threads:
            return
        self._stop.clear()
        for lane in self.lanes.values():
            self._threads.append(threading.Thread(target=self._lane_loop, args=(lane,),
                                                  name=f"hub-{lane.node_id}", daemon=True))
        self._threads.append(threading.Thread(target=self._tick_loop, name="hub-tick", daemon=True))
        self._threads.append(threading.Thread(target=self._send_loop, name="hub-send", daemon=True))
        for th in self._threads:
            th.start()

    def stop(self, timeout: float = 2.0) -> None:
        """멈추고, 줄에 남은 메시지까지 처리한다."""
        self._stop.set()
        for lane in self.lanes.values():
            lane.ready.set()
        self._outbox_ready.set()
        for th in self._threads:
            th.join(timeout)
        self._threads = []
        self.pump()
        with self._misc_lock:
            last, self._outbox = self._outbox, None
        if last is not None:
            self._send(last)

    def _lane_loop(self, lane: _Lane) -> None:
        while not self._stop.is_set():
            lane.ready.wait(0.5)
            lane.ready.clear()
            self._drain(lane)

    def _tick_loop(self) -> None:
        while not self._stop.wait(self.tick_s):
            self.tick()

    def _send_loop(self) -> None:
        while not self._stop.is_set():
            self._outbox_ready.wait(0.5)
            self._outbox_ready.clear()
            with self._misc_lock:
                snap, self._outbox = self._outbox, None
            if snap is not None:
                self._send(snap)

    # ── 상태 보기 ─────────────────────────────────────────────
    def stats(self) -> dict:
        out = {"unrouted": self.unrouted, "published": self.published, "sent": self.sent,
               "superseded": self.superseded, "sink_errors": self.sink_errors, "lanes": {}}
        for room, lane in self.lanes.items():
            with lane.lock:
                s = asdict(lane.stats)
                s["depth"] = len(lane.q)
            s["node_id"] = lane.node_id
            out["lanes"][room] = s
        return out
