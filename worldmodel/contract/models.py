"""WorldSnapshot 2.0 — World Model → Orchestrator 입력 계약 (2026-11-13 협의안) 의 Pydantic 모델.

원문: eyear-orchestrator/World_Model_to_Orchestrator_Contract_v2_Draft_261113_152348.pdf
- 모든 키 필수. nullable 값도 키는 남기고 null로 보낸다 (기본값을 두지 않음).
- 모든 객체 extra=forbid. 숫자는 유한 실수만.
- 한 객체 안에서 확인할 수 있는 규칙은 여기서, 여러 객체를 오가는 참조·중복 규칙은 semantic.py에서 검사한다.
- Node 메시지(schema 0.1)와 별개 버전이다.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal, Union
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "2.0"

Confidence = Annotated[float, Field(ge=0.0, le=1.0)]
NonEmpty = Annotated[str, Field(min_length=1)]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, use_enum_values=True)


# ---------- enum ----------

class ClockMode(str, Enum):
    LIVE = "live"
    REPLAY = "replay"


class EvidenceSource(str, Enum):
    NODE = "node"
    DEVICE_SENSOR = "device_sensor"
    WORLD_INFERENCE = "world_inference"
    APP = "app"
    SYNTHETIC = "synthetic"
    UNKNOWN = "unknown"


class Freshness(str, Enum):
    CURRENT = "current"          # 합의 TTL 안 (사실이 확정됐다는 뜻은 아님)
    STALE = "stale"              # 과거 근거 보존
    UNAVAILABLE = "unavailable"  # 지금 쓸 근거 없음


class Availability(str, Enum):
    ONLINE = "online"
    STALE = "stale"
    OFFLINE = "offline"
    UNKNOWN = "unknown"


class RoomType(str, Enum):
    BEDROOM = "bedroom"
    LIVING = "living"
    KITCHEN = "kitchen"
    LAUNDRY = "laundry"
    HALLWAY = "hallway"
    OTHER = "other"
    UNKNOWN = "unknown"


class OccupancyState(str, Enum):
    OCCUPIED = "OCCUPIED"
    EMPTY = "EMPTY"
    UNKNOWN = "UNKNOWN"


class AudioContext(str, Enum):
    SILENT = "SILENT"
    SPEECH = "SPEECH"
    CONVERSATION = "CONVERSATION"
    MUSIC = "MUSIC"
    TV = "TV"
    LOUD_NOISE = "LOUD_NOISE"
    UNKNOWN = "UNKNOWN"


class LightLevel(str, Enum):
    DARK = "DARK"
    DIM = "DIM"
    BRIGHT = "BRIGHT"
    UNKNOWN = "UNKNOWN"


class IdentitySource(str, Enum):
    FACE = "FACE"
    VOICE = "VOICE"
    TRACK_CARRIED = "TRACK_CARRIED"
    UNKNOWN = "UNKNOWN"


class Posture(str, Enum):
    STANDING = "STANDING"
    SITTING = "SITTING"
    LYING = "LYING"
    WALKING = "WALKING"
    UNKNOWN = "UNKNOWN"


class Motion(str, Enum):
    STILL = "STILL"
    SLIGHT = "SLIGHT"
    ACTIVE = "ACTIVE"
    UNKNOWN = "UNKNOWN"


class ActivityLabel(str, Enum):
    RESTING = "resting"
    MEETING = "meeting"
    WORKING = "working"
    COOKING = "cooking"
    IDLE = "idle"
    OTHER = "other"
    UNKNOWN = "unknown"


class DeviceKind(str, Enum):
    VACUUM = "vacuum"
    WASHER = "washer"
    AC = "ac"
    LIGHT = "light"
    CURTAIN = "curtain"
    PURIFIER = "purifier"


class Action(str, Enum):
    START_CLEANING = "start_cleaning"
    PAUSE_CLEANING = "pause_cleaning"
    RESUME_CLEANING = "resume_cleaning"
    RETURN_TO_DOCK = "return_to_dock"
    SET_MODE = "set_mode"
    SET_POWER = "set_power"
    SET_TARGET_TEMPERATURE = "set_target_temperature"
    SET_AIRFLOW_TARGET = "set_airflow_target"
    SET_CURTAIN_POSITION = "set_curtain_position"


# 기기 종류별로 광고할 수 있는 동작 (07장 표)
ACTIONS_BY_KIND: dict[str, set[str]] = {
    "vacuum": {"start_cleaning", "pause_cleaning", "resume_cleaning", "return_to_dock", "set_mode"},
    "washer": {"set_mode"},
    "ac": {"set_power", "set_mode", "set_target_temperature", "set_airflow_target"},
    "light": {"set_power"},
    "curtain": {"set_curtain_position"},
    "purifier": {"set_power", "set_mode"},
}

RESERVED_IDENTITIES = {"UNKNOWN", "GUEST"}


# ---------- 공통 ----------

class Evidence(_Model):
    """관측 하나의 근거. current는 TTL 안이라는 뜻일 뿐 confidence나 사실 확정과 다르다."""
    observed_at: AwareDatetime | None
    source: EvidenceSource
    node_ids: list[NonEmpty]
    freshness: Freshness

    @model_validator(mode="after")
    def _check(self):
        if self.freshness != Freshness.UNAVAILABLE and self.observed_at is None:
            raise ValueError("current/stale 근거에는 observed_at이 있어야 함")
        if len(set(self.node_ids)) != len(self.node_ids):
            raise ValueError("node_ids 중복")
        return self


class Measurement(_Model):
    value: float | None
    evidence: Evidence

    @model_validator(mode="after")
    def _check(self):
        if self.value is None and self.evidence.freshness != Freshness.UNAVAILABLE:
            raise ValueError("value가 null이면 freshness=unavailable")
        return self


def _ranged(lo: float, hi: float):
    def check(m: Measurement) -> Measurement:
        if m.value is not None and not (lo <= m.value <= hi):
            raise ValueError(f"값 {m.value}이 범위 {lo}~{hi} 밖")
        return m
    return check


# ---------- nodes ----------

class NodeInfo(_Model):
    node_id: NonEmpty
    room_id: NonEmpty
    schema_version: NonEmpty
    availability: Availability
    last_event_id: UUID | None
    last_seq: Annotated[int, Field(ge=0)] | None
    last_timestamp: AwareDatetime | None
    received_at: AwareDatetime | None
    supports_speak: bool


# ---------- rooms ----------

class Occupancy(_Model):
    state: OccupancyState
    confidence: Confidence | None
    stable_for_s: Annotated[int, Field(ge=0)] | None
    evidence: Evidence


class Audio(_Model):
    context: AudioContext
    confidence: Confidence | None
    evidence: Evidence


class Light(_Model):
    level: LightLevel
    confidence: Confidence | None
    evidence: Evidence


class Room(_Model):
    room_id: NonEmpty
    room_type: RoomType
    occupancy: Occupancy
    audio: Audio
    light: Light
    temperature_c: Measurement
    humidity_pct: Measurement
    pm25_ug_m3: Measurement
    pm25_trend_per_min: Measurement

    @model_validator(mode="after")
    def _ranges(self):
        _ranged(-10, 60)(self.temperature_c)
        _ranged(0, 100)(self.humidity_pct)
        _ranged(0, 1000)(self.pm25_ug_m3)
        return self


class RoomLink(_Model):
    room_a: NonEmpty
    room_b: NonEmpty
    passable: bool | None


# ---------- people ----------

class TrackRef(_Model):
    node_id: NonEmpty
    track_id: Annotated[int, Field(ge=0)]


class Activity(_Model):
    label: ActivityLabel
    confidence: Confidence | None
    confirmed: bool
    stable_for_s: Annotated[int, Field(ge=0)] | None
    evidence: Evidence

    @model_validator(mode="after")
    def _check(self):
        if self.label == ActivityLabel.UNKNOWN and self.confirmed:
            raise ValueError("unknown 활동은 confirmed=false")
        return self


class Position(_Model):
    frame: Literal["room_local"]
    x: float
    y: float
    evidence: Evidence


class Person(_Model):
    person_id: NonEmpty
    profile_id: NonEmpty | None
    room_id: NonEmpty | None
    identity: NonEmpty
    identity_confidence: Confidence | None
    identity_source: IdentitySource
    posture: Posture
    posture_confidence: Confidence | None
    motion: Motion
    track_refs: list[TrackRef]
    activity: Activity
    position: Position | None
    evidence: Evidence

    @model_validator(mode="after")
    def _check(self):
        unknown_id = self.identity == "UNKNOWN"
        if unknown_id != (self.identity_source == IdentitySource.UNKNOWN):
            raise ValueError("identity UNKNOWN ⇔ identity_source UNKNOWN")
        if self.identity in RESERVED_IDENTITIES and self.profile_id is not None:
            raise ValueError("UNKNOWN/GUEST는 profile_id=null")
        if self.position is not None and self.room_id is None:
            raise ValueError("room_local 좌표는 room_id가 있어야 해석 가능")
        return self


# ---------- devices ----------

class VacuumState(_Model):
    status: Literal["idle", "cleaning", "paused", "returning", "docked", "completed", "error", "unknown"]
    mode: NonEmpty | None
    target_room_ids: list[NonEmpty]
    dock_room_id: NonEmpty | None


class WasherState(_Model):
    status: Literal["off", "idle", "running", "paused", "completed", "error", "unknown"]
    mode: NonEmpty | None


class AcState(_Model):
    power: Literal["on", "off", "unknown"]
    mode: NonEmpty | None
    target_c: float | None
    airflow_target_person_id: NonEmpty | None


class LightState(_Model):
    power: Literal["on", "off", "unknown"]


class CurtainState(_Model):
    position_pct: Annotated[float, Field(ge=0, le=100)] | None
    status: Literal["stationary", "opening", "closing", "error", "unknown"]


class PurifierState(_Model):
    power: Literal["on", "off", "unknown"]
    mode: NonEmpty | None


STATE_BY_KIND: dict[str, type[_Model]] = {
    "vacuum": VacuumState, "washer": WasherState, "ac": AcState,
    "light": LightState, "curtain": CurtainState, "purifier": PurifierState,
}
DeviceStateT = Union[VacuumState, WasherState, AcState, LightState, CurtainState, PurifierState]


class TemperatureRange(_Model):
    min_c: float
    max_c: float
    step_c: Annotated[float, Field(gt=0)]

    @model_validator(mode="after")
    def _check(self):
        if self.min_c > self.max_c:
            raise ValueError("min_c ≤ max_c")
        return self


class Capabilities(_Model):
    actions: list[Action]
    modes: list[NonEmpty]
    temperature: TemperatureRange | None
    airflow_target: Literal["person"] | None


class Device(_Model):
    device_id: NonEmpty
    room_id: NonEmpty | None
    kind: DeviceKind
    online: bool | None
    manual_override: bool | None
    state_revision: Annotated[int, Field(ge=0)]
    evidence: Evidence
    state: dict  # kind에 맞는 모델로 아래에서 검증 (union 자동 선택은 필드가 겹쳐 오판할 수 있음)
    capabilities: Capabilities

    @model_validator(mode="after")
    def _check(self):
        st = STATE_BY_KIND[self.kind].model_validate(self.state)
        self.state = st.model_dump(mode="json")
        cap = self.capabilities
        acts = set(cap.actions)
        if len(acts) != len(cap.actions) or len(set(cap.modes)) != len(cap.modes):
            raise ValueError("actions/modes 중복")
        bad = acts - ACTIONS_BY_KIND[self.kind]
        if bad:
            raise ValueError(f"{self.kind}는 {sorted(bad)} 동작을 광고할 수 없음")
        if ("set_target_temperature" in acts) != (cap.temperature is not None):
            raise ValueError("set_target_temperature 지원 ⇔ temperature 범위 객체")
        if ("set_airflow_target" in acts) != (cap.airflow_target is not None):
            raise ValueError("set_airflow_target 지원 ⇔ airflow_target='person'")
        if self.kind != "ac" and cap.temperature is not None:
            raise ValueError("temperature는 AC만")
        mode = self.state.get("mode")
        if mode is not None and mode not in cap.modes:
            raise ValueError(f"현재 mode {mode!r}가 modes에 없음")
        return self


# ---------- 앱 설정 ----------

class Profile(_Model):
    profile_id: NonEmpty
    identity: NonEmpty
    preferred_min_c: Annotated[float, Field(ge=-10, le=60)] | None
    preferred_max_c: Annotated[float, Field(ge=-10, le=60)] | None
    quiet_rest: bool | None
    quiet_meeting: bool | None

    @model_validator(mode="after")
    def _check(self):
        a, b = self.preferred_min_c, self.preferred_max_c
        if (a is None) != (b is None):
            raise ValueError("preferred_min_c/max_c는 둘 다 null이거나 둘 다 수치")
        if a is not None and a > b:
            raise ValueError("preferred_min_c ≤ preferred_max_c")
        return self


class Routine(_Model):
    routine_id: NonEmpty
    occurrence_id: NonEmpty
    device_id: NonEmpty
    room_ids: Annotated[list[NonEmpty], Field(min_length=1)]
    due: bool
    requested_at: AwareDatetime | None
    deadline_at: AwareDatetime | None

    @model_validator(mode="after")
    def _check(self):
        if len(set(self.room_ids)) != len(self.room_ids):
            raise ValueError("room_ids 중복")
        if self.requested_at and self.deadline_at and self.deadline_at < self.requested_at:
            raise ValueError("deadline_at ≥ requested_at")
        return self


class UserRestriction(_Model):
    restriction_id: NonEmpty
    target_type: Literal["room", "device"]
    target_id: NonEmpty
    action: Action | None
    expires_at: AwareDatetime | None
    reason: str  # 설명용 데이터. 실행 코드·지시로 해석하지 않음


# ---------- 봉투 ----------

class WorldSnapshot(_Model):
    schema_version: Literal["2.0"]
    home_id: NonEmpty
    world_session_id: UUID
    world_revision: Annotated[int, Field(ge=0)]
    as_of: AwareDatetime
    clock_mode: ClockMode
    nodes: list[NodeInfo]
    rooms: Annotated[list[Room], Field(min_length=1)]
    people: list[Person]
    devices: list[Device]
    profiles: list[Profile]
    routines: list[Routine]
    room_influence: dict[NonEmpty, dict[NonEmpty, Confidence | None]]
    room_links: list[RoomLink]
    user_restrictions: list[UserRestriction]
