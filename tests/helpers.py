from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "worldmodel" / "contract" / "examples" / "world_snapshot_2_0_example.json"
CONFIG = ROOT / "config" / "home_demo.json"
KST = timezone(timedelta(hours=9))
T0 = datetime(2026, 11, 13, 21, 0, 0, tzinfo=KST)


def at(s: float) -> datetime:
    return T0 + timedelta(seconds=s)


def example() -> dict:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


def person(track_id=1, identity="MEMBER_A", source="FACE", posture="LYING", activity="RESTING",
           position=(2.4, 2.67), **kw) -> dict:
    return {
        "track_id": track_id, "identity": identity,
        "identity_confidence": 0.0 if identity == "UNKNOWN" else 0.93,
        "identity_source": source, "posture": posture,
        "posture_confidence": 0.0 if posture == "UNKNOWN" else 0.9,
        "motion": kw.get("motion", "SLIGHT"), "activity": activity,
        "activity_confidence": 0.0 if activity == "UNKNOWN" else 0.86,
        "position": None if position is None else {"x": position[0], "y": position[1]},
    }


class FakeNode:
    """Node v0.1 메시지 생성기. seq·event_id를 알아서 올린다."""

    def __init__(self, node_id="node_room1", room_id="room1"):
        self.node_id, self.room_id, self.seq = node_id, room_id, 0

    def msg(self, t: float, occupancy="OCCUPIED", conf=0.95, persons=(), audio="SILENT",
            light="BRIGHT", event_type="HEARTBEAT", seq=None) -> dict:
        if seq is None:
            self.seq += 1
            seq = self.seq
        else:
            self.seq = seq
        return {
            "schema_version": "0.1", "event_id": str(uuid.uuid4()),
            "node_id": self.node_id, "room_id": self.room_id,
            "timestamp": at(t).isoformat(), "seq": seq, "event_type": event_type, "changes": [],
            "occupancy": {"state": occupancy, "confidence": conf},
            "persons": list(persons),
            "audio": {"context": audio, "confidence": 0.0 if audio == "UNKNOWN" else 0.8},
            "light": light,
        }
