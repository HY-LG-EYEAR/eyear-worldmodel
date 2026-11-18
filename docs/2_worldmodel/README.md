# ② World Model (이효창) : 하는 일

**방마다 따로 오는 Node 메시지 + 기기 상태 + 앱 설정 → 집 전체 상태 한 장(WorldSnapshot 2.0)**

```
 Node(방1) ─┐
 Node(거실) ─┤                         ┌─ 방 5개의 재실·소리·밝기·온도
 Node(방2) ─┼─▶  World Model 엔진  ──▶ ├─ 사람 (집 전체 공통 ID)
 기기 상태  ─┤   (engine.py)            ├─ 기기 상태·할 수 있는 조작
 앱 설정   ─┘                         └─ 프로필·루틴·제한
```

판단(청소할지 말지)은 하지 않는다. **있는 그대로, 모르면 모른다고** 정리만 한다.

## 코드

| 파일 | 역할 |
|---|---|
| [`worldmodel/engine.py`](../../worldmodel/engine.py) | 본체. `ingest_node()`로 받고 `poll()`로 내보냄 |
| [`worldmodel/config.py`](../../worldmodel/config.py) + [`config/home_demo.json`](../../config/home_demo.json) | 방·Node·사람 ID 매핑·TTL |
| [`worldmodel/hub.py`](../../worldmodel/hub.py) | 여러 방 Node 메시지를 방별 줄로 받아 엔진에 하나씩 → [설명](여러_방_동시_처리.md) |
| [`sim/`](../../sim/) | 브라우저 집 시뮬레이터 (저녁 시나리오) |
| [`worldmodel/schema/`](../../worldmodel/schema/) | v0.1 초안 (2.0으로 대체됨, 참고용) |

## 엔진 규칙 8가지

1. **모르면 null/UNKNOWN** — 0이나 다른 사람 ID로 채우지 않는다.
2. **사람 목록이 비어도 빈방이 아니다** — 재실은 Node occupancy만 따른다.
3. **track 번호 ≠ 사람 ID** — `MEMBER_A`→`person_a`, 모르는 사람은 `anon_{node}_e{재시작회차}_t{track}`.
4. **추적이 끊겨도 방이 계속 OCCUPIED면 그 방에 둔다 (HELD)** — 단, 자세 UNKNOWN·좌표 null·근거 stale.
5. **3초 동안 Node 소식이 없으면** 그 방은 UNKNOWN(stale). 새 메시지가 없어도 엔진이 알아서 바꿔 발행.
6. **중복(event_id)·역순(seq)** 메시지는 버린다. seq가 0이면 재시작 → track 연결 초기화.
7. **같은 활동이 3초 이어지면** `confirmed=true`. `stable_for_s`는 세션에서 처음 본 때부터 잰 값.
8. **보내는 주기**: 의미 변화는 즉시, 값만 변하면 최대 1초에 1번, 아무 변화 없어도 30초에 1번. 보낼 때마다 revision +1.

## 관련 문서 (원래 위치 그대로)

- [EYEAR_월드모델_데이터_명세서.md](../../EYEAR_월드모델_데이터_명세서.md) — v0.1 초안 (11/13)

## 테스트

`py -m pytest` — 95개. 계약 인수 테스트 항목 전부 포함.
