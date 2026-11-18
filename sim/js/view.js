// 평면도 그리기. 입력은 World Model 스냅샷(WorldSnapshot 0.1)과 가전 state 메시지뿐 (시뮬레이터 내부 값을 직접 보지 않음).
// → 화면에 보이는 것 = World Model이 알고 있는 것. 그래서 Node를 끄면 사람이 "위치 모름"으로 바뀜.
//   방 색      재실 OCCUPIED = 파란 테두리, 모름(STALE) = 빗금
//   사람 모양  SEEN 실선 · HELD 점선 테두리 · IN_TRANSIT 점선 + 문 밖으로 걸어 나감 · LAST_KNOWN 흐린 점선
//   태그 두 줄 "A · 레이더만" / "누워 있음 · 휴식 1분 12초째"
window.EY = window.EY || {};

(function () {
  const H = EY.HOME, W = EY.WORDS;
  const NS = "http://www.w3.org/2000/svg";
  const VB = { x: 70, y: 170, w: 1390, h: 1660 };
  const WALK_MIN = 1.2;     // 사람 걷는 속도 m/s (sim 시간). 경로가 길면 4초 안에 도착하게 빨라짐
  const WALK_TIME = 4;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const svgEl = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
    if (parent) parent.appendChild(e);
    return e;
  };
  const DARK = { DARK: 0.45, DIM: 0.25, BRIGHT: 0 };
  const roomRectSvg = (room) => {
    const r = H.rooms[room].rect, a = EY.toSvg([r[0], r[1]]), b = EY.toSvg([r[2], r[3]]);
    return { x: a[0], y: a[1], w: b[0] - a[0], h: b[1] - a[1] };
  };
  // 방 정보 두 줄 (재실 / 온도·먼지·빛) 위치
  const INFO_AT = { room1: [1115, 500], room2: [125, 275], living: [125, 770], laundry: [1024, 336] };
  const NODE_AT = { room1: [1408, 625] };
  const pathLen = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

  EY.View = class {
    constructor() {
      this.people = new Map();      // person_id → 아바타
      this.vacPos = null;
      this.lastT = null;
      this.bubbleKey = "";
      this.night = {}; this.info = {}; this.nodes = {}; this.stale = {}; this.occ = {};
      Object.keys(H.rooms).forEach((room) => {
        const r = roomRectSvg(room);
        this.occ[room] = svgEl("rect", { class: "occ", x: r.x + 6, y: r.y + 6, width: r.w - 12, height: r.h - 12, rx: 6 }, $("occLayer"));
        this.night[room] = svgEl("rect", { class: "night", x: r.x, y: r.y, width: r.w, height: r.h }, $("nightLayer"));
        const [ix, iy] = INFO_AT[room];
        this.info[room] = svgEl("text", { class: "rinfo", x: ix, y: iy }, $("infoLayer"));
        if (room === "room1") {
          this.nodes[room] = { body: $("nodeBody_room1"), text: $("nodeText_room1") };
        } else {
          const p = EY.toSvg(H.rooms[room].nodeAt);
          NODE_AT[room] = p;
          const g = svgEl("g", { class: "nodemark", transform: `translate(${p[0]} ${p[1]})` }, $("nodeLayer"));
          svgEl("rect", { x: -11, y: -11, width: 22, height: 22, rx: 5 }, g);
          const t = svgEl("text", { x: -16, y: 6, "text-anchor": "end" }, g);
          t.textContent = "Node";
          this.nodes[room] = { g, text: t };
        }
        const sg = svgEl("g", { style: "display:none" }, $("staleLayer"));
        svgEl("rect", { class: "stale", x: r.x, y: r.y, width: r.w, height: r.h }, sg);
        const st = svgEl("text", { class: "staletext", x: r.x + r.w / 2, y: r.y + Math.min(r.h / 2, 120), "text-anchor": "middle" }, sg);
        this.stale[room] = { g: sg, text: st };
      });
    }

    reset() {
      this.people.forEach((a) => a.el.remove());
      this.people.clear();
      this.vacPos = null; this.lastT = null; this.bubbleKey = "";
      document.querySelectorAll("#mapbox .bubble").forEach((b) => b.remove());
    }

    // ---------- 사람 ----------
    makeAvatar(p) {
      const letter = W.who(p.person_id).slice(0, 2);
      const el = svgEl("g", { class: "person" }, $("peopleLayer"));
      const stand = svgEl("g", { class: "shape" }, el);
      svgEl("circle", { class: "pring", r: 36 }, stand);
      svgEl("circle", { class: "pbody", r: 28 }, stand);
      svgEl("text", { class: "pletter" }, stand).textContent = letter;
      const lie = svgEl("g", { class: "shape", style: "opacity:0" }, el);
      svgEl("rect", { class: "pring", x: -58, y: -26, width: 116, height: 52, rx: 26 }, lie);
      svgEl("rect", { class: "pbody", x: -50, y: -18, width: 100, height: 36, rx: 18 }, lie);
      svgEl("text", { class: "pletter", x: -28 }, lie).textContent = letter;
      const tag = svgEl("text", { class: "ptag", y: -72 }, el);
      const sub = svgEl("text", { class: "psub", y: -46 }, el);
      return { el, stand, lie, tag, sub, letter, pos: null, route: [], speed: WALK_MIN, room: null, target: null, presence: null, lying: false };
    }

    // 그 방 사람들끼리 겹치지 않게 조금씩 비켜 세움 (좌표가 없을 때만)
    targetOf(p, idx) {
      if (p.position && p.position.home) return EY.homeToSim(p.position.home);
      const c = EY.roomCenter(p.room_id);
      return [c[0] + (idx % 2 ? 0.6 : -0.6), c[1]];
    }
    go(a, pts) { a.route = pts; a.speed = Math.max(WALK_MIN, pathLen([a.pos, ...pts]) / WALK_TIME); }

    updatePeople(snap, dt, jump) {
      const seen = new Set(), now = snap ? snap.timestamp : null;
      (snap ? snap.people : []).forEach((p, i) => {
        seen.add(p.person_id);
        let a = this.people.get(p.person_id);
        const target = this.targetOf(p, i);
        const fresh = !a;
        if (!a) {
          a = this.makeAvatar(p);
          this.people.set(p.person_id, a);
          // 새로 나타난 사람은 그 방 문 쪽에서 걸어 들어옴
          const entry = H.nav.nodes[H.nav.entry[p.room_id]];
          a.pos = jump || !entry ? target.slice() : entry.slice();
          this.go(a, [target]);
        }
        const moved = a.room !== p.room_id;
        if (p.presence === "IN_TRANSIT" && a.presence !== "IN_TRANSIT") {
          // 방이 비었다 = 문 밖으로 나갔다. 복도 쪽으로 걸어 나가는 모습
          this.go(a, EY.navPath(p.room_id, "hall"));
        } else if (p.presence !== "IN_TRANSIT" && !fresh) {
          if (moved || a.presence === "IN_TRANSIT") {
            const from = EY.roomOf(a.pos) || "hall";
            this.go(a, [...(from === p.room_id ? [] : EY.navPath(from, p.room_id)), target]);
          } else if (!a.target || a.target[0] !== target[0] || a.target[1] !== target[1]) this.go(a, [target]);
        }
        a.room = p.room_id; a.target = target; a.presence = p.presence;
        // 자세를 모르면(어두움·추적 유지) 마지막 모양 유지
        if (p.posture.state !== "UNKNOWN") a.lying = p.posture.state === "LYING";
        if (p.presence === "IN_TRANSIT") a.lying = false;
        a.stand.style.opacity = a.lying ? 0 : 1;
        a.lie.style.opacity = a.lying ? 1 : 0;
        const cand = p.candidates && p.candidates.length ? ` (${p.candidates.map((c) => W.who(c.identity)).join("·")}일 수도)` : "";
        const idHint = p.presence === "SEEN" && p.identity_source === "TRACK_CARRIED" ? " · 추적 유지" : "";
        a.tag.textContent = `${W.who(p.person_id)}${cand}${p.presence === "SEEN" ? idHint : " · " + W.PRES_SHORT[p.presence]}`;
        a.sub.textContent = W.doing(p, now);
        a.cls = "person p-" + p.presence + (p.activity.state === "RESTING" ? " resting" : "");
      });
      // 스냅샷에서 사라진 사람(익명 기록 삭제 등) → 지움
      this.people.forEach((a, pid) => { if (!seen.has(pid)) { a.el.remove(); this.people.delete(pid); } });
      // 걷기
      this.people.forEach((a) => {
        if (jump && a.route.length) { a.pos = a.route[a.route.length - 1].slice(); a.route = []; }
        let left = a.speed * dt;
        while (left > 0 && a.route.length) {
          const b = a.route[0], d = Math.hypot(b[0] - a.pos[0], b[1] - a.pos[1]);
          if (d <= left) { a.pos = b.slice(); a.route.shift(); left -= d; }
          else { a.pos = [a.pos[0] + (b[0] - a.pos[0]) * left / d, a.pos[1] + (b[1] - a.pos[1]) * left / d]; left = 0; }
        }
        const s = EY.toSvg(a.pos);
        a.el.setAttribute("transform", `translate(${s[0].toFixed(1)} ${s[1].toFixed(1)})`);
        a.el.setAttribute("class", a.cls);
      });
    }

    // ---------- 그리기 (매 프레임) ----------
    frame(t, snap, dev, bubbles, offline) {
      const dt = this.lastT === null ? 0 : t - this.lastT;
      const jump = this.lastT === null || dt < 0 || dt > 3;
      this.lastT = t;
      this.updatePeople(snap, jump ? 0 : dt, jump);

      // 방: 재실 색, 어둠, 정보, Node 상태, 끊김 표시
      Object.keys(H.rooms).forEach((room) => {
        const r = snap && snap.rooms.find((x) => x.room_id === room);
        const status = offline[room] ? "OFF" : (r ? r.source.status : "NO_DATA");
        this.night[room].style.opacity = r ? (DARK[r.light.state] || 0) : 0;
        this.occ[room].setAttribute("class", "occ " + (r ? r.occupancy.state : "UNKNOWN"));
        if (r) {
          const o = r.occupancy;
          const l1 = `${o.state === "OCCUPIED" ? "● " : o.state === "EMPTY" ? "○ " : ""}${W.OCC[o.state]}${o.confidence ? " " + o.confidence.toFixed(2) : ""}` +
            (o.since && snap ? ` · ${W.dur(W.since(o.since, snap.timestamp))}째` : "");
          const l2 = [];
          if (room !== "laundry" && r.temperature_c.value !== null) l2.push(`${r.temperature_c.value.toFixed(1)}°C`, `먼지 ${r.dirt_level.value.toFixed(2)}`);
          if (r.light.state !== "UNKNOWN") l2.push(W.LIGHT[r.light.state]);
          const [ix, iy] = INFO_AT[room];
          this.info[room].innerHTML = `<tspan x="${ix}" y="${iy}">${esc(l1)}</tspan>` + (l2.length ? `<tspan x="${ix}" dy="28" class="l2">${esc(l2.join(" · "))}</tspan>` : "");
          this.info[room].setAttribute("class", "rinfo " + o.state);
        }
        const n = this.nodes[room];
        if (n.g) n.g.setAttribute("class", "nodemark " + status);
        else { n.body.setAttribute("class", "nodebody " + status); n.text.style.fill = status === "FRESH" ? "" : "var(--noise)"; }
        n.text.textContent = status === "OFF" ? "Node 꺼짐" : status === "STALE" ? "Node 끊김" : "Node";
        const showStale = r && r.source.status === "STALE";
        this.stale[room].g.style.display = showStale ? "" : "none";
        if (showStale) {
          const age = W.since(r.source.last_observed_at, snap.timestamp);
          this.stale[room].text.textContent = `${age !== null ? age.toFixed(0) : "?"}초째 소식 없음 · 상태 모름`;
        }
      });

      // 청소기 (state.x_m·y_m = 집 좌표)
      const v = dev.vacuum;
      if (v && v.x_m !== undefined) {
        const target = EY.homeToSim({ x: v.x_m, y: v.y_m });
        if (!this.vacPos || jump) this.vacPos = target;
        else { const k = Math.min(1, dt * 6); this.vacPos = [this.vacPos[0] + (target[0] - this.vacPos[0]) * k, this.vacPos[1] + (target[1] - this.vacPos[1]) * k]; }
        const s = EY.toSvg(this.vacPos);
        $("vac").setAttribute("transform", `translate(${s[0].toFixed(1)} ${s[1].toFixed(1)})`);
        const word = { DOCKED: "충전", TO_ROOM: "이동", CLEANING: "청소 중", RETURNING: "복귀" }[v.status] || v.status;
        $("vacTxt").textContent = `청소기 · ${word} ${Math.round(v.battery * 100)}%`;
      }

      // 세탁기
      const w = dev.washer;
      if (w) {
        const on = w.power === "RUNNING";
        $("waves").style.display = on ? "" : "none";
        $("waves").setAttribute("class", "waves" + (w.mode === "LOW_NOISE" ? " low" : ""));
        $("washTxt").textContent = on ? `작동 중 · ${w.mode === "LOW_NOISE" ? "저소음" : "일반"}` : "완료";
      }

      // 에어컨 바람 (wind_to 사람 쪽으로)
      ["ac_living", "ac_room1"].forEach((id) => {
        const a = dev[id], flow = $("flow_" + id), txt = $("txt_" + id);
        if (!a) return;
        if (a.power !== "ON") { flow.setAttribute("class", "flow off"); txt.textContent = `${H.devices[id].name} 꺼짐`; txt.setAttribute("class", "flowtext off"); return; }
        const from = EY.toSvg(H.devices[id].at);
        const av = a.wind_to && this.people.get(a.wind_to);
        const here = av && (av.presence === "SEEN" || av.presence === "HELD") && av.room === H.devices[id].room;
        const to = here ? EY.toSvg(av.pos) : EY.toSvg(EY.roomCenter(H.devices[id].room));
        const d = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
        const end = [to[0] - (to[0] - from[0]) / d * 60, to[1] - (to[1] - from[1]) / d * 60];
        const start = [from[0] + (to[0] - from[0]) / d * 45, from[1] + (to[1] - from[1]) / d * 45];
        flow.setAttribute("d", `M${start[0].toFixed(0)} ${start[1].toFixed(0)} L${end[0].toFixed(0)} ${end[1].toFixed(0)}`);
        flow.setAttribute("class", "flow");
        txt.setAttribute("class", "flowtext");
        txt.textContent = `${a.target_c}°C · 바람 → ${a.wind_to ? W.who(a.wind_to) : "전체"}`;
      });

      // 방1 조명 (전구 표시)
      const lt = dev.light_room1;
      if (lt) $("bulb").setAttribute("class", "bulb " + (lt.power === "ON" ? "on" : "off"));

      // 커튼
      const c = dev.curtain_room1;
      if (c) {
        let closed = c.position === "CLOSED" ? 1 : 0;
        if (c.position === "MOVING") closed = c.moving_to === "CLOSED" ? c.progress : 1 - c.progress;
        $("curtClosed").style.opacity = closed;
        $("curtOpen").style.opacity = 1 - closed;
      }

      this.renderBubbles(bubbles);
    }

    // ---------- 말풍선 ----------
    // kind: node(스피커) · person(사람이 말함) · device(가전이 반응, 이유와 함께)
    bubbleAt(b) {
      if (b.kind === "node") {
        const p = NODE_AT[b.room];
        return { x: p[0] - 20, y: p[1] - 40, align: p[0] > 900 ? "right" : "left" };
      }
      if (b.kind === "device") {
        const def = H.devices[b.device];
        const p = b.device === "vacuum" && this.vacPos ? EY.toSvg(this.vacPos) : EY.toSvg(def.at || EY.roomCenter(def.room));
        return p[0] > 900 ? { x: p[0] - 30, y: p[1] - 30, align: "right" } : { x: p[0] + 30, y: p[1] - 30, align: "left" };
      }
      const av = [...this.people.values()].find((a) => a.room === b.room && (a.presence === "SEEN" || a.presence === "HELD"));
      const p = av ? EY.toSvg(av.pos) : EY.toSvg(EY.roomCenter(b.room));
      // 사람 옆(바깥쪽이 아니라 방 안쪽)에 붙임
      return p[0] > 900 ? { x: p[0] - 70, y: p[1] + 20, align: "right" } : { x: p[0] + 70, y: p[1] + 20, align: "left" };
    }
    renderBubbles(list) {
      const key = list.map((b) => b.id).join(",");
      if (key === this.bubbleKey) return;
      this.bubbleKey = key;
      const box = $("mapbox");
      const keep = new Set(list.map((b) => b.id));
      box.querySelectorAll(".bubble").forEach((e) => { if (!keep.has(e.dataset.id)) e.remove(); });
      list.forEach((b) => {
        if (box.querySelector(`.bubble[data-id="${b.id}"]`)) return;
        const at = this.bubbleAt(b);
        const d = document.createElement("div");
        d.className = "bubble " + b.kind;
        d.dataset.id = b.id;
        const tx = at.align === "right" ? "-100%" : "0";
        const tf = `translate(${tx}, -100%)`;
        d.style.setProperty("--t", tf);
        d.style.transform = tf;
        d.style.left = ((at.x - VB.x) / VB.w * 100) + "%";
        d.style.top = ((at.y - VB.y) / VB.h * 100) + "%";
        d.innerHTML = `<span class="who">${esc(b.who)}</span>${esc(b.text)}` + (b.why ? `<span class="bwhy">${esc(b.why)}</span>` : "");
        box.appendChild(d);
      });
    }
  };
})();
