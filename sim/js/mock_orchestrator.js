// ⚠ 임시 중앙 판단 (정빈님 Orchestrator 자리를 채우는 가짜). 규칙 몇 줄로 시나리오만 돌아가게 함.
// 실제 구현이 생기면 이 파일을 빼고, 같은 토픽(snapshot 받기 → device command·speak 보내기)으로 붙이면 됨.
// 입력: eyear/v0/world/snapshot (WorldSnapshot 0.1), eyear/v0/world/device_result, eyear/v0/{room}/voice/reply|command
// 출력: eyear/v0/device/{id}/command (action은 명세서 7.1절), eyear/v0/{room}/speak, eyear/v0/orchestrator/trace (화면용)
window.EY = window.EY || {};

(function () {
  const H = EY.HOME;
  const label = (id) => (H.preferences[id] ? H.preferences[id].label : id);
  const rname = (room) => (H.rooms[room] ? H.rooms[room].name : room);
  // Node는 들은 말을 그대로 보냄. 문장부호("응.", "응?")와 공백은 빼고 해석 (eyear-node docs/schema_v0.md 3장)
  const norm = (t) => (t || "").replace(/[\s.,!?~…'"]/g, "");
  const NO = /^(아니|아뇨|안|싫|괜찮)/;
  const YES = /^(응|네|넹|어|예|그래|좋아|잘)/;
  const MIN_CONF = 0.2;     // 짧은 대답은 0.3 안팎도 정상 → 기준을 낮게
  const LISTEN = 8;
  const HERE = ["SEEN", "HELD"];   // 지금 이 방에 있다고 보는 presence

  EY.MockOrchestrator = class {
    constructor(clock, bus) {
      this.clock = clock; this.bus = bus;
      this.snap = null;
      this.pending = {};        // device → Set(command_id) 진행 중 명령 (에어컨은 여러 개 동시에 가능)
      this.cooldown = {};       // device → 이 시각 전엔 다시 판단 안 함 (거절 반복 방지)
      this.decisions = [];      // 화면용 판단 기록
      this.cause = null;        // 스냅샷 변화가 아닌 원인(음성 대답·명령) — 화면용
      this.asked = new Set();   // "person_id#rest_episode" → 이번 휴식에서 이미 물어봄
      this.questions = {};      // command_id → {room, person}
      this.agents = {};

      bus.subscribe(EY.T.snapshot, (s) => { this.snap = s; this.run(); });
      bus.subscribe(EY.T.deviceResult, (r) => this.onResult(r));
      bus.subscribe("eyear/v0/+/voice/reply", (m, topic) => this.onReply(EY.T.roomOf(topic), m));
      bus.subscribe("eyear/v0/+/voice/command", (m, topic) => this.onVoice(EY.T.roomOf(topic), m));
    }

    // ---------- 스냅샷 조회 ----------
    room(id) { return this.snap.rooms.find((r) => r.room_id === id); }
    dev(id) { return this.snap.devices.find((d) => d.device_id === id); }
    st(id) { const d = this.dev(id); return (d && d.state) || {}; }
    // 이번 판단을 부른 변화 (화면에서 "왜"를 이어 보여 주려고 기록)
    trigger() {
      const c = this.snap.changes || [];
      return c.slice(0, 3).map((x) => [x.type, x.room_id || x.device_id, x.person_id, x.after].filter(Boolean).join(" ")).join(" · ");
    }

    // ---------- 기록 ----------
    log(dev, act, why, cmd, agent) {
      this.decisions.unshift({
        t: this.clock.hhmmss(), now: this.clock.t, rev: this.snap ? this.snap.revision : null, agent: agent || null, cause: this.cause || null,
        dev, act, why, command_id: cmd ? cmd.command_id : null, device_id: cmd ? cmd.device_id : null, status: cmd ? "SENT" : "INFO",
      });
      if (this.decisions.length > 40) this.decisions.pop();
    }
    command(device, action, params, actText, why, agent) {
      const cmd = { schema_version: "0.1", command_id: EY.uuid(), device_id: device, action, params: params || {}, issued_by: "mock_orchestrator",
        based_on_revision: this.snap ? this.snap.revision : null, timestamp: this.clock.iso() };
      (this.pending[device] = this.pending[device] || new Set()).add(cmd.command_id);
      this.bus.publish(EY.T.devCommand(device), cmd);
      this.log(H.devices[device].name, actText, why, cmd, agent);
    }
    speak(room, text, expectReply, why, meta) {
      const cmd = { schema_version: "0.1", command_id: EY.uuid(), timestamp: this.clock.iso(), text, expect_reply: expectReply, listen_seconds: expectReply ? LISTEN : 0 };
      if (meta) {
        // Node가 no_response조차 못 보낼 수 있으니 직접 기한을 둠: 말하는 시간 + listen_seconds + 2초
        const wait = +(EY.speakSeconds(text) + LISTEN + 2).toFixed(1);
        this.questions[cmd.command_id] = meta;
        this.clock.after(wait, () => {
          if (!this.questions[cmd.command_id]) return;
          delete this.questions[cmd.command_id];
          this.cause = "질문 대답 기한 지남";
          this.log(rname(room), "대답 안 옴 → 아무것도 안 함", `${wait}초 안에 reply도 no_response도 없음 (Node 끊김?)`, null, "light");
          this.cause = null;
          this.publishTrace();
        });
      }
      this.bus.publish(EY.T.speak(room), cmd);
      this.log(`${rname(room)} 스피커`, `말하기 "${text}"`, why, null, meta ? "light" : "voice");
    }
    onResult(r) {
      const d = this.decisions.find((x) => x.command_id === r.command_id);
      if (d) { d.status = r.status + (r.reason ? ` · ${r.reason}` : ""); d.result_rev = r.revision; }
      if (r.status === "ACCEPTED") return;
      const set = this.pending[r.device_id];
      if (set) { set.delete(r.command_id); if (!set.size) delete this.pending[r.device_id]; }
      // 결과가 다음 스냅샷에 반영될 시간을 조금 줌. 거절이면 같은 판단을 10초 동안 반복하지 않음
      this.cooldown[r.device_id] = this.clock.t + (r.status === "REJECTED" ? 10 : 0.5);
    }
    ready(device) { return !this.pending[device] && !(this.cooldown[device] > this.clock.t); }

    // ---------- 공통 상황 ----------
    roomInfo(id) {
      const r = this.room(id);
      const people = this.snap.people.filter((p) => p.room_id === id && HERE.includes(p.presence));
      return { r, people, fresh: r.source.status === "FRESH", occ: r.occupancy.state };
    }
    // 사람이 있거나 모르는 방 = 청소기·소음 금지
    banned() {
      return this.snap.rooms.filter((r) => r.occupancy.state === "OCCUPIED" || r.occupancy.state === "UNKNOWN").map((r) => r.room_id);
    }

    run() {
      if (!this.snap) return;
      // 막 켜졌을 때는 모든 방이 '데이터 없음'이라 전부 금지로 보임 → 첫 메시지들이 들어올 때까지 2초 기다림
      if (this.clock.t < 2 && this.snap.rooms.some((r) => r.source.status === "NO_DATA")) return;
      const banned = this.banned();
      const ag = this.agents = {};
      const why0 = this.trigger();

      // ===== 소음 에이전트 =====
      const w = this.st("washer");
      const quietNeeded = H.rooms.laundry.adjacent.filter((k) => banned.includes(k));
      const wantMode = quietNeeded.length ? "LOW_NOISE" : "NORMAL";
      ag.noise = {
        sit: `사람 있거나 모르는 방: ${banned.map(rname).join(", ") || "없음"} · 세탁기 ${w.power === "RUNNING" ? "작동 중(" + w.mode + ")" : w.power || "?"}`,
        rec: (quietNeeded.length ? `세탁실 옆 ${quietNeeded.map(rname).join(", ")}에 사람 → 저소음` : "세탁실 옆에 사람 없음 → 일반 모드") +
          ` · 청소기 금지: ${banned.map(rname).join(", ") || "없음"}`,
      };
      if (w.power === "RUNNING" && w.mode !== wantMode && this.ready("washer")) {
        this.command("washer", "SET_MODE", { mode: wantMode }, wantMode === "LOW_NOISE" ? "저소음 모드로" : "일반 모드로", ag.noise.rec, "noise");
      }

      // ===== 청소 에이전트 =====
      const v = this.st("vacuum");
      const bat = typeof v.battery === "number" ? Math.round(v.battery * 100) : null;   // 스냅샷은 0~1
      const cands = this.snap.rooms
        .filter((r) => H.rooms[r.room_id].cleanable && r.dirt_level.value !== null)
        .sort((a, b) => b.dirt_level.value - a.dirt_level.value);
      const dirty = cands.filter((r) => r.dirt_level.value >= 0.5);
      const target = dirty.find((r) => !banned.includes(r.room_id));
      ag.clean = {
        sit: `오염도 ${cands.map((r) => r.name + " " + r.dirt_level.value.toFixed(2)).join(" · ")} · 청소기 ${v.status || "?"}${bat !== null ? " " + bat + "%" : ""}`,
        rec: "",
      };
      if ((v.status === "TO_ROOM" || v.status === "CLEANING") && banned.includes(v.room)) {
        ag.clean.rec = `${rname(v.room)}에 사람이 생김 → 도크 복귀`;
        if (this.ready("vacuum")) this.command("vacuum", "RETURN_TO_DOCK", {}, "청소 중단, 도크로", ag.clean.rec, "clean");
      } else if (v.status === "DOCKED") {
        if (!dirty.length) ag.clean.rec = "청소할 만큼 더러운 방 없음 → 대기";
        else if (!target) ag.clean.rec = `${dirty.map((r) => r.name).join(", ")} 더러움, 하지만 사람이 있거나 모름 → 보류`;
        else if (bat < 50) ag.clean.rec = `${target.name} 청소 필요, 배터리 ${bat}% → 충전 후 (50% 이상)`;
        else {
          ag.clean.rec = `${target.name} 비어 있고 오염도 ${target.dirt_level.value.toFixed(2)} → 청소`;
          if (this.ready("vacuum")) this.command("vacuum", "CLEAN_ROOM", { room: target.room_id }, `${target.name} 청소`, ag.clean.rec, "clean");
        }
      } else {
        ag.clean.rec = v.status === "RETURNING" ? "청소 끝, 복귀 중 (돌아갈 때는 사람 있는 곳 지나가도 됨)" : `${rname(v.room)} 청소 진행 중`;
      }

      // ===== 온도 에이전트 =====
      const tempSit = [], tempRec = [];
      Object.entries(H.devices).filter(([, d]) => d.type === "AC").forEach(([id, d]) => {
        const { r, people, fresh, occ } = this.roomInfo(d.room);
        const ac = this.st(id);
        const known = people.filter((p) => H.preferences[p.identity]);
        const tv = r.temperature_c.value;
        tempSit.push(`${r.name} ${tv !== null ? tv.toFixed(1) + "°C" : "?"}, ${fresh ? (known.map((p) => label(p.identity)).join("·") || occ) : r.source.status}`);
        let want = null, why;
        if (!fresh) { why = `${r.name} 상태 모름(${r.source.status}) → 그대로 유지`; }
        else if (occ === "EMPTY") { want = { power: "OFF" }; why = `${r.name} 비어 있음 → 끔`; }
        else if (known.length) {
          const prefs = known.map((p) => H.preferences[p.identity].target_temp_c);
          const target_c = Math.round(prefs.reduce((a, b) => a + b, 0) / prefs.length);
          const cold = known.reduce((a, b) => (H.preferences[a.identity].target_temp_c <= H.preferences[b.identity].target_temp_c ? a : b));
          want = { power: "ON", target_c, wind_to: cold.identity };
          why = known.length > 1
            ? `${r.name}에 ${known.map((p) => label(p.identity) + " " + H.preferences[p.identity].target_temp_c + "°C").join(", ")} → 평균 ${target_c}°C, 더 시원한 걸 원하는 ${label(cold.identity)} 쪽으로 바람`
            : `${r.name}에 ${label(cold.identity)} → 선호 ${target_c}°C, 바람 ${label(cold.identity)} 쪽`;
        } else { why = `${r.name}에 누군지 모르는 사람 → 그대로 유지`; }
        tempRec.push(why);
        if (want && this.ready(id)) {
          // 7.1절: 켜기·끄기·목표 온도·바람 방향은 각각 다른 action. 필요한 것만 한꺼번에 보냄
          if (want.power === "OFF") {
            if (ac.power !== "OFF") this.command(id, "TURN_OFF", {}, "끄기", why, "temp");
          } else {
            if (ac.power !== "ON") this.command(id, "TURN_ON", {}, "켜기", why, "temp");
            if (ac.target_c !== want.target_c) this.command(id, "SET_TARGET", { target_c: want.target_c }, `목표 ${want.target_c}°C`, why, "temp");
            if (ac.wind_to !== want.wind_to) this.command(id, "SET_WIND", { wind_to: want.wind_to }, `바람 → ${label(want.wind_to)}`, why, "temp");
          }
        }
      });
      ag.temp = { sit: tempSit.join(" / "), rec: tempRec.join(" / ") };

      // ===== 빛 에이전트 =====
      const lightSit = [], lightRec = [];
      ["room1"].forEach((room) => {
        const { r, people, fresh } = this.roomInfo(room);
        const resting = people.filter((p) => p.activity.state === "RESTING" && H.preferences[p.identity]);
        lightSit.push(`${r.name} 빛 ${fresh ? r.light.state : r.source.status} · 조명 ${this.st("light_room1").power || "?"} · 커튼 ${this.st("curtain_room1").position || "?"}` +
          (resting.length ? ` · ${resting.map((p) => label(p.identity)).join(",")} 쉬는 중(${resting[0].posture.state})` : ""));
        if (!fresh) { lightRec.push("상태 모름 → 아무것도 안 함"); return; }
        if (!resting.length) { lightRec.push("쉬는 사람 없음 → 그대로"); return; }
        const p = resting[0];
        const key = `${p.person_id}#${p.activity.rest_episode}`;
        if (!this.asked.has(key)) {
          this.asked.add(key);
          lightRec.push(`${label(p.identity)} 휴식 ${p.activity.rest_episode}회차 시작 → 잘 건지 물어보기`);
          this.speak(room, `${label(p.identity)}님, 주무실 거면 '네'라고 말씀해 주세요`, true,
            `${label(p.identity)} ${p.posture.state}·RESTING, 휴식 ${p.activity.rest_episode}회차 (신원 ${p.identity_source})`, { room, person: p.person_id });
        } else lightRec.push(`휴식 ${p.activity.rest_episode}회차는 이미 물어봄 → 대답대로 유지`);
      });
      ag.light = { sit: lightSit.join(" / "), rec: lightRec.join(" / ") };

      this.lastTrigger = why0;
      this.publishTrace();
    }

    // ---------- 음성 ----------
    onReply(room, m) {
      this.cause = m.no_response ? `${rname(room)}: 대답 없음` : `${rname(room)}에서 대답 "${m.text}"`;
      try { this.handleReply(room, m); } finally { this.cause = null; }
    }
    handleReply(room, m) {
      const q = this.questions[m.command_id];
      if (!q) { this.log(rname(room), "무시", `기한이 지났거나 모르는 질문의 대답 (${m.no_response ? "no_response" : `"${m.text}"`})`, null, "light"); this.publishTrace(); return; }
      delete this.questions[m.command_id];
      if (m.no_response) { this.log(rname(room), "대답 없음 → 아무것도 안 함", `${LISTEN}초 동안 대답이 없음 (Node no_response)`, null, "light"); this.publishTrace(); return; }
      const t = norm(m.text), conf = m.confidence;
      const heard = `"${m.text}" → "${t}" (신뢰도 ${conf})`;
      if (conf !== null && conf < MIN_CONF) {
        this.log(rname(room), "그대로 둠", `${heard} — 신뢰도 ${MIN_CONF} 미만이라 못 믿음`, null, "light");
      } else if (NO.test(t)) {
        this.log(rname(room), "그대로 둠", `${heard} = 부정`, null, "light");
      } else if (YES.test(t)) {
        const why = `${heard} = 긍정 → 잘 준비`;
        if (this.ready("curtain_room1")) this.command("curtain_room1", "CLOSE", {}, "닫기", why, "light");
        if (this.ready("light_room1")) this.command("light_room1", "TURN_OFF", {}, "끄기", why, "light");
      } else {
        this.log(rname(room), "그대로 둠", `${heard} = 긍정인지 부정인지 모름`, null, "light");
      }
      this.publishTrace();
    }
    onVoice(room, m) {
      this.cause = `${rname(room)}에서 음성 명령 "${m.text}"`;
      try { this.handleVoice(room, m); } finally { this.cause = null; }
    }
    handleVoice(room, m) {
      const t = m.text.replace(/\s/g, "");
      const dev = `light_${room}`;
      if (!H.devices[dev]) { this.log(rname(room), "처리 못함", `"${m.text}" — 이 방엔 조명 기기가 없음`, null, "voice"); return; }
      if (/불.*켜/.test(t)) {
        this.command(dev, "TURN_ON", {}, "켜기", `음성 명령 "${m.text}" (신뢰도 ${m.confidence})`, "voice");
        this.speak(room, "네, 불을 켤게요", false, "음성 명령에 대한 확인 응답");
      } else if (/불.*꺼/.test(t)) {
        this.command(dev, "TURN_OFF", {}, "끄기", `음성 명령 "${m.text}"`, "voice");
      } else this.log(rname(room), "처리 못함", `"${m.text}" — 아는 명령이 아님`, null, "voice");
      this.publishTrace();
    }

    publishTrace() {
      this.bus.publish(EY.T.trace, {
        timestamp: this.clock.iso(), based_on_revision: this.snap ? this.snap.revision : null,
        agents: this.agents, decisions: this.decisions.slice(0, 12), pending: Object.keys(this.pending),
      });
    }
  };
})();
