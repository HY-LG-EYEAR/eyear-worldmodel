"""Node → World Model 입력 메시지 (eyear-node schema 0.1, faf518d 기준).

eyear-node/schema/models.py 의 NodeStateMessage와 같은 모양. 별도 저장소라 필요한 부분만 옮겨 둔다.
Node가 필드를 늘려도 World Model이 멈추지 않도록 모르는 키는 무시한다 (Node 쪽 검증은 Node가 함).
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

Confidence = Annotated[float, Field(ge=0.0, le=1.0)]


class _In(BaseModel):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)


class NodePosition(_In):
    x: float
    y: float


class NodePerson(_In):
    track_id: int = Field(ge=0)
    identity: str
    identity_confidence: Confidence
    identity_source: Literal["FACE", "VOICE", "TRACK_CARRIED", "UNKNOWN"]
    posture: Literal["STANDING", "SITTING", "LYING", "WALKING", "UNKNOWN"]
    posture_confidence: Confidence
    motion: Literal["STILL", "SLIGHT", "ACTIVE", "UNKNOWN"]
    activity: Literal["RESTING", "OTHER", "UNKNOWN"]
    activity_confidence: Confidence
    position: NodePosition | None


class NodeOccupancy(_In):
    state: Literal["OCCUPIED", "EMPTY", "UNKNOWN"]
    confidence: Confidence


class NodeAudio(_In):
    context: Literal["SILENT", "SPEECH", "CONVERSATION", "MUSIC", "TV", "LOUD_NOISE", "UNKNOWN"]
    confidence: Confidence


class NodeStateMessage(_In):
    schema_version: Literal["0.1"]
    event_id: UUID
    node_id: str
    room_id: str
    timestamp: AwareDatetime
    seq: int = Field(ge=0)
    event_type: Literal["HEARTBEAT", "STATE_CHANGE"]
    changes: list[dict]
    occupancy: NodeOccupancy
    persons: list[NodePerson]
    audio: NodeAudio
    light: Literal["DARK", "DIM", "BRIGHT", "UNKNOWN"]
