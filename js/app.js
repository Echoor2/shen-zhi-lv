import { PoseEngine } from "./pose.js";
import { HandEngine } from "./hands.js";
import { HandAnalyzer } from "./fingers.js";
import { HandGestureDetector } from "./hand-gestures.js";
import { MotionAnalyzer } from "./motion.js";
import { MusicEngine } from "./music-engine.js";
import { MODES, applyModeTheme } from "./modes.js";
import { VisualEngine } from "./visual.js";
import { UI } from "./ui.js";
import {
  buildExplainabilitySnapshot,
  createEmptyExplainabilitySnapshot,
  PROVENANCE_MODES,
} from "./explainability.js";

class BodyMusicExperience {
  constructor() {
    this.video = document.querySelector("#camera");
    this.ui = new UI();
    this.mode = MODES["gu-yun"];
    this.motion = new MotionAnalyzer();
    this.music = new MusicEngine();
    this.visual = new VisualEngine(document.querySelector("#visual-canvas"), () => this.mode);
    this.pose = new PoseEngine(this.video, (landmarks, now) => this.onPose(landmarks, now));
    this.hand = new HandEngine(this.video, (detections, now) => this.onHands(detections, now));
    this.handAnalyzer = new HandAnalyzer();
    this.handGestures = new HandGestureDetector();
    this.running = false;
    this.starting = false;
    this.startAttempt = 0;
    this.presentation = false;
    this.metrics = this.motion.getIdleMetrics();
    this.hands = this.createEmptyHandsState();
    this.poseLandmarks = null;
    this.pendingHandEvents = [];
    this.handEvents = [];
    this.explainabilitySnapshot = createEmptyExplainabilitySnapshot();
    this.provenanceMode = PROVENANCE_MODES.PENDING_REAL_TEST;
    this.runtimeStatus = "READY";
    this.lastFrameAt = performance.now();
    this.frameCount = 0;
    this.fps = null;
    this.poseModelLoadingTimeMs = null;
    this.raf = null;
    this.music.onNote = (event) => this.visual.note(event);
    this.ui.bind({
      onStartStop: () => this.toggle(),
      onMode: (id) => this.selectMode(id),
      onPresentation: (value) => this.togglePresentation(value),
      onDebug: () => this.ui.toggleDebug(),
      onExplain: (value) => this.toggleExplain(value),
    });
    window.addEventListener("resize", () => this.visual.resize());
    applyModeTheme(this.mode);
    this.visualLoop(performance.now());
  }

  updateFps(now) {
    this.frameCount += 1;
    const elapsed = now - this.lastFrameAt;
    if (elapsed < 1000) return;
    this.fps = this.frameCount * 1000 / elapsed;
    this.frameCount = 0;
    this.lastFrameAt = now;
  }

  buildSnapshot(music = null, timestamp = performance.now()) {
    const publicMusic = music ?? this.music.getPublicState();
    const audioContext = this.music.audio?.context;
    this.explainabilitySnapshot = buildExplainabilitySnapshot({
      metrics: this.metrics,
      rawMetrics: this.metrics.poseLostMs || this.metrics.trackingState !== "active" ? null : this.motion.getRawMetrics(),
      inputWrists: this.motion.lastInputWrists,
      hands: this.hands,
      handEvents: this.handEvents,
      music: publicMusic,
      mode: this.mode,
      timestamp,
      provenance: this.provenanceMode,
      system: {
        runtimeStatus: this.runtimeStatus,
        poseStatus: this.pose.status,
        handStatus: this.hand.status === "STANDBY" && this.running ? "LOADING" : this.hand.status,
        audioStatus: audioContext?.state?.toUpperCase() ?? "IDLE",
        poseDelegate: this.pose.delegate,
        handDelegate: this.hand.delegate,
        fallback: {
          pose: this.pose.delegate === "CPU",
          hand: this.hand.delegate === "CPU" || this.hand.status === "UNAVAILABLE",
        },
        fps: this.fps,
        modelLoadingTimeMs: this.poseModelLoadingTimeMs,
        inference: {
          poseMs: this.pose.lastInferenceMs,
          handMs: this.hand.lastInferenceMs,
        },
        audioLatency: null,
        lastError: this.pose.lastError ?? this.hand.lastError ?? null,
      },
    });
    return this.explainabilitySnapshot;
  }

  async toggle() {
    if (this.starting) {
      await this.cancelStart();
      return;
    }
    if (this.running) {
      this.stop();
      return;
    }
    await this.start();
  }

  async start() {
    if (this.starting) return;
    const attempt = ++this.startAttempt;
    this.starting = true;
    this.runtimeStatus = "STARTING";
    this.provenanceMode = PROVENANCE_MODES.PENDING_REAL_TEST;
    this.ui.clearError();
    this.ui.setLoading(true);
    this.ui.setStatus("REQUESTING CAMERA");
    this.ui.setStartupMessage("正在请求摄像头权限，请在浏览器提示中选择“允许”。");
    this.ui.setHandStatus("standby");
    try {
      // Start the audio context during the click gesture, then request the camera immediately.
      const musicStartup = this.music.start(this.mode);
      await this.pose.startCamera();
      if (attempt !== this.startAttempt) { this.pose.stop(); await this.music.stop(); return; }
      this.ui.setStartupMessage("摄像头已连接，正在加载姿态识别模块。");
      await musicStartup;
      if (attempt !== this.startAttempt) { this.pose.stop(); await this.music.stop(); return; }
      this.ui.setStatus("LOADING POSE ENGINE");
      const poseLoadStartedAt = performance.now();
      await this.pose.initialize();
      if (attempt !== this.startAttempt) { this.pose.stop(); await this.music.stop(); return; }
      this.poseModelLoadingTimeMs = performance.now() - poseLoadStartedAt;
      this.handAnalyzer.reset();
      this.handGestures.reset();
      this.poseLandmarks = null;
      this.pendingHandEvents = [];
      this.handEvents = [];
      this.running = true;
      this.runtimeStatus = "RUNNING";
      this.provenanceMode = PROVENANCE_MODES.LIVE;
      this.ui.setRunning(true);
      this.ui.setLoading(false);
      this.ui.setStartupMessage("请站到画面中央，挥动手臂开始演奏。");
      this.ui.setStatus("CAMERA READY");
      this.initializeHands();
    } catch (error) {
      if (attempt !== this.startAttempt) return;
      console.error("Unable to start 身姿律:", error);
      this.running = false;
      this.starting = false;
      this.runtimeStatus = "ERROR";
      this.provenanceMode = PROVENANCE_MODES.PENDING_REAL_TEST;
      await this.music.stop();
      this.pose.stop();
      this.ui.setRunning(false);
      this.ui.setLoading(false);
      this.ui.showError(error);
      this.buildSnapshot(null);
      return;
    }
    this.starting = false;
    this.buildSnapshot(null);
  }

  async cancelStart() {
    this.startAttempt += 1;
    this.starting = false;
    this.running = false;
    this.runtimeStatus = "STOPPED";
    this.provenanceMode = PROVENANCE_MODES.PENDING_REAL_TEST;
    this.pose.stop();
    await this.music.stop();
    this.ui.setRunning(false);
    this.ui.setLoading(false);
    this.ui.setHandStatus("standby");
    this.ui.setStatus("SYSTEM READY", "neutral");
    this.ui.setStartupMessage("启动已取消，可再次开始体验。");
    this.buildSnapshot(null);
  }

  createEmptyHandsState(timestamp = 0) {
    return {
      left: null,
      right: null,
      leftQuality: 0,
      rightQuality: 0,
      timestamp,
    };
  }

  async initializeHands() {
    this.ui.setHandStatus("loading");
    try {
      await this.hand.initialize();
      if (this.running) this.ui.setHandStatus("ready");
    } catch (error) {
      // Hands is an optional visual layer; Pose and V3 music keep running.
      console.warn("Hand tracking unavailable; continuing with Pose.", error);
      if (this.running) this.ui.setHandStatus("unavailable");
      this.hand.status = "UNAVAILABLE";
      this.buildSnapshot(null);
    }
  }

  async stop() {
    this.startAttempt += 1;
    this.running = false;
    this.starting = false;
    this.runtimeStatus = "STOPPED";
    this.provenanceMode = PROVENANCE_MODES.PENDING_REAL_TEST;
    this.pose.stop();
    this.hand.reset();
    this.handAnalyzer.reset();
    this.handGestures.reset();
    this.hands = this.createEmptyHandsState();
    this.poseLandmarks = null;
    this.pendingHandEvents = [];
    this.handEvents = [];
    this.ui.setHandStatus("standby");
    this.motion.reset();
    this.metrics = this.motion.getIdleMetrics();
    await this.music.stop();
    this.ui.setRunning(false);
    this.ui.setLoading(false);
    this.ui.setStatus("SYSTEM READY", "neutral");
    this.buildSnapshot(null);
  }

  selectMode(id) {
    const nextMode = MODES[id];
    if (!nextMode) return;
    this.mode = nextMode;
    applyModeTheme(this.mode);
    this.music.setMode(this.mode);
    this.ui.setMode(id);
    this.ui.updateSnapshot(this.buildSnapshot(null));
  }

  togglePresentation(value = !this.presentation) {
    this.presentation = value;
    if (value) this.ui.setExplain(false);
    this.ui.setPresentation(value);
  }

  toggleExplain(value) {
    this.presentation = false;
    this.ui.setPresentation(false);
    this.ui.setExplain(value);
    this.ui.updateSnapshot(this.explainabilitySnapshot, true);
  }

  onPose(landmarks, now) {
    this.poseLandmarks = landmarks;
    this.metrics = this.motion.analyze(landmarks, now);
  }

  onHands(detections, now) {
    const analyzed = this.handAnalyzer.analyze(detections, this.poseLandmarks, now);
    this.hands = {
      ...analyzed,
      leftQuality: analyzed.left.trackingQuality,
      rightQuality: analyzed.right.trackingQuality,
      timestamp: now,
    };
    this.handEvents = this.handGestures.detect(this.hands, now);
    this.pendingHandEvents.push(...this.handEvents);
    this.handEvents.forEach((event) => this.visual.handEvent(event, this.hands));
  }

  visualLoop(now) {
    this.updateFps(now);
    if (this.running) this.pose.detect(now);
    if (this.running) this.hand.detect(now);
    if (this.running) {
      const fingerEvents = this.pendingHandEvents.splice(0);
      const music = this.music.update(this.metrics, this.hands, fingerEvents);
      const snapshot = this.buildSnapshot({ ...music, ...this.music.getPublicState() }, now);
      this.ui.updateSnapshot(snapshot);
      this.ui.setStatus(
        music.state === "FLOW" || music.state === "PLAYING"
          ? "CREATING SOUND"
          : music.state === "PAUSE"
            ? "SUSTAINING SOUND"
            : "CAMERA READY",
      );
    }
    this.visual.setMetrics(this.metrics);
    this.visual.setHands(this.hands);
    this.visual.frame(now);
    if (!this.running) this.ui.updateSnapshot(this.buildSnapshot(null, now));
    this.raf = requestAnimationFrame((time) => this.visualLoop(time));
  }
}

new BodyMusicExperience();
