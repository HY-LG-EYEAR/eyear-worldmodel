// World Model (효창 담당) — 시뮬레이터 안에서 돌아가는 1차 구현. 출력은 WorldSnapshot 0.1
// (worldmodel/schema/models.py, EYEAR_월드모델_데이터_명세서.md 5·6절과 같은 규칙).
//
//   ① 출처   Node 메시지 검증, 세션(seq가 줄었는데 시각은 최신 → 재시작), 순서, STALE(3초)
//   ② 방     FRESH면 Node 값 그대로. STALE·NO_DATA면 UNKNOWN. 값이 바뀐 시각을 since로
//   ③ 사람   SEEN → HELD(방은 OCCUPIED) → IN_TRANSIT(방이 EMPTY, 10초) → LAST_KNOWN
//            rest_episode는 Node에서 OTHER/UNKNOWN → RESTING을 관측했을 때만 +1
//   ④ 집     가전 상태·명령 결과·환경(온도·먼지)·선호·루틴
//   revision 변화(changes)가 있을 때만 +1, 발행은 변화 즉시 + 1초마다 재발행
//   명령 결과는 revision을 붙여 eyear/v0/world/device_result로 다시 내보냄
// 실제 서비스 코드(Python)로 옮길 때 이 파일이 설계 초안 역할을 함.
window.EY = window.EY || {};

(function () {
  const H = EY.HOME;
  const STALE_AFTER = 3.0;       // models.py SOURCE_STALE_SECONDS
  const IN_TRANSIT_FOR = 10.0;   // models.py IN_TRANSIT_SECONDS
  const ANON_FORGET = 300;       // LAST_KNOWN 익명 기록은 5분 뒤 삭제
  const ENV_TEMP = 0.5, ENV_DIRT = 0.1;
  const RESERVED = new Set(["UNKNOWN", "GUEST"]);
  // 가전 state에서 "의미 있는 변화"로 볼 키 (배터리·남은 시간·진행률·좌표는 제외)
  const DEV_KEYS = ["power", "mode", "target_c", "wind_to", "position", "moving_to", "status", "room"];
  const devText = (st) => (st ? DEV_KEYS.filter((k) => st[k] !== undefined && st[k] !== null && typeof st[k] !== "object").map((k) => `${k}=${st[k]}`).join(" ") : null);
  const sid = (s) => `${s.node_id}#${s.session}`;
  const chg = (type, o) => Object.assign({ type, room_id: null, person_id: null, device_id: null, before: null, after: null }, o);
  const fmt = (v) => (v === null || v === undefined ? null : String(v));

  EY.WorldModel = class {
    constructor(clock, bus) {
      this.clock = clock; this.bus = bus;
      this.revision = 0;
      this.changes = [];          // 지금 revision을 만든 변화 (재발행에도 그대로)
      this.history = [];          // 화면용: 최근 revision들 {revision, t, changes}
      this.lastPub = -1;
      this.issues = [];           // 받은 메시지에서 발견한 문제 (화면용)
      this.pending = [];          // 다음 tick에서 revision에 넣을 변화 (세션 변경 등)
      this.results = [];          // 다음 tick에서 처리할 명령 결과
      this.src = {};              // room → {node_id, session, last_seq, last_ts, last_rx, last_observed_at, msg}
      this.rooms = {};            // room → 방 상태
      this.people = new Map();    // person_id → 사람 기록 (내부 필드 포함)
      this.devices = {};          // id → {state, observed_at, last_result, text}
      this.env = null;
      this.snapshot = null;

      Object.keys(H.rooms).forEach((room) => {
        this.rooms[room] = {
          status: "NO_DATA",
          occupancy: { state: "UNKNOWN", confidence: 0, since: null },
          light: { state: "UNKNOWN", since: null },
          audio: { context: "UNKNOWN", confidence: 0, since: null },
          temperature_c: { value: null, observed_at: null, source: null },
          dirt_level: { value: null, observed_at: null, source: null },
          ref: { temp: null, dirt: null },     // ENVIRONMENT_CHANGED 기준값
        };
      });
      Object.keys(H.devices).forEach((id) => { this.devices[id] = { state: null, observed_at: null, last_result: null, text: null }; });

      bus.subscribe("eyear/v0/+/state", (m, topic) => this.ingestNode(EY.T.roomOf(topic), m));
      bus.subscribe("eyear/v0/device/+/state", (m) => this.ingestDevice(m));
      bus.subscribe("eyear/v0/device/+/result", (m) => this.results.push(m));
      bus.subscribe(EY.T.simEnv, (m) => { this.env = m; });
      clock.onTick(() => this.tick());
    }

    issue(room, kind, detail) {
      this.issues.unshift({ t: this.clock.hhmmss(), room, kind, detail });
      if (this.issues.length > 30) this.issues.pop();
    }

    // ---------- ① 출처 ----------
    ingestNode(topicRoom, m) {
      if (!H.rooms[topicRoom]) return;
      if (m.schema_version !== "0.1") { this.issue(topicRoom, "SCHEMA", `알 수 없는 schema_version ${m.schema_version} → 버림`); return; }
      if (m.room_id !== topicRoom) { this.issue(topicRoom, "ROOM_MISMATCH", `토픽 ${topicRoom} ≠ room_id ${m.room_id} → 버림`); return; }
      const ts = Date.parse(m.timestamp);
      let s = this.src[topicRoom];
      if (!s) {
        s = this.src[topicRoom] = { node_id: m.node_id, session: 1, last_seq: m.seq - 1, last_ts: -Infinity };
      } else if (m.seq <= s.last_seq) {
        if (ts > s.last_ts) {
          // seq가 줄었는데 시각은 더 최신 → Node 재시작. seq 0만 보고 판단하지 않음 (0번이 유실돼도 알아챔)
          const before = sid(s);
          s.session += 1;
          this.issue(topicRoom, "RESTART", `seq ${s.last_seq} → ${m.seq}, 시각은 최신 → Node 재시작, 세션 ${sid(s)}`);
          this.pending.push(chg("SOURCE_CHANGED", { room_id: topicRoom, before, after: sid(s) }));
        } else {
          this.issue(topicRoom, "OLD_SEQ", `seq ${m.seq} ≤ ${s.last_seq} → 중복·역순, 무시`);
          return;
        }
      } else {
        if (ts < s.last_ts) { this.issue(topicRoom, "OLD_TIME", `시각이 마지막 메시지보다 과거 → 무시`); return; }
        if (m.seq > s.last_seq + 1) this.issue(topicRoom, "GAP", `seq ${s.last_seq + 1}~${m.seq - 1} 빠짐 (메시지가 전체 상태라 받은 것만 반영)`);
      }
      Object.assign(s, { node_id: m.node_id, last_seq: m.seq, last_ts: ts, last_rx: this.clock.t, last_observed_at: m.timestamp, msg: m });
    }

    ingestDevice(m) {
      const d = this.devices[m.device_id];
      if (!d) return;
      d.state = m.state; d.observed_at = m.timestamp;
    }

    statusOf(room) {
      const s = this.src[room];
      if (!s) return "NO_DATA";
      return this.clock.t - s.last_rx > STALE_AFTER ? "STALE" : "FRESH";
    }

    // ---------- 한 틱: 상태 갱신 → 변화 모음 → revision → 발행 ----------
    tick() {
      const now = this.clock.t, iso = this.clock.iso();
      const ch = this.pending; this.pending = [];

      // ② 방
      Object.keys(H.rooms).forEach((room) => {
        const v = this.rooms[room], s = this.src[room];
        const status = this.statusOf(room);
        if (status !== v.status) { ch.push(chg("SOURCE_CHANGED", { room_id: room, before: v.status, after: status })); v.status = status; }
        const m = status === "FRESH" ? s.msg : null;
        const at = m ? m.timestamp : iso;
        const occ = m ? m.occupancy : { state: "UNKNOWN", confidence: 0 };
        if (occ.state !== v.occupancy.state) {
          ch.push(chg("OCCUPANCY_CHANGED", { room_id: room, before: v.occupancy.state, after: occ.state }));
          v.occupancy = { state: occ.state, confidence: occ.confidence, since: at };
        } else v.occupancy.confidence = occ.confidence;
        const light = m ? m.light : "UNKNOWN";
        if (light !== v.light.state) {
          ch.push(chg("LIGHT_CHANGED", { room_id: room, before: v.light.state, after: light }));
          v.light = { state: light, since: at };
        }
        const audio = m ? m.audio : { context: "UNKNOWN", confidence: 0 };
        if (audio.context !== v.audio.context) {
          ch.push(chg("AUDIO_CHANGED", { room_id: room, before: v.audio.context, after: audio.context }));
          v.audio = { context: audio.context, confidence: audio.confidence, since: at };
        } else v.audio.confidence = audio.confidence;
        // 온도·먼지 (시뮬레이션 환경 값). 값은 계속 갱신하고, 기준값에서 많이 바뀌었을 때만 revision
        const e = this.env && this.env.rooms[room];
        if (e) {
          v.temperature_c = { value: e.temperature_c, observed_at: this.env.timestamp, source: "sim" };
          v.dirt_level = { value: e.dirt_level, observed_at: this.env.timestamp, source: "sim" };
          if (v.ref.temp === null) v.ref.temp = e.temperature_c;
          else if (Math.abs(e.temperature_c - v.ref.temp) >= ENV_TEMP - 1e-9) {
            ch.push(chg("ENVIRONMENT_CHANGED", { room_id: room, before: `${v.ref.temp}°C`, after: `${e.temperature_c}°C` }));
            v.ref.temp = e.temperature_c;
          }
          if (v.ref.dirt === null) v.ref.dirt = e.dirt_level;
          else if (Math.abs(e.dirt_level - v.ref.dirt) >= ENV_DIRT - 1e-9) {
            ch.push(chg("ENVIRONMENT_CHANGED", { room_id: room, before: `먼지 ${v.ref.dirt}`, after: `먼지 ${e.dirt_level}` }));
            v.ref.dirt = e.dirt_level;
          }
        }
      });

      // ③ 사람
      this.updatePeople(ch, now, iso);

      // ④ 가전 상태
      Object.entries(this.devices).forEach(([id, d]) => {
        const text = devText(d.state);
        if (text !== d.text) {
          ch.push(chg("DEVICE_STATE_CHANGED", { device_id: id, before: d.text, after: text }));
          d.text = text;
        }
      });
      const results = this.results; this.results = [];
      results.forEach((m) => ch.push(chg("COMMAND_RESULT", { device_id: m.device_id, before: m.action, after: m.status + (m.reason ? ` (${m.reason})` : "") })));

      // revision
      if (ch.length) {
        this.revision += 1;
        this.changes = ch;
        this.history.unshift({ revision: this.revision, t: this.clock.hhmmss(), now, changes: ch });
        if (this.history.length > 60) this.history.pop();
      }
      // 명령 결과: 이 revision에 반영됐다고 표시하고 Orchestrator에 따로 알림
      results.forEach((m) => {
        const d = this.devices[m.device_id];
        if (!d) return;
        d.last_result = { command_id: m.command_id, action: m.action, status: m.status, reason: m.reason, timestamp: m.timestamp, revision: this.revision };
        this.bus.publish(EY.T.deviceResult, {
          schema_version: "0.1", event_id: EY.uuid(), timestamp: m.timestamp, revision: this.revision,
          command_id: m.command_id, device_id: m.device_id, action: m.action, status: m.status, reason: m.reason, state: m.state,
        });
      });

      this.snapshot = this.build(iso);
      if (ch.length || now - this.lastPub >= 1 - 1e-6) {
        this.lastPub = now;
        this.bus.publish(EY.T.snapshot, this.snapshot);
      }
    }

    // ---------- ③ 사람 ----------
    updatePeople(ch, now, iso) {
      // Node가 지금 보고 있는 사람 (FRESH 방만). 같은 사람이 두 방에 보이면 더 최근 메시지 쪽
      const obs = new Map();
      Object.keys(H.rooms).forEach((room) => {
        const s = this.src[room];
        if (this.rooms[room].status !== "FRESH" || !s || !s.msg) return;
        s.msg.persons.forEach((p) => {
          const known = p.identity && !RESERVED.has(p.identity);
          const pid = known ? p.identity : `anon_${room}_s${s.session}_t${p.track_id}`;
          const o = obs.get(pid);
          if (!o || s.last_ts > o.s.last_ts) obs.set(pid, { room, p, s, known });
        });
      });

      // 보이는 사람
      obs.forEach(({ room, p, s, known }, pid) => {
        let r = this.people.get(pid);
        const isNew = !r;
        if (isNew) {
          r = {
            person_id: pid, identity: p.identity, identity_confidence: p.identity_confidence, identity_source: p.identity_source,
            candidates: [], presence: "SEEN", presence_since: iso, room_id: room, track: null,
            posture: { state: p.posture, confidence: p.posture_confidence, since: iso },
            motion: p.motion,
            activity: { state: p.activity, confidence: p.activity_confidence, since: iso, rest_episode: 0 },
            position: null, last_seen_at: s.last_observed_at,
            _lastObsAct: null, _transitAt: null, _lastKnownAt: null,
          };
          if (!known) r.candidates = this.candidatesFor(room, now);
          this.people.set(pid, r);
          ch.push(chg("PERSON_ENTERED", { room_id: room, person_id: pid }));
          // 같은 track이 익명이다가 신원이 붙은 경우: 익명 기록 정리
          this.people.forEach((x) => {
            if (x !== r && x.person_id.startsWith("anon_") && x.track && x.track.session_id === sid(s) && x.track.track_id === p.track_id) {
              this.people.delete(x.person_id);
              ch.push(chg("PERSON_REMOVED", { room_id: x.room_id, person_id: x.person_id, after: `신원 확인 → ${pid}` }));
            }
          });
        } else {
          if (r.room_id !== room) {
            if (r.presence === "SEEN" || r.presence === "HELD") ch.push(chg("PERSON_LEFT", { room_id: r.room_id, person_id: pid }));
            ch.push(chg("PERSON_ENTERED", { room_id: room, person_id: pid }));
          } else if (r.presence === "IN_TRANSIT" || r.presence === "LAST_KNOWN") {
            ch.push(chg("PERSON_ENTERED", { room_id: room, person_id: pid }));
          }
          if (r.presence !== "SEEN") {
            ch.push(chg("PRESENCE_CHANGED", { room_id: room, person_id: pid, before: r.presence, after: "SEEN" }));
            r.presence = "SEEN"; r.presence_since = iso;
          }
          if (r.identity !== p.identity || r.identity_source !== p.identity_source) {
            ch.push(chg("IDENTITY_CHANGED", { room_id: room, person_id: pid, before: `${r.identity} ${r.identity_source}`, after: `${p.identity} ${p.identity_source}` }));
          }
          if (r.posture.state !== p.posture) {
            ch.push(chg("POSTURE_CHANGED", { room_id: room, person_id: pid, before: r.posture.state, after: p.posture }));
            r.posture = { state: p.posture, confidence: p.posture_confidence, since: iso };
          } else r.posture.confidence = p.posture_confidence;
        }
        // 휴식 회차: Node에서 RESTING이 아닌 값 → RESTING을 관측했을 때만 +1 (HELD·STALE을 거쳐 돌아온 RESTING은 같은 회차)
        let ep = r.activity.rest_episode;
        if (p.activity === "RESTING" && r._lastObsAct !== "RESTING") ep += 1;
        if (r.activity.state !== p.activity) {
          if (!isNew) ch.push(chg("ACTIVITY_CHANGED", { room_id: room, person_id: pid, before: r.activity.state, after: p.activity + (ep !== r.activity.rest_episode ? ` (휴식 ${ep}회차)` : "") }));
          r.activity = { state: p.activity, confidence: p.activity_confidence, since: isNew ? iso : iso, rest_episode: ep };
        } else { r.activity.confidence = p.activity_confidence; r.activity.rest_episode = ep; }
        r._lastObsAct = p.activity;

        Object.assign(r, {
          identity: p.identity, identity_confidence: p.identity_confidence, identity_source: p.identity_source,
          room_id: room, motion: p.motion, last_seen_at: s.last_observed_at,
          track: { node_id: s.node_id, session_id: sid(s), track_id: p.track_id },
          position: p.position ? this.positionOf(room, p.position) : null,
          _transitAt: null, _lastKnownAt: null,
        });
        if (known) r.candidates = [];
      });

      // 안 보이는 사람
      [...this.people.values()].forEach((r) => {
        if (obs.has(r.person_id)) return;
        const v = this.rooms[r.room_id];
        let next = r.presence;
        if (v.status !== "FRESH") next = "LAST_KNOWN";
        else if (r.presence === "SEEN" || r.presence === "HELD") next = v.occupancy.state === "OCCUPIED" ? "HELD" : "IN_TRANSIT";
        else if (r.presence === "IN_TRANSIT" && now - r._transitAt > IN_TRANSIT_FOR) next = "LAST_KNOWN";
        if (next !== r.presence) {
          if (next === "IN_TRANSIT") { ch.push(chg("PERSON_LEFT", { room_id: r.room_id, person_id: r.person_id })); r._transitAt = now; }
          if (next === "LAST_KNOWN") r._lastKnownAt = now;
          ch.push(chg("PRESENCE_CHANGED", { room_id: r.room_id, person_id: r.person_id, before: r.presence, after: next }));
          r.presence = next; r.presence_since = iso; r.track = null;
          // HELD는 마지막 관측값 유지. 이동 중·마지막 위치면 지금 자세·활동은 모름
          if (next === "IN_TRANSIT" || next === "LAST_KNOWN") {
            r.motion = "UNKNOWN";
            if (r.posture.state !== "UNKNOWN") r.posture = { state: "UNKNOWN", confidence: 0, since: iso };
            if (r.activity.state !== "UNKNOWN") r.activity = { state: "UNKNOWN", confidence: 0, since: iso, rest_episode: r.activity.rest_episode };
          }
        }
        if (r.presence === "LAST_KNOWN" && r.person_id.startsWith("anon_") && now - r._lastKnownAt > ANON_FORGET) {
          this.people.delete(r.person_id);
          ch.push(chg("PERSON_REMOVED", { room_id: r.room_id, person_id: r.person_id, after: "익명 · 5분 넘게 소식 없음" }));
        }
      });
    }

    // 신원 모르는 사람이 나타났을 때: 지금 이동 중인 가족을 '가설'로만 적음 (identity는 UNKNOWN 유지)
    candidatesFor(room, now) {
      return [...this.people.values()]
        .filter((x) => x.presence === "IN_TRANSIT" && !x.person_id.startsWith("anon_") && x.room_id !== room)
        .map((x) => ({ identity: x.identity, reason: `${x.room_id}에서 IN_TRANSIT였고 ${(now - x._transitAt).toFixed(0)}초 뒤 ${room}에 나타남` }));
    }

    positionOf(room, pos) {
      const simPt = EY.roomToSim(room, pos);
      return { room: { x: pos.x, y: pos.y }, home: EY.simToHome(simPt), zone: EY.zoneAt(room, simPt) };
    }

    // ---------- 스냅샷 ----------
    build(iso) {
      const people = [...this.people.values()].sort((a, b) => (a.person_id < b.person_id ? -1 : 1)).map((r) => ({
        person_id: r.person_id, identity: r.identity, identity_confidence: r.identity_confidence, identity_source: r.identity_source,
        candidates: r.candidates, presence: r.presence, presence_since: r.presence_since, room_id: r.room_id, track: r.track,
        posture: { ...r.posture }, motion: r.motion, activity: { ...r.activity }, position: r.position, last_seen_at: r.last_seen_at,
      }));
      const rooms = Object.entries(H.rooms).map(([room, def]) => {
        const v = this.rooms[room], s = this.src[room], g = EY.roomGeom(room);
        return {
          room_id: room, name: def.name, origin_m: g.origin_m, size_m: g.size_m, adjacent: def.adjacent,
          source: s ? { node_id: s.node_id, status: v.status, session_id: sid(s), last_seq: s.last_seq, last_observed_at: s.last_observed_at }
            : { node_id: null, status: "NO_DATA", session_id: null, last_seq: null, last_observed_at: null },
          occupancy: { ...v.occupancy }, light: { ...v.light }, audio: { ...v.audio },
          temperature_c: { ...v.temperature_c }, dirt_level: { ...v.dirt_level },
          person_ids: people.filter((p) => p.room_id === room && (p.presence === "SEEN" || p.presence === "HELD")).map((p) => p.person_id),
        };
      });
      const devices = Object.entries(H.devices).map(([id, def]) => {
        const d = this.devices[id];
        return {
          device_id: id, type: def.type, name: def.name, room_id: def.room || null, online: d.state !== null,
          actions: def.actions, state: d.state || {}, observed_at: d.observed_at, last_result: d.last_result,
        };
      });
      return {
        schema_version: "0.1", snapshot_id: EY.uuid(), home_id: H.home_id,
        revision: this.revision, timestamp: iso, changes: this.revision ? this.changes : [],
        rooms, people, devices,
        preferences: Object.entries(H.preferences).map(([id, p]) => ({ identity: id, display_name: p.label, preferred_temp_c: p.target_temp_c, updated_at: null })),
        routines: H.routines,
      };
    }
  };
})();
