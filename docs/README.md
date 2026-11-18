# docs — World Model이 중간에서 보는 세 갈래

파일은 원래 자리에 그대로 두고, 이 폴더에서 **World Model(이효창) 입장에서** 양쪽을 설명한다.

```
 ① 반석 · Node           ② 이효창 · World Model            ③ 정빈 · Orchestrator
 방마다 1초에 1번   ──▶  방 메시지 + 기기 + 앱 설정   ──▶   집 전체 1장을 받아
 "이 방에서 본 것"        → 집 전체 "아는 것/모르는 것"        청소·에어컨·질문 판단
```

| 폴더 | 읽을 사람 | 내용 |
|---|---|---|
| [1_from_node/](1_from_node/README.md) | 반석님 · 나 | Node 메시지를 내가 어떻게 받는지 |
| [2_worldmodel/](2_worldmodel/README.md) | 모두 | 엔진이 지키는 규칙 8가지 |
| [3_to_orchestrator/](3_to_orchestrator/README.md) | 정빈님 | 넘기는 파일, 받는 쪽 규칙, [합의 요청](3_to_orchestrator/합의_요청_2026-11-14.md) |
| [worldmodel_explainer.html](worldmodel_explainer.html) | 모두 | 저녁 장면 7단계로 보는 시각 설명 (브라우저로 열기) |
| [고민_목록.md](고민_목록.md) | 나 | 외부와 조정할 것 · 내가 더 고민할 것 · 회의 안건 |

## 실제 파일 위치 (옮기지 않음)

| 무엇 | 위치 |
|---|---|
| Node 입력 형식 | `worldmodel/node_input.py` |
| 엔진 · 설정 | `worldmodel/engine.py`, `worldmodel/config.py`, `config/home_demo.json` |
| 여러 Node 동시 수신 | `worldmodel/hub.py` |
| 2.0 계약 코드 · Schema · 예제 | `worldmodel/contract/` |
| v0.1 초안 (참고용) | `worldmodel/schema/` |
| 명세서 | 루트의 `EYEAR_레이더_데이터_명세서.md`, `EYEAR_월드모델_데이터_명세서.md` |
| 계약 2.0 PDF 원본 | `../eyear-orchestrator/` |
