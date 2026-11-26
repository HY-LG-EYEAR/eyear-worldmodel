"""집 설정 — 방·Node·사람 ID 매핑·방 영향도·TTL.

TTL과 영향도 수치는 중앙(Orchestrator)과 공유해야 하는 합의값이다. 코드에 박지 않고 이 파일에서 읽는다.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, model_validator

from worldmodel.contract.models import RESERVED_IDENTITIES, ClockMode, RoomLink, RoomType

Seconds = Annotated[float, Field(gt=0)]


class _Cfg(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class RoomCfg(_Cfg):
    room_id: str
    room_type: RoomType


class NodeCfg(_Cfg):
    node_id: str
    room_id: str
    supports_speak: bool


class Ttl(_Cfg):
    node_s: Seconds = 3.0                # Node heartbeat 1초 기준. 이 시간 안이면 current
    device_s: Seconds = 10.0             # 기기 상태 보고 TTL
    measurement_s: Seconds = 120.0       # 온습도·PM2.5 TTL
    activity_confirm_s: Seconds = 3.0    # 같은 활동 라벨이 이만큼 이어지면 confirmed
    person_forget_s: Seconds = 1800.0    # 추적이 끊긴 등록 구성원을 위치 미상으로 남겨 두는 시간
    heartbeat_publish_s: Seconds = 1.0   # 의미 변화가 없을 때 최대 송신 주기
    keepalive_s: Seconds = 30.0          # 아무 변화가 없어도 이 주기로 보냄 (live 120초 창 안)


class HomeConfig(_Cfg):
    comment: str | None = Field(default=None, alias="_comment")
    home_id: str
    clock_mode: ClockMode = ClockMode.LIVE
    rooms: list[RoomCfg] = Field(min_length=1)
    nodes: list[NodeCfg]
    identities: dict[str, str]           # Node identity 문자열 → 집 공통 person_id
    room_influence: dict[str, dict[str, Annotated[float, Field(ge=0, le=1)] | None]]
    room_links: list[RoomLink]
    ttl: Ttl = Ttl()
    # B1 방을 옮긴 사람 이어 붙이기: 구성원이 추적이 끊긴 뒤 이 시간(초) 안에 붙어 있는 방에 얼굴 없이 1명이 새로 잡히면
    # 같은 person_id로 이어 준다 (identity_source TRACK_CARRIED). null이면 끔. 틀리면 다른 사람을 구성원으로 오인한다
    handoff_s: Seconds | None = None

    @model_validator(mode="after")
    def _check(self):
        rooms = {r.room_id for r in self.rooms}
        if len(rooms) != len(self.rooms):
            raise ValueError("room_id 중복")
        node_rooms = [n.room_id for n in self.nodes]
        if len({n.node_id for n in self.nodes}) != len(self.nodes):
            raise ValueError("node_id 중복")
        if len(set(node_rooms)) != len(node_rooms):
            raise ValueError("방 하나에 Node 하나 (여러 Node 융합은 아직 미정)")
        if bad := set(node_rooms) - rooms:
            raise ValueError(f"Node의 방이 rooms에 없음: {sorted(bad)}")
        if bad := set(self.identities) & RESERVED_IDENTITIES:
            raise ValueError(f"예약어는 person_id에 매핑하지 않음: {sorted(bad)}")
        if len(set(self.identities.values())) != len(self.identities):
            raise ValueError("서로 다른 identity가 같은 person_id를 가리킴")
        return self

    def node(self, node_id: str) -> NodeCfg | None:
        return next((n for n in self.nodes if n.node_id == node_id), None)


def load_config(path: str | Path) -> HomeConfig:
    return HomeConfig.model_validate(json.loads(Path(path).read_text(encoding="utf-8")))
