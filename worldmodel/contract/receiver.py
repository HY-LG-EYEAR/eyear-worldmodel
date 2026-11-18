"""수신측(Orchestrator) 참조 구현 — 계약 10장의 채택 규칙과 07·08장의 조작 가능 여부.

중앙 실제 코드는 송정빈님 쪽에 둔다. 이 파일은 양쪽이 같은 규칙으로 테스트하기 위한 기준이다.
HTTP 없이 receive(payload) → (status, body) 만 흉내 낸다.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from uuid import UUID

from pydantic import ValidationError

from worldmodel.contract.models import WorldSnapshot
from worldmodel.contract.semantic import check

LIVE_WINDOW_S = (-5.0, 120.0)  # now - as_of 허용 범위 (live)


def _digest(s: WorldSnapshot) -> str:
    return hashlib.sha256(json.dumps(s.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()


class SnapshotReceiver:
    def __init__(self):
        self.sessions: dict[str, UUID] = {}                  # home_id → 등록된 세션
        self.latest: dict[str, tuple[int, str]] = {}         # home_id → (revision, digest)
        self.snapshots: dict[str, WorldSnapshot] = {}
        self.work: dict[tuple[str, str], str] = {}           # (occurrence_id, room_id) → 상태 pending|done
        self.decisions = 0                                   # 재판단 횟수 (멱등 확인용)

    def register(self, home_id: str, session_id: UUID | str) -> None:
        """명시적 reset. 임의 UUID가 왔다는 이유만으로 세션을 바꾸지 않는다. 대기 작업도 초기화."""
        self.sessions[home_id] = UUID(str(session_id))
        self.latest.pop(home_id, None)
        self.snapshots.pop(home_id, None)
        self.work.clear()

    def receive(self, payload: dict | str, now: datetime | None = None) -> tuple[int, dict]:
        try:
            s = WorldSnapshot.model_validate_json(payload) if isinstance(payload, str) \
                else WorldSnapshot.model_validate(payload)
        except ValidationError as e:
            return 422, {"accepted": False, "errors": [er["msg"] for er in e.errors()]}
        if errs := check(s):
            return 422, {"accepted": False, "errors": errs}
        if s.clock_mode == "live" and now is not None:
            lag = (now - s.as_of).total_seconds()
            if not (LIVE_WINDOW_S[0] <= lag <= LIVE_WINDOW_S[1]):
                return 422, {"accepted": False, "errors": [f"as_of가 live 신선도 범위 밖 ({lag:.1f}s)"]}

        reg = self.sessions.get(s.home_id)
        if reg is None or reg != s.world_session_id:
            return 409, {"accepted": False, "errors": ["등록되지 않은 세션 — reset/등록 먼저"]}
        ok = {"accepted": True, "home_id": s.home_id, "world_session_id": str(s.world_session_id),
              "world_revision": s.world_revision}
        dg = _digest(s)
        cur = self.latest.get(s.home_id)
        if cur is not None:
            rev, old = cur
            if s.world_revision == rev and dg == old:
                return 202, {**ok, "duplicate": True}  # 멱등 확인. 재판단 안 함
            if s.world_revision <= rev:
                return 409, {"accepted": False, "errors": [f"revision 충돌 (현재 {rev}, 받은 {s.world_revision})"]}

        self.latest[s.home_id] = (s.world_revision, dg)
        self.snapshots[s.home_id] = s
        self.decisions += 1
        for rt in s.routines:
            if rt.due:
                for rid in rt.room_ids:
                    self.work.setdefault((rt.occurrence_id, rid), "pending")  # 같은 회차 반복은 새 작업 아님
        return 202, ok


def can_issue(s: WorldSnapshot, device_id: str, action: str, params: dict | None = None) -> tuple[bool, str]:
    """스냅샷의 capabilities 기준으로 이 조작을 발행할 수 있는지. 광고되지 않은 조작은 못 보낸다."""
    params = params or {}
    dev = next((d for d in s.devices if d.device_id == device_id), None)
    if dev is None:
        return False, "없는 기기"
    if dev.online is not True:
        return False, "기기 online 확인 안 됨"
    if dev.evidence.freshness != "current":
        return False, "기기 상태가 current가 아님"
    cap = dev.capabilities
    if action not in cap.actions:
        return False, f"{dev.kind}가 {action}을 광고하지 않음"
    if action == "set_mode" and params.get("mode") not in cap.modes:
        return False, f"지원하지 않는 모드 {params.get('mode')!r}"
    if action == "set_target_temperature":
        t, rng = params.get("target_c"), cap.temperature
        if t is None or not (rng.min_c <= t <= rng.max_c) or abs((t - rng.min_c) / rng.step_c % 1) > 1e-6:
            return False, f"온도 {t}가 범위·간격 밖"
    if action == "set_airflow_target":
        pid = params.get("person_id")
        p = next((x for x in s.people if x.person_id == pid), None)
        if p is None or p.room_id != dev.room_id or p.position is None:
            return False, "대상 사람이 이 방에 위치와 함께 관측되지 않음"
    if action in ("start_cleaning",):
        rooms = params.get("room_ids") or []
        known = {r.room_id for r in s.rooms}
        if not rooms or any(r not in known for r in rooms):
            return False, "청소 방 지정 오류"
    return True, "ok"
