import { MODES } from "./modes.js";

const ERROR_COPY = {
  CAMERA_UNSUPPORTED: "CAMERA ACCESS REQUIRED<br>当前浏览器不支持摄像头访问。",
  CAMERA_DENIED: "CAMERA ACCESS REQUIRED<br>请允许浏览器访问摄像头，以体验身体动作交互。",
  CAMERA_FAILED: "CAMERA ACCESS REQUIRED<br>摄像头暂时无法启动，请检查设备是否被其他应用占用。",
  POSE_LOAD_FAILED: "POSE ENGINE OFFLINE<br>姿态识别模块暂时无法启动，请刷新页面后重试。",
  AUDIO_UNSUPPORTED: "AUDIO ENGINE OFFLINE<br>当前浏览器不支持 Web Audio API。",
  AUDIO_FAILED: "AUDIO ENGINE OFFLINE<br>声音引擎暂时无法启动。",
};

const percentage = (value) => `${String(Math.round((value ?? 0) * 100)).padStart(2, "0")}%`;
const decimal = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "--";
const signed = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}` : "--";
const noteLabel = (midi, frequency) => {
  if (!Number.isFinite(midi)) return "尚未调度";
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const name = `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  return Number.isFinite(frequency) ? `${name} · ${frequency.toFixed(1)} Hz` : `${name} · MIDI ${midi}`;
};
const statusText = (snapshot) => {
  if (snapshot.provenance.mode !== "LIVE" || snapshot.system.runtimeStatus !== "RUNNING") return "等待输入";
  if (snapshot.motion.poseLostMs > 0) return "恢复中";
  if (snapshot.motion.trackingState === "grace") return "恢复中";
  if (["paused", "idle"].includes(snapshot.motion.trackingState)) return "输入暂时不可见";
  return null;
};
const inputTarget = (target) => target instanceof HTMLElement
  && (target.matches("input, textarea, select, button, summary") || target.isContentEditable);

export class UI {
  constructor() {
    this.experience = document.querySelector("#experience");
    this.startButton = document.querySelector("#start-button");
    this.startLabel = document.querySelector("#start-label");
    this.stageStop = document.querySelector("#stage-stop");
    this.explainStop = document.querySelector("#explain-stop");
    this.status = document.querySelector(".system-status");
    this.statusLabel = document.querySelector("#status-label");
    this.handStatus = document.querySelector("#hand-status");
    this.notice = document.querySelector("#notice");
    this.startFeedback = document.querySelector("#start-feedback");
    this.explainLayer = document.querySelector("#explain-layer");
    this.explainDetails = document.querySelector(".explain-details");
    this.modeButtons = [...document.querySelectorAll(".mode-button")];
    this.viewButtons = [...document.querySelectorAll(".view-button[data-view]")];
    this.explaining = false;
    this.lastExplainUpdate = 0;
    this.lastGesture = null;
    this.mapSignatures = new Map();
    this.mapTimers = new Map();
    this.meters = {
      motion: document.querySelector("#motion-meter"), tempo: document.querySelector("#tempo-meter"),
      energy: document.querySelector("#energy-meter"), motionValue: document.querySelector("#motion-value"),
      tempoValue: document.querySelector("#tempo-value"), energyValue: document.querySelector("#energy-value"),
    };
    this.explain = {};
    [
      "explain-mode-name", "explain-provenance", "ex-motion-height", "ex-motion-speed",
      "ex-motion-energy", "ex-motion-direction", "ex-motion-duration", "ex-motion-tracking",
      "ex-recent-gesture", "ex-music-pitch", "ex-music-note", "ex-music-bpm",
      "ex-music-density", "ex-music-harmony", "ex-music-pan", "ex-music-sustain",
      "ex-music-phrase", "map-height", "map-pitch", "map-scale", "map-note", "map-speed",
      "map-rhythm", "map-phrase", "map-body-x", "map-pan", "map-image", "map-persistence",
      "map-sustain", "current-mapping", "mode-detail-name", "mode-description", "mode-scale",
      "detail-motion", "detail-music", "detail-system",
    ].forEach((id) => { this.explain[id] = document.querySelector(`#${id}`); });
    this.mappingBands = [...document.querySelectorAll(".mapping-band")];
  }

  bind({ onStartStop, onMode, onPresentation, onDebug, onExplain }) {
    this.startButton.addEventListener("click", onStartStop);
    this.stageStop?.addEventListener("click", onStartStop);
    this.explainStop?.addEventListener("click", onStartStop);
    this.modeButtons.forEach((button) => button.addEventListener("click", () => onMode(button.dataset.mode)));
    this.viewButtons.forEach((button) => button.addEventListener("click", () => onExplain(button.dataset.view === "explain")));
    window.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || inputTarget(event.target)) return;
      if (event.code === "Space" && !event.repeat) { event.preventDefault(); onStartStop(); }
      if (event.repeat) return;
      if (["1", "2", "3"].includes(event.key)) onMode({ 1: "gu-yun", 2: "electronic", 3: "nature" }[event.key]);
      if (event.key.toLowerCase() === "e") onExplain(!this.explaining);
      if (event.key.toLowerCase() === "p") onPresentation();
      if (event.key === "Escape") { onExplain(false); onPresentation(false); }
      if (event.key.toLowerCase() === "d") onDebug?.();
    });
  }

  setRunning(isRunning) {
    this.experience.classList.toggle("running", isRunning);
    this.startLabel.textContent = isRunning ? "STOP" : "START";
    this.startButton.setAttribute("aria-label", isRunning ? "停止体验" : "开始体验");
    if (this.stageStop) {
      this.stageStop.setAttribute("aria-hidden", String(!isRunning));
      this.stageStop.disabled = !isRunning;
    }
    if (this.explainStop) this.explainStop.textContent = isRunning ? "停止" : "开始";
  }

  setLoading(isLoading) {
    this.experience.classList.toggle("starting", isLoading);
    this.startButton.disabled = false;
    if (this.stageStop) this.stageStop.disabled = false;
    if (this.explainStop) this.explainStop.disabled = false;
    if (isLoading) { this.startLabel.textContent = "CANCEL"; if (this.explainStop) this.explainStop.textContent = "取消启动"; }
    if (!isLoading && !this.experience.classList.contains("running")) this.setStartupMessage("");
  }

  setStartupMessage(message) {
    if (!this.startFeedback) return;
    this.startFeedback.textContent = message;
    this.startFeedback.classList.toggle("visible", Boolean(message));
  }

  setStatus(text, kind = "active") {
    this.statusLabel.textContent = text;
    this.status.classList.toggle("active", kind === "active");
    this.status.classList.toggle("error", kind === "error");
  }

  setHandStatus(state) {
    if (!this.handStatus) return;
    const labels = { standby: "HAND DETAIL STANDBY", loading: "HAND DETAIL LOADING", ready: "HAND DETAIL READY", unavailable: "HAND DETAIL UNAVAILABLE · BODY MUSIC CONTINUES" };
    this.handStatus.textContent = labels[state] ?? labels.standby;
    this.handStatus.dataset.state = state;
  }

  setMode(id) {
    this.modeButtons.forEach((button) => {
      const selected = button.dataset.mode === id;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
    });
  }

  setExplain(value) {
    this.explaining = Boolean(value);
    this.experience.classList.toggle("explaining", this.explaining);
    this.experience.classList.remove("debugging");
    this.explainLayer?.setAttribute("aria-hidden", String(!this.explaining));
    this.viewButtons.forEach((button) => {
      const selected = (button.dataset.view === "explain") === this.explaining;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  updateMetrics(metrics) {
    this.meters.motion.style.width = `${Math.round(metrics.wristSpeed * 100)}%`;
    this.meters.energy.style.width = `${Math.round(metrics.motionEnergy * 100)}%`;
    this.meters.tempo.style.width = `${Math.round(Math.min(1, Math.max(0, (metrics.tempo - 60) / 45)) * 100)}%`;
    this.meters.motionValue.textContent = percentage(metrics.wristSpeed);
    this.meters.energyValue.textContent = percentage(metrics.motionEnergy);
    this.meters.tempoValue.textContent = `${metrics.tempo} BPM`;
  }

  updateSnapshot(snapshot, force = false) {
    if (!snapshot) return;
    const { motion, music } = snapshot;
    this.updateMetrics({ wristSpeed: motion.velocity.wrist, motionEnergy: motion.energy.motion, tempo: music.bpm });
    this.updateDebug({ trackingState: motion.trackingState, trackingQuality: motion.trackingQuality,
      wristSpeed: motion.velocity.wrist, armSpread: motion.armSpread, upperBodyEnergy: motion.energy.upperBody,
      tempo: music.bpm, musicState: music.state, handEngineState: snapshot.system.handStatus,
      hands: { left: { detected: snapshot.hands.left.detected }, right: { detected: snapshot.hands.right.detected } },
      handEvents: snapshot.hands.events });
    if (!this.explaining) return;
    if (!force && snapshot.timestamp - this.lastExplainUpdate < 80) return;
    this.lastExplainUpdate = snapshot.timestamp;
    this.updateExplain(snapshot);
  }

  updateExplain(snapshot) {
    const { motion, music, system } = snapshot;
    const unavailable = statusText(snapshot);
    const active = unavailable === null;
    const source = motion.primaryPitchInput.source;
    const sourceLabel = source === "left" ? "左腕" : source === "right" ? "右腕" : "未确定";
    const height = motion.primaryPitchInput.height;
    const direction = motion.direction.vertical > 0 ? "↑ 上升" : motion.direction.vertical < 0 ? "↓ 下降"
      : motion.direction.horizontal > 0 ? "→ 横向" : motion.direction.horizontal < 0 ? "← 横向" : "保持";
    const note = noteLabel(music.midi, music.currentNote);
    const mode = MODES[music.mode] ?? MODES["gu-yun"];
    const preserved = unavailable === "恢复中" || unavailable === "输入暂时不可见";
    const liveValue = (value) => active ? value : preserved ? `保留值 · ${value}` : unavailable;

    this.text("explain-mode-name", mode.name);
    this.text("explain-provenance", snapshot.provenance.mode === "LIVE" ? "LIVE · 摄像头" : "待真实输入");
    this.text("ex-motion-height", active && Number.isFinite(height) ? `${sourceLabel} · ${decimal(height)}` : unavailable);
    this.text("ex-motion-speed", liveValue(decimal(motion.velocity.wrist)));
    this.text("ex-motion-energy", liveValue(decimal(motion.energy.motion)));
    this.text("ex-motion-direction", active ? direction : unavailable);
    this.text("ex-motion-duration", liveValue(`${decimal(motion.persistence.gestureDuration, 1)} s`));
    this.text("ex-motion-tracking", active ? "ACTIVE" : unavailable);
    this.text("ex-music-pitch", liveValue(decimal(music.musicState?.pitch)));
    this.text("ex-music-note", active ? note : preserved && Number.isFinite(music.midi) ? `保留值 · ${note}` : "尚未调度");
    this.text("ex-music-bpm", liveValue(Number.isFinite(music.bpm) ? `${music.bpm}` : "--"));
    this.text("ex-music-density", liveValue(decimal(music.density)));
    this.text("ex-music-harmony", liveValue(decimal(music.harmonyLevel)));
    this.text("ex-music-pan", liveValue(signed(music.pan)));
    this.text("ex-music-sustain", liveValue(decimal(music.sustain)));
    this.text("ex-music-phrase", liveValue(music.phraseState ?? "--"));

    this.captureGesture(snapshot);
    this.text("ex-recent-gesture", this.lastGesture && snapshot.timestamp - this.lastGesture.timestamp < 1800
      ? `刚刚识别到：${this.lastGesture.label}` : active ? "最近手势：暂无" : `最近手势：${unavailable}`);
    this.text("map-height", active && Number.isFinite(height) ? `${sourceLabel} ${decimal(height)}` : unavailable);
    this.text("map-pitch", liveValue(decimal(music.musicState?.pitch)));
    this.text("map-scale", mode.explain.scaleLabel.replace("Scale: ", ""));
    this.text("map-note", active ? note : "--");
    this.text("map-speed", liveValue(decimal(motion.velocity.wrist)));
    this.text("map-rhythm", active ? `${music.bpm} / ${decimal(music.density)}` : unavailable);
    this.text("map-phrase", liveValue(music.phraseState ?? "--"));
    this.text("map-body-x", active ? decimal(motion.position.shoulder.x) : unavailable);
    this.text("map-pan", liveValue(signed(music.pan)));
    this.text("map-image", active ? (Math.abs(music.pan) < 0.08 ? "中央" : music.pan < 0 ? "偏左" : "偏右") : unavailable);
    this.text("map-persistence", active ? `${decimal(motion.persistence.gestureDuration, 1)}s / ${decimal(motion.persistence.stillness)}` : unavailable);
    this.text("map-sustain", liveValue(decimal(music.sustain)));
    this.text("current-mapping", active && source !== "fallback"
      ? `${sourceLabel}高度控制旋律目标；实际音符按当前音阶与音级惯性生成。` : "当前旋律输入来源暂未确定。");
    this.text("mode-detail-name", mode.name);
    this.text("mode-description", mode.explain.description);
    this.text("mode-scale", mode.explain.scaleLabel);
    this.updateBands(snapshot, active);
    if (this.explainDetails?.open) this.updateDetails(snapshot);
  }

  captureGesture(snapshot) {
    const allowed = new Set(["pinch", "open", "close", "swipe"]);
    snapshot.hands.events.forEach((event) => {
      const type = String(event.type ?? "").toLowerCase();
      if (!allowed.has(type)) return;
      const key = [event.timestamp, event.hand, event.finger, type].join(":");
      if (key === this.lastGesture?.key) return;
      const side = event.hand === "left" ? "左手" : event.hand === "right" ? "右手" : "手部";
      this.lastGesture = { key, timestamp: snapshot.timestamp, label: `${side} ${type.toUpperCase()}` };
    });
  }

  updateBands(snapshot, active) {
    const signatures = {
      pitch: [snapshot.motion.primaryPitchInput.height, snapshot.music.musicState?.pitch, snapshot.music.midi],
      rhythm: [snapshot.motion.velocity.wrist, snapshot.music.bpm, snapshot.music.density],
      pan: [snapshot.motion.position.shoulder.x, snapshot.music.pan],
      sustain: [snapshot.motion.persistence.gestureDuration, snapshot.motion.persistence.stillness, snapshot.music.sustain],
    };
    this.mappingBands.forEach((band) => {
      const name = band.dataset.map;
      const signature = signatures[name].map((value) => Number.isFinite(value) ? value.toFixed(3) : value).join("|");
      band.classList.toggle("active", active);
      if (active && this.mapSignatures.has(name) && this.mapSignatures.get(name) !== signature) {
        band.classList.add("changed");
        clearTimeout(this.mapTimers.get(name));
        this.mapTimers.set(name, setTimeout(() => band.classList.remove("changed"), 220));
      }
      this.mapSignatures.set(name, signature);
    });
  }

  updateDetails(snapshot) {
    const { motion, music, system } = snapshot;
    this.pairs("detail-motion", [["velocity", decimal(motion.velocity.wrist)], ["acceleration", decimal(motion.acceleration.wrist)],
      ["direction x / y", `${signed(motion.direction.x)} / ${signed(motion.direction.y)}`], ["trackingQuality", decimal(motion.trackingQuality)],
      ["poseLostMs", decimal(motion.poseLostMs, 0)], ["armSpread", decimal(motion.armSpread)],
      ["wrist visibility", `L ${motion.wristVisibility.left ? "+" : "−"} / R ${motion.wristVisibility.right ? "+" : "−"}`]]);
    this.pairs("detail-music", [["MIDI", music.midi ?? "--"], ["pitchClass", music.pitchClass ?? "--"],
      ["scaleDegree", music.scaleDegree ?? "--"], ["activityLevel", music.activityLevel], ["harmonyInterval", music.harmonyInterval],
      ["sustain", decimal(music.sustain)], ["phraseState", music.phraseState]]);
    this.pairs("detail-system", [["RAF FPS", decimal(system.fps, 1)], ["Pose / Hand", `${system.poseStatus} / ${system.handStatus}`],
      ["Audio", system.audioStatus], ["delegates", `${system.poseDelegate ?? "--"} / ${system.handDelegate ?? "--"}`],
      ["fallback", `Pose ${system.fallback.pose ? "YES" : "NO"} / Hand ${system.fallback.hand ? "YES" : "NO"}`],
      ["inference", `Pose ${decimal(system.inference.poseMs, 1)} ms / Hand ${decimal(system.inference.handMs, 1)} ms`]]);
  }

  pairs(id, rows) {
    const root = this.explain[id];
    if (!root) return;
    root.replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement("p"); const key = document.createElement("span"); const data = document.createElement("b");
      key.textContent = label; data.textContent = String(value ?? "--"); row.append(key, data); return row;
    }));
  }

  text(id, value) { if (this.explain[id]) this.explain[id].textContent = value ?? "--"; }

  updateDebug(metrics) {
    const values = { "debug-tracking": metrics.trackingState?.toUpperCase() ?? "IDLE", "debug-quality": (metrics.trackingQuality ?? 0).toFixed(2),
      "debug-visible": "--", "debug-wrist": (metrics.wristSpeed ?? 0).toFixed(2), "debug-spread": (metrics.armSpread ?? 0).toFixed(2),
      "debug-energy": (metrics.upperBodyEnergy ?? 0).toFixed(2), "debug-bpm": String(metrics.tempo ?? 60),
      "debug-music": metrics.musicState ?? "IDLE", "debug-hand-engine": metrics.handEngineState ?? "LOADING",
      "debug-hands": ["left", "right"].map((side) => `${side[0].toUpperCase()}${metrics.hands?.[side]?.detected ? "+" : "-"}`).join(" "),
      "debug-gesture": metrics.handEvents?.map((event) => `${event.hand[0].toUpperCase()}:${event.type}`).join(" ") || "--" };
    Object.entries(values).forEach(([id, value]) => { const element = document.querySelector(`#${id}`); if (element) element.textContent = value; });
  }

  showError(error) {
    this.setStatus("SYSTEM OFFLINE", "error"); this.setStartupMessage("");
    this.notice.innerHTML = ERROR_COPY[error.message] || "SYSTEM OFFLINE<br>系统暂时无法启动，请刷新后重试。";
    this.notice.classList.add("visible");
  }
  clearError() { this.notice.classList.remove("visible"); }
  setPresentation(value) { this.experience.classList.toggle("presentation", value); if (value) this.setExplain(false); }
  toggleDebug() { if (!this.explaining) this.experience.classList.toggle("debugging"); }
}
