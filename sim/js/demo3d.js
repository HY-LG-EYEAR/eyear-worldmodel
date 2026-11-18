// 발표용 3D 데모 조립: 같은 모듈(가짜 Node → World Model → 임시 중앙 판단 → 가상 가전)을 그대로 돌리고
// 화면만 view3d.js로 그림.
// 기본은 PPT처럼 '단계 넘기기': Space/→ 를 누르면 그 단계(t0, t1, …)만 재생하고 멈춤.
//   demo3d.html?auto       끊김 없이 자동 재생 (약 70초)
//   demo3d.html?play       바로 시작
//   demo3d.html?speed=3    배속 고정
//   demo3d.html?t=80       80초 지점에서 시작
//   demo3d.html?panel      센서 범위 설정 창을 연 채로 시작
//   demo3d.html?nocov      센서 범위를 끈 채로 시작
//   demo3d.html?set=room1.cam.range:2,room1.pres.range:1.5   센서 범위를 미리 바꿈
(function () {
  const H = EY.HOME, SC = EY.SCENARIO, W = EY.WORDS;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const qs = new URLSearchParams(location.search);
  const END = +qs.get("end") || 122;
  const AUTO = qs.has("auto");
  const STEPS = SC.steps.filter((s) => s.at < END);
  // 단계 k 재생이 멈추는 지점: 다음 단계 바로 앞 (마지막 단계는 END)
  // 시계가 0.1초 단위로 올림하므로 0.15초 앞에 둬야 다음 단계 사건이 먼저 터지지 않음
  const segEnd = (k) => (k + 1 < STEPS.length ? STEPS[k + 1].at - 0.15 : END);
  // 단계 모드 배속: 한 단계가 실제 7초 안팎이 되게, 짧은 단계는 실시간(1×)
  const SEG_SEC = +qs.get("seg") || 7;
  const segSpeed = (k) => Math.max(1, Math.round((segEnd(k) - STEPS[k].at) / SEG_SEC * 2) / 2);

  // 자동 모드 [시작, 끝, 배속] — 핵심 장면은 1~1.5배속
  const PACE = [
    [0, 14, 3], [14, 22, 1.5], [22, 30, 3.5], [30, 45, 1.2], [45, 49, 3.5], [49, 55, 1.2], [55, 62, 5],
    [62, 73, 1.2], [73, 80, 3.5], [80, 101, 1.2], [101, 108, 2], [108, 999, 3],
  ];
  const fixedSpeed = qs.has("speed") ? +qs.get("speed") : null;
  const speedAt = (t) => fixedSpeed || (AUTO
    ? (PACE.find(([a, b]) => t >= a && t < b) || [0, 0, 3])[2]
    : segSpeed(Math.max(0, stepIndex(t))));

  // 청중용 자막 (단계별)
  const STORY = {
    "t0": ["밤 9시. B는 거실에서 TV, 세탁기 작동 중, 청소기는 방2 청소 마무리", "청소를 끝낸 청소기는 거실을 지나 도크로 돌아갑니다 · 방마다 있는 Node가 본 것을 World Model이 하나의 집 상태로 합칩니다"],
    "t1": ["A가 방1에 들어옴 → 얼굴로 A를 알아봄", "세탁기는 저소음, 방1 에어컨은 A가 좋아하는 24°C로 · 방1은 더럽지만 사람이 있어 청소기는 도크로 돌아가 대기"],
    "t2": ["A가 침대에 누움 → World Model: ‘휴식 1회차’ 시작", "중앙은 휴식 회차마다 한 번만 물어봅니다"],
    "t3": ["A: “응.” → 불을 끄고 커튼을 닫음", "문장부호가 붙고 신뢰도가 낮은(0.55) 짧은 대답도 긍정으로 해석"],
    "t4": ["불이 꺼져 카메라는 못 보지만, 레이더가 A를 계속 감지", "재실·위치는 레이더로 유지 · 얼굴과 자세는 볼 수 없어 신원은 추적으로 잇고 자세는 ‘모름’ · 같은 휴식이라 다시 묻지 않음"],
    "t5-1": ["A: “하이 엘지, 불 켜줘” → 조명 켬", "음성 명령은 스냅샷 밖에서 온 원인이지만 같은 흐름으로 처리"],
    "t5-2": ["밝아지자 얼굴로 A를 다시 확인 · 침대에 앉음 → 휴식 끝", "신원 근거가 ‘추적 유지’에서 다시 ‘얼굴’로"],
    "t6-1": ["A가 일어나 문 쪽으로 걸어감", "아직 방1에 사람이 있으니 청소기는 도크에서 기다림"],
    "t6-2": ["카메라와 위치 레이더는 A를 놓쳤지만, 재실 레이더는 ‘사람 있음’", "문을 나서는 중이라 놓침 · 화면의 A는 마지막 확인 위치 · 재실 레이더가 감지하는 동안은 빈 방이 아님 (HELD)"],
    "t6-3": ["센서 범위에서 사라져 방1은 ‘빈 방’ → A는 ‘이동 중’", "빈 방 기준: 카메라·재실 레이더 모두 없음, 또는 걷던 사람이 카메라·위치 레이더에서 5초간 사라짐 → 이제 청소기 출발"],
    "t7-1": ["거실 Node가 A를 확인 → 방1의 A와 같은 사람으로 이어 붙임", "A·B가 함께 있으니 거실 에어컨 25°C(둘의 평균), 바람은 A 쪽으로"],
    "t7-2": ["A가 B 옆에 앉음", "앉은 것은 휴식이 아니므로 질문하지 않음 · 청소기는 방1 청소 중"],
  };
  // 자동 카메라 [시작 sim초, 카메라 위치, 바라보는 점]
  const SHOTS = [
    [0, [6.65, 15.5, 22.5], [6.65, 0, 7.6]],
    [15, [8.4, 10.5, 11.0], [11.2, 0, 3.0]],
    [80, [7.0, 9.5, 12.5], [9.6, 0, 4.4]],
    [96, [9.5, 9.5, 17.5], [5.2, 0, 7.6]],
    [112, [6.65, 15.5, 22.5], [6.65, 0, 7.6]],
  ];
  const shotAt = (t) => SHOTS.filter((s) => s[0] <= t + 1e-6).pop();

  const ui = { playing: false, ended: false, started: false, stopAt: null };
  let sim = null, store = null, lastShot = null;

  // ---------- 센서 범위 설정 ----------
  const COV = EY.Coverage;
  let covCfg = COV.defaults(), covRoom = "room1", covOn = !qs.has("nocov");
  const getPath = (o, p) => p.split(".").reduce((x, k) => x[k], o);
  const setPath = (o, p, v) => { const ks = p.split("."), l = ks.pop(); ks.reduce((x, k) => x[k], o)[l] = v; };
  (qs.get("set") || "").split(",").filter(Boolean).forEach((kv) => {
    const [p, v] = kv.split(":");
    if (p && Number.isFinite(+v)) { try { setPath(covCfg, p, +v); } catch (e) { /* 잘못된 키는 무시 */ } }
  });
  const covChanged = () => JSON.stringify(covCfg) !== JSON.stringify(COV.defaults());
  // [설정 경로, 이름, 단위, 최소, 최대, 간격, 방1에서 실제 Node 설정·규격값인가]
  const SLIDERS = [
    ["facing", "설치 방향", "°", 0, 359, 1, false],
    ["cam.range", "카메라 거리", "m", 0.5, 12, 0.25, false],
    ["cam.fov", "카메라 화각", "°", 20, 120, 5, false],
    ["pos.range", "위치 레이더 거리", "m", 0.5, 12, 0.25, true],
    ["pos.half", "위치 레이더 좌우", "±°", 15, 60, 5, true],
    ["pres.range", "재실 레이더 거리", "m", 0.5, 12, 0.25, true],
  ];
  const view = new EY.View3D($("scene"), $("overlay"));
  view.onManual = () => hint("마우스로 카메라를 움직였습니다 · C를 누르면 자동 카메라로 돌아갑니다");

  // ---------- 조립 (app.js와 같은 구독) ----------
  function build() {
    const clock = new EY.Clock(SC.base_time);
    const bus = new EY.Bus(clock);
    const s = { clock, bus };
    s.nodes = new EY.FakeNodes(clock, bus, SC);
    s.cover = COV.attach(s.nodes, clock, () => covCfg);
    EY.createDevices(s);
    s.wm = new EY.WorldModel(clock, bus);
    s.orch = new EY.MockOrchestrator(clock, bus);
    const st = { snap: null, dev: {}, bubbles: [], wmLine: null, actLine: null };
    const bubble = (room, kind, who, text, extra) => st.bubbles.push(Object.assign({ id: EY.uuid(), room, kind, who, text, until: clock.t + 5 }, extra));
    const personIn = (room) => {
      const p = st.snap && st.snap.people.find((x) => x.room_id === room && (x.presence === "SEEN" || x.presence === "HELD"));
      return p ? p.person_id : null;
    };
    bus.subscribe(EY.T.deviceResult, (r) => {
      if (r.status === "ACCEPTED") return;
      const d = s.orch.decisions.find((x) => x.command_id === r.command_id);
      const act = d ? d.act : r.action;
      const text = r.status === "COMPLETED" ? act : `${act} — ${r.status}`;
      const why = d ? (d.cause || d.why) : "";
      const old = st.bubbles.find((b) => b.kind === "device" && b.device === r.device_id && clock.t - b.at < 2);
      if (old) st.bubbles.splice(st.bubbles.indexOf(old), 1);
      bubble(null, "device", W.dev(r.device_id), old ? `${old.text} · ${text}` : text,
        { device: r.device_id, at: clock.t, why: why.length > 48 ? why.slice(0, 46) + "…" : why, until: clock.t + 6 });
    });
    bus.subscribe("eyear/v0/+/speak", (m, topic) => bubble(EY.T.roomOf(topic), "node", "EYEAR 스피커", m.text, { until: clock.t + 6 }));
    bus.subscribe("eyear/v0/+/voice/reply", (m, topic) => {
      const pid = personIn(EY.T.roomOf(topic));
      bubble(EY.T.roomOf(topic), "person", pid ? W.who(pid) : "?", m.no_response ? "(대답 없음)" : `${m.text}  (${m.confidence})`);
    });
    bus.subscribe("eyear/v0/+/voice/command", (m, topic) => {
      const pid = personIn(EY.T.roomOf(topic));
      bubble(EY.T.roomOf(topic), "person", pid ? W.who(pid) : "?", "하이 엘지, " + m.text);
    });
    const QUIET = new Set(["ENVIRONMENT_CHANGED", "DEVICE_STATE_CHANGED", "COMMAND_RESULT", "AUDIO_CHANGED"]);
    bus.subscribe(EY.T.snapshot, (m) => {
      if ((!st.snap || st.snap.revision !== m.revision) && m.revision > 0) {
        const loud = m.changes.filter((c) => !QUIET.has(c.type));
        if (loud.length) st.wmLine = { rev: m.revision, text: W.summary(loud, 3), t: clock.t };
      }
      st.snap = m;
    });
    bus.subscribe("eyear/v0/device/+/state", (m) => { st.dev[m.device_id] = m.state; });
    sim = s; store = st;
    view.reset();
  }

  function jumpTo(t) {
    if (!sim || t < sim.clock.t - 1e-6) build();
    sim.clock.advanceTo(Math.min(t, END));
    ui.ended = false;
    $("endcard").classList.remove("show");
  }
  function stepIndex(t) { let i = -1; STEPS.forEach((s, k) => { if (s.at <= t + 1e-6) i = k; }); return i; }

  // 범위를 바꾸면 처음부터 새 범위로 다시 돌려 지금 시각까지 맞춤 (되감기와 같은 방식)
  function resimulate() {
    const t = sim.clock.t;
    build();
    sim.clock.advanceTo(t);
    renderCovPanel();
  }
  function renderCovPanel() {
    const real = covRoom === "room1";
    $("covRoom").value = covRoom;
    $("covRows").innerHTML = SLIDERS.map(([p, name, unit, min, max, step, isReal]) => {
      const tag = real && isReal ? '<i class="real">실제값</i>' : '<i>가정</i>';
      const v = getPath(covCfg[covRoom], p);
      return `<label class="cr"><span>${name}${tag}</span><b id="cv-${p.replace(".", "-")}">${unit === "±°" ? `±${v}°` : v + unit}</b>` +
        `<input type="range" data-p="${p}" data-u="${unit}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
    }).join("");
    $("covNote").textContent = real
      ? "실제값: 지금 Node 설정·레이더 규격. 설치 위치·방향과 카메라 값은 아직 실측 전이라 가정"
      : "이 방은 실물 Node가 없어, 방 전체를 본다고 가정한 값";
    $("covState").textContent = covChanged() ? "기본값에서 바뀜 · 자막과 결과가 다를 수 있음" : "기본값 · 시나리오 그대로";
    $("covState").classList.toggle("warn", covChanged());
  }
  function toggleCovPanel() {
    $("covPanel").classList.toggle("open");
    if ($("covPanel").classList.contains("open")) { covOn = true; renderCovPanel(); }
  }
  function toggleCov() { covOn = !covOn; hint(covOn ? "센서 범위 표시" : "센서 범위 숨김"); }

  // ---------- 자막·패널 ----------
  let lastStep = null, lastWm = null, lastAct = null, lastSen = null;
  const SEN = {
    cam: ["카메라", { see: "봄", blind: "얼굴·자세 못 봄", out: "범위 밖", lost: "놓침", none: "감지 없음" }],
    pos: ["위치 레이더", { see: "추적 중", out: "범위 밖", lost: "놓침", none: "감지 없음" }],
    pres: ["재실 레이더", { see: "사람 있음", out: "범위 밖", lost: "놓침", none: "감지 없음" }],
  };
  function renderSensors(s, off) {
    const room = s && s.rooms && s.rooms.living ? "living" : "room1";
    const st = sim.cover.status[room], dead = off.includes(room);
    const html = dead ? '<span class="none">Node 끊김 · 센서 값이 들어오지 않음</span>' : Object.entries(SEN).map(([k, [name, words]]) =>
      `<span class="sc ${st[k] === "see" ? "yes" : st[k] === "none" ? "idle" : "no"}"><i class="sw ${k}"></i>${name} <b>${words[st[k]]}</b></span>`).join("") +
      (covChanged() ? '<span class="sc chg">범위 변경됨</span>' : "");
    const key = room + html;
    if (key !== lastSen) { lastSen = key; $("senKey").textContent = W.room(room) + " 센서"; $("sen").innerHTML = html; }
  }
  function renderHud() {
    const t = sim.clock.t, i = stepIndex(t), s = SC.steps[i];
    $("clock").textContent = sim.clock.hhmmss();
    $("speed").textContent = ui.playing ? `${speedAt(t)}×` : "일시정지";
    const held = !AUTO && ui.started && !ui.playing && !ui.ended;
    $("cue").classList.toggle("show", held);
    $("cue").innerHTML = `<span>${Math.max(1, i + 1)} / ${STEPS.length}</span>` + (held ? "Space ▶ 다음" : "");
    $("bar").style.width = Math.min(100, t / END * 100) + "%";
    document.querySelectorAll("#ticks .tk").forEach((e, k) => e.classList.toggle("done", SC.steps[k].at <= t + 1e-6));

    const off = Object.entries(sim.nodes.nodes).filter(([, n]) => !n.online).map(([r]) => r);
    const key = off.length ? "fault:" + off.join(",") : s ? s.id : "";
    if (key !== lastStep) {
      lastStep = key;
      const [head, note] = off.length
        ? [`${off.map(W.room).join("·")} Node 연결 끊김 → 3초 뒤 ‘빈 방’이 아니라 ‘모름’`, "모르는 방에는 청소기를 보내지 않고, 에어컨은 설정을 그대로 둡니다 · N을 다시 누르면 복구"]
        : (STORY[s && s.id] || [s ? s.title : "", ""]);
      $("stepId").textContent = off.length ? "장애" : s ? s.id : "";
      $("head").textContent = head;
      $("note").textContent = note;
      const cap = $("caption");
      cap.classList.remove("pop"); void cap.offsetWidth; cap.classList.add("pop");
    }
    renderSensors(s, off);
    const wm = store.wmLine;
    const wmKey = wm ? wm.rev : null;
    if (wmKey !== lastWm) {
      lastWm = wmKey;
      $("wm").innerHTML = wm ? `${esc(wm.text)}<span class="rev">rev ${wm.rev}</span>` : "—";
      flash("wmRow");
    }
    const d = sim.orch.decisions.filter((x) => x.dev && x.now > t - 8 && x.now <= t).slice(0, 3).reverse();
    const actKey = d.map((x) => x.command_id || x.now + x.act).join("|");
    if (actKey !== lastAct) {
      lastAct = actKey;
      if (d.length) {
        $("act").innerHTML = d.map((x) => `<span class="ai">${esc(x.dev)} · ${esc(x.act)}</span>`).join("");
        flash("actRow");
      } else $("act").innerHTML = '<span class="none">새 명령 없음</span>';
    }
    // 사람 목록
    const snap = store.snap;
    const html = snap ? snap.people.map((p) => `<li class="p-${p.presence}"><i class="dot ${W.who(p.person_id)}"></i><b>${esc(W.who(p.person_id))}</b>` +
      `<span class="where">${esc(W.room(p.room_id))} · ${esc(p.presence === "SEEN" && p.identity_source === "TRACK_CARRIED" ? "감지 중" : { SEEN: "보임", HELD: "레이더로만 확인", IN_TRANSIT: "이동 중", LAST_KNOWN: "위치 모름" }[p.presence])}</span></li>`).join("") : "";
    if ($("people")._h !== html) { $("people").innerHTML = html; $("people")._h = html; }
  }
  function flash(id) { const e = $(id); e.classList.remove("flash"); void e.offsetWidth; e.classList.add("flash"); }
  let hintTimer = null;
  function hint(text) {
    $("hint").textContent = text; $("hint").classList.add("show");
    clearTimeout(hintTimer); hintTimer = setTimeout(() => $("hint").classList.remove("show"), 2600);
  }

  // ---------- 조작 ----------
  $("ticks").innerHTML = SC.steps.filter((s) => s.at < END).map((s) => `<i class="tk" style="left:${s.at / END * 100}%" title="${esc(s.id)}"></i>`).join("");
  function start() {
    $("intro").classList.add("gone");
    ui.started = true;
    if (ui.ended) { ui.playing = false; build(); jumpTo(0.5); lastStep = null; return true; }
    return false;
  }
  // 자동 모드: 재생/정지
  function togglePlay() {
    const restarted = start();
    ui.stopAt = null;
    ui.playing = restarted || !ui.playing;
  }
  // 단계 모드: 다음 단계 재생 (재생 중에 누르면 그 단계를 바로 끝까지)
  function next() {
    if (start()) { playSeg(0); return; }   // 끝난 뒤 → 처음부터
    if (ui.playing) { jumpTo(ui.stopAt || END); ui.playing = false; return; }
    const t = sim.clock.t, cur = Math.max(0, stepIndex(t));
    if (t < segEnd(cur) - 0.01) playSeg(cur);          // 이 단계를 아직 다 안 봄
    else if (cur + 1 < STEPS.length) playSeg(cur + 1);
  }
  function playSeg(k) {
    if (sim.clock.t < STEPS[k].at - 0.01) jumpTo(STEPS[k].at);
    ui.stopAt = segEnd(k);
    ui.playing = true;
  }
  // 이전 단계: 그 단계가 끝난 화면으로
  function prev() {
    $("intro").classList.add("gone");
    ui.started = true;
    ui.playing = false;
    const t = sim.clock.t;
    const k = stepIndex(t);
    jumpTo(k > 0 ? segEnd(k - 1) : 0.5);
  }
  const clickers = { PageDown: "next", Enter: "next", ArrowDown: "next", PageUp: "prev", ArrowUp: "prev" };
  document.addEventListener("keydown", (e) => {
    if (e.target.matches && e.target.matches("input,select")) return;   // 설정 창 조작 중에는 진행 키가 먹지 않게
    const k = e.key.toLowerCase();
    if (e.key === " ") { e.preventDefault(); AUTO ? togglePlay() : next(); }
    else if (e.key === "ArrowRight" || clickers[e.key] === "next") {
      e.preventDefault();
      if (AUTO) { const nx = STEPS.find((s) => s.at > sim.clock.t + 0.6); jumpTo(nx ? nx.at + 0.5 : END); }
      else next();
    }
    else if (e.key === "ArrowLeft" || clickers[e.key] === "prev") {
      e.preventDefault();
      if (AUTO) { const i = stepIndex(sim.clock.t - 1.5); jumpTo(i >= 0 ? STEPS[i].at + 0.5 : 0.5); }
      else prev();
    }
    else if (k === "p") { start(); ui.playing = !ui.playing && (ui.stopAt === null || sim.clock.t < ui.stopAt); }
    else if (k === "r") { ui.playing = false; ui.started = false; ui.stopAt = null; build(); jumpTo(0.5); lastStep = null; $("intro").classList.remove("gone"); }
    else if (k === "c") { view.auto = true; hint("자동 카메라"); }
    else if (k === "h") document.body.classList.toggle("clean");
    else if (k === "v") toggleCov();
    else if (k === "s") toggleCovPanel();
    else if (k === "n") {
      const on = !sim.nodes.nodes.living.online;
      sim.nodes.setOnline("living", on);
      hint(on ? "거실 Node 다시 켬 (seq 0부터 새 세션)" : "거실 Node 끔 → 3초 뒤 STALE");
    }
    else if (k === "f") { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); }
  });
  const go = () => (AUTO ? togglePlay() : next());
  $("intro").addEventListener("click", go);
  $("endcard").addEventListener("click", go);
  $("caption").addEventListener("click", go);
  $("covBtn").addEventListener("click", (e) => { toggleCovPanel(); e.currentTarget.blur(); });
  $("covRoom").addEventListener("change", (e) => {
    covRoom = e.target.value; e.target.blur();
    view.setCoverage(covCfg, covRoom); renderCovPanel();
  });
  // 끄는 동안에는 그림만 바꾸고, 손을 놓으면 그 범위로 다시 계산
  $("covRows").addEventListener("input", (e) => {
    const { p, u } = e.target.dataset, v = +e.target.value;
    setPath(covCfg[covRoom], p, v);
    $("cv-" + p.replace(".", "-")).textContent = u === "±°" ? `±${v}°` : v + u;
    view.setCoverage(covCfg, covRoom);
  });
  $("covRows").addEventListener("change", (e) => { e.target.blur(); resimulate(); });
  $("covReset").addEventListener("click", (e) => {
    e.currentTarget.blur();
    covCfg = COV.defaults();
    view.setCoverage(covCfg, covRoom);
    resimulate();
    hint("센서 범위를 기본값으로 되돌림");
  });

  // ---------- 루프 ----------
  let lastFrame = null;
  function loop(ts) {
    const rdt = lastFrame === null ? 0 : Math.min(0.1, (ts - lastFrame) / 1000);
    lastFrame = ts;
    if (ui.playing) {
      const stop = Math.min(END, ui.stopAt === null ? END : ui.stopAt);
      sim.clock.advanceTo(Math.min(sim.clock.t + rdt * speedAt(sim.clock.t), stop));
      if (sim.clock.t >= stop - 1e-6) ui.playing = false;
      if (sim.clock.t >= END - 1e-6) { ui.playing = false; ui.ended = true; $("endcard").classList.add("show"); }
    }
    const t = sim.clock.t;
    store.bubbles = store.bubbles.filter((b) => b.until > t);
    const shot = shotAt(t);
    if (shot !== lastShot) { lastShot = shot; view.setShot(shot[1], shot[2]); }
    const offline = {};
    Object.entries(sim.nodes.nodes).forEach(([r, n]) => { offline[r] = !n.online; });
    view.updateCoverage(covOn, sim.cover.status);
    view.frame(t, store.snap, store.dev, store.bubbles, offline, rdt);
    renderHud();
    requestAnimationFrame(loop);
  }

  build();
  view.setCoverage(covCfg, covRoom);
  renderCovPanel();
  if (qs.has("panel")) $("covPanel").classList.add("open");
  sim.clock.advanceTo(Math.max(0.5, +qs.get("t") || 0));
  const s0 = shotAt(sim.clock.t);
  view.camera.position.set(...s0[1]); view.controls.target.set(...s0[2]);
  if (qs.has("play")) go();
  requestAnimationFrame(loop);
  window.EY_SIM = () => sim;
})();
