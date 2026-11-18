"""World Model 엔진 — Node v0.1 메시지·기기 상태·앱 설정을 모아 WorldSnapshot 2.0을 만든다.

시간은 전부 호출자가 넘긴다 (now / received_at). live에서는 벽시계, replay에서는 가상 시계를 넘기면
같은 입력에서 항상 같은 출력이 나온다.

원칙 (계약 2.0):
- 관측하지 않은 값은 null / UNKNOWN / unavailable. 0이나 다른 사람 ID, LYING 등으로 채우지 않는다.
- persons=[]만으로 빈방을 만들지 않는다. 방 재실은 Node occupancy 그대로.
- Node 시각(timestamp)은 evidence.observed_at에, WM 수신 시각은 nodes[].received_at에 따로 둔다.
  TTL은 WM 시계(수신 시각) 기준으로 재서 Node와 WM 시계가 어긋나도 신선도 판단이 흔들리지 않게 한다.
- 우선순위·판단(청소 금지 등)은 만들지 않는다. 그건 중앙(Orchestrator)의 일.
"""

from __future__ import annotations

import json
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime

from pydantic import ValidationError

from worldmodel.config import HomeConfig
from worldmodel.contract.models import (
    SCHEMA_VERSION,
    Device,
    Profile,
    Routine,
    UserRestriction,
    WorldSnapshot,
)
from worldmodel.contract.semantic import check
from worldmodel.node_input import NodePerson, NodeStateMessage

ACTIVITY_MAP = {"RESTING": "resting", "OTHER": "other", "UNKNOWN": "unknown"}
MEASUREMENT_FIELDS = ("temperature_c", "humidity_pct", "pm25_ug_m3", "pm25_trend_per_min")
ANON_PREFIX = "anon_"


class SnapshotError(RuntimeError):
    """엔진이 계약을 어기는 스냅샷을 만들려 함 — 엔진 버그. 내보내지 않는다."""


# ---------- 내부 상태 ----------

@dataclass
class Stable:
    """값이 바뀐 시각을 기억해 '얼마나 이어졌나'를 잰다. 세션 안 첫 관측부터 잰 하한값."""
    value: object = None
    since: datetime | None = None

    def update(self, v, t: datetime) -> None:
        if self.since is None or v != self.value:
            self.value, self.since = v, t

    def age(self, now: datetime) -> int | None:
        return None if self.since is None else int(max(0.0, (now - self.since).total_seconds()))


@dataclass
class NodeRec:
    last: NodeStateMessage | None = None
    received_at: datetime | None = None
    offline: bool = False
    epoch: int = 0                                   # 재시작으로 판단할 때마다 +1 (track 번호 재사용 구분)
    event_ids: deque = field(default_factory=lambda: deque(maxlen=512))
    track_person: dict[int, str] = field(default_factory=dict)


@dataclass
class PersonRec:
    person_id: str
    node_id: str
    room_id: str
    obs: NodePerson
    observed_at: datetime                            # Node timestamp
    track_id: int
    tracked: bool = True
    lost_at: datetime | None = None                  # WM 시계
    activity: Stable = field(default_factory=Stable)


@dataclass
class DeviceRec:
    data: dict                                       # Device 필드 중 evidence 제외
    observed_at: datetime
    received_at: datetime
    source: str


@dataclass
class MeasurementRec:
    value: float
    observed_at: datetime
    received_at: datetime
    source: str
    node_ids: list[str]


def _iso(t: datetime | None) -> str | None:
    return None if t is None else t.isoformat()


def _ev(observed_at: datetime | None, source: str, node_ids: list[str], freshness: str) -> dict:
    if freshness == "unavailable":
        return {"observed_at": None, "source": "unknown", "node_ids": [], "freshness": "unavailable"}
    return {"observed_at": _iso(observed_at), "source": source, "node_ids": list(node_ids), "freshness": freshness}


NO_EVIDENCE = _ev(None, "unknown", [], "unavailable")


def _null_if_unknown(label: str, conf: float) -> float | None:
    return None if label == "UNKNOWN" else conf


# ---------- 엔진 ----------

class WorldEngine:
    def __init__(self, cfg: HomeConfig, session_id: uuid.UUID | None = None):
        self.cfg = cfg
        self.profiles: list[dict] = []
        self.routines: list[dict] = []
        self.restrictions: list[dict] = []
        self._new_session(session_id)

    # ----- 세션 -----

    def _new_session(self, session_id: uuid.UUID | None) -> None:
        self.session_id = session_id or uuid.uuid4()
        self.revision = 0
        self.nodes: dict[str, NodeRec] = {n.node_id: NodeRec() for n in self.cfg.nodes}
        self.room_occ: dict[str, Stable] = {r.room_id: Stable() for r in self.cfg.rooms}
        self.people: dict[str, PersonRec] = {}
        self.devices: dict[str, DeviceRec] = {}
        self.device_events: deque = deque(maxlen=1024)
        self.measurements: dict[tuple[str, str], MeasurementRec] = {}
        self._last_pub_at: datetime | None = None
        self._last_meaning: str | None = None
        self._last_content: str | None = None
        self.last_snapshot: WorldSnapshot | None = None

    def reset(self, session_id: uuid.UUID | None = None) -> uuid.UUID:
        """새 세션. 관측 이력은 버리고 앱 설정(프로필·루틴·제한)만 유지.
        중앙에는 이 세션을 먼저 등록(reset 요청)한 뒤 스냅샷을 보내야 한다."""
        self._new_session(session_id)
        return self.session_id

    # ----- 입력: Node -----

    def ingest_node(self, raw: dict | NodeStateMessage, received_at: datetime) -> str:
        """반환: accepted | restart | duplicate | out_of_order | invalid | unknown_node | room_mismatch"""
        try:
            msg = raw if isinstance(raw, NodeStateMessage) else NodeStateMessage.model_validate(raw)
        except ValidationError:
            return "invalid"
        ncfg = self.cfg.node(msg.node_id)
        if ncfg is None:
            return "unknown_node"
        if ncfg.room_id != msg.room_id:
            return "room_mismatch"
        nr = self.nodes[msg.node_id]
        if msg.event_id in nr.event_ids:
            return "duplicate"

        restart = False
        if nr.last is not None and msg.seq <= nr.last.seq:
            # Node에 boot_id가 없어 seq만으로는 확실히 못 가른다.
            # seq가 0으로 돌아왔거나, seq는 줄었는데 Node 시각은 앞섰으면 재시작으로 본다.
            if msg.seq == 0 or msg.timestamp > nr.last.timestamp:
                restart = True
            else:
                return "out_of_order"

        nr.event_ids.append(msg.event_id)
        if restart:
            self._restart_node(msg.node_id, received_at)
        nr.last, nr.received_at, nr.offline = msg, received_at, False
        self.room_occ[msg.room_id].update(msg.occupancy.state, received_at)
        self._apply_persons(msg, received_at)
        return "restart" if restart else "accepted"

    def mark_node_offline(self, node_id: str) -> None:
        """MQTT LWT 등으로 연결 끊김이 명시적으로 확인됐을 때."""
        if node_id in self.nodes:
            self.nodes[node_id].offline = True

    def _restart_node(self, node_id: str, t: datetime) -> None:
        nr = self.nodes[node_id]
        nr.epoch += 1
        for pid in set(nr.track_person.values()):
            self._lose(pid, node_id, t)
        nr.track_person = {}
        self.room_occ[self.cfg.node(node_id).room_id] = Stable()

    def _lose(self, pid: str, node_id: str, t: datetime) -> None:
        p = self.people.get(pid)
        if p is None or p.node_id != node_id or not p.tracked:
            return  # 이미 다른 Node에서 보고 있는 사람
        if pid.startswith(ANON_PREFIX):
            del self.people[pid]  # 익명 track은 끊기면 이어 붙일 근거가 없다
        else:
            p.tracked, p.lost_at = False, t

    def _person_id(self, nr: NodeRec, node_id: str, p: NodePerson) -> str:
        if p.identity in self.cfg.identities:
            return self.cfg.identities[p.identity]
        prev = nr.track_person.get(p.track_id)
        if prev is not None and prev.startswith(ANON_PREFIX):
            return prev
        # Node별 track_id는 집 전체 ID가 아니다 → Node·재시작 회차·track으로 만든다
        return f"{ANON_PREFIX}{node_id}_e{nr.epoch}_t{p.track_id}"

    def _apply_persons(self, msg: NodeStateMessage, t: datetime) -> None:
        nr = self.nodes[msg.node_id]
        new_map: dict[int, str] = {}
        for p in msg.persons:
            pid = self._person_id(nr, msg.node_id, p)
            if pid in new_map.values():
                # 같은 Node 안에서 두 track이 같은 구성원으로 나옴 → 뒤 track은 익명으로
                pid = f"{ANON_PREFIX}{msg.node_id}_e{nr.epoch}_t{p.track_id}"
            new_map[p.track_id] = pid
            rec = self.people.get(pid)
            if rec is None or rec.node_id != msg.node_id or not rec.tracked or rec.track_id != p.track_id:
                rec = PersonRec(pid, msg.node_id, msg.room_id, p, msg.timestamp, p.track_id)
                self.people[pid] = rec
            rec.obs, rec.observed_at, rec.tracked, rec.lost_at = p, msg.timestamp, True, None
            rec.activity.update(p.activity, t)
        for tid, pid in nr.track_person.items():
            if pid not in new_map.values():
                self._lose(pid, msg.node_id, t)
        nr.track_person = new_map

    # ----- 입력: 기기·환경·앱 -----

    def upsert_device(self, *, device_id: str, kind: str, room_id: str | None, online: bool | None,
                      manual_override: bool | None, state: dict, capabilities: dict,
                      observed_at: datetime, received_at: datetime, source: str = "device_sensor") -> int:
        """어댑터/시뮬레이터가 보고한 기기 상태. 보고된 기기만 스냅샷에 들어간다. 반환: state_revision."""
        old = self.devices.get(device_id)
        rev = old.data["state_revision"] if old else 0
        data = {"device_id": device_id, "room_id": room_id, "kind": kind, "online": online,
                "manual_override": manual_override, "state": state, "capabilities": capabilities}
        if old is None or any(old.data[k] != data[k] for k in data):
            rev += 1
        data["state_revision"] = rev
        Device.model_validate({**data, "evidence": _ev(observed_at, source, [], "current")})  # 형식 오류는 여기서 거절
        self.devices[device_id] = DeviceRec(data, observed_at, received_at, source)
        return rev

    def ingest_device_result(self, event: dict, received_at: datetime) -> str:
        """어댑터 결과 이벤트 {event_id, command_id, device_id, status, timestamp, state, reason}.
        스냅샷 배열에 넣지 않고 최신 기기 상태만 갱신한다. 반환: accepted | duplicate | unknown_device"""
        if event["event_id"] in self.device_events:
            return "duplicate"
        dev = self.devices.get(event["device_id"])
        if dev is None:
            return "unknown_device"
        self.device_events.append(event["event_id"])
        if event.get("state") is not None:
            ts = datetime.fromisoformat(event["timestamp"]) if isinstance(event["timestamp"], str) else event["timestamp"]
            d = dev.data
            self.upsert_device(device_id=d["device_id"], kind=d["kind"], room_id=d["room_id"], online=d["online"],
                               manual_override=d["manual_override"], state=event["state"],
                               capabilities=d["capabilities"], observed_at=ts, received_at=received_at,
                               source=dev.source)
        return "accepted"

    def ingest_measurement(self, room_id: str, name: str, value: float, *, observed_at: datetime,
                           received_at: datetime, source: str = "device_sensor",
                           node_ids: list[str] | None = None) -> None:
        if name not in MEASUREMENT_FIELDS:
            raise ValueError(f"모르는 환경값 {name}")
        if room_id not in self.room_occ:
            raise ValueError(f"없는 방 {room_id}")
        self.measurements[(room_id, name)] = MeasurementRec(value, observed_at, received_at, source, node_ids or [])

    def set_profiles(self, items: list[dict]) -> None:
        self.profiles = [Profile.model_validate(x).model_dump(mode="json") for x in items]

    def set_routines(self, items: list[dict]) -> None:
        """occurrence_id는 앱이 정한 값을 그대로 둔다. 같은 회차를 WM이 새 ID로 바꾸지 않는다."""
        self.routines = [Routine.model_validate(x).model_dump(mode="json") for x in items]

    def set_restrictions(self, items: list[dict]) -> None:
        self.restrictions = [UserRestriction.model_validate(x).model_dump(mode="json") for x in items]

    # ----- 출력 -----

    def _node_fresh(self, node_id: str, now: datetime) -> bool:
        nr = self.nodes[node_id]
        return (nr.received_at is not None and not nr.offline
                and (now - nr.received_at).total_seconds() <= self.cfg.ttl.node_s)

    def _nodes_out(self, now: datetime) -> list[dict]:
        out = []
        for n in self.cfg.nodes:
            nr = self.nodes[n.node_id]
            if nr.received_at is None:
                avail = "offline" if nr.offline else "unknown"
            elif nr.offline:
                avail = "offline"
            else:
                avail = "online" if self._node_fresh(n.node_id, now) else "stale"
            m = nr.last
            out.append({
                "node_id": n.node_id, "room_id": n.room_id,
                "schema_version": m.schema_version if m else "0.1",
                "availability": avail,
                "last_event_id": str(m.event_id) if m else None,
                "last_seq": m.seq if m else None,
                "last_timestamp": _iso(m.timestamp) if m else None,
                "received_at": _iso(nr.received_at),
                "supports_speak": n.supports_speak,
            })
        return out

    def _measurement(self, room_id: str, name: str, now: datetime) -> dict:
        m = self.measurements.get((room_id, name))
        if m is None:
            return {"value": None, "evidence": NO_EVIDENCE}
        fresh = (now - m.received_at).total_seconds() <= self.cfg.ttl.measurement_s
        # stale 값은 남기되 current로 올리지 않는다
        return {"value": m.value, "evidence": _ev(m.observed_at, m.source, m.node_ids, "current" if fresh else "stale")}

    def _rooms_out(self, now: datetime) -> list[dict]:
        node_of = {n.room_id: n.node_id for n in self.cfg.nodes}
        out = []
        for r in self.cfg.rooms:
            nid = node_of.get(r.room_id)
            nr = self.nodes.get(nid) if nid else None
            msg = nr.last if nr else None
            if msg is None:
                occ = {"state": "UNKNOWN", "confidence": None, "stable_for_s": None, "evidence": NO_EVIDENCE}
                audio = {"context": "UNKNOWN", "confidence": None, "evidence": NO_EVIDENCE}
                light = {"level": "UNKNOWN", "confidence": None, "evidence": NO_EVIDENCE}
            elif self._node_fresh(nid, now):
                e = _ev(msg.timestamp, "node", [nid], "current")
                st = msg.occupancy.state
                occ = {"state": st, "confidence": _null_if_unknown(st, msg.occupancy.confidence),
                       "stable_for_s": self.room_occ[r.room_id].age(now), "evidence": e}
                audio = {"context": msg.audio.context,
                         "confidence": _null_if_unknown(msg.audio.context, msg.audio.confidence), "evidence": e}
                light = {"level": msg.light, "confidence": None, "evidence": e}  # Node light에는 confidence 없음
            else:
                # 만료: 과거 근거(observed_at)는 남기고 값은 UNKNOWN. 마지막 EMPTY를 계속 믿지 않게.
                e = _ev(msg.timestamp, "node", [nid], "stale")
                occ = {"state": "UNKNOWN", "confidence": None, "stable_for_s": None, "evidence": e}
                audio = {"context": "UNKNOWN", "confidence": None, "evidence": e}
                light = {"level": "UNKNOWN", "confidence": None, "evidence": e}
            room = {"room_id": r.room_id, "room_type": r.room_type.value if hasattr(r.room_type, "value") else r.room_type,
                    "occupancy": occ, "audio": audio, "light": light}
            for f in MEASUREMENT_FIELDS:
                room[f] = self._measurement(r.room_id, f, now)
            out.append(room)
        return out

    def _people_out(self, now: datetime) -> list[dict]:
        profile_by_identity = {p["identity"]: p["profile_id"] for p in self.profiles}
        out, forget = [], []
        for pid, p in self.people.items():
            o = p.obs
            fresh = self._node_fresh(p.node_id, now)
            profile_id = None if o.identity in ("UNKNOWN", "GUEST") else profile_by_identity.get(o.identity)
            base = {"person_id": pid, "profile_id": profile_id, "identity": o.identity,
                    "identity_confidence": _null_if_unknown(o.identity, o.identity_confidence),
                    "identity_source": o.identity_source}
            label = ACTIVITY_MAP[o.activity]

            if p.tracked and fresh:
                e = _ev(p.observed_at, "node", [p.node_id], "current")
                stable = p.activity.age(now)
                out.append({**base,
                    "room_id": p.room_id,
                    "posture": o.posture, "posture_confidence": _null_if_unknown(o.posture, o.posture_confidence),
                    "motion": o.motion,
                    "track_refs": [{"node_id": p.node_id, "track_id": p.track_id}],
                    "activity": {"label": label,
                                 "confidence": None if label == "unknown" else o.activity_confidence,
                                 "confirmed": label != "unknown" and stable is not None
                                              and stable >= self.cfg.ttl.activity_confirm_s,
                                 "stable_for_s": stable, "evidence": e},
                    "position": None if o.position is None else
                        {"frame": "room_local", "x": o.position.x, "y": o.position.y, "evidence": e},
                    "evidence": e})
                continue

            if pid.startswith(ANON_PREFIX):
                continue  # 익명은 지금 보이는 동안만

            lost_at = p.lost_at if not p.tracked else self.nodes[p.node_id].received_at
            occ = self.room_occ[p.room_id]
            # HELD: 사람 추적은 끊겼지만 그 방 재실이 끊긴 뒤로 한 번도 바뀌지 않고 OCCUPIED로 이어짐
            held = (not p.tracked and fresh and occ.value == "OCCUPIED"
                    and occ.since is not None and occ.since <= lost_at)
            if not held and (now - lost_at).total_seconds() > self.cfg.ttl.person_forget_s:
                forget.append(pid)
                continue
            e = _ev(p.observed_at, "world_inference", [p.node_id], "stale")
            out.append({**base,
                "room_id": p.room_id if held else None,
                "posture": "UNKNOWN", "posture_confidence": None, "motion": "UNKNOWN",
                "track_refs": [],
                "activity": {"label": label, "confidence": None, "confirmed": False,
                             "stable_for_s": None, "evidence": e},
                "position": None,
                "evidence": e})
        for pid in forget:
            del self.people[pid]
        out.sort(key=lambda x: x["person_id"])
        return out

    def _devices_out(self, now: datetime, people: set[str]) -> list[dict]:
        out = []
        for did in sorted(self.devices):
            d = self.devices[did]
            fresh = (now - d.received_at).total_seconds() <= self.cfg.ttl.device_s
            data = json.loads(json.dumps(d.data))
            st = data["state"]
            if data["kind"] == "ac" and st.get("airflow_target_person_id") not in (None, *people):
                # 지금 people에 없는 사람을 기준으로 풍향을 판단하지 않도록 null
                st["airflow_target_person_id"] = None
            out.append({**data, "evidence": _ev(d.observed_at, d.source, [], "current" if fresh else "stale")})
        return out

    def _compose(self, now: datetime) -> dict:
        people = self._people_out(now)
        restrictions = [r for r in self.restrictions
                        if r["expires_at"] is None or datetime.fromisoformat(r["expires_at"]) > now]
        return {
            "schema_version": SCHEMA_VERSION,
            "home_id": self.cfg.home_id,
            "world_session_id": str(self.session_id),
            "world_revision": self.revision,
            "as_of": _iso(now),
            "clock_mode": self.cfg.clock_mode.value if hasattr(self.cfg.clock_mode, "value") else self.cfg.clock_mode,
            "nodes": self._nodes_out(now),
            "rooms": self._rooms_out(now),
            "people": people,
            "devices": self._devices_out(now, {p["person_id"] for p in people}),
            "profiles": self.profiles,
            "routines": self.routines,
            "room_influence": self.cfg.room_influence,
            "room_links": [l.model_dump(mode="json") for l in self.cfg.room_links],
            "user_restrictions": restrictions,
        }

    @staticmethod
    def _meaning(body: dict) -> str:
        """중앙이 다시 판단할 만한 변화만 뽑은 키. 신뢰도·좌표·지속시간 같은 연속값은 뺀다."""
        f = lambda e: e["freshness"]
        key = {
            "nodes": [(n["node_id"], n["availability"]) for n in body["nodes"]],
            "rooms": [(r["room_id"], r["occupancy"]["state"], f(r["occupancy"]["evidence"]),
                       r["audio"]["context"], r["light"]["level"],
                       [f(r[m]["evidence"]) for m in MEASUREMENT_FIELDS]) for r in body["rooms"]],
            "people": [(p["person_id"], p["room_id"], p["identity"], p["identity_source"], p["posture"],
                        p["activity"]["label"], p["activity"]["confirmed"], f(p["evidence"]))
                       for p in body["people"]],
            "devices": [(d["device_id"], d["state_revision"], f(d["evidence"])) for d in body["devices"]],
            "app": [body["profiles"], body["routines"], body["user_restrictions"]],
        }
        return json.dumps(key, sort_keys=True, ensure_ascii=False, default=str)

    @staticmethod
    def _content(body: dict) -> str:
        rest = {k: v for k, v in body.items() if k not in ("as_of", "world_revision")}
        return json.dumps(rest, sort_keys=True, ensure_ascii=False, default=str)

    def poll(self, now: datetime) -> WorldSnapshot | None:
        """보낼 때가 됐으면 새 revision 스냅샷, 아니면 None.
        의미 변화 → 즉시. 값만 바뀜 → 최대 초당 1회. 변화 없음 → keepalive 주기."""
        body = self._compose(now)
        meaning, content = self._meaning(body), self._content(body)
        if self._last_pub_at is not None:
            since = (now - self._last_pub_at).total_seconds()
            due = (meaning != self._last_meaning
                   or (content != self._last_content and since >= self.cfg.ttl.heartbeat_publish_s)
                   or since >= self.cfg.ttl.keepalive_s)
            if not due:
                return None
        return self._publish(body, now, meaning, content)

    def snapshot(self, now: datetime) -> WorldSnapshot:
        """주기와 상관없이 지금 상태를 새 revision으로 발행."""
        body = self._compose(now)
        return self._publish(body, now, self._meaning(body), self._content(body))

    def _publish(self, body: dict, now: datetime, meaning: str, content: str) -> WorldSnapshot:
        # 같은 revision에 다른 payload를 보내면 409이므로, 발행할 때마다 revision을 올린다
        body["world_revision"] = self.revision + 1
        try:
            snap = WorldSnapshot.model_validate(body)
        except ValidationError as e:
            raise SnapshotError(str(e)) from e
        if errs := check(snap):
            raise SnapshotError("; ".join(errs))
        self.revision += 1
        self._last_pub_at, self._last_meaning, self._last_content = now, meaning, content
        self.last_snapshot = snap
        return snap
