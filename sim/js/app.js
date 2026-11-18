// 조립 + 화면 패널 + 조작.
// 되감기 = 처음부터 다시 만들고 그 시각까지 빨리 감기 (시계가 결정적이라 같은 결과가 나옴)
(function () {
  const H = EY.HOME, SC = EY.SCENARIO, W = EY.WORDS;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const ui = { playing: false, speed: 2, msgTab: "room1", snapTab: "changes", reply: "yes" };
  let sim = null, store = null;
  const view = new EY.View();

  // ---------- 조립 ----------
  function build() {
    const clock = new EY.Clock(SC.base_time);
    const bus = new EY.Bus(clock);
    const s = { clock, bus };
    s.nodes = new EY.FakeNodes(clock, bus, SC);
    s.nodes.reply = ui.reply;
    EY.createDevices(s);
    s.wm = new EY.WorldModel(clock, bus);
    s.orch = new EY.MockOrchestrator(clock, bus);

    // 화면이 듣는 토픽 (화면도 버스의 구독자 하나일 뿐)
    const st = { msgs: {}, voice: [], snap: null, prevSnap: null, trace: null, dev: {}, bubbles: [], devChanged: {} };
    Object.keys(H.rooms).forEach((r) => { st.msgs[r] = { cur: null, prev: null, log: [] }; });
    bus.subscribe("eyear/v0/+/state", (m, topic) => {
      const box = st.msgs[EY.T.roomOf(topic)];
      if (!box) return;
      if (m.event_type === "STATE_CHANGE" || !box.cur) box.prev = box.cur;
      box.cur = m;
      box.log.unshift({ t: clock.hhmmss(), seq: m.seq, type: m.event_type, changes: m.changes.map((c) => c.type.replace("_CHANGED", "").replace("PERSON_", "") + (c.track_id !== null ? "#" + c.track_id : "")).join(" ") });
      if (box.log.length > 8) box.log.pop();
    });
    const bubble = (room, kind, who, text, extra) => {
      st.bubbles.push(Object.assign({ id: EY.uuid(), room, kind, who, text, until: clock.t + 5 }, extra));
    };
    // 가전이 명령을 끝내면(또는 거절하면) 그 가전 옆에 "무엇을 · 왜"를 띄움. 같은 가전의 연속 결과는 한 말풍선으로
    bus.subscribe(EY.T.deviceResult, (r) => {
      if (r.status === "ACCEPTED") return;
      const d = s.orch.decisions.find((x) => x.command_id === r.command_id);
      const act = d ? d.act : r.action;
      const text = r.status === "COMPLETED" ? act : `${act} — ${r.status}${r.reason ? " " + r.reason : ""}`;
      const why = d ? (d.cause || d.why) : "";
      const old = st.bubbles.find((b) => b.kind === "device" && b.device === r.device_id && clock.t - b.at < 2);
      if (old) st.bubbles.splice(st.bubbles.indexOf(old), 1);
      bubble(null, "device", W.dev(r.device_id), old ? `${old.text} · ${text}` : text,
        { device: r.device_id, at: clock.t, why: why.length > 60 ? why.slice(0, 58) + "…" : why, until: clock.t + 6 });
    });
    const addVoice = (dir, topic, m) => { st.voice.unshift({ t: clock.hhmmss(), dir, topic, m }); if (st.voice.length > 6) st.voice.pop(); };
    bus.subscribe("eyear/v0/+/speak", (m, topic) => { addVoice("중앙 → Node (스피커로 말하기)", topic, m); bubble(EY.T.roomOf(topic), "node", "EYEAR", m.text); });
    bus.subscribe("eyear/v0/+/voice/reply", (m, topic) => {
      addVoice("Node → 중앙 (질문에 대한 대답)", topic, m);
      const pid = personIn(EY.T.roomOf(topic));
      bubble(EY.T.roomOf(topic), "person", pid ? W.who(pid) : "?", m.no_response ? "(대답 없음)" : m.text);
    });
    bus.subscribe("eyear/v0/+/voice/command", (m, topic) => {
      addVoice("Node → 중앙 (음성 명령)", topic, m);
      const pid = personIn(EY.T.roomOf(topic));
      bubble(EY.T.roomOf(topic), "person", pid ? W.who(pid) : "?", "하이 엘지, " + m.text);
    });
    bus.subscribe(EY.T.snapshot, (m) => {
      if (!st.snap || st.snap.revision !== m.revision) st.prevSnap = st.snap;
      st.snap = m;
    });
    bus.subscribe(EY.T.trace, (m) => { st.trace = m; });
    bus.subscribe("eyear/v0/device/+/state", (m) => {
      const old = st.dev[m.device_id];
      st.dev[m.device_id] = m.state;
      if (old && W.devState(m.device_id, old) !== W.devState(m.device_id, m.state)) st.devChanged[m.device_id] = clock.t;
    });
    function personIn(room) {
      const p = st.snap && st.snap.people.find((x) => x.room_id === room && (x.presence === "SEEN" || x.presence === "HELD"));
      return p ? p.person_id : null;
    }
    sim = s; store = st;
    view.reset();
  }

  function jumpTo(t) {
    if (!sim || t < sim.clock.t - 1e-6) build();
    sim.clock.advanceTo(t);
    renderAll(true);
  }
  function currentStep(t) {
    let i = -1;
    SC.steps.forEach((s, k) => { if (s.at <= t + 1e-6) i = k; });
    return i;
  }

  // ---------- JSON 보기 (원본 페이지의 노란 줄 표시 그대로) ----------
  // 짧은 배열·객체는 한 줄로
  function pretty(v, ind = "") {
    const flat = JSON.stringify(v);
    if (v === null || typeof v !== "object") return flat;
    const simple = Object.values(v).every((x) => x === null || typeof x !== "object" || (Array.isArray(x) && x.every((y) => typeof y !== "object")));
    if (flat.length <= 64 && simple) return flat.replace(/,"/g, ', "').replace(/":/g, '": ').replace(/,(?=[-\d])/g, ", ");
    const n = ind + "  ";
    if (Array.isArray(v)) return v.length ? "[\n" + v.map((x) => n + pretty(x, n)).join(",\n") + "\n" + ind + "]" : "[]";
    const ks = Object.keys(v);
    return ks.length ? "{\n" + ks.map((k) => n + JSON.stringify(k) + ": " + pretty(v[k], n)).join(",\n") + "\n" + ind + "}" : "{}";
  }
  function colorize(line) {
    const e = esc(line);
    let pre = "", rest = e;
    const km = e.match(/^(\s*)("[^"]*")(:\s?)/);
    if (km) { pre = km[1] + '<span class="k">' + km[2] + "</span>" + km[3]; rest = e.slice(km[0].length); }
    else { const sm = e.match(/^(\s*)/); pre = sm[1]; rest = e.slice(sm[1].length); }
    if (/"/.test(rest)) rest = rest.replace(/"[^"]*"/g, (x) => '<span class="s">' + x + "</span>");
    else rest = rest.replace(/^(-?\d+(?:\.\d+)?|true|false|null)/, '<span class="n">$1</span>');
    return pre + rest;
  }
  // 1초마다 다시 나가는 스냅샷에서 늘 바뀌는 값은 노란 줄에서 뺌 (revision이 그대로여도 바뀔 수 있는 값)
  const IGNORE = /"(event_id|snapshot_id|seq|timestamp|observed_at|last_observed_at|last_seq|value|battery|x_m|y_m|remaining_s|noise_db|progress|revision|command_id|current_command)"/;
  function jsonHTML(obj, prev) {
    const lines = pretty(obj).split("\n");
    const prevSet = prev ? new Set(pretty(prev).split("\n")) : null;
    return '<pre class="json">' + lines.map((l) => {
      const chg = prevSet && !IGNORE.test(l) && !prevSet.has(l) && l.trim() !== "";
      return '<span class="ln' + (chg ? " chg" : "") + '">' + colorize(l) + "</span>";
    }).join("") + "</pre>";
  }
  // 같은 내용이면 다시 그리지 않음, 스크롤 위치 유지
  const lastHTML = {};
  function setHTML(id, html) {
    if (lastHTML[id] === html) return;
    lastHTML[id] = html;
    const el = $(id);
    const scrolls = [...el.querySelectorAll("pre")].map((p) => p.scrollTop);
    el.innerHTML = html;
    el.querySelectorAll("pre").forEach((p, i) => { if (scrolls[i]) p.scrollTop = scrolls[i]; });
  }
  function tabsHTML(list, cur, attr) {
    return list.map(([k, name, dot]) => `<button class="tab" role="tab" type="button" data-${attr}="${k}" aria-selected="${k === cur}">${esc(name)}${dot ? `<span class="dot">${dot}</span>` : ""}</button>`).join("");
  }

  // ---------- 패널 ----------
  function renderNow() {
    const t = sim.clock.t, i = currentStep(t), s = SC.steps[i], nx = SC.steps[i + 1];
    $("clock").innerHTML = `${sim.clock.hhmmss()} <small>+${t.toFixed(1)}s · ${ui.speed}×</small>`;
    $("stepKey").textContent = s ? `${s.id} · 시작 +${s.at}s` + (nx ? ` · 다음 ${nx.id}까지 ${(nx.at - t).toFixed(0)}s` : "") : "";
    $("stepTitle").textContent = s ? s.title : "";
    $("stepDesc").textContent = s ? "기대 결과: " + s.expect : "";
    document.querySelectorAll("#chips .chip").forEach((c, k) => c.setAttribute("aria-current", k === i ? "step" : "false"));
    $("tlFill").style.width = Math.min(100, t / SC.end_at * 100) + "%";
    $("play").textContent = ui.playing ? "일시정지" : t >= SC.end_at ? "처음부터 재생" : "재생";
  }

  function renderMsgs() {
    const rooms = Object.keys(H.rooms);
    setHTML("msgTabs", tabsHTML([...rooms.map((r) => [r, H.rooms[r].name + (H.rooms[r].real ? " · 실물 자리" : "")]), ["voice", "음성", store.voice.length || ""]], ui.msgTab, "msg"));
    let h;
    if (ui.msgTab === "voice") {
      h = store.voice.length ? store.voice.map((v) => `<div class="voicecard"><div class="dir">${esc(v.t)} · ${esc(v.dir)}</div><p class="topic">${esc(v.topic)}</p>${jsonHTML(v.m, null)}</div>`).join("")
        : '<p class="empty">아직 음성 메시지가 없습니다. t2(질문), t5-1(불 켜줘)에서 오갑니다.</p>';
      h += '<p class="note">원본 음성은 Node 밖으로 나가지 않고 텍스트만 오갑니다. "응." 같은 텍스트를 긍정으로 해석하는 것은 중앙이 합니다 (문장부호 무시, 신뢰도 0.3 안팎도 정상).</p>';
    } else {
      const box = store.msgs[ui.msgTab];
      if (!box.cur) h = `<p class="empty">${sim.nodes.nodes[ui.msgTab].online ? "아직 받은 메시지가 없습니다." : "Node가 꺼져 있습니다."}</p>`;
      else {
        h = `<p class="topic">${esc(EY.T.state(ui.msgTab))} · 노란 줄 = 직전 STATE_CHANGE와 다른 부분</p>` + jsonHTML(box.cur, box.prev);
        h += '<table class="msglog"><thead><tr><th>받은 시각</th><th>seq</th><th>종류</th><th>changes</th></tr></thead><tbody>' +
          box.log.map((l) => `<tr class="${l.type === "STATE_CHANGE" ? "sc" : ""}"><td>${l.t}</td><td>${l.seq}</td><td>${l.type}</td><td>${esc(l.changes)}</td></tr>`).join("") + "</tbody></table>";
      }
    }
    setHTML("msgBody", h);
  }

  function renderSnap() {
    const s = store.snap;
    if (!s) { setHTML("snapBody", '<p class="empty">아직 스냅샷이 없습니다.</p>'); return; }
    const srcs = s.rooms.map((r) => `${r.name} <b>${r.source.status}</b>`).join(" · ");
    setHTML("snapHead", `<span>revision <b>${s.revision}</b></span><span>${srcs}</span>`);
    setHTML("snapTabs", tabsHTML([["changes", "이번 변화", s.changes.length], ["people", `사람 ${s.people.length}`], ["rooms", "방"], ["devices", "가전"], ["all", "전체"]], ui.snapTab, "snap"));
    const p = store.prevSnap;
    let h;
    if (ui.snapTab === "changes") {
      h = `<p class="topic">revision ${s.revision}을 만든 changes[] — 1초마다 다시 나갈 때도 그대로 실림</p>` +
        (s.changes.length ? '<ul class="chlist">' + s.changes.map((c) => `<li><code>${esc(c.type)}</code>${esc(W.change(c))}</li>`).join("") + "</ul>" : '<p class="empty">아직 변화 없음</p>') +
        jsonHTML(s.changes, null);
    } else {
      const pick = (x) => (!x ? null : ui.snapTab === "all" ? x : x[ui.snapTab]);
      h = jsonHTML(pick(s), pick(p));
    }
    setHTML("snapBody", h + '<p class="note">revision은 명세서의 변화 종류(사람 들어옴·나감, presence·자세·활동, 재실, 빛, 소리, Node 상태, 온도 0.5°C·먼지 0.1 이상, 가전 상태, 명령 결과)가 생길 때만 올라갑니다. 스냅샷은 1초마다 같은 revision으로 다시 나가고, 그때 온도·배터리·시각 같은 값은 바뀔 수 있습니다.</p>');
    const iss = sim.wm.issues;
    setHTML("issues", iss.length ? iss.slice(0, 6).map((x) => `<li><span class="kind">${x.kind}</span>${x.t} · ${esc(W.room(x.room))} · ${esc(x.detail)}</li>`).join("")
      : '<li>받은 메시지 문제 없음 (seq 끊김·재시작·형식 오류가 생기면 여기 표시)</li>');
  }

  // 지금 누가 어디서 무엇을
  function renderPeopleNow() {
    const s = store.snap;
    if (!s) { setHTML("peopleNow", ""); return; }
    setHTML("peopleNow", s.people.map((p) => {
      const conf = p.identity_source !== "NONE" ? ` · ${W.IDSRC[p.identity_source] || p.identity_source} ${p.identity_confidence.toFixed(2)}` : "";
      const cand = p.candidates.length ? ` · 후보 ${p.candidates.map((c) => W.who(c.identity)).join(", ")}` : "";
      return `<li class="p-${p.presence}"><span class="av">${esc(W.who(p.person_id).slice(0, 2))}</span>` +
        `<span class="where">${esc(W.room(p.room_id))}<span class="pr">${esc(W.PRES_SHORT[p.presence])}${esc(conf)}${esc(cand)}</span></span>` +
        `<span class="what">${esc(W.doing(p, s.timestamp))}${p.activity.rest_episode ? ` · 휴식 ${p.activity.rest_episode}회차` : ""}</span></li>`;
    }).join(""));
  }

  // World Model 변화 → 에이전트 판단 → 가전 결과
  const QUIET = new Set(["ENVIRONMENT_CHANGED", "DEVICE_STATE_CHANGED", "COMMAND_RESULT", "AUDIO_CHANGED"]);
  function renderCausal() {
    const t = sim.clock.t, ds = sim.orch.decisions;
    const items = [];
    sim.wm.history.forEach((h) => {
      const acts = ds.filter((d) => d.rev === h.revision && !d.cause);
      const loud = h.changes.filter((c) => !QUIET.has(c.type));
      if (!acts.length && !loud.length) return;
      items.push({ now: h.now, t: h.t, rev: h.revision, cause: W.summary(loud.length ? loud : h.changes), acts });
    });
    const byCause = new Map();
    ds.filter((d) => d.cause).forEach((d) => {
      const k = d.cause + "@" + d.t;
      if (!byCause.has(k)) { byCause.set(k, { now: d.now, t: d.t, rev: null, cause: d.cause, acts: [] }); items.push(byCause.get(k)); }
      byCause.get(k).acts.push(d);
    });
    items.sort((a, b) => b.now - a.now);
    const cls = (s) => (s.startsWith("COMPLETED") ? "ok" : s.startsWith("FAILED") || s.startsWith("REJECTED") ? "bad" : s === "INFO" ? "info" : "run");
    const word = (s) => (s === "INFO" ? "보냄" : s === "SENT" ? "응답 대기" : s.startsWith("COMPLETED") ? "완료" : s.startsWith("ACCEPTED") ? "진행 중" : s);
    setHTML("causal", items.length ? items.slice(0, 14).map((it) =>
      `<li class="${t - it.now < 5 ? "fresh" : ""}"><span class="ct">${it.t}${it.rev !== null ? `<b>rev ${it.rev}</b>` : "<b>음성</b>"}</span><div>` +
      `<div class="cause">${esc(it.cause)}</div>` +
      (it.acts.length ? '<ul class="acts">' + it.acts.slice().reverse().map((d) =>
        `<li>${d.agent ? `<span class="ag ${d.agent}">${esc(W.AGENT[d.agent] || d.agent)}</span>` : ""}<span class="what">${esc(d.dev)} · ${esc(d.act)}</span>` +
        `<span class="st ${cls(d.status)}">${esc(word(d.status))}</span></li>`).join("") + "</ul>"
        : '<div class="none">→ 할 일 없음 (에이전트 권고 그대로)</div>') +
      "</div></li>").join("") : '<li><span class="ct">—</span><div class="none">아직 변화가 없습니다.</div></li>');
  }

  const AGENTS = [["clean", "청소", "var(--clean)"], ["noise", "소음", "var(--noise)"], ["temp", "온도", "var(--temp)"], ["light", "빛", "var(--light)"]];
  function renderAgents() {
    const tr = store.trace;
    setHTML("agents", AGENTS.map(([id, name, color]) => {
      const a = tr && tr.agents[id];
      return `<div class="agent"><div class="top"><span class="name"><i style="background:${color}"></i>${name} 에이전트</span></div>` +
        `<dl><dt>파악한 상황</dt><dd>${esc(a ? a.sit : "—")}</dd><dt>권고</dt><dd class="rec">${esc(a ? a.rec : "—")}</dd></dl></div>`;
    }).join(""));
  }

  function renderDecisions() {
    const ds = sim.orch.decisions.slice(0, 10);
    const cls = (s) => (s.startsWith("COMPLETED") ? "ok" : s.startsWith("FAILED") || s.startsWith("REJECTED") ? "bad" : s === "INFO" ? "info" : "run");
    const word = (s) => (s === "INFO" ? "보냄" : s === "SENT" ? "보냄 · 응답 대기" : s);
    setHTML("decisions", ds.length ? ds.map((d) => `<li><span class="dev"><span class="time">${d.t}</span>${esc(d.dev)}</span><span class="act">${esc(d.act)}</span>` +
      `<span class="why">${esc(d.why)}</span><span class="why"><span class="st ${cls(d.status)}">${esc(word(d.status))}</span></span></li>`).join("")
      : '<li><span class="dev">—</span><span class="why">아직 판단이 없습니다.</span></li>');
  }

  function renderDevices() {
    const s = store.snap, t = sim.clock.t;
    setHTML("devices", "<tbody>" + Object.entries(H.devices).map(([id, def]) => {
      const d = s && s.devices.find((x) => x.device_id === id);
      const chg = store.devChanged[id] !== undefined && t - store.devChanged[id] < 3;
      const lr = d && d.last_result ? `<br><span class="hint">마지막 명령: ${esc(d.last_result.action)} → ${esc(d.last_result.status)}${d.last_result.reason ? " (" + esc(d.last_result.reason) + ")" : ""}</span>` : "";
      return `<tr class="${chg ? "chg" : ""}"><th scope="row">${esc(def.name)}</th><td>${esc(W.devState(id, d && d.state))}${lr}</td></tr>`;
    }).join("") + "</tbody>");
  }

  function renderFaults() {
    setHTML("faultRows", Object.keys(H.rooms).map((r) => {
      const on = sim.nodes.nodes[r].online, lost = !!sim.nodes.trackLost[r];
      return `<b>${H.rooms[r].name} Node</b><button class="mini${on ? "" : " off"}" data-node="${r}" type="button">${on ? "끄기" : "켜기"}</button>` +
        `<button class="mini" data-restart="${r}" type="button" ${on ? "" : "disabled"}>재시작</button>` +
        `<button class="mini${lost ? " off" : ""}" data-lost="${r}" type="button" title="occupancy는 OCCUPIED 유지, persons만 비움 (LD2450이 가만히 누운 사람을 놓친 상황)">${lost ? "위치 추적 복구" : "위치 추적 놓침"}</button>`;
    }).join('<span style="width:10px"></span>'));
  }

  let lastPanel = -1;
  function renderAll(force) {
    const now = performance.now();
    store.bubbles = store.bubbles.filter((b) => b.until > sim.clock.t);
    const offline = {};
    Object.entries(sim.nodes.nodes).forEach(([r, n]) => { offline[r] = !n.online; });
    view.frame(sim.clock.t, store.snap, store.dev, store.bubbles, offline);
    if (!force && now - lastPanel < 250) return;
    lastPanel = now;
    renderNow(); renderPeopleNow(); renderCausal(); renderMsgs(); renderSnap(); renderAgents(); renderDecisions(); renderDevices(); renderFaults();
  }

  // ---------- 조작 ----------
  $("chips").innerHTML = SC.steps.map((s, k) => `<button class="chip" type="button" data-step="${k}" title="${esc(s.title)}">${s.id}</button>`).join("");
  $("chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-step]");
    if (b) jumpTo(SC.steps[+b.dataset.step].at + 0.5);
  });
  SC.steps.forEach((s) => {
    const k = document.createElement("div");
    k.className = "tick"; k.style.left = (s.at / SC.end_at * 100) + "%";
    $("timeline").appendChild(k);
  });
  $("timeline").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    jumpTo(Math.round((e.clientX - r.left) / r.width * SC.end_at * 10) / 10);
  });
  $("play").addEventListener("click", () => {
    if (!ui.playing && sim.clock.t >= SC.end_at) jumpTo(0.5);
    ui.playing = !ui.playing; renderAll(true);
  });
  $("next").addEventListener("click", () => {
    const nx = SC.steps.find((s) => s.at > sim.clock.t + 0.6);
    jumpTo(nx ? nx.at + 0.5 : SC.end_at);
  });
  $("reset").addEventListener("click", () => { ui.playing = false; build(); sim.clock.advanceTo(0.5); renderAll(true); });
  document.querySelectorAll("[data-speed]").forEach((b) => b.addEventListener("click", () => {
    ui.speed = +b.dataset.speed;
    document.querySelectorAll("[data-speed]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderAll(true);
  }));
  document.querySelector(`[data-speed="${ui.speed}"]`).setAttribute("aria-pressed", "true");
  $("msgTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-msg]"); if (b) { ui.msgTab = b.dataset.msg; renderAll(true); } });
  $("snapTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-snap]"); if (b) { ui.snapTab = b.dataset.snap; renderAll(true); } });
  $("faultRows").addEventListener("click", (e) => {
    const n = e.target.closest("[data-node]"), r = e.target.closest("[data-restart]"), l = e.target.closest("[data-lost]");
    if (l) sim.nodes.setTrackLost(l.dataset.lost, !sim.nodes.trackLost[l.dataset.lost]);
    if (n) sim.nodes.setOnline(n.dataset.node, !sim.nodes.nodes[n.dataset.node].online);
    if (r) sim.nodes.restart(r.dataset.restart);
    renderAll(true);
  });
  $("replySel").innerHTML = Object.entries(EY.REPLY_PRESETS).map(([k, p]) => `<option value="${k}"${k === ui.reply ? " selected" : ""}>${esc(p.label)}</option>`).join("");
  $("replySel").addEventListener("change", (e) => { ui.reply = e.target.value; sim.nodes.reply = ui.reply; });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("select, input, textarea")) return;
    if (e.key === " ") { e.preventDefault(); $("play").click(); }
    else if (e.key === "ArrowRight") $("next").click();
    else if (e.key === "r" || e.key === "R") $("reset").click();
  });

  // ---------- 루프 ----------
  let lastFrame = null;
  function loop(ts) {
    if (lastFrame !== null && ui.playing) {
      const target = Math.min(sim.clock.t + Math.min(0.25, (ts - lastFrame) / 1000) * ui.speed, SC.end_at);
      sim.clock.advanceTo(target);
      if (sim.clock.t >= SC.end_at - 1e-6) ui.playing = false;
    }
    lastFrame = ts;
    renderAll(false);
    requestAnimationFrame(loop);
  }
  // index.html?t=40 → 40초 지점에서 시작, &play → 바로 재생
  const qs = new URLSearchParams(location.search);
  build();
  sim.clock.advanceTo(Math.max(0.5, +qs.get("t") || 0));
  if (qs.has("play")) ui.playing = true;
  renderAll(true);
  requestAnimationFrame(loop);

  window.EY_SIM = () => sim;   // 콘솔에서 확인용
})();
