# World Model 데이터 명세서 (v0.1 초안)

| 항목 | 내용 |
|---|---|
| 범위 | Node → World Model 입력, World Model이 합치는 규칙, World Model → Orchestrator 출력(WorldSnapshot) |
| 근거 | eyear-node `docs/schema_v0.md`·`schema/models.py` @ faf518d (schema 0.1), 반석 2026-11-12 메시지, LG-EYEAR `docs/main.tex` R-12·R-13·인터페이스 표 |
| 코드 | `worldmodel/schema/models.py` (원본) → `python -m worldmodel.schema.export`로 JSON Schema·예시 생성 |
| 작성 | 이효창 · 2026-11-13 |
| 표기 | `[Node]` eyear-node 문서·코드에 명시 · `[실측]` 실제 Node(방1)에서 확인된 동작 · `[제안]` 이 문서에서 처음 정하는 것 · `⬜ 합의 필요` |

---

## 목차
1. 한눈에 보기
2. 입력: Node 방 상태 메시지
3. 좌표 기준
4. 입력 필드를 어디에 쓰는가
5. 합치는 규칙 (4단계)
6. 출력: WorldSnapshot
7. 가전 상태와 실행 결과
8. Orchestrator에서 읽는 법 (에이전트별)
9. 파일과 예시
10. 합의·확인 필요 항목

---

## 1. 한눈에 보기

```
 Node (방마다)                     World Model (효창)                     Orchestrator (정빈)
 eyear/v0/{room}/state ─────────▶ ① 출처: 검증·세션·seq·STALE       eyear/v0/world/snapshot
   1초 HEARTBEAT                   ② 방: 재실·밝기·소리 (UNKNOWN 유지) ─────▶ 에이전트 4개가 같은 revision을 읽음
   + 변할 때 STATE_CHANGE          ③ 사람: 방 사이 이어 붙이기           eyear/v0/world/device_result
 가전 어댑터                       ④ 집: 가전·선호·루틴·방 관계        ─────▶ 명령 결과 + 반영된 revision
   eyear/v0/device/{id}/state ──▶
   eyear/v0/device/{id}/result ─▶   revision: 의미 있는 변화마다 +1
 앱 (예원)                          발행: 변화 즉시 + 1초마다 재발행
   선호 변경 ─────────────────▶
```

| 토픽 | 방향 | 내용 | 상태 |
|---|---|---|---|
| `eyear/v0/{room_id}/state` | Node → WM | 방 상태 (NodeStateMessage) | `[Node]` 합의됨 |
| `eyear/v0/{room_id}/voice/reply`·`voice/command` | Node → Orchestrator | 음성 대답·명령 | `[Node]` World Model은 거치지 않음 |
| `eyear/v0/{room_id}/speak` | Orchestrator → Node | 말하기 | `[Node]` |
| `eyear/v0/world/snapshot` | WM → Orchestrator | WorldSnapshot | `[제안]` ⬜ 합의 필요 |
| `eyear/v0/world/device_result` | WM → Orchestrator | DeviceResultEvent | `[제안]` ⬜ 합의 필요 |
| `eyear/v0/device/{device_id}/command` | Orchestrator → 가전 | 명령 | `[제안]` ⬜ 합의 필요 |
| `eyear/v0/device/{device_id}/result`·`/state` | 가전 → WM | 실행 결과·현재 상태 | `[제안]` ⬜ 합의 필요 |

> 핵심 약속 세 가지
> 1. **모르는 것은 UNKNOWN / null.** 메시지가 끊긴 방은 "빈 방"이 아니라 "모름" (R-12).
> 2. **판단은 넣지 않는다.** "A가 자는 중" 같은 결론은 Orchestrator·에이전트가 내린다. World Model은 관측 사실과 지속 시간만 준다.
> 3. **revision 하나 = 집 상태 하나.** 에이전트 제안과 명령은 자기가 읽은 revision을 적는다.

---

## 2. 입력: Node 방 상태 메시지

### 2.1 메시지 구조 `[Node]`
토픽 `eyear/v0/{room_id}/state`, JSON, 매 메시지가 **방 전체 스냅샷**이다 (하나만 받아도 방 상태를 앎).

| 필드 | 형식 | 의미 |
|---|---|---|
| `schema_version` | `"0.1"` | 다르면 거부 |
| `event_id` | UUID | 메시지 고유 ID |
| `node_id` / `room_id` | 소문자 ID | 방 ID: `room1` `room2` `living` `laundry` |
| `timestamp` | ISO 8601 (시간대 포함) | Node에서 관측한 시각 |
| `seq` | 정수 ≥ 0 | Node별 일련번호. 1씩 증가, 재시작하면 0부터 |
| `event_type` | `HEARTBEAT` / `STATE_CHANGE` | HEARTBEAT는 1초마다, 무언가 바뀌면 즉시 STATE_CHANGE |
| `changes[]` | `{type, track_id}` | 바뀐 것. HEARTBEAT면 빈 리스트 |
| `occupancy` | `{state, confidence}` | `OCCUPIED` / `EMPTY` / `UNKNOWN` |
| `persons[]` | 아래 표 | 위치·신원을 추적 중인 사람. 나간 사람은 빠짐 |
| `audio` | `{context, confidence}` | `SILENT` `SPEECH` `CONVERSATION` `MUSIC` `TV` `LOUD_NOISE` `UNKNOWN` |
| `light` | enum | `DARK` `DIM` `BRIGHT` `UNKNOWN` |

`changes[].type`: 사람 단위 `PERSON_ENTERED` `PERSON_LEFT` `IDENTITY_CHANGED` `POSTURE_CHANGED` `ACTIVITY_CHANGED` (track_id 있음), 방 단위 `OCCUPANCY_CHANGED` `AUDIO_CHANGED` `LIGHT_CHANGED` (track_id null).

**persons[] 한 사람**
| 필드 | 값 | 비고 |
|---|---|---|
| `track_id` | 정수 | Node 안에서만 유효. 방을 나가면 재사용될 수 있음 |
| `identity` | `MEMBER_A`~ / `UNKNOWN` / `GUEST` | 가족 이름은 `config/family.yaml` |
| `identity_confidence` | 0~1 | |
| `identity_source` | `FACE` `VOICE` `TRACK_CARRIED` `UNKNOWN` | identity가 UNKNOWN ⇔ source UNKNOWN |
| `posture` / `posture_confidence` | `STANDING` `SITTING` `LYING` `WALKING` `UNKNOWN` | |
| `motion` | `STILL` `SLIGHT` `ACTIVE` `UNKNOWN` | 레이더 기준 |
| `activity` / `activity_confidence` | `RESTING` `OTHER` `UNKNOWN` | 잠과 휴식은 구분하지 않음 |
| `position` | `{x, y}` 또는 null | 방 좌표(m). 3절 |

**필드 사이 규칙** `[Node]`: HEARTBEAT에는 changes 없음 · STATE_CHANGE에는 1개 이상 · persons가 있으면 EMPTY일 수 없음 · `OCCUPIED` + `persons: []` = 사람은 있는데 위치·신원을 모름 · `UNKNOWN`은 빈 방이 아님.

### 2.2 실제 Node(방1) 동작 `[실측]` (반석, 2026-11-12)
| 상황 | Node가 보내는 것 | World Model이 알아야 할 점 |
|---|---|---|
| 걸어 나감 | 사람이 persons에서 빠짐(PERSON_LEFT) → **약 6~7초 뒤** EMPTY | PERSON_LEFT만으로는 나갔는지 위치만 놓쳤는지 모름. EMPTY가 와야 확정 |
| 들어옴 | 레이더가 먼저 잡고 놓친 뒤 카메라가 잡음 → 3초 안에 ENTERED → LEFT → ENTERED | 짧은 LEFT로 사람을 지우면 안 됨 |
| `EMPTY` 신뢰도 0.6 | 재실 레이더(LD2410C)가 벽 너머 사람을 잡는 중 | "방 밖, 바로 옆에 사람이 있을 수 있음". 비어 있다는 판단은 유효 |
| 소등 | identity_source `TRACK_CARRIED`, posture `UNKNOWN`(0.0), RESTING은 크게 움직이기 전까지 유지 | 어두워져도 휴식 중이라는 사실은 유지됨 |
| RESTING 시작 | LYING + 이미지 판단이 5초 일치해야 RESTING. OTHER로 돌아가는 데 2초 | **새로 들어온 RESTING = 새 휴식 회차** (rest_episode +1) |
| 소리 | 3초 다수결 | AUDIO_CHANGED는 최대 3초 늦음 |
| position | 설치 위치를 재기 전까지 **null** | 위치·zone 없이도 동작해야 함 (zone은 null) |
| 음성 대답 | 구두점 포함, 신뢰도 0.3~0.6 | Orchestrator가 해석 (World Model과 무관) |
| 다른 방 | 방1만 실제 Node. 나머지는 가짜 송신기 | 실제 시연에서는 방2·거실·세탁실이 `NO_DATA`일 수 있음 |

---

## 3. 좌표 기준 `[Node]` 2026-11-12 확정안

- 평면도를 위에서 본 2D, 단위 m.
- **방 좌표**: 원점 = 그 방의 왼쪽 아래 모서리, x = 오른쪽, y = 위쪽. Node `position`은 이 좌표.
- **집 좌표**: 원점 = 평면도 전체의 왼쪽 아래 모서리, 방향 동일. `집 좌표 = 방 좌표 + 방 origin_m`.

| 방 | 크기 (가로×세로) | origin_m (집 좌표) `[제안]` | 주요 지점 (방 좌표) |
|---|---|---|---|
| room1 (방1) | 4.2 × 3.4 | (9.10, 9.15) | 침대 (2.40, 2.67) → 집 (11.50, 11.82) |
| room2 (방2) | 6.2 × 4.95 | (0.00, 9.10) | |
| living (거실) | 7.1 × 9.1 | (0.00, 0.00) | 소파 위쪽 자리 (0.60, 4.90), 아래쪽 자리 (0.60, 2.40) |
| laundry (세탁실) | 4.2 × 1.5 | (9.10, 12.55) | |

> origin_m은 시뮬레이터 평면도(전체 13.3 × 14.05 m)에서 계산한 값이다. ⬜ 집 원점을 어디로 둘지 반석·3D 시뮬레이션과 합의 필요.

---

## 4. 입력 필드를 어디에 쓰는가

| Node 필드 | World Model에서 | 주로 쓰는 에이전트 | 한계 |
|---|---|---|---|
| `occupancy` | 방 `occupancy` + `since` (지속 시간) | 전부 (빈 방 조명·냉방 끄기, 사람 있는 방 청소 금지) | EMPTY 확정이 6~7초 늦음 |
| `persons[].identity*` | 사람 `person_id`·`identity`, 방 사이 이어 붙이기 | 온도(개인 선호 온도), 수면 질문 대상 | 어두우면 TRACK_CARRIED, 처음부터 어두우면 UNKNOWN |
| `persons[].posture` | `posture` + `since` | 표시·보조 근거 | 어두우면 UNKNOWN |
| `persons[].activity` | `activity` + `since` + `rest_episode` | 소음(세탁기 저소음), 조명, 온도, 청소 미루기 | 잠·휴식 구분 없음. 확률이 아님 (confidence는 참고값) |
| `persons[].motion` | 그대로 | 휴식 해제 판단 보조 | |
| `persons[].position` | 방·집 좌표 + `zone` (bed, sofa) | 에어컨 바람 방향, 표시 | 지금은 null |
| `audio` | 방 `audio` + `since` | 소음 (TV·대화 중이면 질문 미루기 등) | 3초 늦음 |
| `light` | 방 `light` + `since` | 조명 | 조명 명령 직후 값은 가전 상태와 잠깐 어긋날 수 있음 |
| `seq`·`timestamp` | 출처 세션·순서·STALE 판단 | (Orchestrator는 `source.status`만 보면 됨) | |
| `changes[]` | 참고만 함. 변화는 World Model이 직접 비교해서 다시 만든다 | | 메시지가 유실되면 change도 유실 |

Node가 주지 않아서 **다른 곳에서 받는 값**: 온도(에어컨·온도 센서 어댑터), 먼지(청소기·시뮬레이터), 가전 상태(가전 어댑터), 선호·루틴(앱).

---

## 5. 합치는 규칙 (4단계)

### ① 출처: Node 메시지 받아들이기
| 규칙 | 내용 |
|---|---|
| 검증 | Node 스키마 0.1로 검증. 실패하면 버리고 기록. `room_id`가 그 Node에 배정된 방과 다르면 거부 |
| 세션 | 처음 받은 메시지에서 세션 시작 (`node_room1#1`). `seq`가 **줄었는데 timestamp는 더 최신**이면 Node 재시작 → 새 세션 (`#2`). seq 0만 보고 판단하지 않음 (0번이 유실돼도 복구) |
| 순서 | 같은 세션에서 `seq ≤ 마지막 seq`면 중복·역순 → 무시. 빠진 seq는 GAP으로 기록만 (메시지가 전체 스냅샷이라 복구 불필요) |
| 시간 | timestamp가 마지막보다 과거면 무시 (오래된 값이 새 값을 덮지 않음, R-12) |
| STALE | 마지막 메시지 후 **3초** 넘게 없으면 STALE (HEARTBEAT 1초 × 3). 다시 오면 FRESH |
| NO_DATA | Node가 배정되지 않았거나 한 번도 받지 못함 |

> ⬜ 반석님께 제안: Node 메시지에 `session_id`(부팅 시 UUID)를 넣으면 재시작 판단이 확실해진다.

### ② 방: 재실·밝기·소리
- Node가 이미 방 안에서 센서를 합쳤으므로 **다시 합치지 않는다**. FRESH면 Node 값을 그대로 쓴다.
- STALE·NO_DATA면 `occupancy`·`light`·`audio`를 모두 `UNKNOWN`(신뢰도 0)으로 바꾼다. null이 아니라 enum UNKNOWN.
- 값이 바뀐 시각을 `since`로 둔다 → "빈 방이 된 지 5분", "어두워진 지 30초"를 Orchestrator가 바로 계산.
- 온도·먼지는 가전·환경 어댑터 값. 측정이 없으면 `value: null`.

### ③ 사람: 방 사이 이어 붙이기
**person_id**: 신원을 알면 가족 이름(`MEMBER_A`), 모르면 `anon_<room>_<세션>_<track>` (예: `anon_living_s1_t2`).

**presence 상태**
```
           Node persons에 나타남
   ┌──────────────────────────────────────┐
   ▼                                      │
 SEEN ──persons에서 빠짐, 방은 OCCUPIED──▶ HELD
   │                                      │
   │ persons에서 빠짐 + 방 EMPTY           │ 방이 EMPTY가 됨
   ▼                                      ▼
 IN_TRANSIT ◀─────────────────────────────┘
   │ 10초 동안 다른 방에서 안 보임
   ▼
 LAST_KNOWN ◀── (어느 상태든) 그 방 Node가 STALE
```

| presence | 뜻 | posture·activity | room_id | track |
|---|---|---|---|---|
| `SEEN` | 최신 Node 메시지에 있음 | Node 값 | 지금 방 | 있음 |
| `HELD` | Node가 놓쳤지만 방은 OCCUPIED (위치만 잃음, 또는 나가는 중 6~7초) | 마지막 관측값 유지 | 지금 방 | null |
| `IN_TRANSIT` | 떠난 방이 EMPTY가 된 뒤 10초 이내 | UNKNOWN | 떠난 방 | null |
| `LAST_KNOWN` | 그보다 오래됨, 또는 Node STALE | UNKNOWN | 마지막 방 | null |

| 규칙 | 내용 |
|---|---|
| 같은 사람이 두 방에 | 가족 이름이 같으면 한 사람. 가장 최근 SEEN인 방을 쓴다. 다른 방 기록은 PERSON_LEFT |
| 짧은 깜빡임 | HELD 상태에서 같은 방에 같은 신원(또는 같은 track)이 다시 나타나면 같은 기록으로 SEEN 복귀 (PERSON_ENTERED를 새로 만들지 않음) |
| 익명 사람 | 신원 UNKNOWN은 `identity`를 덮어쓰지 않는다. 직전에 IN_TRANSIT이던 가족이 있으면 `candidates`에 **가설**로만 적음 (R-13: 확실하지 않은 것을 확실하게 만들지 않음) |
| 익명 기록 정리 | LAST_KNOWN이 된 지 5분 지난 익명 기록은 삭제 (PERSON_REMOVED). 가족 기록은 지우지 않음 |
| 휴식 회차 | `rest_episode`는 Node에서 **OTHER/UNKNOWN(관측됨) → RESTING**이 올 때만 +1. HELD·STALE을 거쳐 RESTING으로 돌아오는 건 같은 회차 |
| `since` | posture·activity·presence 값이 바뀐 시각. 휴식 지속 시간 = `timestamp - activity.since` |

### ④ 집: 사실만 모으기
가전 상태(`device/{id}/state`), 실행 결과(`device/{id}/result`), 선호(앱), 루틴, 방 연결 관계, 온도·먼지. 판단(수면 여부, 청소 필요 여부)은 넣지 않는다.

### revision과 발행
| 규칙 | 내용 |
|---|---|
| revision +1 | 아래 표의 변화가 하나라도 있을 때. 신뢰도만 조금 바뀐 것, HEARTBEAT 수신, seq 증가는 **올리지 않음** |
| 발행 시점 | revision이 바뀌면 즉시 + 변화 없어도 1초마다 같은 revision 재발행 (Orchestrator가 World Model 살아 있음을 앎) |
| changes | revision-1 → revision 사이 변화 목록. 재발행에도 그대로 실음 (QoS 0으로 하나 놓쳐도 다음 1초에 다시 받음) |
| 같은 revision | 판단에 쓰는 상태(사람·presence·자세·활동·재실·빛·소리·Node 상태·가전 상태)는 같음. 단 신뢰도·경과 시간·age_s·온도·먼지(기준 미만)·배터리·청소기 위치·남은 시간 같은 연속 값은 재발행 때 바뀔 수 있음 |
| 시간이 지나서 생기는 변화 | STALE 전환, IN_TRANSIT → LAST_KNOWN은 메시지 없이도 World Model이 시계로 판단해 revision을 올림 |

**revision을 올리는 변화 (`changes[].type`)**
| type | 대상 | before → after 예 |
|---|---|---|
| `PERSON_ENTERED` / `PERSON_LEFT` | person, room | — |
| `PRESENCE_CHANGED` | person | `SEEN` → `HELD` |
| `IDENTITY_CHANGED` | person | `FACE` → `TRACK_CARRIED` |
| `POSTURE_CHANGED` / `ACTIVITY_CHANGED` | person | `OTHER` → `RESTING` |
| `PERSON_REMOVED` | person (이미 people에 없음) | — |
| `OCCUPANCY_CHANGED` / `LIGHT_CHANGED` / `AUDIO_CHANGED` | room | `OCCUPIED` → `EMPTY` |
| `SOURCE_CHANGED` | room | `FRESH` → `STALE`, 새 세션 |
| `ENVIRONMENT_CHANGED` | room | 온도 0.5°C 이상, 먼지 0.1 이상 변화 |
| `DEVICE_STATE_CHANGED` / `COMMAND_RESULT` | device | `RUNNING` → `DONE` |
| `PREFERENCE_CHANGED` | — | 앱에서 선호 변경 |

---

## 6. 출력: WorldSnapshot `[제안]`

토픽 `eyear/v0/world/snapshot`, JSON, QoS 0, retain 권장 (Orchestrator가 새로 켜져도 바로 최신 상태를 받음). ⬜ 합의 필요

### 6.1 최상위
| 필드 | 형식 | 의미 |
|---|---|---|
| `schema_version` | `"0.1"` | |
| `snapshot_id` | UUID | 발행마다 새로 |
| `home_id` | ID | `home` |
| `revision` | 정수 | 집 상태 버전. 에이전트 제안·명령의 input-state version |
| `timestamp` | ISO 8601 | 발행 시각 (지속 시간 계산 기준) |
| `changes[]` | WorldChange | 이번 revision을 만든 변화 (5절 표) |
| `rooms[]` | RoomState | 방 4개 항상 모두 포함 |
| `people[]` | PersonState | 기억하는 사람 전부 (LAST_KNOWN 포함) |
| `devices[]` | DeviceState | 가전 전부 |
| `preferences[]` | MemberPreference | 가족별 선호 |
| `routines[]` | Routine | 생활 루틴 |

### 6.2 rooms[]
| 필드 | 형식 | 의미 |
|---|---|---|
| `room_id` / `name` | | `room1` / `방1` |
| `origin_m` / `size_m` | `{x, y}` | 집 좌표의 왼쪽 아래 모서리 / 가로·세로 |
| `adjacent` | 방 ID 목록 | 문으로 바로 이어진 방 |
| `source` | `{node_id, status, session_id, last_seq, last_observed_at}` | status: `FRESH` `STALE` `NO_DATA` |
| `occupancy` | `{state, confidence, since}` | FRESH가 아니면 UNKNOWN |
| `light` | `{state, since}` | |
| `audio` | `{context, confidence, since}` | |
| `temperature_c` / `dirt_level` | `{value, observed_at, source}` | 측정 없으면 value null. dirt는 0~1 |
| `person_ids` | 목록 | 이 방에 SEEN·HELD인 사람 |

### 6.3 people[]
| 필드 | 형식 | 의미 |
|---|---|---|
| `person_id` | `MEMBER_A` / `anon_…` | |
| `identity` / `identity_confidence` / `identity_source` | Node와 같음 | |
| `candidates[]` | `{identity, reason}` | identity UNKNOWN일 때 누구일 수 있는지 (가설) |
| `presence` / `presence_since` | 5절 ③ | |
| `room_id` | 방 ID 또는 null | |
| `track` | `{node_id, session_id, track_id}` 또는 null | SEEN일 때만 |
| `posture` | `{state, confidence, since}` | |
| `motion` | enum | |
| `activity` | `{state, confidence, since, rest_episode}` | |
| `position` | `{room:{x,y}, home:{x,y}, zone}` 또는 null | |
| `last_seen_at` | 시각 | Node persons에 마지막으로 나온 시각 |

### 6.4 devices[] / preferences[] / routines[]
| 필드 | 의미 |
|---|---|
| `device_id` `type` `name` `room_id` `online` | 기본 정보. type: `LIGHT` `CURTAIN` `AC` `WASHER` `ROBOT_VACUUM` |
| `actions` | 받을 수 있는 명령 (capability) |
| `state` | 가전이 알려 온 현재 상태 (7절). **명령을 보냈다고 바뀌지 않음** — 가전이 알려야 바뀜 |
| `observed_at` | 상태를 마지막으로 받은 시각 |
| `last_result` | `{command_id, action, status, reason, timestamp, revision}` |
| preferences | `{identity, display_name, preferred_temp_c, updated_at}` |
| routines | `{routine_id, identity, kind, time "HH:MM", days}` · kind: `SLEEP` `WAKE_UP` `LEAVE` `RETURN` `OTHER` |

### 6.5 JSON Schema로 표현되지 않는 규칙 (모델에서 검증)
- Node가 FRESH가 아닌 방: occupancy·light·audio 모두 UNKNOWN.
- `person_ids`가 있는 방은 EMPTY일 수 없고, `person_ids` = 그 방의 SEEN·HELD 사람.
- SEEN ⇔ track 있음. SEEN은 FRESH인 방에서만, HELD는 OCCUPIED인 방에서만.
- IN_TRANSIT·LAST_KNOWN이면 posture·motion·activity는 UNKNOWN.
- candidates는 identity UNKNOWN일 때만. 신원을 모르면 person_id는 `anon_`으로 시작.
- 모든 room_id·device_id·person_id 참조가 존재. `last_result.revision ≤ revision`.

---

## 7. 가전 상태와 실행 결과 `[제안]` ⬜ 합의 필요

### 7.1 가전별 state 키
| type | actions | state 키 |
|---|---|---|
| LIGHT | `TURN_ON` `TURN_OFF` | `power`: ON/OFF |
| CURTAIN | `OPEN` `CLOSE` | `position`: OPEN/CLOSED/MOVING, `moving_to`, `progress` 0~1 |
| AC | `TURN_ON` `TURN_OFF` `SET_TARGET` `SET_WIND` | `power`, `target_c`, `wind_to` (person_id 또는 null) |
| WASHER | `START` `PAUSE` `SET_MODE` | `power`: OFF/RUNNING/DONE, `mode`: NORMAL/LOW_NOISE, `remaining_s`, `noise_db` |
| ROBOT_VACUUM | `CLEAN_ROOM` `RETURN_TO_DOCK` `PAUSE` | `status`: DOCKED/TO_ROOM/CLEANING/RETURNING, `room`, `battery` 0~1 |

### 7.2 실행 결과 흐름 (R-19, main.tex 인터페이스 표)
```
Orchestrator ─command(command_id, revision)─▶ 가전 ─result─▶ World Model ─┬─▶ snapshot (revision+1, last_result, state)
                                                                          └─▶ device_result (같은 revision)
```
`DeviceResultEvent` (`eyear/v0/world/device_result`): `event_id`, `timestamp`, `revision`, `command_id`, `device_id`, `action`, `status` (`ACCEPTED` `REJECTED` `COMPLETED` `FAILED`), `reason` (REJECTED·FAILED면 필수), `state`.
Orchestrator는 `command_id`로 자기 명령과 맞추고, 이후 판단은 `revision` 이상의 snapshot으로 한다.

---

## 8. Orchestrator에서 읽는 법 (에이전트별)

| 에이전트 | 읽는 필드 | 주의 |
|---|---|---|
| 공통 | `revision`, `changes`, `rooms[].source.status` | revision이 같으면 LLM을 다시 부르지 않아도 됨. `changes`로 어떤 에이전트를 깨울지 결정 |
| 소음 | 사람 `activity`(RESTING)·`room_id`, 방 `audio`, `washer.state` | RESTING이 LAST_KNOWN으로 UNKNOWN이 되면 "휴식 끝"이 아니라 "모름" → 저소음 유지 등 보수적으로 |
| 청소 | 방 `occupancy`·`since`, `dirt_level`, `vacuum.state` | `UNKNOWN` 방은 비었다고 보고 청소하면 안 됨 (R-12). EMPTY 0.6은 비어 있음으로 봐도 됨 |
| 온도 | 사람 `identity`·`room_id`·`position.zone`, `preferences`, 방 `temperature_c` | identity UNKNOWN이면 선호를 고르지 않음. candidates는 참고만 |
| 조명 | 방 `light`·`occupancy`, 사람 `activity`·`rest_episode` | 수면 질문은 `(person_id, rest_episode)`당 한 번 |
| 디스패치 직전 | `timestamp`, `source.last_observed_at` | snapshot이 오래됐으면(예: 3초) 명령 보류 (main.tex 알고리즘) |

---

## 9. 파일과 예시

| 파일 | 내용 |
|---|---|
| `worldmodel/schema/enums.py` | enum (Node 값은 eyear-node 0.1과 동일) |
| `worldmodel/schema/models.py` | WorldSnapshot·DeviceResultEvent 모델과 6.5 규칙 |
| `worldmodel/schema/export.py` | JSON Schema·예시 생성 |
| `worldmodel/schema/json/*.schema.json` | 정빈님에게 전달할 형식 정의 |
| `worldmodel/schema/examples/*.json` | 아래 예시 |

| 예시 | 상황 |
|---|---|
| `world_snapshot_boot` | 시작 직후. 아무 Node도 받지 못함 → 모든 방 NO_DATA·UNKNOWN (rev 0) |
| `world_snapshot_resting` | 소등 후 A가 침대에서 휴식 (TRACK_CARRIED, posture UNKNOWN, rest_episode 1). 거실에 B, 세탁기 동작 중 |
| `world_snapshot_held` | Node가 A 위치를 놓쳤지만 방1 OCCUPIED → A HELD |
| `world_snapshot_source_stale` | 방1 Node 3초 무응답 → 방1 UNKNOWN, A LAST_KNOWN |
| `world_snapshot_in_transit` | A가 나가고 방1 EMPTY(0.6) → A IN_TRANSIT |
| `world_snapshot_unknown_person` | 어두운 거실에 신원 모를 사람 → candidates에 A (identity는 UNKNOWN 유지) |
| `device_result_completed` / `_rejected` | 조명 끄기 완료 / 청소기 배터리 부족으로 거부 |

생성: `py -3.13 -m worldmodel.schema.export` (pydantic 2.x 필요).

---

## 10. 합의·확인 필요 항목

| # | 항목 | 누구와 | 제안 |
|---|---|---|---|
| 1 | snapshot·device_result 토픽 이름, retain 여부 | 정빈 | `eyear/v0/world/snapshot` retain, `eyear/v0/world/device_result` |
| 2 | 가전 command/result/state 토픽과 state 키 (7절) | 정빈 | 시뮬레이터 구현 기준 |
| 3 | Node 메시지에 `session_id` 추가 | 반석 | 부팅 시 UUID. 없어도 seq·timestamp로 판단은 가능 |
| 4 | 집 좌표 원점 (평면도 왼쪽 아래)과 방 origin_m | 반석·3D 시뮬레이션 | 3절 표 |
| 5 | STALE 3초, IN_TRANSIT 10초, 익명 기록 5분 | 실측 후 조정 | `models.py` 상수 |
| 6 | 선호 메시지 형식 (앱 → World Model) | 예원 | `preferred_temp_c`부터 |
| 7 | revision을 올리는 온도·먼지 변화 기준 | 정빈 | 0.5°C, 0.1 |
| 8 | snapshot을 매초 재발행할 때 Orchestrator가 감당 가능한지 (약 10KB/초) | 정빈 | 부족하면 변화 시에만 + 5초 heartbeat |
