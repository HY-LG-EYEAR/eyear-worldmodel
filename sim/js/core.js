// 시나리오 시계 + 메시지 버스.
// 모든 모듈은 실제 시간이 아니라 이 시계(sim 초)로 움직인다 → 일시정지·배속·되감기(리셋 후 빨리감기)가 결정적으로 동작.
// 버스는 MQTT와 같은 토픽 규칙(+, #)을 쓴다. 나중에 mqtt.js(WebSocket)로 바꾸면 모듈 코드는 그대로.
window.EY = window.EY || {};

EY.Clock = class {
  constructor(baseTime) {
    this.base = baseTime;     // 시나리오 시작 시각 "2026-07-15T21:00:00+09:00"
    this.t = 0;               // 시작 후 경과 초
    this.q = [];              // 예약된 일 {t, n, fn}
    this.n = 0;
    this.tickers = [];
    this.DT = 0.1;
  }
  at(t, fn) {
    const e = { t, n: this.n++, fn };
    let i = this.q.length;
    while (i > 0 && (this.q[i - 1].t > t || (this.q[i - 1].t === t && this.q[i - 1].n > e.n))) i--;
    this.q.splice(i, 0, e);
  }
  after(dt, fn) { this.at(this.t + dt, fn); }
  onTick(fn) { this.tickers.push(fn); }
  step() {
    const end = this.t + this.DT;
    while (this.q.length && this.q[0].t <= end + 1e-9) {
      const e = this.q.shift();
      this.t = Math.max(this.t, e.t);
      e.fn();
    }
    this.t = +end.toFixed(3);
    this.tickers.forEach((f) => f(this.DT, this.t));
  }
  advanceTo(target) { while (this.t < target - 1e-9) this.step(); }

  // ISO 8601 (+09:00)
  iso(t = this.t) {
    const m = this.base.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(.*)$/);
    let s = (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]) + t;
    const ms = Math.round((s % 1) * 1000);
    s = Math.floor(s);
    const p = (v, w = 2) => String(v).padStart(w, "0");
    return `${m[1]}T${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}.${p(ms, 3)}${m[5]}`;
  }
  hhmmss(t = this.t) { return this.iso(t).slice(11, 19); }
};

EY.topicMatch = (pattern, topic) => {
  const p = pattern.split("/"), t = topic.split("/");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "#") return true;
    if (i >= t.length) return false;
    if (p[i] !== "+" && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
};

EY.Bus = class {
  constructor(clock) {
    this.clock = clock;
    this.subs = [];
    this.log = [];      // 최근 메시지 (화면용)
  }
  subscribe(pattern, fn) { this.subs.push({ pattern, fn }); }
  // QoS·지연은 흉내 내지 않음. 받는 쪽은 다음 시계 틱 안에서 처리 (재귀 호출 방지)
  publish(topic, payload) {
    const msg = { topic, payload: EY.clone(payload), t: this.clock.t };
    this.log.push(msg);
    if (this.log.length > 400) this.log.shift();
    this.clock.after(0, () => {
      this.subs.forEach((s) => { if (EY.topicMatch(s.pattern, topic)) s.fn(EY.clone(msg.payload), topic); });
    });
  }
};

// 토픽 이름 한곳에서 관리. eyear/v0/{room}/... 은 반석님 topics.py와 같음, 나머지는 효창 제안(합의 전)
EY.T = {
  state: (room) => `eyear/v0/${room}/state`,
  speak: (room) => `eyear/v0/${room}/speak`,
  voiceReply: (room) => `eyear/v0/${room}/voice/reply`,
  voiceCommand: (room) => `eyear/v0/${room}/voice/command`,
  snapshot: "eyear/v0/world/snapshot",                    // 제안
  devCommand: (id) => `eyear/v0/device/${id}/command`,    // 제안 (정빈님이 정할 부분)
  devResult: (id) => `eyear/v0/device/${id}/result`,      // 제안
  devState: (id) => `eyear/v0/device/${id}/state`,        // 제안
  simEnv: "eyear/v0/sim/env",                             // 시뮬레이터 전용 (방 온도·오염도)
  deviceResult: "eyear/v0/world/device_result",          // 제안 (명령 결과 + 반영된 revision)
  trace: "eyear/v0/orchestrator/trace",                   // 제안 (화면에 판단 과정 표시용)
  roomOf: (topic) => topic.split("/")[2],
};
