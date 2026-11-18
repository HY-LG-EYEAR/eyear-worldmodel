# EYEAR 집 시뮬레이터 (v0.1)

`index.html`을 더블클릭하면 브라우저에서 바로 열립니다. 서버나 설치는 필요 없습니다.

- `index.html?t=64` : 64초 지점에서 시작합니다.
- `index.html?play` : 열자마자 재생합니다.
- 키보드: Space 재생/일시정지, → 다음 단계, R 처음으로.

## 무엇이 돌아가나

```
가짜 Node (scenario.js) ──eyear/v0/{room}/state──▶ World Model (worldmodel.js) ──eyear/v0/world/snapshot──▶ 임시 중앙 판단 (mock_orchestrator.js)
      ▲   ▲                                              ▲                                                    │
      │   └──── eyear/v0/{room}/speak ─── (질문/대답) ───┼────────────────────────────────────────────────────┤
      │                                                 │                                                    ▼
      └──── 조명 상태 (불 끄면 DARK) ◀── 가상 가전 (devices.js) ◀──eyear/v0/device/{id}/command── (명령)
                                         └─ /state, /result (ACCEPTED·REJECTED → COMPLETED·FAILED)
                                                  └─▶ World Model이 COMMAND_RESULT로 반영 → eyear/v0/world/device_result
```

모든 모듈은 페이지 안의 버스(`core.js`)로만 대화합니다. 이 버스는 MQTT와 같은 토픽 규칙(`+`, `#`)을 씁니다. 화면(`view.js`, `app.js`)도 버스의 구독자일 뿐입니다. 평면도에 보이는 사람 위치는 시나리오 원본이 아니라 **World Model 스냅샷**에서 가져옵니다.

| 파일 | 내용 | 진짜/임시 |
|---|---|---|
| `js/home.js` | 방·가구·가전 위치, 방 좌표 → 집 좌표 변환, 이동 경로 | 좌표계는 명세서 합의안 (집: 왼쪽 아래 원점·y 북쪽, 방: 방의 왼쪽 아래 모서리) |
| `js/core.js` | 시나리오 시계(0.1초 단위), 메시지 버스, 토픽 이름 | |
| `js/words.js` | 화면용 한국어 문구 (재실·자세·활동·presence·변화 종류를 사람이 읽는 말로) | 화면 전용 |
| `js/scenario.js` | 반석님 `summer_evening.yaml`을 옮긴 가짜 Node. heartbeat·seq·changes 규칙은 `fusion/events.py`와 같음 | Node 쪽 사본 |
| `js/devices.js` | 가상 가전 6개 + 방 온도·오염도 | 시뮬레이터 전용 |
| `js/worldmodel.js` | **World Model 1차 구현** — WorldSnapshot 0.1 생성 (seq·세션·STALE, 사람 합치기·presence, rest_episode, changes·revision, 명령 결과) | **효창 담당 — 실제 코드의 설계 초안** |
| `js/mock_orchestrator.js` | 서브에이전트 4개 + 중앙 판단 흉내 | **가짜** (정빈님 자리) |
| `js/view.js`, `js/app.js` | 평면도·패널·조작 | |

## 화면 읽는 법

- **평면도**: 파란 칸 = 사람 있음(OCCUPIED), 빗금 = Node 끊김(STALE → 모름). 사람 위 두 줄은 "누구 · 확인 방식"과 "자세 · 활동 · 경과 시간"입니다. 테두리 모양이 presence입니다 (실선 = SEEN, 이중선 = HELD, 점선 = IN_TRANSIT·LAST_KNOWN).
- **가전 말풍선**: 명령이 끝나면 그 가전 옆에 "무엇을 했고 왜"가 뜹니다 (예: 방1 에어컨 · 끄기 · 방1 비어 있음 → 끔).
- **지금 누가 어디서 무엇을**: 스냅샷 `people[]`를 사람마다 한 줄로 보여 줍니다.
- **무슨 일이 있었고, 그래서 무엇을 했나**: revision마다 World Model 변화 → 에이전트 판단 → 가전 결과를 한 묶음으로 보여 줍니다. 음성 명령·대답처럼 스냅샷 밖에서 온 원인도 같은 목록에 나옵니다.
- **World Model 스냅샷**: 기본 탭은 "이번 변화"(`changes[]`)입니다. 사람·방·가전·전체 탭에서 JSON을 보고, 노란 줄은 직전 revision과 달라진 부분입니다.

## 확인할 수 있는 것

- **t0~t7-2 시나리오**: 질문("A님, 주무실 거면 '네'라고 말씀해 주세요") → "응." → 커튼·조명, "불 켜줘" → 조명, 방1이 비면 청소, 거실 25°C·바람 A 쪽.
- **장애 넣기**: Node 끄기를 누르면 3초 뒤 그 방은 STALE이 되고, 재실은 `UNKNOWN`으로 바뀝니다("비어 있음"이 아니라 "모름"). 이때 청소기는 들어가지 않고, 에어컨은 설정을 유지합니다. 다시 켜거나 재시작하면 seq 0이 오고, World Model이 새 세션으로 처리합니다.
- **대답 바꾸기**: 반석님 실측(Whisper)처럼 문장부호와 낮은 신뢰도가 붙은 대답을 고를 수 있습니다.
  - `"응."` 0.55, `"네."` 0.55, `"응?"` 0.48 → 문장부호를 빼고 긍정으로 해석 (신뢰도 기준 0.2)
  - 작게 `"응."` 0.31 → 마감 0.7초 뒤에 와도 긍정으로 처리
  - `"아니."` 0.79, 무응답 → 아무것도 하지 않음
  - 질문 직후 Node를 끄면, 중앙이 "말하는 시간 + listen_seconds + 2초" 뒤 스스로 포기합니다.
- **위치 추적 놓침**: 재실(`occupancy`)은 OCCUPIED인데 `persons: []`가 오는 경우입니다 (위치 레이더 LD2450이 가만히 누운 사람을 놓침). World Model은 마지막으로 본 사람을 `presence: "HELD"`로 그 방에 둡니다. 방이 EMPTY가 되면 10초 동안 `IN_TRANSIT`(이동 중)으로 두고, 다른 방에서 보이면 그쪽 SEEN으로 이어 붙입니다.

## World Model 사람 상태 (presence)

| 값 | 뜻 | 중앙 판단에서 |
|---|---|---|
| `SEEN` | Node가 지금 보고 있음 | 방에 있음 |
| `HELD` | 재실 레이더는 사람이 있다고 하지만 위치 추적을 놓침 → 마지막 사람이 그대로 있다고 봄 | 방에 있음 |
| `IN_TRANSIT` | 방이 EMPTY가 됨 → 10초 동안 이동 중 (자세·활동 UNKNOWN). 다른 방에 나타나지 않으면 LAST_KNOWN | 방 밖 |
| `LAST_KNOWN` | Node 소식이 끊김(STALE) 또는 이동 후 사라짐 → 마지막으로 본 곳. 익명 사람은 5분 뒤 지움 | 모름 |

`activity.rest_episode`는 Node가 RESTING이 아니다가 RESTING으로 바뀐 것을 볼 때만 1 오릅니다. 중앙은 (person_id, rest_episode)마다 한 번만 "주무실 건가요?"를 묻습니다.

## 실제 시스템으로 바꿀 때

1. **MQTT 연결**: `EY.Bus`를 mqtt.js(WebSocket) 클라이언트로 바꿉니다. `subscribe`·`publish` 모양은 같습니다. Mosquitto에서 WebSocket 리스너를 켜야 합니다.
2. **실물 Node**: 가짜 Node(`FakeNodes`)를 끄고, 반석님 Node가 같은 토픽으로 보내게 합니다.
3. **정빈님 Orchestrator**: `mock_orchestrator.js`를 빼고, `eyear/v0/world/snapshot`을 구독하게 합니다.
4. **World Model**: `worldmodel.js`의 규칙을 Python 서비스로 옮깁니다.

## 아직 합의 안 된 것

- 토픽: `eyear/v0/world/snapshot`, `eyear/v0/device/{id}/command|result|state`, `eyear/v0/orchestrator/trace` (제안)
- 스냅샷 형식: WorldSnapshot `0.1` (`worldmodel/schema`) — 정빈님 확인 필요
- `eyear/v0/world/device_result` 토픽 (명령 결과 + 반영된 revision)
- 청소기 위치를 `state.x_m`, `state.y_m`(집 좌표)로 보내는 것 (가전 state 값은 스칼라만)
- 가전 action 이름 (`TURN_ON`, `TURN_OFF`, `SET_TARGET`, `SET_WIND`, `SET_MODE`, `CLEAN_ROOM`, `RETURN_TO_DOCK`, `OPEN`, `CLOSE`). 스피커 말하기는 가전이 아니라 `eyear/v0/{room}/speak`
- 방별 좌표 원점: 방의 왼쪽 아래 모서리·y 북쪽 (반석님 확인 필요)
- STALE 기준 3초
- `presence: HELD` 규칙: Node가 이어받을지(`TRACK_CARRIED`처럼), World Model이 이어받을지
- 질문 문장 형식과 대답 해석 기준(문장부호 무시, 신뢰도 0.2): 정빈님 쪽 결정

## 발표용 3D 데모 (`demo3d.html`)
같은 시나리오·같은 World Model을 3D로 보여주는 발표용 페이지. `index.html`은 그대로 둠.
- 여는 법: `demo3d.html` 더블클릭 (인터넷 없이 됨. three.js는 `vendor/`에 들어 있음)
- 진행: PPT처럼 단계(t0~t7-2)마다 끊김. Space · → · 자막 클릭(또는 프레젠터 리모컨 PageDown)으로 다음 단계를 재생하고 그 단계 끝에서 멈춤. 한 단계 약 4~8초, 전체 재생 약 80초
- 키: ← 이전 단계 · P 일시정지 · R 처음으로 · V 센서 범위 표시 · S 범위 설정 · C 자동 카메라 · H 화면 정리 · N 거실 Node 끊기 · F 전체 화면
- URL 옵션: `?auto` 끊김 없이 자동 재생(약 70초) · `?seg=10` 단계당 목표 초(기본 7, 길수록 느림) · `?t=55` 그 시점부터 · `?speed=1` 배속 고정 · `?play` 바로 시작 · `?panel` 범위 설정 창 열기 · `?nocov` 범위 숨김 · `?set=room1.cam.range:2` 범위 미리 지정
- 센서 범위(`js/coverage.js`): 카메라·위치 레이더(LD2450)·재실 레이더(LD2410C) 범위를 바닥에 그리고, 범위를 바꾸면 가짜 Node가 보내는 값도 `eyear-node/fusion/fuse.py` 규칙대로 바뀜. 기본값에서는 시나리오 메시지가 그대로임
- 범위 값의 출처: 방1 레이더 거리 3.75m·좌우 ±60°는 실제 Node 설정·규격. 설치 위치·방향, 카메라 거리·화각, 방1 외 Node 값은 가정(실측 후 교체)
- 사람은 시나리오 원본이 아니라 World Model 스냅샷으로 그림 (보임/HELD/이동 중/위치 모름이 투명도·고리로 보임)
