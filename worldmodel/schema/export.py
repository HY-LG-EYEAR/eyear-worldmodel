"""pydantic 모델에서 JSON Schema 파일과 예시 메시지를 생성한다.

    python -m worldmodel.schema.export      (eyear-worldmodel 폴더에서)

결과
- worldmodel/schema/json/<메시지>.schema.json : 정빈님(Orchestrator)에게 전달하는 형식 정의
- worldmodel/schema/examples/<예시>.json      : 실제 메시지 예시

주의: 필드 사이의 규칙(SEEN이면 track 필요 등)은 JSON Schema로 표현되지 않는다.
EYEAR_월드모델_데이터_명세서.md에 따로 적는다.
"""

import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

from pydantic import BaseModel

from worldmodel.schema.models import DeviceResultEvent, WorldSnapshot

SCHEMA_DIR = Path(__file__).resolve().parent
JSON_DIR = SCHEMA_DIR / "json"
EXAMPLES_DIR = SCHEMA_DIR / "examples"

MESSAGE_MODELS: dict[str, type[BaseModel]] = {
    "world_snapshot": WorldSnapshot,
    "device_result": DeviceResultEvent,
}

_KST = timezone(timedelta(hours=9))
_T0 = datetime(2026, 10, 30, 22, 0, 0, tzinfo=_KST)
_LIGHT_OFF_CMD = UUID("00000000-0000-4000-8000-0000000000d1")


def _t(seconds: float) -> datetime:
    return _T0 + timedelta(seconds=seconds)


def _uuid(n: int) -> UUID:
    return UUID(f"00000000-0000-4000-8000-{n:012d}")


# ---------- 집 구성 (나중에 config/home.yaml) ----------
# origin_m: 집 좌표(평면도 왼쪽 아래 원점, y 위쪽)에서 방 왼쪽 아래 모서리
_ROOMS = {
    "room1": ("방1", (9.1, 9.15), (4.2, 3.4), ["laundry"]),
    "room2": ("방2", (0.0, 9.1), (6.2, 4.95), []),
    "living": ("거실", (0.0, 0.0), (7.1, 9.1), []),
    "laundry": ("세탁실", (9.1, 12.55), (4.2, 1.5), ["room1"]),
}


def _room(room_id: str, *, node: str | None = None, seq: int | None = None, seen: float | None = None,
          occupancy=("UNKNOWN", 0.0, None), light=("UNKNOWN", None), audio=("UNKNOWN", 0.0, None),
          temp=None, dirt=None, person_ids=(), status: str | None = None) -> dict:
    name, origin, size, adjacent = _ROOMS[room_id]
    if status is None:
        status = "NO_DATA" if seen is None else "FRESH"
    return {
        "room_id": room_id, "name": name,
        "origin_m": {"x": origin[0], "y": origin[1]},
        "size_m": {"x": size[0], "y": size[1]},
        "adjacent": adjacent,
        "source": {
            "node_id": node, "status": status,
            "session_id": f"{node}#1" if seen is not None else None,
            "last_seq": seq, "last_observed_at": _t(seen) if seen is not None else None,
        },
        "occupancy": {"state": occupancy[0], "confidence": occupancy[1],
                      "since": _t(occupancy[2]) if occupancy[2] is not None else None},
        "light": {"state": light[0], "since": _t(light[1]) if light[1] is not None else None},
        "audio": {"context": audio[0], "confidence": audio[1],
                  "since": _t(audio[2]) if audio[2] is not None else None},
        "temperature_c": {"value": temp[0], "observed_at": _t(temp[1]), "source": temp[2]} if temp
        else {"value": None, "observed_at": None, "source": None},
        "dirt_level": {"value": dirt[0], "observed_at": _t(dirt[1]), "source": "sim"} if dirt
        else {"value": None, "observed_at": None, "source": None},
        "person_ids": list(person_ids),
    }


def _pos(room_id: str, x: float, y: float, zone: str | None) -> dict:
    ox, oy = _ROOMS[room_id][1]
    return {"room": {"x": x, "y": y}, "home": {"x": round(ox + x, 2), "y": round(oy + y, 2)}, "zone": zone}


def _member_a_resting() -> dict:
    # 방1 침대에서 휴식 중, 소등 후 → 레이더로 신원 이어받음, 자세 UNKNOWN
    return {
        "person_id": "MEMBER_A", "identity": "MEMBER_A",
        "identity_confidence": 0.75, "identity_source": "TRACK_CARRIED", "candidates": [],
        "presence": "SEEN", "presence_since": _t(0), "room_id": "room1",
        "track": {"node_id": "node_room1", "session_id": "node_room1#1", "track_id": 1},
        "posture": {"state": "UNKNOWN", "confidence": 0.0, "since": _t(70)},
        "motion": "STILL",
        "activity": {"state": "RESTING", "confidence": 0.70, "since": _t(40), "rest_episode": 1},
        "position": _pos("room1", 2.40, 2.67, "bed"),
        "last_seen_at": _t(75),
    }


def _member_b_sofa() -> dict:
    return {
        "person_id": "MEMBER_B", "identity": "MEMBER_B",
        "identity_confidence": 0.90, "identity_source": "FACE", "candidates": [],
        "presence": "SEEN", "presence_since": _t(-300), "room_id": "living",
        "track": {"node_id": "node_living", "session_id": "node_living#1", "track_id": 1},
        "posture": {"state": "SITTING", "confidence": 0.88, "since": _t(-280)},
        "motion": "SLIGHT",
        "activity": {"state": "OTHER", "confidence": 0.80, "since": _t(-300), "rest_episode": 0},
        "position": _pos("living", 0.60, 4.90, "sofa"),
        "last_seen_at": _t(75),
    }


def _devices(light_power: str = "OFF") -> list[dict]:
    light_result = {
        "command_id": _LIGHT_OFF_CMD, "action": "TURN_OFF", "status": "COMPLETED",
        "reason": None, "timestamp": _t(69.5), "revision": 40,
    }
    return [
        {"device_id": "light_room1", "type": "LIGHT", "name": "방1 조명", "room_id": "room1", "online": True,
         "actions": ["TURN_ON", "TURN_OFF"], "state": {"power": light_power},
         "observed_at": _t(69.5), "last_result": light_result},
        {"device_id": "curtain_room1", "type": "CURTAIN", "name": "방1 커튼", "room_id": "room1", "online": True,
         "actions": ["OPEN", "CLOSE"], "state": {"position": "CLOSED", "moving_to": None, "progress": 1.0},
         "observed_at": _t(10), "last_result": None},
        {"device_id": "ac_room1", "type": "AC", "name": "방1 에어컨", "room_id": "room1", "online": True,
         "actions": ["TURN_ON", "TURN_OFF", "SET_TARGET", "SET_WIND"],
         "state": {"power": "ON", "target_c": 24.0, "wind_to": "MEMBER_A"},
         "observed_at": _t(30), "last_result": None},
        {"device_id": "ac_living", "type": "AC", "name": "거실 에어컨", "room_id": "living", "online": True,
         "actions": ["TURN_ON", "TURN_OFF", "SET_TARGET", "SET_WIND"],
         "state": {"power": "ON", "target_c": 26.0, "wind_to": "MEMBER_B"},
         "observed_at": _t(-200), "last_result": None},
        {"device_id": "washer", "type": "WASHER", "name": "세탁기", "room_id": "laundry", "online": True,
         "actions": ["START", "PAUSE", "SET_MODE"],
         "state": {"power": "RUNNING", "mode": "NORMAL", "remaining_s": 1260, "noise_db": 58.0},
         "observed_at": _t(74), "last_result": None},
        {"device_id": "vacuum", "type": "ROBOT_VACUUM", "name": "로봇청소기", "room_id": None, "online": True,
         "actions": ["CLEAN_ROOM", "RETURN_TO_DOCK", "PAUSE"],
         "state": {"status": "DOCKED", "room": None, "battery": 0.92},
         "observed_at": _t(60), "last_result": None},
    ]


def _base(revision: int, at: float, changes: list[dict], room1: dict, people: list[dict]) -> dict:
    return {
        "schema_version": "0.1",
        "snapshot_id": _uuid(revision),
        "home_id": "home",
        "revision": revision,
        "timestamp": _t(at),
        "changes": changes,
        "rooms": [
            room1,
            _room("living", node="node_living", seq=380, seen=at - 0.4,
                  occupancy=("OCCUPIED", 0.95, -300), light=("BRIGHT", -600), audio=("TV", 0.80, -250),
                  temp=(26.4, at - 2, "ac_living"), dirt=(0.35, at - 5), person_ids=["MEMBER_B"]),
            # 방2·세탁실에는 Node가 없다 → 재실 UNKNOWN (빈 방이 아님)
            _room("room2"),
            _room("laundry", temp=None),
        ],
        "people": people,
        "devices": _devices(),
        "preferences": [
            {"identity": "MEMBER_A", "display_name": "A", "preferred_temp_c": 24.0, "updated_at": _t(-86400)},
            {"identity": "MEMBER_B", "display_name": "B", "preferred_temp_c": 26.0, "updated_at": None},
        ],
        "routines": [
            {"routine_id": "a_sleep", "identity": "MEMBER_A", "kind": "SLEEP", "time": "23:30",
             "days": ["SUN", "MON", "TUE", "WED", "THU"]},
        ],
    }


def example_messages() -> dict[str, BaseModel]:
    room1_dark = dict(node="node_room1", temp=(27.6, 74, "ac_room1"), dirt=(0.20, 70))

    # 1) t4: 소등 후 A가 침대에서 휴식 중 (rev 42)
    resting = _base(42, 75, [
        {"type": "LIGHT_CHANGED", "room_id": "room1", "before": "BRIGHT", "after": "DARK"},
        {"type": "IDENTITY_CHANGED", "person_id": "MEMBER_A", "room_id": "room1",
         "before": "FACE", "after": "TRACK_CARRIED"},
        {"type": "POSTURE_CHANGED", "person_id": "MEMBER_A", "room_id": "room1", "before": "LYING", "after": "UNKNOWN"},
    ], _room("room1", seq=75, seen=75, occupancy=("OCCUPIED", 0.85, 0), light=("DARK", 70),
             audio=("SILENT", 0.85, 2), person_ids=["MEMBER_A"], **room1_dark),
        [_member_a_resting(), _member_b_sofa()])

    # 2) Node가 A의 위치를 놓쳤지만 재실 레이더는 사람을 봄 → HELD (rev 43)
    a_held = _member_a_resting() | {"presence": "HELD", "presence_since": _t(77), "track": None,
                                     "last_seen_at": _t(76)}
    held = _base(43, 77, [
        {"type": "PRESENCE_CHANGED", "person_id": "MEMBER_A", "room_id": "room1", "before": "SEEN", "after": "HELD"},
    ], _room("room1", seq=77, seen=77, occupancy=("OCCUPIED", 0.90, 0), light=("DARK", 70),
             audio=("SILENT", 0.85, 2), person_ids=["MEMBER_A"], **room1_dark),
        [a_held, _member_b_sofa()])

    # 3) A가 일어나 방을 나감: Node가 EMPTY를 보냄 → IN_TRANSIT (rev 51)
    a_transit = _member_a_resting() | {
        "identity_confidence": 0.75, "presence": "IN_TRANSIT", "presence_since": _t(128), "track": None,
        "posture": {"state": "UNKNOWN", "confidence": 0.0, "since": _t(128)}, "motion": "UNKNOWN",
        "activity": {"state": "UNKNOWN", "confidence": 0.0, "since": _t(128), "rest_episode": 1},
        "position": _pos("room1", 0.5, 2.0, None), "last_seen_at": _t(121),
    }
    transit = _base(51, 128, [
        {"type": "OCCUPANCY_CHANGED", "room_id": "room1", "before": "OCCUPIED", "after": "EMPTY"},
        {"type": "PERSON_LEFT", "person_id": "MEMBER_A", "room_id": "room1"},
        {"type": "PRESENCE_CHANGED", "person_id": "MEMBER_A", "room_id": "room1", "before": "HELD", "after": "IN_TRANSIT"},
    ], _room("room1", seq=128, seen=128, occupancy=("EMPTY", 0.60, 128), light=("DARK", 70),
             audio=("SILENT", 0.85, 2), **room1_dark),
        [a_transit, _member_b_sofa()])

    # 4) 어두운 거실에 신원 모를 사람이 나타남 → 후보로 A만 적음, identity는 UNKNOWN 그대로 (rev 52)
    living_unknown = {
        "person_id": "anon_living_s1_t2", "identity": "UNKNOWN",
        "identity_confidence": 0.0, "identity_source": "UNKNOWN",
        "candidates": [{"identity": "MEMBER_A", "reason": "room1에서 IN_TRANSIT 4초 뒤 living에 나타남"}],
        "presence": "SEEN", "presence_since": _t(132), "room_id": "living",
        "track": {"node_id": "node_living", "session_id": "node_living#1", "track_id": 2},
        "posture": {"state": "UNKNOWN", "confidence": 0.0, "since": _t(132)}, "motion": "ACTIVE",
        "activity": {"state": "UNKNOWN", "confidence": 0.0, "since": _t(132), "rest_episode": 0},
        "position": _pos("living", 6.2, 8.5, None), "last_seen_at": _t(132),
    }
    unknown = _base(52, 132, [
        {"type": "PERSON_ENTERED", "person_id": "anon_living_s1_t2", "room_id": "living"},
    ], _room("room1", seq=132, seen=132, occupancy=("EMPTY", 0.60, 128), light=("DARK", 70),
             audio=("SILENT", 0.85, 2), **room1_dark),
        [a_transit | {"presence_since": _t(128)}, _member_b_sofa(), living_unknown])
    unknown["rooms"][1]["person_ids"] = ["MEMBER_B", "anon_living_s1_t2"]

    # 5) 방1 Node가 3초 넘게 조용함 → STALE, 방 관측값 UNKNOWN, A는 LAST_KNOWN (rev 44)
    a_last = _member_a_resting() | {
        "presence": "LAST_KNOWN", "presence_since": _t(79), "track": None,
        "posture": {"state": "UNKNOWN", "confidence": 0.0, "since": _t(79)}, "motion": "UNKNOWN",
        "activity": {"state": "UNKNOWN", "confidence": 0.0, "since": _t(79), "rest_episode": 1},
        "last_seen_at": _t(75),
    }
    stale = _base(44, 79, [
        {"type": "SOURCE_CHANGED", "room_id": "room1", "before": "FRESH", "after": "STALE"},
        {"type": "OCCUPANCY_CHANGED", "room_id": "room1", "before": "OCCUPIED", "after": "UNKNOWN"},
        {"type": "LIGHT_CHANGED", "room_id": "room1", "before": "DARK", "after": "UNKNOWN"},
        {"type": "AUDIO_CHANGED", "room_id": "room1", "before": "SILENT", "after": "UNKNOWN"},
        {"type": "PRESENCE_CHANGED", "person_id": "MEMBER_A", "room_id": "room1", "before": "SEEN", "after": "LAST_KNOWN"},
    ], _room("room1", seq=75, seen=75, status="STALE", occupancy=("UNKNOWN", 0.0, 79), light=("UNKNOWN", 79),
             audio=("UNKNOWN", 0.0, 79), **room1_dark),
        [a_last, _member_b_sofa()])

    # 6) 시작 직후: 아직 아무 Node도 받지 못함 (rev 0)
    boot = _base(0, 0, [], _room("room1", node="node_room1"), [])
    boot["rooms"][1] = _room("living", node="node_living")
    boot["devices"] = copy.deepcopy(boot["devices"])
    for d in boot["devices"]:
        d["last_result"] = None

    # 가전 실행 결과 (조명 끄기 완료 → rev 40에 반영)
    result = {
        "schema_version": "0.1", "event_id": _uuid(900), "timestamp": _t(69.6), "revision": 40,
        "command_id": _LIGHT_OFF_CMD, "device_id": "light_room1", "action": "TURN_OFF",
        "status": "COMPLETED", "reason": None, "state": {"power": "OFF"},
    }
    rejected = {
        "schema_version": "0.1", "event_id": _uuid(901), "timestamp": _t(90.2), "revision": 46,
        "command_id": _uuid(902), "device_id": "vacuum", "action": "CLEAN_ROOM",
        "status": "REJECTED", "reason": "BATTERY_LOW", "state": {"status": "DOCKED", "room": None, "battery": 0.12},
    }

    raw = {
        "world_snapshot_boot": (WorldSnapshot, boot),
        "world_snapshot_resting": (WorldSnapshot, resting),
        "world_snapshot_held": (WorldSnapshot, held),
        "world_snapshot_source_stale": (WorldSnapshot, stale),
        "world_snapshot_in_transit": (WorldSnapshot, transit),
        "world_snapshot_unknown_person": (WorldSnapshot, unknown),
        "device_result_completed": (DeviceResultEvent, result),
        "device_result_rejected": (DeviceResultEvent, rejected),
    }
    return {name: model.model_validate(data) for name, (model, data) in raw.items()}


def json_schemas() -> dict[str, dict]:
    return {name: model.model_json_schema(mode="serialization") for name, model in MESSAGE_MODELS.items()}


def _write(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    JSON_DIR.mkdir(exist_ok=True)
    EXAMPLES_DIR.mkdir(exist_ok=True)
    for name, schema in json_schemas().items():
        _write(JSON_DIR / f"{name}.schema.json", schema)
    for name, message in example_messages().items():
        _write(EXAMPLES_DIR / f"{name}.json", message.model_dump(mode="json"))
    print(f"JSON Schema → {JSON_DIR}")
    print(f"예시 메시지 → {EXAMPLES_DIR}")


if __name__ == "__main__":
    main()
