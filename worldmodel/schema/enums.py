"""WorldSnapshot에서 쓰는 enum.

- Node에서 그대로 받는 값(재실·자세·활동 등)은 eyear-node schema/enums.py (schema 0.1)와 같은 값을 쓴다.
  Node 쪽이 바뀌면 여기도 같이 바꾼다.
- 관측 enum에는 모두 UNKNOWN이 있다. 근거가 없으면 지어내지 않고 UNKNOWN (R-12, R-13).
"""

from enum import Enum


# ---------- Node에서 그대로 받는 값 (eyear-node 0.1과 같음) ----------

class OccupancyState(str, Enum):
    OCCUPIED = "OCCUPIED"
    EMPTY = "EMPTY"
    UNKNOWN = "UNKNOWN"  # Node 없음·끊김·센서 고장. 빈 방이 아님


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


class Activity(str, Enum):
    RESTING = "RESTING"
    OTHER = "OTHER"
    UNKNOWN = "UNKNOWN"


class AudioContext(str, Enum):
    SILENT = "SILENT"
    SPEECH = "SPEECH"
    CONVERSATION = "CONVERSATION"
    MUSIC = "MUSIC"
    TV = "TV"
    LOUD_NOISE = "LOUD_NOISE"
    UNKNOWN = "UNKNOWN"


class Light(str, Enum):
    DARK = "DARK"
    DIM = "DIM"
    BRIGHT = "BRIGHT"
    UNKNOWN = "UNKNOWN"


IDENTITY_UNKNOWN = "UNKNOWN"
IDENTITY_GUEST = "GUEST"
RESERVED_IDENTITIES = {IDENTITY_UNKNOWN, IDENTITY_GUEST}


# ---------- World Model이 만드는 값 ----------

class SourceStatus(str, Enum):
    """방에 배정된 Node의 상태."""
    FRESH = "FRESH"      # 마지막 메시지가 3초 이내
    STALE = "STALE"      # 3초 넘게 메시지 없음 → 방 관측값 UNKNOWN
    NO_DATA = "NO_DATA"  # Node가 없거나 아직 한 번도 받지 못함


class Presence(str, Enum):
    """사람 기록이 얼마나 최신인지."""
    SEEN = "SEEN"              # 최신 Node 메시지의 persons에 있음
    HELD = "HELD"              # Node가 놓쳤지만 그 방은 아직 OCCUPIED → 그 방에 있다고 유지
    IN_TRANSIT = "IN_TRANSIT"  # 떠난 방이 EMPTY가 된 뒤 10초 이내, 다른 방에서 아직 안 보임
    LAST_KNOWN = "LAST_KNOWN"  # 그보다 오래됨, 또는 그 방 Node가 STALE. 마지막 위치만 앎


class DeviceType(str, Enum):
    LIGHT = "LIGHT"
    CURTAIN = "CURTAIN"
    AC = "AC"
    WASHER = "WASHER"
    ROBOT_VACUUM = "ROBOT_VACUUM"


class CommandStatus(str, Enum):
    ACCEPTED = "ACCEPTED"
    REJECTED = "REJECTED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class RoutineKind(str, Enum):
    SLEEP = "SLEEP"
    WAKE_UP = "WAKE_UP"
    LEAVE = "LEAVE"
    RETURN = "RETURN"
    OTHER = "OTHER"


class Weekday(str, Enum):
    MON = "MON"
    TUE = "TUE"
    WED = "WED"
    THU = "THU"
    FRI = "FRI"
    SAT = "SAT"
    SUN = "SUN"


class WorldChangeType(str, Enum):
    """revision을 올린 변화. Orchestrator는 이것만 보고 에이전트를 깨울지 정할 수 있다."""
    # 사람 (person_id 있음)
    PERSON_ENTERED = "PERSON_ENTERED"      # room_id 방에 처음 보임 (다른 방에서 옮겨 온 경우 포함)
    PERSON_LEFT = "PERSON_LEFT"            # room_id 방을 떠남 (IN_TRANSIT 시작)
    PRESENCE_CHANGED = "PRESENCE_CHANGED"  # SEEN/HELD/IN_TRANSIT/LAST_KNOWN 사이 변화
    IDENTITY_CHANGED = "IDENTITY_CHANGED"
    POSTURE_CHANGED = "POSTURE_CHANGED"
    ACTIVITY_CHANGED = "ACTIVITY_CHANGED"  # RESTING 시작이면 rest_episode가 1 오름
    PERSON_REMOVED = "PERSON_REMOVED"      # 기록 삭제 (오래된 익명 기록 등). person_id는 이미 people에 없음
    # 방 (room_id 있음)
    OCCUPANCY_CHANGED = "OCCUPANCY_CHANGED"
    LIGHT_CHANGED = "LIGHT_CHANGED"
    AUDIO_CHANGED = "AUDIO_CHANGED"
    SOURCE_CHANGED = "SOURCE_CHANGED"            # FRESH↔STALE, Node 재시작(새 세션)
    ENVIRONMENT_CHANGED = "ENVIRONMENT_CHANGED"  # 온도 0.5°C 이상, 먼지 0.1 이상 변화
    # 가전 (device_id 있음)
    DEVICE_STATE_CHANGED = "DEVICE_STATE_CHANGED"
    COMMAND_RESULT = "COMMAND_RESULT"
    # 집
    PREFERENCE_CHANGED = "PREFERENCE_CHANGED"
