// 집 정의: 방·가구 영역·Node 좌표계·가전 위치·이동 경로.
// 단위는 미터. 좌표는 두 가지:
//   - 그림 좌표(내부용): 평면도 왼쪽 위가 (0,0), y는 아래로. SVG는 1m = 100칸.
//   - 집 좌표(스냅샷에 나가는 값): 평면도 왼쪽 아래가 (0,0), y는 위로. home = (x, 14.05 - y)   (명세서 3절, 반석님과 11-12 합의)
//   - 방 좌표(Node가 보내는 값): 그 방 왼쪽 아래 모서리가 원점, x는 동쪽, y는 북쪽.
// 나중에 config/home.yaml로 옮길 내용.
window.EY = window.EY || {};

EY.HOME = {
  home_id: "home",
  // 그림 좌표(m) → SVG 좌표
  svgOrigin: [100, 195],
  svgScale: 100,
  planH: 14.05,     // 평면도 세로 길이 (집 좌표 y 뒤집기용)

  rooms: {
    room1: {
      name: "방1", rect: [9.1, 1.5, 13.3, 4.9],
      node: "node_room1", real: true,              // 실물 Node가 설치된 방
      // 방 좌표 → 그림 좌표: origin + x*ux + y*uy (방 왼쪽 아래 모서리가 원점, y는 북쪽 = 그림에서 위)
      frame: { origin: [9.1, 4.9], ux: [1, 0], uy: [0, -1] },
      adjacent: ["laundry"], cleanable: true,
      nodeAt: [13.08, 4.0],
    },
    room2: {
      name: "방2", rect: [0, 0, 6.2, 4.95],
      node: "node_room2", real: false,
      frame: { origin: [0, 4.95], ux: [1, 0], uy: [0, -1] },
      adjacent: [], cleanable: true,
      nodeAt: [5.9, 0.35],
    },
    living: {
      name: "거실", rect: [0, 4.95, 7.1, 14.05],
      node: "node_living", real: false,
      frame: { origin: [0, 14.05], ux: [1, 0], uy: [0, -1] },
      adjacent: [], cleanable: true,
      nodeAt: [6.75, 5.3],
    },
    laundry: {
      name: "세탁실", rect: [9.1, 0, 13.3, 1.5],
      node: "node_laundry", real: false,
      frame: { origin: [9.1, 1.5], ux: [1, 0], uy: [0, -1] },
      adjacent: ["room1"], cleanable: false,
      nodeAt: [13.05, 0.25],
    },
  },

  // 가구 영역 → 사람 위치로 zone 계산 (회의 예시의 zone: "bed")
  zones: [
    { id: "bed", room: "room1", rect: [10.0, 1.57, 13.24, 2.89] },
    { id: "sofa", room: "living", rect: [0.08, 8.35, 1.13, 12.65] },
  ],

  // actions는 명세서 7.1절 (정빈님과 합의 전 제안)
  devices: {
    vacuum: { type: "ROBOT_VACUUM", name: "로봇청소기", room: null, dock: [6.42, 3.84], actions: ["CLEAN_ROOM", "RETURN_TO_DOCK", "PAUSE"] },
    washer: { type: "WASHER", name: "세탁기", room: "laundry", at: [11.2, 0.7], actions: ["START", "PAUSE", "SET_MODE"] },
    ac_room1: { type: "AC", name: "방1 에어컨", room: "room1", at: [12.0, 4.55], actions: ["TURN_ON", "TURN_OFF", "SET_TARGET", "SET_WIND"] },
    ac_living: { type: "AC", name: "거실 에어컨", room: "living", at: [6.7, 13.35], actions: ["TURN_ON", "TURN_OFF", "SET_TARGET", "SET_WIND"] },
    light_room1: { type: "LIGHT", name: "방1 조명", room: "room1", at: [12.6, 3.3], actions: ["TURN_ON", "TURN_OFF"] },
    curtain_room1: { type: "CURTAIN", name: "방1 커튼", room: "room1", at: [13.0, 2.3], actions: ["OPEN", "CLOSE"] },
  },

  // 가족 선호 (나중에 예원님 앱에서 받음)
  preferences: {
    MEMBER_A: { label: "A", target_temp_c: 24 },
    MEMBER_B: { label: "B", target_temp_c: 26 },
  },
  routines: [
    { routine_id: "a_sleep", identity: "MEMBER_A", kind: "SLEEP", time: "23:30", days: ["SUN", "MON", "TUE", "WED", "THU"] },
  ],

  // 사람·청소기가 다니는 길 (문을 지나는 점들)
  nav: {
    nodes: {
      dock: [6.42, 3.84], hall_mid: [7.7, 3.84], hall_top: [7.7, 0.73], hall_low: [7.9, 6.3],
      r1_door: [9.1, 3.83], r1_in: [9.8, 3.83],
      ld_door: [9.1, 0.73], ld_in: [9.7, 0.9],
      lv_in: [6.3, 6.6], r2_out: [5.67, 5.5], r2_door: [5.67, 4.95], r2_in: [5.67, 4.2],
    },
    edges: [
      ["dock", "hall_mid"], ["hall_mid", "r1_door"], ["r1_door", "r1_in"],
      ["hall_mid", "hall_top"], ["hall_top", "ld_door"], ["ld_door", "ld_in"],
      ["hall_mid", "hall_low"], ["hall_low", "lv_in"],
      ["lv_in", "r2_out"], ["r2_out", "r2_door"], ["r2_door", "r2_in"],
    ],
    entry: { room1: "r1_in", room2: "r2_in", living: "lv_in", laundry: "ld_in", hall: "hall_mid", dock: "dock" },
  },
};

// ---------- 좌표 도우미 ----------
EY.toSvg = (p) => [p[0] * EY.HOME.svgScale + EY.HOME.svgOrigin[0], p[1] * EY.HOME.svgScale + EY.HOME.svgOrigin[1]];

// 방 좌표 {x, y} → 그림 좌표 [x, y↓]
EY.roomToSim = (roomId, pos) => {
  const f = EY.HOME.rooms[roomId].frame;
  return [
    +(f.origin[0] + pos.x * f.ux[0] + pos.y * f.uy[0]).toFixed(2),
    +(f.origin[1] + pos.x * f.ux[1] + pos.y * f.uy[1]).toFixed(2),
  ];
};

// 그림 좌표 [x, y↓] ↔ 집 좌표 {x, y↑}
EY.simToHome = (p) => ({ x: +p[0].toFixed(2), y: +(EY.HOME.planH - p[1]).toFixed(2) });
EY.homeToSim = (v) => [v.x, EY.HOME.planH - v.y];
// 방 원점·크기 (집 좌표, 스냅샷 rooms[].origin_m / size_m)
EY.roomGeom = (roomId) => {
  const r = EY.HOME.rooms[roomId].rect;
  return { origin_m: EY.simToHome([r[0], r[3]]), size_m: { x: +(r[2] - r[0]).toFixed(2), y: +(r[3] - r[1]).toFixed(2) } };
};

EY.inRect = (p, r) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];

EY.roomCenter = (roomId) => {
  const r = EY.HOME.rooms[roomId].rect;
  return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
};

EY.zoneAt = (roomId, p) => {
  const z = EY.HOME.zones.find((z) => z.room === roomId && EY.inRect(p, z.rect));
  return z ? z.id : null;
};

// 방(또는 hall/dock) 입구 사이 경로: BFS로 nav 점 목록을 돌려줌
EY.navPath = (fromKey, toKey) => {
  const nav = EY.HOME.nav;
  const a = nav.entry[fromKey] || fromKey, b = nav.entry[toKey] || toKey;
  const adj = {};
  nav.edges.forEach(([u, v]) => { (adj[u] = adj[u] || []).push(v); (adj[v] = adj[v] || []).push(u); });
  const prev = { [a]: null }, q = [a];
  while (q.length) {
    const u = q.shift();
    if (u === b) break;
    (adj[u] || []).forEach((v) => { if (!(v in prev)) { prev[v] = u; q.push(v); } });
  }
  if (!(b in prev)) return [];
  const out = [];
  for (let u = b; u !== null; u = prev[u]) out.unshift(nav.nodes[u]);
  return out;
};

// 방 안을 지그재그로 도는 청소 경로
EY.zigzag = (roomId, inset = 0.45, lane = 0.7) => {
  const r = EY.HOME.rooms[roomId].rect;
  const x0 = r[0] + inset, x1 = r[2] - inset, y0 = r[1] + inset, y1 = r[3] - inset;
  const pts = [];
  let left = true;
  for (let y = y0; y <= y1 + 1e-6; y += lane) {
    pts.push(left ? [x0, y] : [x1, y]);
    pts.push(left ? [x1, y] : [x0, y]);
    left = !left;
  }
  return pts;
};

// 어느 방에 있는 점인지 (Node 방 기준, 아니면 null)
EY.roomOf = (p) => {
  for (const [id, r] of Object.entries(EY.HOME.rooms)) if (EY.inRect(p, r.rect)) return id;
  return null;
};

EY.uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });

EY.clone = (o) => JSON.parse(JSON.stringify(o));
