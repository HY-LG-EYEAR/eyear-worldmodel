# ① 반석(Node) → World Model : 받는 것

방마다 있는 Node(카메라·레이더·마이크)가 **1초마다** 자기 방 상태를 보낸다.

- MQTT 토픽: `eyear/v0/{room_id}/state`
- 형식: Node schema **0.1** (eyear-node `schema/models.py` @ `faf518d`)
- 받는 코드: [`worldmodel/node_input.py`](../../worldmodel/node_input.py)

## 한 메시지에 들어 있는 것

| 칸 | 예시 | 뜻 |
|---|---|---|
| `node_id` / `room_id` | `node_room1` / `room1` | 누가, 어느 방 |
| `event_id` / `seq` / `timestamp` | UUID / 42 / 시각 | 중복·순서 판단용 |
| `occupancy` | `OCCUPIED` 0.95 | 방에 사람 있음/없음/모름 + 신뢰도 |
| `persons[]` | track 1, `MEMBER_A`, `LYING`, `RESTING`, (x,y) | 보이는 사람마다 한 줄 |
| `audio` | `SILENT` | 소리 상황 |
| `light` | `DARK` | 밝기 (신뢰도 없음) |

## 11월 12~13일 기준 알아둘 점

- **레이더 융합**: LD2410C 혼자서는 입장을 확정하지 않는다. 카메라·LD2450과 함께 판단.
- **카메라만 있을 때**: 밝은 방에서 못 보면 `EMPTY(0.5)`, 어두운 방에서 못 보면 `UNKNOWN`.
- **어두우면 자세 `UNKNOWN`**: 레이더만으로 LYING을 유지하지 않는다.
- **좌표**: 방 왼쪽 아래가 원점, x 오른쪽·y 위쪽(미터). 설치 보정 전에는 `null`.
- **track_id는 Node 안에서만 의미**: 두 방에 track 1이 동시에 있을 수 있다.
- **boot_id 없음**: 재시작을 seq로 추정한다 (seq가 0으로 돌아오면 재시작).

## 관련 문서 (원래 위치 그대로)

- [EYEAR_레이더_데이터_명세서.md](../../EYEAR_레이더_데이터_명세서.md) — 레이더 두 모듈에서 받을 수 있는 원시 데이터 (11/04)
