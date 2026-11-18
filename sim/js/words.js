// 화면용 한국어 표현 (스냅샷 값 → 사람이 읽는 말). 화면만 쓰고, 데이터 형식에는 영향 없음.
window.EY = window.EY || {};

(function () {
  const H = EY.HOME;
  const W = EY.WORDS = {
    OCC: { EMPTY: "비어 있음", OCCUPIED: "사람 있음", UNKNOWN: "모름" },
    LIGHT: { DARK: "어두움", DIM: "조금 어두움", BRIGHT: "밝음", UNKNOWN: "모름" },
    AUDIO: { SILENT: "조용함", SPEECH: "말소리", TV: "TV 소리", LOUD_NOISE: "시끄러움", UNKNOWN: "모름" },
    POSTURE: { STANDING: "서 있음", SITTING: "앉아 있음", LYING: "누워 있음", WALKING: "걷는 중", UNKNOWN: "자세 모름" },
    ACT: { RESTING: "휴식", OTHER: "활동 중", UNKNOWN: "활동 모름" },
    PRES: { SEEN: "보임", HELD: "재실 레이더로만 확인", IN_TRANSIT: "이동 중", LAST_KNOWN: "마지막 위치만 앎" },
    PRES_SHORT: { SEEN: "보임", HELD: "레이더만", IN_TRANSIT: "이동 중", LAST_KNOWN: "위치 모름" },
    SRC: { FRESH: "정상", STALE: "끊김", NO_DATA: "데이터 없음" },
    IDSRC: { FACE: "얼굴", TRACK_CARRIED: "추적 유지", VOICE: "목소리", NONE: "모름" },
    AGENT: { clean: "청소", noise: "소음", temp: "온도", light: "빛", voice: "음성" },
  };

  W.who = (pidOrIdentity) => {
    if (!pidOrIdentity) return "?";
    if (H.preferences[pidOrIdentity]) return H.preferences[pidOrIdentity].label;
    if (pidOrIdentity.startsWith("anon_")) return "?" + pidOrIdentity.split("_t").pop();
    return pidOrIdentity;
  };
  W.room = (id) => (H.rooms[id] ? H.rooms[id].name : id || "");
  W.dev = (id) => (H.devices[id] ? H.devices[id].name : id || "");

  // 경과 시간 "12초" "3분 5초"
  W.dur = (sec) => {
    if (sec === null || sec === undefined || !isFinite(sec)) return "";
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec}초`;
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `${m}분 ${s}초` : `${m}분`;
  };
  W.since = (iso, nowIso) => (iso && nowIso ? (Date.parse(nowIso) - Date.parse(iso)) / 1000 : null);

  // 사람 한 명의 "지금 하는 일" 한 줄: "누워서 휴식 · 1분 12초째"
  W.doing = (p, nowIso) => {
    if (p.presence === "IN_TRANSIT") return `${W.room(p.room_id)}에서 나감 · ${W.dur(W.since(p.presence_since, nowIso))}째 이동 중`;
    if (p.presence === "LAST_KNOWN") return `${W.room(p.room_id)}에서 마지막으로 봄 · ${W.dur(W.since(p.presence_since, nowIso))} 전`;
    const pos = p.posture.state === "UNKNOWN" ? "자세 모름(어두움)" : W.POSTURE[p.posture.state];
    const act = p.activity.state === "RESTING" ? `휴식 ${W.dur(W.since(p.activity.since, nowIso))}째` : W.ACT[p.activity.state];
    return `${pos} · ${act}`;
  };

  // changes[] 한 개 → 한국어 문장
  W.change = (c) => {
    const who = W.who(c.person_id), room = W.room(c.room_id), dev = W.dev(c.device_id);
    switch (c.type) {
      case "PERSON_ENTERED": return `${who}가 ${room}에 들어옴`;
      case "PERSON_LEFT": return `${who}가 ${room}에서 나감`;
      case "PERSON_REMOVED": return `${who} 기록 삭제 (${c.after || ""})`;
      case "PRESENCE_CHANGED": return `${who}: ${W.PRES[c.after] || c.after}`;
      case "IDENTITY_CHANGED": return `${who} 신원 근거 ${c.before} → ${c.after}`;
      case "POSTURE_CHANGED": return `${who} ${W.POSTURE[c.after] || c.after}`;
      case "ACTIVITY_CHANGED": return `${who} ${c.after.startsWith("RESTING") ? "휴식 시작" + (c.after.match(/\((.*)\)/) ? " (" + c.after.match(/\((.*)\)/)[1] + ")" : "") : W.ACT[c.after] || c.after}`;
      case "OCCUPANCY_CHANGED": return `${room} ${W.OCC[c.after] || c.after}`;
      case "LIGHT_CHANGED": return `${room} ${W.LIGHT[c.after] || c.after}`;
      case "AUDIO_CHANGED": return `${room} ${W.AUDIO[c.after] || c.after}`;
      case "SOURCE_CHANGED": return `${room} Node ${W.SRC[c.after] || c.after}`;
      case "ENVIRONMENT_CHANGED": return `${room} ${c.after}`;
      case "DEVICE_STATE_CHANGED": return `${dev} 상태 바뀜`;
      case "COMMAND_RESULT": return `${dev} ${c.before} → ${c.after}`;
    }
    return `${c.type} ${room || dev}`;
  };
  // 사람 눈에 중요한 변화부터 (화면 요약용)
  const RANK = ["PERSON_ENTERED", "PERSON_LEFT", "PRESENCE_CHANGED", "ACTIVITY_CHANGED", "POSTURE_CHANGED", "OCCUPANCY_CHANGED", "LIGHT_CHANGED", "SOURCE_CHANGED", "AUDIO_CHANGED", "IDENTITY_CHANGED", "PERSON_REMOVED", "ENVIRONMENT_CHANGED", "DEVICE_STATE_CHANGED", "COMMAND_RESULT"];
  W.summary = (changes, max = 3) => {
    const xs = changes.slice().sort((a, b) => RANK.indexOf(a.type) - RANK.indexOf(b.type));
    const out = [], seen = new Set();
    xs.forEach((c) => { const s = W.change(c); if (!seen.has(s)) { seen.add(s); out.push(s); } });
    return out.length > max ? out.slice(0, max).join(" · ") + ` 외 ${out.length - max}건` : out.join(" · ");
  };

  // 가전 state 한 줄
  W.devState = (id, s) => {
    if (!s || !Object.keys(s).length) return "—";
    const lb = (x) => (x ? W.who(x) : "전체");
    switch (H.devices[id].type) {
      case "ROBOT_VACUUM": return `${{ DOCKED: "도크에서 충전", TO_ROOM: "이동 중", CLEANING: "청소 중", RETURNING: "도크로 복귀 중" }[s.status] || s.status}${s.room ? " · " + W.room(s.room) : ""} · 배터리 ${Math.round(s.battery * 100)}%`;
      case "WASHER": return s.power === "RUNNING" ? `작동 중 · ${s.mode === "LOW_NOISE" ? "저소음" : "일반"} (${s.noise_db}dB)` : "완료";
      case "AC": return s.power === "ON" ? `켜짐 · ${s.target_c}°C · 바람 → ${lb(s.wind_to)}` : "꺼짐";
      case "LIGHT": return s.power === "ON" ? "켜짐" : "꺼짐";
      case "CURTAIN": return s.position === "MOVING" ? `움직이는 중 → ${s.moving_to === "CLOSED" ? "닫힘" : "열림"}` : s.position === "CLOSED" ? "닫힘" : "열림";
    }
    return JSON.stringify(s);
  };
})();
