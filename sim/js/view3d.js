// 발표용 3D 화면. view.js(평면도)와 같은 입력만 씀: World Model 스냅샷 + 가전 state 메시지.
// → 사람은 시나리오 원본이 아니라 World Model이 아는 위치·presence로 그림.
//   사람 모양  SEEN 진하게 + 실선 링 · HELD 레이더 파동 · IN_TRANSIT 반투명 + 끊긴 링 · LAST_KNOWN 흐린 잔상
//   방         OCCUPIED = 바닥 파란빛, 조명은 스냅샷 light 값, STALE = 회색 안개 + "모름"
// 좌표: 그림 좌표 [x, y↓](m) → three (x, 높이, y)
window.EY = window.EY || {};

(function () {
  const H = EY.HOME, W = EY.WORDS;
  const WALL_H = 1.0, WALL_T = 0.12, RAIL_H = 0.45;
  const WALK_MIN = 1.2, WALK_TIME = 4;           // view.js와 같음
  const COLOR = { A: 0xf59e0b, B: 0x14b8a6, anon: 0x94a3b8 };
  const OPACITY = { SEEN: 1, HELD: 0.82, IN_TRANSIT: 0.42, LAST_KNOWN: 0.22 };
  const LIGHT_I = { BRIGHT: 1.5, DIM: 0.6, DARK: 0.0 };
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pathLen = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
  const V = (x, h, z) => new THREE.Vector3(x, h, z);
  const lerp = (a, b, k) => a + (b - a) * k;

  // ---------- 집 모양 (index.html 평면도 SVG를 m로 옮김) ----------
  const WALLS = [
    [0, 0, 13.3, 0], [13.3, 0, 13.3, 1.85], [13.3, 2.75, 13.3, 14.05], [0, 14.05, 0, 6.8], [0, 6.2, 0, 0],
    [6.2, 0, 6.2, 4.95], [0, 4.95, 4.35, 4.95], [5.95, 4.95, 6.2, 4.95],   // 방2 문은 청소기 길(x 5.67)까지 넓힘
    [9.1, 0, 9.1, 0.45], [9.1, 1.0, 9.1, 3.5], [9.1, 4.15, 9.1, 5.5], [9.1, 6.05, 9.1, 8.0],
    [9.1, 1.5, 13.3, 1.5], [9.1, 4.9, 13.3, 4.9], [9.1, 6.4, 13.3, 6.4],
    [7.1, 8.0, 8.5, 8.0], [9.05, 8.0, 11.8, 8.0], [12.4, 8.0, 13.3, 8.0], [7.1, 8.0, 7.1, 14.05],
    [0, 14.05, 5.0, 14.05], [5.65, 14.05, 13.3, 14.05],
  ];
  const RAILS = [[0, 14.05, 0, 16.05], [0, 16.05, 13.3, 16.05], [13.3, 16.05, 13.3, 14.05]];
  const rect = (x1, z1, x2, z2) => [[x1, z1], [x2, z1], [x2, z2], [x1, z2]];
  const FLOORS = [
    { pts: rect(0, 0, 6.2, 4.95), mat: "wood", room: "room2" },
    { pts: [[6.2, 0], [9.1, 0], [9.1, 8.0], [7.1, 8.0], [7.1, 4.95], [6.2, 4.95]], mat: "hall" },
    { pts: rect(9.1, 0, 13.3, 1.5), mat: "tile", room: "laundry" },
    { pts: rect(9.1, 1.5, 13.3, 4.9), mat: "wood", room: "room1" },
    { pts: rect(9.1, 4.9, 13.3, 6.4), mat: "tile" },
    { pts: rect(9.1, 6.4, 13.3, 8.0), mat: "tile" },
    { pts: rect(0, 4.95, 7.1, 14.05), mat: "wood", room: "living" },
    { pts: rect(7.1, 8.0, 13.3, 14.05), mat: "dim" },
    { pts: rect(0, 14.05, 13.3, 16.05), mat: "out" },
  ];
  const OTHER_LABELS = [["부엌", 7.6, 1.2], ["화1", 11.2, 5.65], ["화2", 11.2, 7.2], ["방3", 10.2, 11], ["베란다", 6.6, 15.1]];
  // 방 조명 위치 (스냅샷 light 값으로 밝기). 노드 없는 곳은 고정 밝기
  const ROOM_LAMPS = { room1: [11.2, 3.2], room2: [3.1, 2.5], living: [3.5, 9.5], laundry: [11.2, 0.75] };
  const FIXED_LAMPS = [[7.7, 2.5, 0.75], [8.1, 6.5, 0.6], [10.2, 11, 0.25], [11.2, 6.4, 0.25]];

  EY.View3D = class {
    constructor(canvas, overlay) {
      this.canvas = canvas; this.overlay = overlay;
      const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r.outputEncoding = THREE.sRGBEncoding;
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = 0.9;
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      r.localClippingEnabled = true;     // 센서 범위를 방 안으로 자르는 데 씀

      const scene = this.scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b1020);
      scene.fog = new THREE.Fog(0x0b1020, 30, 60);
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
      this.camera.position.set(6.65, 17, 23);
      this.controls = new THREE.OrbitControls(this.camera, canvas);
      this.controls.target.set(6.65, 0, 7.5);
      this.controls.enableDamping = true;
      this.controls.maxPolarAngle = Math.PI * 0.47;
      this.controls.minDistance = 4; this.controls.maxDistance = 45;
      this.shot = null;          // {pos, target} 자동 카메라 목표
      this.auto = true;
      this.controls.addEventListener("start", () => { this.auto = false; if (this.onManual) this.onManual(); });

      scene.add(new THREE.HemisphereLight(0x9fb2d9, 0x1d2230, 0.3));
      const moon = new THREE.DirectionalLight(0xbfd0ff, 0.35);
      moon.position.set(-8, 18, 22); moon.target.position.set(6.65, 0, 8);
      moon.castShadow = true;
      moon.shadow.mapSize.set(2048, 2048);
      Object.assign(moon.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 60 });
      moon.shadow.bias = -0.0008;
      scene.add(moon, moon.target);

      this.buildHouse();
      this.buildDevices();
      this.people = new Map();
      this.labels = new Map();     // key → div (매 프레임 위치 갱신)
      this.bubbleEls = new Map();
      this.clock3 = 0;
      this.lastT = null;
      window.addEventListener("resize", () => this.resize());
      this.resize();
    }

    resize() {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.w = w; this.h = h;
    }

    mat(color, o) { return new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.85, metalness: 0 }, o)); }
    box(x1, z1, x2, z2, y0, y1, material, parent) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x2 - x1), y1 - y0, Math.abs(z2 - z1)), material);
      m.position.set((x1 + x2) / 2, (y0 + y1) / 2, (z1 + z2) / 2);
      m.castShadow = true; m.receiveShadow = true;
      (parent || this.scene).add(m);
      return m;
    }
    shape(pts, y, material) {
      const s = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
      const g = new THREE.ShapeGeometry(s);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, material);
      m.position.y = y; m.receiveShadow = true;
      this.scene.add(m);
      return m;
    }

    // ---------- 집 ----------
    buildHouse() {
      const S = this.scene;
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), this.mat(0x111729, { roughness: 1 }));
      ground.rotation.x = -Math.PI / 2; ground.position.set(6.65, -0.06, 8); ground.receiveShadow = true;
      S.add(ground);
      const F = {
        wood: this.mat(0xc7a57c), hall: this.mat(0xb9ad9c), tile: this.mat(0x9fb0bd),
        dim: this.mat(0x6f747c), out: this.mat(0x4b5563),
      };
      FLOORS.forEach((f) => this.shape(f.pts, 0, F[f.mat]));

      // 재실 표시 (바닥 위 파란빛) · STALE 안개
      this.occ = {}; this.fog = {}; this.roomLights = {};
      Object.entries(H.rooms).forEach(([id, def]) => {
        const [x1, z1, x2, z2] = def.rect;
        const occ = this.shape(rect(x1 + 0.08, z1 + 0.08, x2 - 0.08, z2 - 0.08), 0.015,
          new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0, depthWrite: false }));
        occ.receiveShadow = false;
        this.occ[id] = { mesh: occ, k: 0 };
        const fog = new THREE.Mesh(new THREE.BoxGeometry(x2 - x1 - 0.1, 1.5, z2 - z1 - 0.1),
          new THREE.MeshBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0, depthWrite: false }));
        fog.position.set((x1 + x2) / 2, 0.75, (z1 + z2) / 2);
        fog.visible = false;
        S.add(fog);
        this.fog[id] = { mesh: fog, k: 0 };
        // 불 꺼짐: 방 안을 남색으로 어둡게 (위에서 봐도 티 나게)
        const shade = new THREE.Mesh(new THREE.BoxGeometry(x2 - x1 - 0.06, 1.02, z2 - z1 - 0.06),
          new THREE.MeshBasicMaterial({ color: 0x050a1a, transparent: true, opacity: 0, depthWrite: false }));
        shade.position.set((x1 + x2) / 2, 0.51, (z1 + z2) / 2);
        shade.renderOrder = 2; shade.visible = false;
        S.add(shade);
        this.fog[id].shade = shade; this.fog[id].dk = 0;
      });

      const wallM = this.mat(0xdfe3ea, { roughness: 0.75 });
      const capM = new THREE.MeshBasicMaterial({ color: 0x3a4154 });
      const wall = (x1, z1, x2, z2, h) => {
        const len = Math.hypot(x2 - x1, z2 - z1) + WALL_T;
        const g = new THREE.Group();
        const m = new THREE.Mesh(new THREE.BoxGeometry(len, h, WALL_T), wallM);
        m.position.y = h / 2; m.castShadow = true; m.receiveShadow = true;
        const cap = new THREE.Mesh(new THREE.BoxGeometry(len, 0.012, WALL_T + 0.004), capM);
        cap.position.y = h + 0.006;
        g.add(m, cap);
        g.position.set((x1 + x2) / 2, 0, (z1 + z2) / 2);
        g.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
        S.add(g);
      };
      WALLS.forEach((w) => wall(...w, WALL_H));
      RAILS.forEach((w) => wall(...w, RAIL_H));
      // 방1 창문 (동쪽 벽)
      this.box(13.24, 1.85, 13.36, 2.75, 0, 0.3, wallM);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.7, 0.9),
        new THREE.MeshStandardMaterial({ color: 0x9cc8ff, transparent: true, opacity: 0.35, roughness: 0.1, emissive: 0x1a2b55, emissiveIntensity: 0.6 }));
      glass.position.set(13.3, 0.65, 2.3);
      S.add(glass);

      // 가구
      const wood = this.mat(0x8b6b4e), fabric = this.mat(0x6b7a90), white = this.mat(0xf3f1ec), light = this.mat(0xc9ccd2);
      // 방1 침대
      this.box(10.0, 1.57, 13.24, 2.89, 0, 0.32, wood);
      this.box(10.05, 1.6, 13.2, 2.86, 0.32, 0.46, white);
      this.box(10.05, 1.58, 12.45, 2.88, 0.46, 0.5, this.mat(0x9db4d8));
      this.box(12.66, 1.75, 13.1, 2.71, 0.46, 0.56, white);
      this.box(10.5, 4.55, 11.4, 4.84, 0, 0.55, wood);      // 서랍장
      // 거실 소파·러그·TV
      this.box(0.08, 8.35, 1.13, 12.65, 0, 0.42, fabric);
      this.box(0.08, 8.35, 0.34, 12.65, 0.42, 0.85, fabric);
      this.box(0.08, 8.35, 1.13, 8.6, 0.42, 0.62, fabric);
      this.box(0.08, 12.4, 1.13, 12.65, 0.42, 0.62, fabric);
      this.shape(rect(1.7, 8.9, 4.4, 12.1), 0.008, this.mat(0x5b6476));
      this.box(6.52, 8.5, 6.92, 12.35, 0, 0.42, wood);
      this.box(6.7, 9.3, 6.78, 11.55, 0.45, 1.3, this.mat(0x111111, { roughness: 0.4 }));
      this.tvScreen = new THREE.Mesh(new THREE.PlaneGeometry(2.15, 0.75), new THREE.MeshBasicMaterial({ color: 0x6aa5ff }));
      this.tvScreen.position.set(6.69, 0.875, 10.425); this.tvScreen.rotation.y = -Math.PI / 2;
      this.scene.add(this.tvScreen);
      this.tvLight = new THREE.PointLight(0x6aa5ff, 0.6, 5, 2);
      this.tvLight.position.set(5.9, 0.9, 10.4);
      this.scene.add(this.tvLight);
      // 방2, 부엌, 방3 (배경)
      this.box(3.4, 0.06, 5.6, 0.42, 0, 0.72, light);
      this.box(0.06, 1.0, 0.42, 3.2, 0, 1.0, light);
      this.box(6.3, 0.06, 9.0, 0.62, 0, 0.9, light);
      this.box(11.2, 8.2, 13.2, 10.2, 0, 0.45, this.mat(0x9a9ea6));

      // 조명
      Object.entries(ROOM_LAMPS).forEach(([room, [x, z]]) => {
        const l = new THREE.PointLight(0xffd6a0, 0, 7.5, 1.6);
        l.position.set(x, 2.4, z);
        this.scene.add(l);
        this.roomLights[room] = { light: l, k: 0 };
      });
      FIXED_LAMPS.forEach(([x, z, i]) => {
        const l = new THREE.PointLight(0xffe2b8, i, 6, 1.6);
        l.position.set(x, 2.4, z);
        this.scene.add(l);
      });
    }

    // ---------- 가전 ----------
    buildDevices() {
      const S = this.scene, D = H.devices;
      // 세탁기
      const wg = this.washer = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.85, 0.7), this.mat(0xf5f5f5, { roughness: 0.5 }));
      body.position.y = 0.425; body.castShadow = true;
      const drum = new THREE.Mesh(new THREE.CircleGeometry(0.22, 32), this.mat(0x3b4252, { roughness: 0.3 }));
      drum.position.set(0, 0.45, 0.351);
      wg.add(body, drum);
      wg.position.set(D.washer.at[0], 0, D.washer.at[1]);
      S.add(wg);
      this.waves = [0, 1, 2].map(() => {
        const m = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.47, 48),
          new THREE.MeshBasicMaterial({ color: 0xfb923c, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
        m.rotation.x = -Math.PI / 2; m.position.set(D.washer.at[0], 0.05, D.washer.at[1]);
        S.add(m);
        return m;
      });

      // 에어컨 (거실: 스탠드, 방1: 벽걸이)
      const acM = this.mat(0xf8fafc, { roughness: 0.4 });
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 1.7, 24), acM);
      st.position.set(D.ac_living.at[0], 0.85, D.ac_living.at[1]); st.castShadow = true;
      S.add(st);
      this.box(11.45, 4.66, 12.55, 4.86, 0.72, 0.98, acM);
      this.acFrom = { ac_living: V(D.ac_living.at[0] - 0.2, 1.45, D.ac_living.at[1] - 0.2), ac_room1: V(12.0, 0.8, 4.6) };
      this.acLed = {};
      [["ac_living", V(D.ac_living.at[0] - 0.22, 1.35, D.ac_living.at[1] - 0.15)], ["ac_room1", V(12.0, 0.75, 4.65)]].forEach(([id, p]) => {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0x334155 }));
        m.position.copy(p); S.add(m); this.acLed[id] = m;
      });
      this.wind = {};
      ["ac_living", "ac_room1"].forEach((id) => {
        const N = 46, g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
        const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x7dd3fc, size: 0.09, transparent: true, opacity: 0.85, depthWrite: false }));
        pts.visible = false;
        S.add(pts);
        this.wind[id] = { pts, N, to: null, k: 0 };
      });

      // 방1 조명 (펜던트)
      const lp = D.light_room1.at;
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.5, 6), new THREE.MeshBasicMaterial({ color: 0x555555 }));
      cord.position.set(lp[0], 2.15, lp[1]);
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.18, 24, 1, true), this.mat(0x2f3542, { side: THREE.DoubleSide }));
      shade.position.set(lp[0], 1.86, lp[1]);
      this.bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffe9b0 }));
      this.bulb.position.set(lp[0], 1.78, lp[1]);
      S.add(cord, shade, this.bulb);

      // 방1 커튼 (창문 양쪽에서 가운데로)
      const cm = this.mat(0xc7b9e8, { roughness: 0.95 });
      this.curtains = [1, -1].map((dir) => {
        const g = new THREE.BoxGeometry(0.04, 0.78, 0.45);
        g.translate(0, 0, dir * 0.225);
        const m = new THREE.Mesh(g, cm);
        m.position.set(13.2, 0.62, dir > 0 ? 1.85 : 2.75);
        m.castShadow = true;
        S.add(m);
        return m;
      });

      // 청소기 + 도크
      this.box(6.24, 3.55, 6.6, 4.13, 0, 0.14, this.mat(0x334155));
      const vg = this.vac = new THREE.Group();
      const vb = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.09, 32), this.mat(0x1f2937, { roughness: 0.4 }));
      vb.position.y = 0.06; vb.castShadow = true;
      const vt = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 20), this.mat(0x60a5fa, { emissive: 0x2563eb, emissiveIntensity: 0.8 }));
      vt.position.y = 0.115;
      vg.add(vb, vt);
      S.add(vg);
      this.vacPos = null;

      // Node 상자
      this.nodes = {};
      Object.entries(H.rooms).forEach(([id, def]) => {
        const g = new THREE.Group();
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.16), this.mat(0x1e293b, { roughness: 0.5 }));
        const led = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshBasicMaterial({ color: 0x22c55e }));
        led.position.y = 0.15;
        g.add(b, led);
        g.position.set(def.nodeAt[0], WALL_H + 0.11, def.nodeAt[1]);
        S.add(g);
        this.nodes[id] = { g, led };
      });
    }

    // ---------- 사람 ----------
    makeAvatar(pid) {
      const lab = W.who(pid);
      const color = COLOR[lab] || COLOR.anon;
      const root = new THREE.Group(), pose = new THREE.Group();
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, transparent: true });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.75, 6, 16), m);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), m);
      body.castShadow = head.castShadow = true;
      pose.add(body, head);
      const ringM = new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.42, 48), ringM);
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
      const dash = new THREE.Group();
      for (let i = 0; i < 10; i++) {
        const a = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.42, 6, 1, (i / 10) * Math.PI * 2, Math.PI / 10), ringM);
        dash.add(a);
      }
      dash.rotation.x = -Math.PI / 2; dash.position.y = 0.03;
      const pulse = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.45, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      pulse.rotation.x = -Math.PI / 2; pulse.position.y = 0.035;
      const blob = new THREE.Mesh(new THREE.CircleGeometry(0.3, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = 0.02;
      root.add(pose, ring, dash, pulse, blob);
      this.scene.add(root);
      const el = document.createElement("div");
      el.className = "plabel";
      el.style.setProperty("--c", "#" + color.toString(16).padStart(6, "0"));
      this.overlay.appendChild(el);
      return { root, pose, body, head, m, ring, ringM, dash, pulse, blob, el, pos: null, route: [], speed: WALK_MIN, room: null, target: null,
        presence: null, lying: false, sitting: false, lie: 0, sit: 0, op: 1, html: "" };
    }

    targetOf(p, idx) {
      if (p.position && p.position.home) return EY.homeToSim(p.position.home);
      const c = EY.roomCenter(p.room_id);
      return [c[0] + (idx % 2 ? 0.6 : -0.6), c[1]];
    }
    go(a, pts) { a.route = pts; a.speed = Math.max(WALK_MIN, pathLen([a.pos, ...pts]) / WALK_TIME); }

    updatePeople(snap, dt, jump, rdt) {
      const seen = new Set(), now = snap ? snap.timestamp : null;
      (snap ? snap.people : []).forEach((p, i) => {
        seen.add(p.person_id);
        let a = this.people.get(p.person_id);
        const target = this.targetOf(p, i);
        const fresh = !a;
        if (!a) {
          a = this.makeAvatar(p.person_id);
          this.people.set(p.person_id, a);
          const entry = H.nav.nodes[H.nav.entry[p.room_id]];
          a.pos = jump || !entry ? target.slice() : entry.slice();
          this.go(a, [target]);
        }
        const moved = a.room !== p.room_id;
        if (p.presence === "IN_TRANSIT" && a.presence !== "IN_TRANSIT") this.go(a, EY.navPath(p.room_id, "hall"));
        else if (p.presence !== "IN_TRANSIT" && !fresh) {
          if (moved || a.presence === "IN_TRANSIT") {
            const from = EY.roomOf(a.pos) || "hall";
            this.go(a, [...(from === p.room_id ? [] : EY.navPath(from, p.room_id)), target]);
          } else if (!a.target || a.target[0] !== target[0] || a.target[1] !== target[1]) this.go(a, [target]);
        }
        a.room = p.room_id; a.target = target; a.presence = p.presence;
        if (p.posture.state !== "UNKNOWN") { a.lying = p.posture.state === "LYING"; a.sitting = p.posture.state === "SITTING"; }
        // 자세 모름이어도 침대 위에서 쉬는 중이면 누운 모습 유지 (중간으로 건너뛴 경우 대비)
        else if (jump && p.activity.state === "RESTING" && EY.zoneAt(p.room_id, target) === "bed") { a.lying = true; a.sitting = false; }
        if (p.presence === "IN_TRANSIT") { a.lying = false; a.sitting = false; }
        a.resting = p.activity.state === "RESTING";
        const cand = p.candidates && p.candidates.length ? ` (${p.candidates.map((c) => W.who(c.identity)).join("·")}일 수도)` : "";
        const src = p.presence === "SEEN" ? (W.IDSRC[p.identity_source] || "") : "";
        // 카메라 없이 추적으로 이어지는 중이면 '보임'이 아니라 '감지 중' (t4: 불 꺼진 방)
        const pres = p.presence === "SEEN" && p.identity_source === "TRACK_CARRIED" ? "감지 중"
          : { SEEN: "보임", HELD: "레이더로만 확인", IN_TRANSIT: "이동 중", LAST_KNOWN: "위치 모름" }[p.presence];
        a.html = `<b>${esc(W.who(p.person_id))}${esc(cand)}</b><span class="pp p-${p.presence}">${esc(pres)}</span>${src ? `<span class="src">${esc(src)}</span>` : ""}` +
          `<div class="sub">${esc(W.doing(p, now))}${p.activity.rest_episode && p.activity.state === "RESTING" ? ` · ${p.activity.rest_episode}회차` : ""}</div>`;
      });
      this.people.forEach((a, pid) => {
        if (!seen.has(pid)) { this.scene.remove(a.root); a.el.remove(); this.people.delete(pid); }
      });
      // 걷기 + 자세 + presence 모양
      this.people.forEach((a) => {
        if (jump && a.route.length) { a.pos = a.route[a.route.length - 1].slice(); a.route = []; }
        let left = a.speed * dt;
        while (left > 0 && a.route.length) {
          const b = a.route[0], d = Math.hypot(b[0] - a.pos[0], b[1] - a.pos[1]);
          if (d <= left) { a.pos = b.slice(); a.route.shift(); left -= d; }
          else { a.pos = [a.pos[0] + (b[0] - a.pos[0]) * left / d, a.pos[1] + (b[1] - a.pos[1]) * left / d]; left = 0; }
        }
        const walking = a.route.length > 0;
        const k = jump ? 1 : Math.min(1, rdt * 4);
        a.lie = lerp(a.lie, a.lying && !walking ? 1 : 0, k);
        a.sit = lerp(a.sit, a.sitting && !walking && !a.lying ? 1 : 0, k);
        a.op = lerp(a.op, OPACITY[a.presence] || 1, k);
        const s = a.sit, l = a.lie;
        const sy = 1 - 0.32 * s;
        a.body.scale.set(1, sy, 1);
        a.body.position.set(0, 0.6 * sy, 0);
        a.head.position.set(0, 1.13 * sy + 0.21, 0);
        a.pose.rotation.z = -Math.PI / 2 * l;
        a.pose.position.set(-0.78 * l, lerp(0.42 * s, 0.68, l), 0);
        const bob = walking ? Math.abs(Math.sin(this.clock3 * 9)) * 0.05 : 0;
        a.root.position.set(a.pos[0], bob, a.pos[1]);
        a.m.opacity = a.op;
        a.m.depthWrite = a.op > 0.95;
        a.ring.visible = a.presence === "SEEN" || a.presence === "HELD";
        a.dash.visible = !a.ring.visible;
        a.ringM.opacity = a.presence === "LAST_KNOWN" ? 0.35 : 0.9;
        a.dash.rotation.z = this.clock3 * 0.6;
        a.pulse.visible = a.presence === "HELD";
        if (a.pulse.visible) {
          const ph = (this.clock3 * 0.8) % 1;
          a.pulse.scale.setScalar(1 + ph * 2.2);
          a.pulse.material.opacity = 0.7 * (1 - ph);
        }
        a.blob.material.opacity = 0.25 * a.op;
        // 이름표: 머리 위
        const top = lerp(lerp(1.75, 1.3, s), 1.15, l);
        a.anchor = V(a.pos[0], top + 0.25, a.pos[1]);
        a.el.className = "plabel p-" + a.presence + (a.resting ? " resting" : "");
        if (a.el._html !== a.html) { a.el.innerHTML = a.html; a.el._html = a.html; }
      });
    }

    // ---------- 매 프레임 ----------
    // t: sim 초, rdt: 실제 경과 초 (애니메이션용)
    frame(t, snap, dev, bubbles, offline, rdt) {
      const dt = this.lastT === null ? 0 : t - this.lastT;
      const jump = this.lastT === null || dt < 0 || dt > 3;
      this.lastT = t;
      this.clock3 += rdt;
      const k = jump ? 1 : Math.min(1, rdt * 3);
      this.updatePeople(snap, jump ? 0 : dt, jump, rdt);

      // 방
      Object.keys(H.rooms).forEach((room) => {
        const r = snap && snap.rooms.find((x) => x.room_id === room);
        const occ = this.occ[room];
        occ.k = lerp(occ.k, r && r.occupancy.state === "OCCUPIED" ? 0.2 : 0, k);
        occ.mesh.material.opacity = occ.k;
        const stale = r && r.source.status === "STALE";
        const fog = this.fog[room];
        fog.k = lerp(fog.k, stale ? 0.55 : 0, k);
        fog.mesh.material.opacity = fog.k; fog.mesh.visible = fog.k > 0.01;
        fog.dk = lerp(fog.dk, r && r.light.state === "DARK" ? 0.5 : 0, k);
        fog.shade.material.opacity = fog.dk; fog.shade.visible = fog.dk > 0.01;
        const L = this.roomLights[room];
        if (r && LIGHT_I[r.light.state] !== undefined) L.target = LIGHT_I[r.light.state];
        if (L.target !== undefined) { L.k = lerp(L.k, L.target, k); L.light.intensity = L.k; }
        const status = offline[room] ? "OFF" : (r ? r.source.status : "NO_DATA");
        this.nodes[room].led.material.color.setHex({ FRESH: 0x22c55e, STALE: 0xf59e0b, OFF: 0xef4444 }[status] || 0x64748b);
        this.nodes[room].led.scale.setScalar(status === "FRESH" ? 1 + 0.25 * Math.sin(this.clock3 * 4) : 1);
        this.roomLabel(room, r, snap, status);
      });

      // TV 깜빡임
      const tvOn = !snap || (snap.rooms.find((x) => x.room_id === "living") || {}).audio?.state !== "SILENT";
      const fl = 0.75 + 0.25 * Math.sin(this.clock3 * 5.3) * Math.sin(this.clock3 * 2.1);
      this.tvScreen.material.color.setHex(tvOn ? 0x6aa5ff : 0x111111).multiplyScalar(tvOn ? fl : 1);
      this.tvLight.intensity = tvOn ? 0.5 * fl : 0;

      // 청소기
      const v = dev.vacuum;
      if (v && v.x_m !== undefined) {
        const target = EY.homeToSim({ x: v.x_m, y: v.y_m });
        if (!this.vacPos || jump) this.vacPos = target;
        else {
          const kk = Math.min(1, rdt * 8);
          const nx = [lerp(this.vacPos[0], target[0], kk), lerp(this.vacPos[1], target[1], kk)];
          const dx = nx[0] - this.vacPos[0], dz = nx[1] - this.vacPos[1];
          if (Math.hypot(dx, dz) > 0.002) this.vac.rotation.y = Math.atan2(dx, dz);
          this.vacPos = nx;
        }
        this.vac.position.set(this.vacPos[0], 0, this.vacPos[1]);
        const word = { DOCKED: "충전 중", TO_ROOM: `${W.room(v.room)}로 이동`, CLEANING: `${W.room(v.room)} 청소 중`, RETURNING: "도크로 복귀" }[v.status] || v.status;
        this.tag("vac", V(this.vacPos[0], 0.3, this.vacPos[1]), `청소기 · ${word}`, v.status === "CLEANING" || v.status === "TO_ROOM" ? "on" : "");
      }

      // 세탁기
      const w = dev.washer;
      const running = w && w.power === "RUNNING", low = w && w.mode === "LOW_NOISE";
      const amp = running ? (low ? 0.004 : 0.014) : 0;
      this.washer.position.x = H.devices.washer.at[0] + Math.sin(this.clock3 * 37) * amp;
      this.washer.position.z = H.devices.washer.at[1] + Math.cos(this.clock3 * 29) * amp;
      this.waves.forEach((m, i) => {
        const ph = ((this.clock3 * (low ? 0.45 : 0.8)) + i / 3) % 1;
        m.scale.setScalar(1 + ph * (low ? 0.9 : 2.6));
        m.material.opacity = running ? (low ? 0.35 : 0.7) * (1 - ph) : 0;
      });
      if (w) this.tag("washer", V(H.devices.washer.at[0], 1.15, H.devices.washer.at[1]), running ? `세탁기 · ${low ? "저소음 " : "일반 "}${w.noise_db}dB` : "세탁기 · 완료", running && !low ? "warn" : "");

      // 에어컨 바람
      ["ac_living", "ac_room1"].forEach((id) => {
        const a = dev[id], wd = this.wind[id];
        if (!a) return;
        const on = a.power === "ON";
        this.acLed[id].material.color.setHex(on ? 0x38bdf8 : 0x334155);
        wd.k = lerp(wd.k, on ? 1 : 0, k);
        wd.pts.visible = wd.k > 0.02;
        wd.pts.material.opacity = 0.85 * wd.k;
        const from = this.acFrom[id];
        const av = a.wind_to && this.people.get(a.wind_to);
        const here = av && (av.presence === "SEEN" || av.presence === "HELD") && av.room === H.devices[id].room;
        const c = EY.roomCenter(H.devices[id].room);
        const to = here ? V(av.pos[0], 1.0, av.pos[1]) : V(c[0], 0.9, c[1]);
        if (!wd.to || jump) wd.to = to.clone(); else wd.to.lerp(to, Math.min(1, rdt * 2));
        if (wd.pts.visible) {
          const arr = wd.pts.geometry.attributes.position.array, dir = wd.to.clone().sub(from);
          const side = V(-dir.z, 0, dir.x).normalize();
          for (let i = 0; i < wd.N; i++) {
            const ph = (this.clock3 * 0.45 + i / wd.N) % 1;
            const sp = Math.sin(i * 12.9898) * 0.5;
            const p = from.clone().addScaledVector(dir, ph * 0.92).addScaledVector(side, sp * ph * 0.7);
            p.y += Math.sin(ph * Math.PI) * 0.25 + Math.sin(i * 7.1) * 0.08 * ph;
            arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
          }
          wd.pts.geometry.attributes.position.needsUpdate = true;
        }
        const tagAt = id === "ac_living" ? V(H.devices[id].at[0], 2.0, H.devices[id].at[1]) : V(12.0, 1.25, 4.75);
        this.tag(id, tagAt, on ? `${H.devices[id].name} · ${a.target_c}°C · 바람 → ${a.wind_to ? W.who(a.wind_to) : "전체"}` : `${H.devices[id].name} · 꺼짐`, on ? "cool" : "off");
      });

      // 방1 조명·커튼
      const lt = dev.light_room1;
      if (lt) this.bulb.material.color.setHex(lt.power === "ON" ? 0xffe9b0 : 0x3a3a3a);
      const c = dev.curtain_room1;
      if (c) {
        let closed = c.position === "CLOSED" ? 1 : 0;
        if (c.position === "MOVING") closed = c.moving_to === "CLOSED" ? c.progress : 1 - c.progress;
        this.curtains.forEach((m) => { m.scale.z = lerp(m.scale.z, 0.18 + 0.82 * closed, k); });
      }

      this.renderBubbles(bubbles);
      this.camStep(rdt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.placeOverlay();
    }

    // ---------- 카메라 ----------
    setShot(pos, target) { this.shot = { pos: V(...pos), target: V(...target) }; }
    camStep(rdt) {
      if (!this.auto || !this.shot) return;
      const k = 1 - Math.exp(-rdt * 1.6);
      this.camera.position.lerp(this.shot.pos, k);
      this.controls.target.lerp(this.shot.target, k);
    }

    // ---------- 글자 (HTML, 3D 위치를 화면에 투영) ----------
    label(key, cls) {
      let el = this.labels.get(key);
      if (!el) { el = document.createElement("div"); this.overlay.appendChild(el); this.labels.set(key, el); }
      if (el.className !== cls) el.className = cls;
      return el;
    }
    setText(el, html) { if (el._html !== html) { el.innerHTML = html; el._html = html; } }
    tag(key, at, text, mod) {
      const el = this.label("tag:" + key, "dtag " + (mod || ""));
      el._at = at;
      this.setText(el, esc(text));
    }
    roomLabel(room, r, snap, status) {
      const def = H.rooms[room], [x1, z1] = def.rect;
      const el = this.label("room:" + room, "rlabel " + (r ? r.occupancy.state : "UNKNOWN") + (status !== "FRESH" ? " stale" : ""));
      el._at = V(x1 + 0.35, WALL_H + 0.05, z1 + 0.35);
      let sub = r ? W.OCC[r.occupancy.state] : "";
      if (r && r.light.state !== "UNKNOWN" && room !== "living") sub += " · " + W.LIGHT[r.light.state];
      if (status === "STALE" || status === "OFF") sub = `Node 끊김 · 상태 모름`;
      this.setText(el, `<b>${esc(def.name)}</b><span>${esc(sub)}</span>`);
      if (!this._others) {
        this._others = OTHER_LABELS.map(([n, x, z]) => {
          const e = this.label("other:" + n, "olabel"); e._at = V(x, 0.05, z); this.setText(e, esc(n)); return e;
        });
      }
    }
    project(v) {
      const p = v.clone().project(this.camera);
      return { x: (p.x + 1) / 2 * this.w, y: (1 - p.y) / 2 * this.h, ok: p.z < 1 && p.z > -1 };
    }
    place(el, at) {
      const s = this.project(at);
      el.style.display = s.ok ? "" : "none";
      el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
    }
    placeOverlay() {
      this.labels.forEach((el) => { if (el._at) this.place(el, el._at); });
      this.people.forEach((a) => this.place(a.el, a.anchor));
      this.bubbleEls.forEach((el) => {
        const at = this.bubbleAnchor(el._b);
        if (at) this.place(el, at);
      });
    }

    // ---------- 말풍선 ----------
    bubbleAnchor(b) {
      if (b.kind === "node") { const n = H.rooms[b.room].nodeAt; return V(n[0], WALL_H + 0.5, n[1]); }
      if (b.kind === "device") {
        if (b.device === "vacuum" && this.vacPos) return V(this.vacPos[0], 0.6, this.vacPos[1]);
        const d = H.devices[b.device];
        const p = d.at || EY.roomCenter(d.room);
        return V(p[0], b.device === "ac_living" ? 2.0 : 1.2, p[1]);
      }
      const av = [...this.people.values()].find((a) => a.room === b.room && (a.presence === "SEEN" || a.presence === "HELD"));
      if (av) return av.anchor;
      const c = EY.roomCenter(b.room);
      return V(c[0], 1.6, c[1]);
    }
    renderBubbles(list) {
      const keep = new Set(list.map((b) => b.id));
      this.bubbleEls.forEach((el, id) => { if (!keep.has(id)) { el.remove(); this.bubbleEls.delete(id); } });
      list.forEach((b) => {
        if (this.bubbleEls.has(b.id)) return;
        const el = document.createElement("div");
        el.className = "bubble3 " + b.kind;
        el._b = b;
        el.innerHTML = `<div class="in"><span class="who">${esc(b.who)}</span>${esc(b.text)}${b.why ? `<span class="bwhy">${esc(b.why)}</span>` : ""}</div>`;
        this.overlay.appendChild(el);
        this.bubbleEls.set(b.id, el);
      });
    }

    // ---------- 센서 범위 (바닥에 그림) ----------
    // 채운 면은 그 방 안으로 자르고, 고른 방은 외곽선만 벽 너머까지 보여 줌
    setCoverage(cfg, selected) {
      if (this.cov) {
        this.scene.remove(this.cov.group);
        this.cov.group.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); m.material.dispose(); } });
      }
      const group = new THREE.Group();
      this.scene.add(group);
      this.cov = { group, parts: [] };
      const flat = (tris, y) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tris.flatMap(([x, z]) => [x, y, z])), 3));
        return g;
      };
      const ribbon = (pts, w, dash) => {
        const out = [];
        for (let i = 1; i < pts.length; i++) {
          if (dash && i % 2) continue;
          const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
          const l = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / l * w / 2, nz = (bx - ax) / l * w / 2;
          out.push([ax + nx, az + nz], [ax - nx, az - nz], [bx + nx, bz + nz], [bx + nx, bz + nz], [ax - nx, az - nz], [bx - nx, bz - nz]);
        }
        return out;
      };
      Object.entries(H.rooms).forEach(([room, def]) => {
        const c = cfg[room], o = def.nodeAt, sel = room === selected, [x1, z1, x2, z2] = def.rect;
        const clip = [new THREE.Plane(V(1, 0, 0), -x1), new THREE.Plane(V(-1, 0, 0), x2), new THREE.Plane(V(0, 0, 1), -z1), new THREE.Plane(V(0, 0, -1), z2)];
        const face = c.facing * Math.PI / 180;
        [["pres", c.pres.range, 180, 0x84cc16, 0.14, 0.022], ["pos", c.pos.range, c.pos.half, 0x0ea5e9, 0.26, 0.026], ["cam", c.cam.range, c.cam.fov / 2, 0xec4899, 0.3, 0.03]]
          .forEach(([key, r, halfDeg, color, op, y]) => {
            const half = halfDeg * Math.PI / 180, N = Math.max(12, Math.ceil(halfDeg / 2.5)), arc = [];
            for (let i = 0; i <= N; i++) {
              const a = face - half + 2 * half * i / N;
              arc.push([o[0] + r * Math.cos(a), o[1] - r * Math.sin(a)]);
            }
            const tris = [];
            for (let i = 1; i < arc.length; i++) tris.push(o, arc[i - 1], arc[i]);
            const add = (g, opacity, clipped) => {
              // 침대·벽에 가려지지 않게 항상 위에 그림
              const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, depthTest: false, toneMapped: false, clippingPlanes: clipped ? clip : [] }));
              m.renderOrder = 3;
              group.add(m);
              this.cov.parts.push({ room, key, m, opacity });
            };
            add(flat(tris, y), sel ? op : op * 0.7, true);
            const line = key === "pres" ? arc : [o, ...arc, o];
            add(flat(ribbon(line, sel ? 0.05 : 0.035, key === "pres"), y + 0.003), sel ? 0.85 : 0.4, !sel);
          });
      });
    }
    // 감지 중이면 진하게, 못 보면 흐리게
    updateCoverage(on, status) {
      if (!this.cov) return;
      this.cov.group.visible = on;
      if (!on) return;
      const gain = { see: 1.25, none: 0.75, blind: 0.35, out: 0.35, lost: 0.35 };
      this.cov.parts.forEach((p) => {
        const st = status && status[p.room] ? status[p.room][p.key] : "none";
        p.m.material.opacity = p.opacity * gain[st];
      });
    }

    reset() {
      this.people.forEach((a) => { this.scene.remove(a.root); a.el.remove(); });
      this.people.clear();
      this.bubbleEls.forEach((el) => el.remove());
      this.bubbleEls.clear();
      this.vacPos = null; this.lastT = null;
      Object.values(this.wind).forEach((w) => { w.to = null; });
    }
  };
})();
