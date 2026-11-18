// 가짜 Node: 반석님 eyear-node/publisher/scenarios/summer_evening.yaml (faf518d, 2026-11-12 좌표 합의 반영)을 옮긴 것.
// 메시지 형식·changes 규칙·heartbeat 규칙은 eyear-node fusion/events.py와 같게 맞춤.
// 다른 점 (시뮬레이터용으로 추가):
//   1) 단계 사이 간격은 sim 초 (at)
//   2) t6을 실제 Node 동작(2026-11-12 실측)에 맞게 셋으로 나눔:
//      문 쪽으로 걸어감 → 위치 추적이 먼저 놓침(persons [] + OCCUPIED, 약 6초) → EMPTY
//   3) 조명 연동: 방에 가상 조명이 있으면 조명 상태가 light 값을 덮어씀 (끄면 DARK)
//   4) 장애 주입: Node 끄기(→ heartbeat 끊김), 재시작(→ seq가 0부터 다시)
// 좌표는 방 좌표: 그 방 왼쪽 아래 모서리가 원점, x는 동쪽, y는 북쪽 (m)
window.EY = window.EY || {};

(function () {
  const empty_dark = {
    occupancy: { state: "EMPTY", confidence: 0.95 }, persons: [],
    audio: { context: "SILENT", confidence: 0.85 }, light: "DARK",
  };
  const B_on_sofa = {
    track_id: 1, identity: "MEMBER_B", identity_confidence: 0.93, identity_source: "FACE",
    posture: "SITTING", posture_confidence: 0.90, motion: "SLIGHT",
    activity: "OTHER", activity_confidence: 0.85, position: { x: 0.60, y: 4.90 },
  };
  const A = (o) => Object.assign({
    track_id: 1, identity: "MEMBER_A", identity_confidence: 0.92, identity_source: "FACE",
    posture: "STANDING", posture_confidence: 0.88, motion: "ACTIVE",
    activity: "OTHER", activity_confidence: 0.85, position: null,
  }, o);
  const living = (persons, conf) => ({ occupancy: { state: "OCCUPIED", confidence: conf }, persons, audio: { context: "TV", confidence: 0.82 }, light: "BRIGHT" });

  EY.SCENARIO = {
    name: "summer_evening",
    base_time: "2026-07-15T21:00:00+09:00",
    end_at: 135,
    nodes: { room1: "node_room1", room2: "node_room2", living: "node_living", laundry: "node_laundry" },
    steps: [
      { id: "t0", at: 0, title: "세탁기 작동 중, 거실에서 B 혼자 TV 시청, 청소기는 방2 청소 마무리",
        expect: "거실 에어컨 26°C, 바람은 B 쪽 / 청소기는 거실을 지나 도크로 복귀",
        rooms: {
          room1: { occupancy: { state: "EMPTY", confidence: 0.95 }, persons: [], audio: { context: "SILENT", confidence: 0.80 }, light: "BRIGHT" },
          room2: empty_dark,
          laundry: { occupancy: { state: "EMPTY", confidence: 0.95 }, persons: [], audio: { context: "LOUD_NOISE", confidence: 0.80 }, light: "DIM" },
          living: living([B_on_sofa], 0.97),
        } },
      { id: "t1", at: 18, title: "A가 밝은 방1에 들어옴 → 얼굴로 A 식별",
        expect: "청소기 도크 대기(방1 보류), 세탁기 저소음, 방1 에어컨 24°C",
        rooms: { room1: { occupancy: { state: "OCCUPIED", confidence: 0.95 },
          persons: [A({ identity_confidence: 0.91, position: { x: 1.40, y: 1.25 } })],
          audio: { context: "SILENT", confidence: 0.80 }, light: "BRIGHT" } } },
      { id: "t2", at: 32, title: "A가 침대에 누움 → RESTING (휴식 1회차 시작)",
        expect: "중앙이 질문 생성 → room1 speak로 \"A님, 주무실 거면 '네'라고 말씀해 주세요\"",
        rooms: { room1: { occupancy: { state: "OCCUPIED", confidence: 0.97 },
          persons: [A({ posture: "LYING", posture_confidence: 0.84, motion: "SLIGHT", activity: "RESTING", activity_confidence: 0.80, position: { x: 2.40, y: 2.67 } })],
          audio: { context: "SILENT", confidence: 0.80 }, light: "BRIGHT" } } },
      { id: "t3", at: 38, title: "A가 대답 (기본 \"응.\" 0.55 · 방 상태 변화 없음)",
        expect: "질문 읽기 약 3.5초 + 1.5초 뒤 대답 → 문장부호 빼고 긍정 → 커튼 닫고 조명 끔",
        rooms: {} },
      { id: "t4", at: 50, title: "[수면 중] 방1 어두움 → 신원은 TRACK_CARRIED, 자세는 모름(UNKNOWN), 휴식은 유지",
        expect: "어두우면 자세를 지어내지 않음. 같은 휴식 회차라 다시 묻지 않음 / 청소기 보류·세탁기 저소음 유지",
        rooms: { room1: { occupancy: { state: "OCCUPIED", confidence: 0.93 },
          persons: [A({ identity_confidence: 0.75, identity_source: "TRACK_CARRIED", posture: "UNKNOWN", posture_confidence: 0.0, motion: "STILL", activity: "RESTING", activity_confidence: 0.70, position: { x: 2.40, y: 2.67 } })],
          audio: { context: "SILENT", confidence: 0.85 }, light: "DARK" } } },
      { id: "t5-1", at: 64, title: "[기상] A \"하이 엘지, 불 켜줘\"",
        expect: "중앙이 조명 켬 → room1 speak로 \"네, 불을 켤게요\"",
        voice_commands: [{ room: "room1", text: "불 켜줘", confidence: 0.81 }],
        rooms: { room1: { occupancy: { state: "OCCUPIED", confidence: 0.96 },
          persons: [A({ identity_confidence: 0.75, identity_source: "TRACK_CARRIED", posture: "UNKNOWN", posture_confidence: 0.0, motion: "ACTIVE", activity: "RESTING", activity_confidence: 0.55, position: { x: 2.40, y: 2.67 } })],
          audio: { context: "SPEECH", confidence: 0.78 }, light: "DARK" } } },
      { id: "t5-2", at: 70, title: "밝아짐 → 카메라가 A 재확인 (FACE 복귀), 침대에 앉음 → 휴식 끝",
        expect: "커튼은 요청이 없으므로 그대로",
        rooms: { room1: { occupancy: { state: "OCCUPIED", confidence: 0.97 },
          persons: [A({ identity_confidence: 0.93, posture: "SITTING", posture_confidence: 0.85, activity: "OTHER", position: { x: 2.40, y: 2.55 } })],
          audio: { context: "SILENT", confidence: 0.80 }, light: "BRIGHT" } } },
      { id: "t6-1", at: 82, title: "A가 일어나 문 쪽으로 걸어감",
        expect: "아직 방1에 있음 → 청소기는 계속 보류",
        rooms: { room1: { occupancy: { state: "OCCUPIED", confidence: 0.96 },
          persons: [A({ identity_confidence: 0.90, posture: "WALKING", posture_confidence: 0.80, position: { x: 0.50, y: 1.20 } })],
          audio: { context: "SILENT", confidence: 0.80 }, light: "BRIGHT" } } },
      { id: "t6-2", at: 86, title: "문을 나서는 중 → 위치 추적은 놓쳤지만 재실 레이더는 아직 사람 있음",
        expect: "World Model이 A를 방1에 HELD로 유지 → \"방1 비었음\"으로 보지 않음 (실측: EMPTY까지 6~7초)",
        rooms: { room1: { occupancy: { state: "OCCUPIED", confidence: 0.70 }, persons: [],
          audio: { context: "SILENT", confidence: 0.80 }, light: "BRIGHT" } } },
      { id: "t6-3", at: 92, title: "방1 비어 있음 → A는 이동 중(IN_TRANSIT)",
        expect: "청소기 도크에서 나와 방1 청소 시작 / 세탁기 일반 모드 / 방1 에어컨 꺼짐 / A는 10초 동안 '이동 중'",
        rooms: { room1: { occupancy: { state: "EMPTY", confidence: 0.95 }, persons: [], audio: { context: "SILENT", confidence: 0.80 }, light: "BRIGHT" } } },
      { id: "t7-1", at: 98, title: "A가 거실에 들어옴 → 거실 Node가 A 식별",
        expect: "온도 에이전트가 A·B 모두 거실에 있음을 파악 → 거실 에어컨 25°C(A·B 평균), 바람 A 쪽",
        rooms: { living: living([B_on_sofa, A({ track_id: 2, identity_confidence: 0.90, posture: "WALKING", posture_confidence: 0.82, position: { x: 1.60, y: 3.00 } })], 0.97) } },
      { id: "t7-2", at: 106, title: "A가 소파 아래쪽 자리, B 옆에 앉음",
        expect: "앉은 것은 RESTING 아님 → 질문 없음, 에어컨은 그대로 / 방1 청소 끝난 청소기 도크로",
        rooms: { living: living([B_on_sofa, A({ track_id: 2, posture: "SITTING", posture_confidence: 0.88, motion: "SLIGHT", position: { x: 0.60, y: 2.40 } })], 0.98) } },
    ],
  };

  // ---------- eyear-node fusion/events.py diff_changes와 같은 규칙 ----------
  EY.diffChanges = (prev, curr) => {
    if (!prev) return [];
    const ch = [];
    const before = new Map(prev.persons.map((p) => [p.track_id, p]));
    const after = new Map(curr.persons.map((p) => [p.track_id, p]));
    const ids = (m) => [...m.keys()].sort((a, b) => a - b);
    ids(before).filter((k) => !after.has(k)).forEach((k) => ch.push({ type: "PERSON_LEFT", track_id: k }));
    ids(after).filter((k) => !before.has(k)).forEach((k) => ch.push({ type: "PERSON_ENTERED", track_id: k }));
    ids(before).filter((k) => after.has(k)).forEach((k) => {
      const b = before.get(k), a = after.get(k);
      if (b.identity !== a.identity || b.identity_source !== a.identity_source) ch.push({ type: "IDENTITY_CHANGED", track_id: k });
      if (b.posture !== a.posture) ch.push({ type: "POSTURE_CHANGED", track_id: k });
      if (b.activity !== a.activity) ch.push({ type: "ACTIVITY_CHANGED", track_id: k });
    });
    if (prev.occupancy.state !== curr.occupancy.state) ch.push({ type: "OCCUPANCY_CHANGED", track_id: null });
    if (prev.audio.context !== curr.audio.context) ch.push({ type: "AUDIO_CHANGED", track_id: null });
    if (prev.light !== curr.light) ch.push({ type: "LIGHT_CHANGED", track_id: null });
    return ch;
  };

  // 실측(2026-11-06·11-11, Whisper small) 기준 가짜 대답. 문장부호가 붙고, 짧은 대답은 신뢰도가 낮음
  EY.REPLY_PRESETS = {
    yes:   { label: '"응." (0.55)', text: "응.", confidence: 0.55 },
    ne:    { label: '"네." (0.55)', text: "네.", confidence: 0.55 },
    quiet: { label: '작게 "응." (0.31, 늦게)', text: "응.", confidence: 0.31, late: true },
    q:     { label: '"응?" (0.48)', text: "응?", confidence: 0.48 },
    no:    { label: '"아니." (0.79)', text: "아니.", confidence: 0.79 },
    none:  { label: "무응답", text: null },
  };
  // 스피커로 문장을 읽는 시간 (대략 글자당 0.12초, 가정값)
  EY.speakSeconds = (text) => +(0.5 + (text || "").length * 0.12).toFixed(1);

  EY.FakeNodes = class {
    constructor(clock, bus, scenario) {
      this.clock = clock; this.bus = bus; this.sc = scenario;
      this.reply = "yes";       // 가짜 음성 대답 프리셋 (EY.REPLY_PRESETS)
      this.trackLost = {};      // 방 → true면 위치 레이더가 사람을 놓침 (재실 레이더는 유지)
      this.lightDev = {};       // 방 → 가상 조명 power
      this.stepIndex = -1;
      this.nodes = {};
      Object.entries(scenario.nodes).forEach(([room, node_id]) => {
        this.nodes[room] = { room, node_id, online: true, seq: 0, prev: null, lastSent: null, script: null };
      });
      scenario.steps.forEach((s, i) => clock.at(s.at, () => this.applyStep(i)));
      clock.onTick(() => this.update());
      bus.subscribe("eyear/v0/+/speak", (p, topic) => this.onSpeak(EY.T.roomOf(topic), p));
      bus.subscribe("eyear/v0/device/+/state", (p) => {
        if (p.type === "LIGHT") this.lightDev[p.room_id] = p.state.power;
      });
    }

    applyStep(i) {
      const s = this.sc.steps[i];
      this.stepIndex = i;
      // 반석님 송신기처럼 음성 명령을 먼저 보내고 방 상태를 보냄
      (s.voice_commands || []).forEach((vc) => {
        const n = this.nodes[vc.room];
        if (!n.online) return;
        this.bus.publish(EY.T.voiceCommand(vc.room), {
          schema_version: "0.1", event_id: EY.uuid(), node_id: n.node_id, room_id: vc.room,
          timestamp: this.clock.iso(), type: "VOICE_COMMAND", text: vc.text, confidence: vc.confidence,
        });
      });
      Object.entries(s.rooms).forEach(([room, st]) => { this.nodes[room].script = EY.clone(st); });
    }

    // 시나리오 값 + 가상 조명 연동 = Node가 지금 보고 있는 방 상태
    effective(n) {
      const snap = EY.clone(n.script);
      // 가만히 누운 사람을 위치 레이더(LD2450)가 놓친 상황: persons는 비지만 재실 레이더(LD2410C)가 OCCUPIED 유지
      if (this.trackLost[n.room] && snap.occupancy.state === "OCCUPIED") snap.persons = [];
      const power = this.lightDev[n.room];
      if (power === "OFF") snap.light = "DARK";
      else if (power === "ON" && snap.light === "DARK") snap.light = "BRIGHT";
      return snap;
    }

    update() {
      const t = this.clock.t;
      Object.values(this.nodes).forEach((n) => {
        if (!n.online || !n.script) return;
        const snap = this.effective(n);
        const changes = EY.diffChanges(n.prev, snap);
        let type;
        if (changes.length) type = "STATE_CHANGE";
        else if (n.lastSent === null || t - n.lastSent >= 1.0 - 1e-6) type = "HEARTBEAT";
        else return;
        this.bus.publish(EY.T.state(n.room), {
          schema_version: "0.1", event_id: EY.uuid(), node_id: n.node_id, room_id: n.room,
          timestamp: this.clock.iso(), seq: n.seq, event_type: type, changes, ...snap,
        });
        n.seq += 1; n.prev = snap; n.lastSent = t;
      });
    }

    // Node가 질문을 다 읽은 뒤(EY.speakSeconds) listen_seconds 동안 들음
    onSpeak(room, cmd) {
      const n = this.nodes[room];
      if (!n || !n.online || !cmd.expect_reply) return;
      const pr = EY.REPLY_PRESETS[this.reply] || EY.REPLY_PRESETS.none;
      const listen = Math.min(cmd.listen_seconds || 5, 10);
      // 대답 있음: 다 읽고 1.5초 뒤 / 작게 말함: 마감 후 0.7초 / 무응답: 마감 때
      const delay = EY.speakSeconds(cmd.text) + (pr.text === null ? listen : pr.late ? listen + 0.7 : 1.5);
      this.clock.after(delay, () => {
        if (!n.online) return;
        const has = pr.text !== null;
        this.bus.publish(EY.T.voiceReply(room), {
          schema_version: "0.1", event_id: EY.uuid(), node_id: n.node_id, room_id: room,
          timestamp: this.clock.iso(), type: "VOICE_REPLY", command_id: cmd.command_id,
          text: has ? pr.text : null, confidence: has ? pr.confidence : null, no_response: !has,
        });
      });
    }

    // ---------- 장애 주입 ----------
    setOnline(room, on) {
      const n = this.nodes[room];
      if (n.online === on) return;
      n.online = on;
      if (on) this.restart(room);    // 다시 켜면 재시작한 것과 같음
    }
    setTrackLost(room, on) { this.trackLost[room] = on; }
    restart(room) {
      const n = this.nodes[room];
      n.seq = 0; n.prev = null; n.lastSent = null;   // 첫 메시지는 HEARTBEAT seq 0 (World Model은 "seq가 줄었는데 시각은 최신"으로 재시작을 알아챔)
    }
  };
})();
