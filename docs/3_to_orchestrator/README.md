# ③ World Model → 정빈(Orchestrator) : 보내는 것

**WorldSnapshot 2.0** — 집 전체 상태 한 장. 협의안: [World_Model_to_Orchestrator_Contract_v2_Draft_261113_152348.pdf](../../../eyear-orchestrator/World_Model_to_Orchestrator_Contract_v2_Draft_261113_152348.pdf) (원본은 eyear-orchestrator 폴더)

## 정빈님께 드릴 것 (전부 `worldmodel/contract/`)

| 파일 | 쓰임 |
|---|---|
| [`json/WorldSnapshot_2_0.schema.json`](../../worldmodel/contract/json/WorldSnapshot_2_0.schema.json) | 문서 별첨 Schema (구조·enum 검사) |
| [`examples/world_snapshot_2_0_example.json`](../../worldmodel/contract/examples/world_snapshot_2_0_example.json) | 문서 별첨 예제 (t2 부근, 사람 2·방 5·기기 6) |
| [`models.py`](../../worldmodel/contract/models.py) | 같은 계약의 Pydantic 모델 — 파이썬이면 그대로 import |
| [`semantic.py`](../../worldmodel/contract/semantic.py) | Schema로 못 잡는 검사 (없는 방 참조, ID 중복, 온도 간격…) |
| [`receiver.py`](../../worldmodel/contract/receiver.py) | 수신측 참조 구현: 202/409/422, 세션 등록, `can_issue()` |

## 받는 쪽 규칙 (계약 10장, receiver.py에 구현)

| 상황 | 응답 |
|---|---|
| 새 revision | **202** 채택 |
| 같은 revision + 같은 내용 | **202** (재판단 안 함) |
| 같은 revision + 다른 내용 / 이전 revision | **409** |
| 등록 안 된 세션 | **409** → reset 등록 먼저 |
| 형식·참조 오류, live에서 as_of가 −5~120초 밖 | **422** |

## 합의 요청

[합의_요청_2026-11-14.md](합의_요청_2026-11-14.md)
