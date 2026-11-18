"""WorldSnapshot 모델 (원본). JSON Schema는 worldmodel/schema/export.py로 이 파일에서 생성한다.

메시지 종류
- WorldSnapshot     : World Model → Orchestrator. 집 전체 상태 (eyear/v0/world/snapshot)
- DeviceResultEvent : World Model → Orchestrator. 가전 실행 결과를 home revision과 함께 전달 (eyear/v0/world/device_result)

규칙
- revision은 의미 있는 변화가 있을 때만 1 오른다. 변화가 없어도 1초마다 같은 revision으로 다시 보낸다.
- 같은 revision이면 snapshot_id·timestamp 말고는 내용이 같다. Orchestrator는 revision으로 중복을 거른다.
- 모르는 값은 UNKNOWN(enum) 또는 null(숫자·시각). 0으로 채우지 않는다.
"""

from datetime import datetime
from typing import Annotated, Literal, Union
from uuid import UUID, uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from worldmodel.schema.enums import (
    RESERVED_IDENTITIES,
    Activity,
    AudioContext,
    CommandStatus,
    DeviceType,
    IdentitySource,
    Light,
    Motion,
    OccupancyState,
    Posture,
    Presence,
    RoutineKind,
    SourceStatus,
    Weekday,
    WorldChangeType,
)

SCHEMA_VERSION = "0.1"
SOURCE_STALE_SECONDS = 3.0   # Node 메시지가 이보다 오래되면 STALE
IN_TRANSIT_SECONDS = 10.0    # 떠난 방이 EMPTY가 된 뒤 이 시간 동안 IN_TRANSIT

Confidence = Annotated[float, Field(ge=0.0, le=1.0, description="신뢰도 0~1")]
Identifier = Annotated[str, Field(pattern=r"^[a-z0-9_]+$", description="소문자, 숫자, 밑줄")]
IdentityName = Annotated[
    str,
    Field(pattern=r"^[A-Z][A-Z0-9_]*$", description="가족 이름(영문 대문자) 또는 예약어 UNKNOWN / GUEST"),
]
PersonId = Annotated[
    str,
    Field(
        pattern=r"^([A-Z][A-Z0-9_]*|anon_[a-z0-9_]+)$",
        description="신원을 알면 가족 이름(MEMBER_A), 모르면 anon_<room>_<세션>_<track> (예: anon_room1_s2_t3)",
    ),
]
StateValue = Union[str, float, int, bool, None]


def now() -> datetime:
    return datetime.now().astimezone()


class _Model(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        use_enum_values=True,
        json_schema_serialization_defaults_required=True,
    )


class Vec2(_Model):
    """미터. 방 좌표: 그 방 왼쪽 아래 모서리가 원점, x 오른쪽, y 위쪽 (eyear-node 2026-11-12 확정안).
    집 좌표: 평면도 왼쪽 아래 모서리가 원점, 방향은 같음. 집 좌표 = 방 좌표 + 방 origin_m."""

    x: float
    y: float


# ---------- 방 ----------

class SourceInfo(_Model):
    node_id: Identifier | None = Field(description="이 방에 배정된 Node. 없으면 null")
    status: SourceStatus
    session_id: str | None = Field(
        description="World Model이 붙인 Node 세션 (예: node_room1#2). Node가 재시작하면 새 세션. 받은 적 없으면 null",
    )
    last_seq: int | None = Field(ge=0, description="받아들인 마지막 seq")
    last_observed_at: AwareDatetime | None = Field(description="받아들인 마지막 Node 메시지의 timestamp")


class OccupancyView(_Model):
    state: OccupancyState
    confidence: Confidence = Field(description="EMPTY 0.6 = 방 밖(벽 너머) 사람을 레이더가 잡는 중일 수 있음")
    since: AwareDatetime | None = Field(description="이 state가 시작된 시각. 처음부터 모르면 null")


class LightView(_Model):
    state: Light
    since: AwareDatetime | None


class AudioView(_Model):
    context: AudioContext
    confidence: Confidence
    since: AwareDatetime | None


class Measurement(_Model):
    """Node가 아닌 곳(가전·환경 센서)에서 오는 숫자 값."""

    value: float | None = Field(description="측정하지 않았으면 null (0으로 채우지 않음)")
    observed_at: AwareDatetime | None
    source: str | None = Field(description="값을 준 곳 (예: ac_room1, sim)")


class RoomState(_Model):
    room_id: Identifier
    name: str
    origin_m: Vec2 = Field(description="집 좌표에서 이 방 왼쪽 아래 모서리")
    size_m: Vec2 = Field(description="x = 가로(m), y = 세로(m)")
    adjacent: list[Identifier] = Field(description="문으로 바로 이어진 방 (복도 제외)")
    source: SourceInfo
    occupancy: OccupancyView
    light: LightView
    audio: AudioView
    temperature_c: Measurement
    dirt_level: Measurement = Field(description="0(깨끗)~1(더러움)")
    person_ids: list[PersonId] = Field(description="presence가 SEEN·HELD이고 room_id가 이 방인 사람")

    @model_validator(mode="after")
    def _unknown_when_not_fresh(self):
        if self.source.status != SourceStatus.FRESH:
            if (self.occupancy.state, self.light.state, self.audio.context) != ("UNKNOWN", "UNKNOWN", "UNKNOWN"):
                raise ValueError(f"{self.room_id}: Node가 {self.source.status}이면 occupancy·light·audio는 UNKNOWN")
        if self.person_ids and self.occupancy.state == OccupancyState.EMPTY:
            raise ValueError(f"{self.room_id}: person_ids가 있는데 EMPTY")
        return self


# ---------- 사람 ----------

class TrackRef(_Model):
    """지금 이 사람을 추적 중인 Node track. SEEN일 때만 있음."""

    node_id: Identifier
    session_id: str
    track_id: int = Field(ge=0)


class IdentityCandidate(_Model):
    """신원 UNKNOWN인 사람이 누구일 수 있는지 (가설). identity를 덮어쓰지 않는다."""

    identity: IdentityName
    reason: str = Field(description="예: room1에서 IN_TRANSIT였고 4초 뒤 living에 나타남")


class PostureView(_Model):
    state: Posture
    confidence: Confidence
    since: AwareDatetime | None


class ActivityView(_Model):
    state: Activity
    confidence: Confidence
    since: AwareDatetime | None = Field(description="이 state가 시작된 시각 → 휴식 지속 시간 = timestamp - since")
    rest_episode: int = Field(
        ge=0,
        description="이 사람의 RESTING 횟수. OTHER→RESTING이 관측될 때만 1 오름 (Node 끊김·HELD 뒤 복귀는 같은 회차)",
    )


class PositionView(_Model):
    room: Vec2 = Field(description="room_id 방 기준 좌표")
    home: Vec2 = Field(description="집 기준 좌표")
    zone: str | None = Field(description="가구 영역 (bed, sofa 등). 밖이면 null")


class PersonState(_Model):
    person_id: PersonId
    identity: IdentityName
    identity_confidence: Confidence
    identity_source: IdentitySource
    candidates: list[IdentityCandidate] = Field(default_factory=list, description="identity가 UNKNOWN일 때만")
    presence: Presence
    presence_since: AwareDatetime
    room_id: Identifier | None = Field(description="SEEN·HELD: 지금 방. IN_TRANSIT·LAST_KNOWN: 마지막으로 있던 방")
    track: TrackRef | None
    posture: PostureView
    motion: Motion
    activity: ActivityView
    position: PositionView | None = Field(description="마지막으로 안 위치. Node가 position을 안 주면 null")
    last_seen_at: AwareDatetime = Field(description="Node persons에 마지막으로 나온 시각")

    @model_validator(mode="after")
    def _consistent(self):
        if (self.presence == Presence.SEEN) != (self.track is not None):
            raise ValueError(f"{self.person_id}: SEEN이면 track 필요, 아니면 track은 null")
        if self.candidates and self.identity != "UNKNOWN":
            raise ValueError(f"{self.person_id}: candidates는 identity UNKNOWN일 때만")
        if self.identity in RESERVED_IDENTITIES and not self.person_id.startswith("anon_"):
            raise ValueError(f"{self.person_id}: 신원을 모르면 person_id는 anon_로 시작")
        if self.presence in (Presence.IN_TRANSIT, Presence.LAST_KNOWN):
            if self.posture.state != "UNKNOWN" or self.activity.state != "UNKNOWN" or self.motion != "UNKNOWN":
                raise ValueError(f"{self.person_id}: {self.presence}이면 posture·motion·activity는 UNKNOWN")
        return self


# ---------- 가전 ----------

class CommandResult(_Model):
    command_id: UUID
    action: str
    status: CommandStatus
    reason: str | None = Field(description="REJECTED·FAILED일 때 이유")
    timestamp: AwareDatetime
    revision: int = Field(ge=0, description="이 결과가 반영된 home revision")


class DeviceState(_Model):
    device_id: Identifier
    type: DeviceType
    name: str
    room_id: Identifier | None = Field(description="놓인 방. 청소기처럼 움직이면 null (state.room 참고)")
    online: bool
    actions: list[str] = Field(description="받을 수 있는 명령 (capability)")
    state: dict[str, StateValue] = Field(description="가전 종류별 키는 명세서 7절")
    observed_at: AwareDatetime | None = Field(description="가전이 마지막으로 상태를 알린 시각")
    last_result: CommandResult | None


# ---------- 선호·루틴 ----------

class MemberPreference(_Model):
    identity: IdentityName
    display_name: str | None
    preferred_temp_c: float | None = Field(ge=16, le=32)
    updated_at: AwareDatetime | None = Field(description="앱에서 마지막으로 바꾼 시각. 기본값이면 null")


class Routine(_Model):
    routine_id: Identifier
    identity: IdentityName
    kind: RoutineKind
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$", description="HH:MM (집 시간대)")
    days: list[Weekday]


# ---------- 변화 ----------

class WorldChange(_Model):
    type: WorldChangeType
    room_id: Identifier | None = None
    person_id: PersonId | None = None
    device_id: Identifier | None = None
    before: str | None = Field(default=None, description="바뀌기 전 값 (사람이 읽을 수 있게)")
    after: str | None = Field(default=None, description="바뀐 뒤 값")


# ---------- 메시지 ----------

class WorldSnapshot(_Model):
    """집 전체 상태. 메시지 하나만 받아도 판단에 필요한 사실을 모두 알 수 있다. 판단(누가 자는지 등)은 넣지 않는다."""

    schema_version: Literal["0.1"] = SCHEMA_VERSION
    snapshot_id: UUID = Field(default_factory=uuid4)
    home_id: Identifier
    revision: int = Field(ge=0, description="의미 있는 변화마다 1 오름. 에이전트 제안·명령의 input-state version")
    timestamp: AwareDatetime = Field(default_factory=now, description="발행 시각")
    changes: list[WorldChange] = Field(description="revision-1 → revision 사이 변화. 같은 revision 재발행에도 그대로")
    rooms: list[RoomState]
    people: list[PersonState]
    devices: list[DeviceState]
    preferences: list[MemberPreference]
    routines: list[Routine]

    @model_validator(mode="after")
    def _references(self):
        rooms = {r.room_id: r for r in self.rooms}
        people = {p.person_id: p for p in self.people}
        devices = {d.device_id for d in self.devices}
        for name, ids in (("rooms", [r.room_id for r in self.rooms]),
                          ("people", [p.person_id for p in self.people]),
                          ("devices", [d.device_id for d in self.devices])):
            if len(ids) != len(set(ids)):
                raise ValueError(f"{name}의 id가 중복됨")
        for r in self.rooms:
            for a in r.adjacent:
                if a not in rooms:
                    raise ValueError(f"{r.room_id}.adjacent에 없는 방 {a}")
            expected = sorted(p.person_id for p in self.people
                              if p.room_id == r.room_id and p.presence in (Presence.SEEN, Presence.HELD))
            if sorted(r.person_ids) != expected:
                raise ValueError(f"{r.room_id}.person_ids가 people과 맞지 않음: {r.person_ids} != {expected}")
        for p in self.people:
            if p.room_id is not None and p.room_id not in rooms:
                raise ValueError(f"{p.person_id}.room_id {p.room_id}가 rooms에 없음")
            if p.presence == Presence.SEEN and rooms[p.room_id].source.status != SourceStatus.FRESH:
                raise ValueError(f"{p.person_id}: Node가 FRESH가 아닌 방에서 SEEN일 수 없음")
            if p.presence == Presence.HELD and rooms[p.room_id].occupancy.state != OccupancyState.OCCUPIED:
                raise ValueError(f"{p.person_id}: HELD는 방이 OCCUPIED일 때만")
        for d in self.devices:
            if d.room_id is not None and d.room_id not in rooms:
                raise ValueError(f"{d.device_id}.room_id {d.room_id}가 rooms에 없음")
            if d.last_result is not None and d.last_result.revision > self.revision:
                raise ValueError(f"{d.device_id}.last_result.revision이 현재 revision보다 큼")
        for c in self.changes:
            if c.room_id is not None and c.room_id not in rooms:
                raise ValueError(f"changes: 없는 방 {c.room_id}")
            if c.device_id is not None and c.device_id not in devices:
                raise ValueError(f"changes: 없는 가전 {c.device_id}")
            if (c.person_id is not None and c.type != WorldChangeType.PERSON_REMOVED
                    and c.person_id not in people):
                raise ValueError(f"changes: 없는 사람 {c.person_id}")
        if self.revision == 0 and self.changes:
            raise ValueError("revision 0(시작 상태)에는 changes가 없음")
        return self


class DeviceResultEvent(_Model):
    """가전 실행 결과. 가전 어댑터 → World Model이 받아 home revision을 붙여 Orchestrator로 보낸다."""

    schema_version: Literal["0.1"] = SCHEMA_VERSION
    event_id: UUID = Field(default_factory=uuid4)
    timestamp: AwareDatetime = Field(default_factory=now)
    revision: int = Field(ge=0, description="이 결과의 state가 반영된 home revision (그 snapshot도 같이 나감)")
    command_id: UUID
    device_id: Identifier
    action: str
    status: CommandStatus
    reason: str | None
    state: dict[str, StateValue] = Field(description="결과 직후 가전 상태 (관측값)")

    @model_validator(mode="after")
    def _reason(self):
        if self.status in (CommandStatus.REJECTED, CommandStatus.FAILED) and not self.reason:
            raise ValueError("REJECTED·FAILED에는 reason이 필요")
        return self
