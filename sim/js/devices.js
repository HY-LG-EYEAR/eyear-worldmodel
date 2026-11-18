// 가상 가전 + 시뮬레이션 환경(방 온도·오염도).
// 명령 처리 규칙 (명세서 §Simulation: "명령을 표시만 하면 안 되고 실제로 실행해 결과를 돌려줘야 함")
//   command → ACCEPTED | REJECTED (즉시)  → 시간이 지나 실제 상태가 바뀌면 COMPLETED | FAILED
// 토픽: eyear/v0/device/{id}/command · /result · /state  (형식은 정빈님과 합의 전 제안, action 이름은 명세서 7.1절)
//   state  = { schema_version, device_id, type, room_id, timestamp, state: {...} }
//   result = { schema_version, command_id, device_id, action, status, reason, timestamp, state: {...} }
// World Model이 이 둘을 받아 스냅샷 devices[]와 eyear/v0/world/device_result(revision 붙임)로 다시 내보낸다.
window.EY = window.EY || {};

(function () {
  const H = EY.HOME;

  class Device {
    constructor(sim, id) {
      this.sim = sim; this.id = id; this.def = H.devices[id];
      this.task = null;   // 진행 중인 명령 {command_id, action, ...}
      sim.bus.subscribe(EY.T.devCommand(id), (cmd) => this.onCommand(cmd));
    }
    get clock() { return this.sim.clock; }
    result(cmd, status, reason) {
      this.sim.bus.publish(EY.T.devResult(this.id), {
        schema_version: "0.1", command_id: cmd.command_id, device_id: this.id, action: cmd.action,
        status, reason: reason || null, timestamp: this.clock.iso(), state: this.state(),
      });
    }
    publishState() {
      this.sim.bus.publish(EY.T.devState(this.id), {
        schema_version: "0.1", device_id: this.id, type: this.def.type, room_id: this.def.room || null,
        timestamp: this.clock.iso(), state: this.state(),
      });
    }
    onCommand(cmd) {
      const err = this.check(cmd);
      if (err) { this.result(cmd, "REJECTED", err); return; }
      if (this.task) this.result(this.task, "FAILED", "SUPERSEDED");   // 새 명령이 이전 명령을 대체
      this.task = cmd;
      this.result(cmd, "ACCEPTED");
      this.start(cmd);
      this.publishState();
    }
    finish(status = "COMPLETED", reason) {
      if (!this.task) return;
      const cmd = this.task; this.task = null;
      this.publishState();
      this.result(cmd, status, reason);
    }
    tick() {}
  }

  // ----- 조명: 거의 바로 바뀜 -----
  class Light extends Device {
    constructor(sim, id) { super(sim, id); this.power = "ON"; }
    state() { return { power: this.power }; }
    check(c) { return ["TURN_ON", "TURN_OFF"].includes(c.action) ? null : "UNKNOWN_ACTION"; }
    start(c) {
      const my = c.command_id;
      this.clock.after(0.3, () => {
        if (!this.task || this.task.command_id !== my) return;
        this.power = c.action === "TURN_ON" ? "ON" : "OFF";
        this.finish();
      });
    }
  }

  // ----- 커튼: MOVING을 거쳐 약 6초 -----
  class Curtain extends Device {
    constructor(sim, id) { super(sim, id); this.pos = "OPEN"; this.moving = null; this.progress = 0; }
    state() { return { position: this.moving ? "MOVING" : this.pos, moving_to: this.moving, progress: +this.progress.toFixed(2) }; }
    check(c) { return ["OPEN", "CLOSE"].includes(c.action) ? null : "UNKNOWN_ACTION"; }
    start(c) {
      const to = c.action === "OPEN" ? "OPEN" : "CLOSED";
      if (to === this.pos && !this.moving) { this.finish(); return; }
      this.moving = to; this.progress = 0;
    }
    tick(dt) {
      if (!this.moving) return;
      this.progress = Math.min(1, this.progress + dt / 6);
      if (this.progress >= 1) { this.pos = this.moving; this.moving = null; this.finish(); }
    }
  }

  // ----- 세탁기: 사람이 직접 켬. 중앙은 모드만 바꿈 -----
  class Washer extends Device {
    constructor(sim, id) { super(sim, id); this.power = "RUNNING"; this.mode = "NORMAL"; this.remaining = 2400; }
    state() { return { power: this.power, mode: this.mode, remaining_s: Math.round(this.remaining), noise_db: this.power === "RUNNING" ? (this.mode === "LOW_NOISE" ? 42 : 58) : 0 }; }
    check(c) {
      if (c.action === "START" || c.action === "PAUSE") return "NOT_SUPPORTED_IN_SIM";
      if (c.action !== "SET_MODE") return "UNKNOWN_ACTION";
      if (!["NORMAL", "LOW_NOISE"].includes(c.params && c.params.mode)) return "BAD_PARAMS";
      if (this.power !== "RUNNING") return "NOT_RUNNING";
      return null;
    }
    start(c) {
      const my = c.command_id;
      this.clock.after(1.0, () => {
        if (!this.task || this.task.command_id !== my) return;
        this.mode = c.params.mode; this.finish();
      });
    }
    tick(dt) {
      if (this.power !== "RUNNING") return;
      this.remaining -= dt * (this.mode === "LOW_NOISE" ? 0.8 : 1);   // 저소음은 느리게 돎
      if (this.remaining <= 0) { this.power = "DONE"; this.remaining = 0; this.publishState(); }
    }
  }

  // ----- 에어컨: 명령마다 1초 뒤 반영 (서로 다른 명령은 서로를 대체하지 않음). 실내 온도는 환경(Env)이 천천히 따라감 -----
  class AC extends Device {
    constructor(sim, id, init) { super(sim, id); Object.assign(this, { power: "OFF", target_c: 26, wind_to: null }, init); }
    state() { return { power: this.power, target_c: this.target_c, wind_to: this.wind_to }; }
    check(c) {
      const p = c.params || {};
      if (c.action === "TURN_ON" || c.action === "TURN_OFF") return null;
      if (c.action === "SET_TARGET") return typeof p.target_c !== "number" ? "BAD_PARAMS" : (p.target_c < 18 || p.target_c > 30) ? "TARGET_OUT_OF_RANGE" : null;
      if (c.action === "SET_WIND") return p.wind_to === undefined ? "BAD_PARAMS" : null;
      return "UNKNOWN_ACTION";
    }
    onCommand(cmd) {
      const err = this.check(cmd);
      if (err) { this.result(cmd, "REJECTED", err); return; }
      this.result(cmd, "ACCEPTED");
      this.clock.after(1.0, () => {
        const p = cmd.params || {};
        if (cmd.action === "TURN_ON") this.power = "ON";
        if (cmd.action === "TURN_OFF") this.power = "OFF";
        if (cmd.action === "SET_TARGET") this.target_c = p.target_c;
        if (cmd.action === "SET_WIND") this.wind_to = p.wind_to;
        this.publishState();
        this.result(cmd, "COMPLETED");
      });
    }
  }

  // ----- 로봇청소기 -----
  // 상태: DOCKED → TO_ROOM → CLEANING → RETURNING → DOCKED
  // 사람이 있는 방에 들어가지 않는 규칙은 중앙(규칙/LLM)이 지킴. 기기는 배터리·바쁨만 확인.
  class Vacuum extends Device {
    constructor(sim, id) {
      super(sim, id);
      this.status = "CLEANING"; this.room = "room2"; this.battery = 45;
      this.pos = [3.0, 2.6]; this.route = []; this.cleanLeft = 5; this.speed = 0.35;
      this.lastPub = -1;
      this.zz = EY.zigzag("room2"); this.zzi = 0;
      this.route = [this.pos, ...this.zz];
    }
    state() {
      // battery는 0~1 (명세서 7.1). x_m·y_m은 집 좌표(m) — 시뮬레이터 화면용 (실제 청소기에는 없을 수 있음). state 값은 스칼라만
      return { status: this.status, room: this.room, battery: +(this.battery / 100).toFixed(2),
        x_m: EY.simToHome(this.pos).x, y_m: EY.simToHome(this.pos).y, current_command: this.task ? this.task.command_id : null };
    }
    check(c) {
      if (c.action === "CLEAN_ROOM") {
        const room = c.params && c.params.room;
        if (!H.rooms[room] || !H.rooms[room].cleanable) return "UNKNOWN_ROOM";
        if (this.battery < 50) return "LOW_BATTERY";
        if (this.status === "CLEANING" || this.status === "TO_ROOM") return "BUSY";
        return null;
      }
      if (c.action === "RETURN_TO_DOCK") return null;
      if (c.action === "PAUSE") return "NOT_SUPPORTED_IN_SIM";
      return "UNKNOWN_ACTION";
    }
    start(c) {
      if (c.action === "CLEAN_ROOM") {
        const from = this.status === "DOCKED" ? "dock" : (EY.roomOf(this.pos) || "hall");
        this.route = [this.pos, ...EY.navPath(from, c.params.room)];
        this.status = "TO_ROOM"; this.room = c.params.room;
        const r = H.rooms[c.params.room].rect;
        this.cleanLeft = Math.round((r[2] - r[0]) * (r[3] - r[1]) * 2.2);   // 넓이 비례 (방1 약 31초)
        this.zz = EY.zigzag(c.params.room); this.zzi = 0;
      } else {
        this.goHome();
      }
    }
    goHome() {
      const from = EY.roomOf(this.pos) || "hall";
      this.route = [this.pos, ...EY.navPath(from, "dock")];
      this.status = "RETURNING";
    }
    moveAlong(dt) {
      let left = this.speed * dt;
      while (left > 0 && this.route.length > 1) {
        const [a, b] = this.route;
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (d <= left) { this.route.shift(); this.route[0] = b; left -= d; }
        else { const f = left / d; this.route[0] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; left = 0; }
      }
      this.pos = this.route[0];
      return this.route.length <= 1;
    }
    tick(dt) {
      const t = this.clock.t;
      if (this.status === "DOCKED") {
        this.battery = Math.min(100, this.battery + 1.0 * dt);
      } else {
        this.battery = Math.max(0, this.battery - 0.15 * dt);
        if (this.status === "TO_ROOM") {
          if (this.moveAlong(dt)) { this.status = "CLEANING"; this.route = [this.pos, ...this.zz]; this.publishState(); }
        } else if (this.status === "CLEANING") {
          this.cleanLeft -= dt;
          const saved = this.speed; this.speed = 0.3;
          if (this.moveAlong(dt)) this.route = [this.pos, ...this.zz];   // 지그재그 반복
          this.speed = saved;
          if (this.cleanLeft <= 0) {
            const doneRoom = this.room;
            this.goHome();
            this.room = doneRoom;
            this.finish("COMPLETED");   // 청소 명령 완료 → 스스로 복귀
          }
        } else if (this.status === "RETURNING") {
          if (this.moveAlong(dt)) {
            this.status = "DOCKED"; this.room = null; this.pos = H.devices.vacuum.dock.slice();
            if (this.task && this.task.action === "RETURN_TO_DOCK") this.finish(); else this.publishState();
          }
        }
      }
      if (t - this.lastPub >= (this.status === "DOCKED" ? 1 : 0.2)) { this.lastPub = t; this.publishState(); }
    }
    onCommand(cmd) {
      // 청소 중에 복귀 명령이 오면 진행 중 청소 명령은 FAILED(CANCELLED)
      if (cmd.action === "RETURN_TO_DOCK" && this.task && this.task.action === "CLEAN_ROOM") {
        const old = this.task; this.task = null;
        this.result(old, "FAILED", "CANCELLED_BY_RETURN");
      }
      super.onCommand(cmd);
    }
  }

  // ----- 환경: 방 온도·오염도 (센서가 아니라 시뮬레이션 값) -----
  class Env {
    constructor(sim) {
      this.sim = sim;
      this.rooms = {
        room1: { temperature_c: 28.4, dirt_level: 0.80 },
        room2: { temperature_c: 28.0, dirt_level: 0.35 },
        living: { temperature_c: 26.4, dirt_level: 0.30 },
        laundry: { temperature_c: 29.0, dirt_level: 0.20 },
      };
      this.outside = 29.5; this.last = -1;
    }
    tick(dt) {
      const d = this.sim.devices;
      Object.entries(this.rooms).forEach(([room, r]) => {
        const ac = Object.values(d).find((x) => x instanceof AC && x.def.room === room);
        if (ac && ac.power === "ON") r.temperature_c += Math.sign(ac.target_c - r.temperature_c) * Math.min(Math.abs(ac.target_c - r.temperature_c), 0.06 * dt);
        else r.temperature_c += (this.outside - r.temperature_c) * 0.004 * dt;
        r.dirt_level = Math.min(1, r.dirt_level + 0.0008 * dt);
      });
      const v = d.vacuum;
      if (v.status === "CLEANING" && this.rooms[v.room]) {
        const r = this.rooms[v.room];
        r.dirt_level = Math.max(0.05, r.dirt_level - 0.03 * dt);
      }
      const t = this.sim.clock.t;
      if (t - this.last >= 1) {
        this.last = t;
        const out = {};
        Object.entries(this.rooms).forEach(([k, r]) => { out[k] = { temperature_c: +r.temperature_c.toFixed(1), dirt_level: +r.dirt_level.toFixed(2) }; });
        this.sim.bus.publish(EY.T.simEnv, { timestamp: this.sim.clock.iso(), origin: "SIMULATED", rooms: out });
      }
    }
  }

  EY.createDevices = (sim) => {
    const d = {
      vacuum: new Vacuum(sim, "vacuum"),
      washer: new Washer(sim, "washer"),
      ac_room1: new AC(sim, "ac_room1"),
      ac_living: new AC(sim, "ac_living", { power: "ON", target_c: 26, wind_to: "MEMBER_B" }),
      light_room1: new Light(sim, "light_room1"),
      curtain_room1: new Curtain(sim, "curtain_room1"),
    };
    sim.devices = d;
    const env = new Env(sim);
    sim.env = env;
    // 시작할 때 모든 기기 상태를 한 번 알림
    Object.values(d).forEach((x) => x.publishState());
    sim.clock.onTick((dt) => { Object.values(d).forEach((x) => x.tick(dt)); env.tick(dt); });
    return d;
  };
})();
