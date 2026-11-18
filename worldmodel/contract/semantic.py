"""WorldSnapshot 2.0 의미 검증 — JSON Schema로 표현되지 않는 참조·중복 규칙.

check(snapshot) -> list[str]  : 문제 목록. 비어 있으면 통과.
수신 서버(Orchestrator)와 송신 쪽(World Model) 모두 같은 함수를 쓰면 판단이 어긋나지 않는다.
"""

from __future__ import annotations

from worldmodel.contract.models import RESERVED_IDENTITIES, Evidence, WorldSnapshot


def _dups(ids: list[str]) -> set[str]:
    seen, out = set(), set()
    for i in ids:
        (out if i in seen else seen).add(i)
    return out


def check(s: WorldSnapshot) -> list[str]:
    err: list[str] = []
    rooms = {r.room_id for r in s.rooms}
    nodes = {n.node_id for n in s.nodes}
    people = {p.person_id for p in s.people}
    profiles = {p.profile_id: p for p in s.profiles}
    devices = {d.device_id: d for d in s.devices}

    for name, ids in [
        ("rooms.room_id", [r.room_id for r in s.rooms]),
        ("nodes.node_id", [n.node_id for n in s.nodes]),
        ("people.person_id", [p.person_id for p in s.people]),
        ("devices.device_id", [d.device_id for d in s.devices]),
        ("profiles.profile_id", [p.profile_id for p in s.profiles]),
        ("profiles.identity", [p.identity for p in s.profiles]),
        ("routines.occurrence_id", [r.occurrence_id for r in s.routines]),
        ("user_restrictions.restriction_id", [r.restriction_id for r in s.user_restrictions]),
    ]:
        if d := _dups(ids):
            err.append(f"{name} 중복: {sorted(d)}")

    def ev(where: str, e: Evidence):
        for nid in e.node_ids:
            if nid not in nodes:
                err.append(f"{where}.evidence.node_ids: 없는 Node {nid}")

    def room_ref(where: str, rid):
        if rid is not None and rid not in rooms:
            err.append(f"{where}: 없는 방 {rid}")

    for n in s.nodes:
        room_ref(f"nodes[{n.node_id}].room_id", n.room_id)

    for r in s.rooms:
        for f in ("occupancy", "audio", "light", "temperature_c", "humidity_pct", "pm25_ug_m3", "pm25_trend_per_min"):
            ev(f"rooms[{r.room_id}].{f}", getattr(r, f).evidence)

    track_owner: dict[tuple[str, int], str] = {}
    for p in s.people:
        w = f"people[{p.person_id}]"
        room_ref(f"{w}.room_id", p.room_id)
        if p.profile_id is not None:
            prof = profiles.get(p.profile_id)
            if prof is None:
                err.append(f"{w}.profile_id: 없는 프로필 {p.profile_id}")
            elif prof.identity != p.identity:
                err.append(f"{w}: profile {p.profile_id}의 identity {prof.identity} ≠ {p.identity}")
        for t in p.track_refs:
            if t.node_id not in nodes:
                err.append(f"{w}.track_refs: 없는 Node {t.node_id}")
            key = (t.node_id, t.track_id)
            if key in track_owner and track_owner[key] != p.person_id:
                err.append(f"track {key}이 {track_owner[key]}와 {p.person_id}에 동시에 연결됨")
            track_owner[key] = p.person_id
        ev(w, p.evidence)
        ev(f"{w}.activity", p.activity.evidence)
        if p.position:
            ev(f"{w}.position", p.position.evidence)

    for d in s.devices:
        w = f"devices[{d.device_id}]"
        room_ref(f"{w}.room_id", d.room_id)
        ev(w, d.evidence)
        st = d.state
        if d.kind == "vacuum":
            for rid in st["target_room_ids"]:
                room_ref(f"{w}.state.target_room_ids", rid)
            room_ref(f"{w}.state.dock_room_id", st["dock_room_id"])
        if d.kind == "ac":
            pid = st["airflow_target_person_id"]
            if pid is not None and pid not in people:
                err.append(f"{w}.state.airflow_target_person_id: 현재 people에 없는 {pid}")
            t, rng = st["target_c"], d.capabilities.temperature
            if t is not None and rng is not None:
                n = (t - rng.min_c) / rng.step_c
                if not (rng.min_c <= t <= rng.max_c) or abs(n - round(n)) > 1e-6:
                    err.append(f"{w}.state.target_c {t}이 기기 범위·간격 밖")

    for rt in s.routines:
        w = f"routines[{rt.occurrence_id}]"
        dev = devices.get(rt.device_id)
        if dev is None:
            err.append(f"{w}.device_id: 없는 기기 {rt.device_id}")
        elif dev.kind != "vacuum":
            err.append(f"{w}.device_id: 청소 루틴은 vacuum만 ({rt.device_id}={dev.kind})")
        for rid in rt.room_ids:
            room_ref(f"{w}.room_ids", rid)

    for src, targets in s.room_influence.items():
        room_ref("room_influence 발생 방", src)
        for dst in targets:
            room_ref(f"room_influence[{src}] 대상 방", dst)
            if dst == src:
                err.append(f"room_influence[{src}][{dst}]: 같은 방은 넣지 않음 (판단 시 1)")

    pairs = set()
    for l in s.room_links:
        room_ref("room_links.room_a", l.room_a)
        room_ref("room_links.room_b", l.room_b)
        key = frozenset((l.room_a, l.room_b))
        if l.room_a == l.room_b:
            err.append(f"room_links: 자기 자신 연결 {l.room_a}")
        if key in pairs:
            err.append(f"room_links: 같은 쌍 중복 {sorted(key)}")
        pairs.add(key)

    for u in s.user_restrictions:
        w = f"user_restrictions[{u.restriction_id}]"
        if u.target_type == "room":
            room_ref(f"{w}.target_id", u.target_id)
        elif u.target_id not in devices:
            err.append(f"{w}.target_id: 없는 기기 {u.target_id}")

    for p in s.profiles:
        if p.identity in RESERVED_IDENTITIES:
            err.append(f"profiles[{p.profile_id}]: 예약어 {p.identity}에 프로필을 연결할 수 없음")
    return err
