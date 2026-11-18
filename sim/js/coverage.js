// 발표용 데모의 센서 범위: 카메라 · 위치 레이더(LD2450) · 재실 레이더(LD2410C).
// 가짜 Node가 보내기 직전의 방 상태를 범위에 맞게 고침 (scenario.js는 그대로 두고 인스턴스의 effective만 감쌈).
// 판단 규칙은 eyear-node fusion/fuse.py를 따름:
//   재실 시작  카메라가 봄, 또는 위치 레이더 + 재실 레이더
//   재실 유지  카메라 또는 재실 레이더
//   빈 방      둘 다 없음, 또는 움직이던 사람이 카메라·위치 레이더에서 5초 사라짐 (걸어 나감)
//   사람 정보  신원·자세는 카메라, 위치는 위치 레이더. 카메라가 못 보면 신원은 추적으로 잇고 자세는 UNKNOWN
// 단, 카메라·위치 레이더 둘 다 놓친 사람은 시나리오 t6-2처럼 persons에서 뺌 (World Model에서 HELD로 보임)
// 기본값에서는 모든 사람이 범위 안이라 시나리오 메시지가 한 글자도 바뀌지 않음.
window.EY = window.EY || {};

(function () {
  const H = EY.HOME;
  const EXIT_SECONDS = 5, MOVING_BEFORE_SECONDS = 3, CARRIED_FACTOR = 0.8;
  // 방별 기본 도달 거리. room1만 실물 Node 설정값(3.75m, ±60°), 나머지 방은 방 전체를 본다고 가정한 가상값
  const REACH = { room1: null, room2: 7.5, living: 9.5, laundry: 4.5 };
  const round3 = (v) => Math.round(v * 1000) / 1000;

  // 방향: 0° = 동(+x), 90° = 북(평면도 위쪽), 반시계 (eyear-node config/radar.yaml의 facing_deg와 같음)
  const facingToCenter = (room) => {
    const n = H.rooms[room].nodeAt, c = EY.roomCenter(room);
    return Math.round((Math.atan2(n[1] - c[1], c[0] - n[0]) * 180 / Math.PI + 360) % 360);
  };
  const defaults = () => {
    const out = {};
    Object.keys(H.rooms).forEach((room) => {
      const reach = REACH[room];
      out[room] = {
        facing: facingToCenter(room),
        cam: { range: reach || 5, fov: 70 },
        pos: { range: reach || 3.75, half: 60 },
        pres: { range: reach || 3.75 },
      };
    });
    return out;
  };
  const inRange = (origin, pt, range) => Math.hypot(pt[0] - origin[0], pt[1] - origin[1]) <= range + 1e-9;
  const inSector = (origin, facing, pt, range, half) => {
    if (!inRange(origin, pt, range)) return false;
    const a = Math.atan2(origin[1] - pt[1], pt[0] - origin[0]) * 180 / Math.PI;
    const d = Math.abs(((a - facing + 540) % 360) - 180);
    return d <= half + 1e-9;
  };
  const detect = (room, c, pt) => {
    const o = H.rooms[room].nodeAt;
    return {
      cam: inSector(o, c.facing, pt, c.cam.range, c.cam.fov / 2),
      pos: inSector(o, c.facing, pt, c.pos.range, c.pos.half),
      pres: inRange(o, pt, c.pres.range),
    };
  };

  const freshRoom = () => ({ present: false, seenAt: null, movingAt: null, carried: new Map(), last: new Map() });
  const clear = (st) => { st.present = false; st.seenAt = null; st.movingAt = null; st.carried.clear(); st.last.clear(); };
  const NONE = { cam: "none", pos: "none", pres: "none", people: 0 };

  function applyRoom(room, c, st, snap, t) {
    const empty = (confidence, status) => {
      clear(st);
      snap.occupancy = { state: "EMPTY", confidence };
      snap.persons = [];
      return status;
    };
    if (snap.occupancy.state !== "OCCUPIED") { clear(st); return NONE; }

    // 시나리오가 '사람은 있는데 위치·신원 모름'으로 보낸 구간 (t6-2): 마지막 위치로 재실 레이더만 판단
    if (!snap.persons.length) {
      if (!st.present) return empty(0.6, NONE);
      const pts = [...st.last.values()];
      const pres = !pts.length || pts.some((pt) => detect(room, c, pt).pres);
      const status = { cam: "lost", pos: "lost", pres: pres ? "see" : "out", people: 0 };
      return pres ? status : empty(0.9, status);
    }

    const seen = snap.persons.map((p) => {
      const pt = p.position ? EY.roomToSim(room, p.position) : null;
      const d = pt ? detect(room, c, pt) : { cam: true, pos: false, pres: true };
      const blind = p.identity_source === "TRACK_CARRIED";    // 시나리오상 카메라가 못 보는 중 (불 꺼짐)
      return { p, pt, d, blind, camOk: d.cam && !blind };
    });
    const anyCam = seen.some((s) => s.camOk), anyPos = seen.some((s) => s.d.pos), anyPres = seen.some((s) => s.d.pres);
    const status = {
      cam: anyCam ? "see" : seen.some((s) => s.d.cam && s.blind) ? "blind" : "out",
      pos: anyPos ? "see" : "out", pres: anyPres ? "see" : "out", people: seen.length,
    };
    const allIn = seen.every((s) => s.d.cam && s.d.pos && s.d.pres);

    if (anyCam || anyPos) {
      st.seenAt = t;
      if (seen.some((s) => (s.camOk || s.d.pos) && (s.p.motion === "ACTIVE" || s.p.posture === "WALKING"))) st.movingAt = t;
    }
    if (!st.present && !(anyCam || (anyPos && anyPres))) return empty(0.6, status);   // 재실 레이더 혼자로는 시작 안 함
    if (!anyCam && !anyPres) return empty(0.9, status);
    const movedBefore = st.seenAt !== null && st.movingAt !== null && st.seenAt - st.movingAt <= MOVING_BEFORE_SECONDS;
    if (st.present && !anyCam && !anyPos && movedBefore && t - st.seenAt >= EXIT_SECONDS - 1e-6) return empty(0.85, status);

    st.present = true;
    if (!allIn) snap.occupancy = { state: "OCCUPIED", confidence: anyCam && anyPres ? 0.95 : anyPres ? (anyPos ? 0.85 : 0.8) : 0.8 };
    snap.persons = seen.map(({ p, pt, d, blind, camOk }) => {
      const id = p.track_id;
      if (pt && d.pos) st.last.set(id, pt);
      if (camOk) st.carried.set(id, { identity: p.identity, conf: p.identity_confidence, activity: p.activity, actConf: p.activity_confidence });
      if (!camOk && !d.pos) return null;
      const out = d.pos ? p : Object.assign({}, p, { position: null });
      if (camOk) return out;
      const k = st.carried.get(id);
      if (!k) {
        return Object.assign({}, out, { identity: "UNKNOWN", identity_confidence: 0, identity_source: "UNKNOWN",
          posture: "UNKNOWN", posture_confidence: 0, activity: "UNKNOWN", activity_confidence: 0 });
      }
      if (blind) return out;                                  // 시나리오가 이미 어둠 상태로 써 둠
      const rest = k.activity === "RESTING";
      return Object.assign({}, out, {
        identity: k.identity, identity_confidence: round3(k.conf * CARRIED_FACTOR), identity_source: "TRACK_CARRIED",
        posture: "UNKNOWN", posture_confidence: 0,
        activity: rest ? "RESTING" : "UNKNOWN", activity_confidence: rest ? round3(k.actConf * CARRIED_FACTOR) : 0,
      });
    }).filter(Boolean);
    return status;
  }

  EY.Coverage = {
    defaults,
    inSector, inRange,
    // nodes: FakeNodes 인스턴스, getCfg(): 지금 설정. 돌려주는 값의 status[room]이 화면 표시용
    attach(nodes, clock, getCfg) {
      const rooms = {}, status = {};
      Object.keys(nodes.nodes).forEach((r) => { rooms[r] = freshRoom(); status[r] = NONE; });
      const base = nodes.effective.bind(nodes);
      nodes.effective = (n) => {
        const snap = base(n);
        status[n.room] = applyRoom(n.room, getCfg()[n.room], rooms[n.room], snap, clock.t);
        return snap;
      };
      return { status };
    },
  };
})();
