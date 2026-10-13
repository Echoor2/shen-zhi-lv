const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = null) => Number.isFinite(value) ? value : fallback;
const copy = (value) => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(copy);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)]));
  return value;
};

const deepFreeze = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

export const PROVENANCE_MODES = Object.freeze({
  LIVE: "LIVE",
  SYNTHETIC: "SYNTHETIC",
  PENDING_REAL_TEST: "PENDING_REAL_TEST",
});

const emptyFinger = () => ({
  detected: false,
  extended: false,
  curled: false,
  curl: 0,
  openness: 0,
  velocity: 0,
  acceleration: 0,
  direction: { x: 0, y: 0, horizontal: 0, vertical: 0 },
});

const emptyHand = () => ({
  detected: false,
  height: null,
  position: { x: null, y: null },
  speed: 0,
  movementDirection: { x: 0, y: 0, horizontal: 0, vertical: 0 },
  trackingQuality: 0,
  openness: 0,
  fingers: {
    thumb: emptyFinger(),
    index: emptyFinger(),
    middle: emptyFinger(),
    ring: emptyFinger(),
    pinky: emptyFinger(),
  },
  lostFor: 0,
  gestures: [],
});

export const createEmptyExplainabilitySnapshot = ({ provenance = PROVENANCE_MODES.PENDING_REAL_TEST } = {}) => ({
  schemaVersion: "v5-p0",
  timestamp: 0,
  provenance: {
    mode: provenance,
    source: provenance === PROVENANCE_MODES.LIVE ? "camera" : "none",
    realCameraValidated: false,
  },
  motion: {
    position: {
      leftHand: { x: null, y: null, height: null },
      rightHand: { x: null, y: null, height: null },
      body: { x: null, y: null },
      shoulder: { x: null, y: null },
    },
    velocity: { leftWrist: 0, rightWrist: 0, wrist: 0, averageWrist: 0, body: 0 },
    acceleration: { wrist: 0 },
    energy: { motion: 0, upperBody: 0, amplitude: 0 },
    direction: { horizontal: 0, vertical: 0, x: 0, y: 0 },
    persistence: { gestureDuration: 0, intentionalMotion: false, stillness: 1 },
    trackingQuality: 0,
    trackingState: "idle",
    poseLostMs: 0,
    armSpread: 0,
    wristVisibility: { left: false, right: false },
    primaryPitchInput: { source: "unknown", height: null },
    raw: {
      detectorWrists: { left: null, right: null },
      featureStage: "LANDMARK_EMA_BEFORE_METRIC_EMA",
      position: { leftHand: { x: null, y: null, height: null }, rightHand: { x: null, y: null, height: null } },
      velocity: { wrist: 0 },
      acceleration: { wrist: 0 },
      energy: { motion: 0 },
      tempo: 60,
      primaryPitchInput: { source: "unknown", height: null },
      detectorPitchInput: { source: "none", height: null },
    },
  },
  hands: {
    left: emptyHand(),
    right: emptyHand(),
    events: [],
    status: "STANDBY",
  },
  music: {
    state: "IDLE",
    currentNote: null,
    midi: null,
    pitchClass: null,
    scaleDegree: null,
    bpm: 60,
    density: 0,
    amplitude: 0,
    energy: 0,
    harmonyLevel: 0,
    harmonyInterval: 0,
    pan: 0,
    sustain: 0,
    phraseState: "REST",
    mode: null,
    activityLevel: 0,
    musicState: null,
  },
  system: {
    runtimeStatus: "READY",
    poseStatus: "IDLE",
    handStatus: "STANDBY",
    audioStatus: "IDLE",
    poseDelegate: null,
    handDelegate: null,
    fallback: { pose: false, hand: false },
    fps: null,
    inference: { poseMs: null, handMs: null },
    audioLatency: null,
    lastError: null,
  },
});

const handSnapshot = (hand, fallback = emptyHand()) => {
  const value = hand ?? fallback;
  return {
    ...copy(fallback),
    ...copy(value),
    // HandAnalyzer stores camera-space Y; Explain uses height where larger means higher.
    height: Number.isFinite(value.y) ? clamp(1 - value.y) : finite(value.height),
    position: { x: finite(value.x), y: finite(value.y) },
    speed: finite(value.movementSpeed, 0),
    movementDirection: copy(value.movementDirection ?? fallback.movementDirection),
    trackingQuality: finite(value.trackingQuality, 0),
    fingers: Object.fromEntries(Object.keys(fallback.fingers).map((finger) => [
      finger,
      { ...copy(fallback.fingers[finger]), ...copy(value.fingers?.[finger] ?? {}) },
    ])),
    lostFor: finite(value.lostFor, 0),
    gestures: [],
  };
};

export const buildExplainabilitySnapshot = ({
  metrics,
  rawMetrics,
  inputWrists,
  hands,
  handEvents = [],
  music,
  mode,
  system = {},
  timestamp = 0,
  provenance = PROVENANCE_MODES.PENDING_REAL_TEST,
} = {}) => {
  const base = createEmptyExplainabilitySnapshot({ provenance });
  const motion = metrics ?? {};
  const rawMotion = rawMetrics ?? {};
  const musicState = music?.musicState ?? null;
  const left = handSnapshot(hands?.left, base.hands.left);
  const right = handSnapshot(hands?.right, base.hands.right);
  const leftWristVisible = motion.leftHandVisible === true && Number.isFinite(motion.leftHandHeight);
  const rightWristVisible = motion.rightHandVisible === true && Number.isFinite(motion.rightHandHeight);
  const primaryPitchInput = leftWristVisible
    ? { source: "left", height: motion.leftHandHeight }
    : rightWristVisible
      ? { source: "right", height: motion.rightHandHeight }
      : { source: "fallback", height: null };
  const rawLeftVisible = rawMotion.leftHandVisible === true && Number.isFinite(rawMotion.leftHandHeight);
  const rawRightVisible = rawMotion.rightHandVisible === true && Number.isFinite(rawMotion.rightHandHeight);
  const rawPrimaryPitchInput = rawLeftVisible
    ? { source: "left", height: rawMotion.leftHandHeight }
    : rawRightVisible
      ? { source: "right", height: rawMotion.rightHandHeight }
      : { source: "fallback", height: null };
  left.gestures = handEvents.filter((event) => event.hand === "left").map(copy);
  right.gestures = handEvents.filter((event) => event.hand === "right").map(copy);

  const snapshot = {
    ...base,
    timestamp,
    provenance: {
      ...base.provenance,
      mode: provenance,
      source: provenance === PROVENANCE_MODES.LIVE ? "camera" : provenance === PROVENANCE_MODES.SYNTHETIC ? "synthetic-input" : "none",
    },
    motion: {
      position: {
        leftHand: { x: finite(motion.leftHandX), y: finite(motion.leftHandHeight === null ? null : 1 - motion.leftHandHeight), height: finite(motion.leftHandHeight) },
        rightHand: { x: finite(motion.rightHandX), y: finite(motion.rightHandHeight === null ? null : 1 - motion.rightHandHeight), height: finite(motion.rightHandHeight) },
        body: { x: finite(motion.center?.x), y: finite(motion.center?.y) },
        shoulder: { x: finite(motion.shoulderCenterX), y: finite(motion.shoulderCenterY) },
      },
      velocity: {
        leftWrist: finite(motion.leftWristSpeed, 0),
        rightWrist: finite(motion.rightWristSpeed, 0),
        wrist: finite(motion.wristSpeed, 0),
        averageWrist: finite(motion.averageWristVelocity, 0),
        body: finite(motion.bodyMovement, 0),
      },
      acceleration: { wrist: finite(motion.wristAcceleration, 0) },
      energy: {
        motion: finite(motion.motionEnergy, 0),
        upperBody: finite(motion.upperBodyEnergy, 0),
        amplitude: finite(motion.motionAmplitude, 0),
      },
      direction: {
        horizontal: finite(motion.horizontalDirection, 0),
        vertical: finite(motion.verticalDirection, 0),
        x: finite(motion.gestureDirection?.x, 0),
        y: finite(motion.gestureDirection?.y, 0),
      },
      persistence: {
        gestureDuration: finite(motion.gestureDuration, 0),
        intentionalMotion: Boolean(motion.intentionalMotion),
        stillness: finite(motion.stillness, 1),
      },
      trackingQuality: finite(motion.trackingQuality, 0),
      trackingState: motion.trackingState ?? "idle",
      poseLostMs: finite(motion.poseLostMs, 0),
      armSpread: finite(motion.armSpread, 0),
      wristVisibility: { left: leftWristVisible, right: rightWristVisible },
      primaryPitchInput,
      raw: {
        detectorWrists: copy(inputWrists ?? { left: null, right: null }),
        featureStage: "LANDMARK_EMA_BEFORE_METRIC_EMA",
        position: {
          leftHand: { x: finite(rawMotion.leftHandX), y: Number.isFinite(rawMotion.leftHandHeight) ? finite(1 - rawMotion.leftHandHeight) : null, height: finite(rawMotion.leftHandHeight) },
          rightHand: { x: finite(rawMotion.rightHandX), y: Number.isFinite(rawMotion.rightHandHeight) ? finite(1 - rawMotion.rightHandHeight) : null, height: finite(rawMotion.rightHandHeight) },
        },
        velocity: { wrist: finite(rawMotion.wristSpeed, 0) },
        acceleration: { wrist: finite(rawMotion.wristAcceleration, 0) },
        energy: { motion: finite(rawMotion.motionEnergy, 0) },
        tempo: finite(rawMotion.tempo, 60),
        primaryPitchInput: rawPrimaryPitchInput,
        detectorPitchInput: inputWrists?.left
          ? { source: "left", height: clamp(1 - inputWrists.left.y) }
          : inputWrists?.right ? { source: "right", height: clamp(1 - inputWrists.right.y) }
            : { source: "none", height: null },
      },
    },
    hands: {
      left,
      right,
      events: handEvents.map(copy),
      status: system.handStatus ?? "STANDBY",
    },
    music: {
      ...base.music,
      state: music?.state ?? "IDLE",
      currentNote: music?.currentNote ?? null,
      midi: finite(music?.midi),
      pitchClass: finite(music?.pitchClass),
      scaleDegree: finite(music?.scaleDegree),
      bpm: finite(music?.bpm, 60),
      density: finite(musicState?.density, 0),
      amplitude: finite(musicState?.amplitude, 0),
      energy: finite(musicState?.energy, 0),
      harmonyLevel: finite(musicState?.harmonyRichness, 0),
      harmonyInterval: finite(musicState?.harmonyInterval, 0),
      pan: finite(musicState?.pan, 0),
      sustain: finite(musicState?.sustain, 0),
      phraseState: music?.phraseState ?? "REST",
      mode: mode?.id ?? null,
      activityLevel: finite(music?.activityLevel, 0),
      musicState: copy(musicState),
    },
    system: {
      ...base.system,
      ...copy(system),
      fallback: { ...base.system.fallback, ...(system.fallback ?? {}) },
      inference: { ...base.system.inference, ...(system.inference ?? {}) },
    },
  };

  return deepFreeze(snapshot);
};
