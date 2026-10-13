const FINGER_INDEXES = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

const POSE_WRISTS = { left: 15, right: 16 };
const SMOOTHING = 0.36;
const HAND_GRACE_MS = 620;

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const lerp = (current, target, amount) => current + (target - current) * amount;
const distance = (a, b) => (!a || !b ? Infinity : Math.hypot(a.x - b.x, a.y - b.y));
const average = (points, fallback) => {
  const valid = points.filter(Boolean);
  if (!valid.length) return fallback;
  return {
    x: valid.reduce((sum, point) => sum + point.x, 0) / valid.length,
    y: valid.reduce((sum, point) => sum + point.y, 0) / valid.length,
  };
};
const direction = (x, y) => ({
  x,
  y,
  horizontal: x > 0.001 ? 1 : x < -0.001 ? -1 : 0,
  vertical: y < -0.001 ? 1 : y > 0.001 ? -1 : 0,
});

const emptyFinger = () => ({
  detected: false,
  extended: false,
  curled: true,
  curl: 1,
  openness: 0,
  x: 0.5,
  y: 0.5,
  velocity: 0,
  acceleration: 0,
  direction: direction(0, 0),
  distanceToPalm: 0,
});

const emptyHand = (side) => ({
  side,
  detected: false,
  confidence: 0,
  trackingQuality: 0,
  x: side === "left" ? 0.4 : 0.6,
  y: 0.5,
  palmSize: 0.12,
  palmRotation: 0,
  openness: 0,
  movementSpeed: 0,
  movementDirection: direction(0, 0),
  alignment: 0,
  allOpen: false,
  closed: false,
  landmarks: null,
  fingers: Object.fromEntries(Object.keys(FINGER_INDEXES).map((name) => [name, emptyFinger()])),
  lostFor: Infinity,
});

export class HandAnalyzer {
  constructor() {
    this.reset();
  }

  reset() {
    this.previous = { left: null, right: null };
    this.lastSeenAt = { left: -Infinity, right: -Infinity };
    this.lastTime = 0;
    this.lastHands = { left: emptyHand("left"), right: emptyHand("right") };
  }

  analyze(detections = [], poseLandmarks = null, now = 0) {
    const assigned = this.assignHands(detections, poseLandmarks);
    const deltaSeconds = this.lastTime ? Math.max((now - this.lastTime) / 1000, 0.016) : 0.062;
    const hands = {};

    ["left", "right"].forEach((side) => {
      const detection = assigned[side];
      if (detection?.landmarks?.[0]) {
        hands[side] = this.buildHand(side, detection, poseLandmarks?.[POSE_WRISTS[side]], deltaSeconds);
        this.previous[side] = hands[side];
        this.lastSeenAt[side] = now;
        return;
      }
      hands[side] = this.handleLoss(side, now);
    });

    this.lastTime = now;
    this.lastHands = hands;
    return hands;
  }

  assignHands(detections, poseLandmarks) {
    const slots = { left: null, right: null };
    const remaining = [...detections];

    // Pose wrists are the stable spatial reference; handedness is only a fallback.
    ["left", "right"].forEach((side) => {
      const poseWrist = poseLandmarks?.[POSE_WRISTS[side]];
      if (!poseWrist || (poseWrist.visibility ?? 1) < 0.25) return;
      let closestIndex = -1;
      let closestDistance = 0.28;
      remaining.forEach((detection, index) => {
        const candidateDistance = distance(detection.landmarks?.[0], poseWrist);
        if (candidateDistance < closestDistance) {
          closestDistance = candidateDistance;
          closestIndex = index;
        }
      });
      if (closestIndex >= 0) slots[side] = remaining.splice(closestIndex, 1)[0];
    });

    remaining.forEach((detection) => {
      const label = detection.label === "left" || detection.label === "right" ? detection.label : null;
      const fallback = label && !slots[label] ? label : !slots.left ? "left" : !slots.right ? "right" : null;
      if (fallback) slots[fallback] = detection;
    });
    return slots;
  }

  buildHand(side, detection, poseWrist, deltaSeconds) {
    const previous = this.previous[side];
    const landmarks = this.smoothLandmarks(detection.landmarks, previous?.landmarks);
    const wrist = landmarks[0];
    const palmCenter = average([wrist, landmarks[5], landmarks[9], landmarks[13], landmarks[17]], wrist);
    const palmSize = Math.max(distance(wrist, landmarks[9]), distance(landmarks[5], landmarks[17]) * 0.72, 0.045);
    const alignment = poseWrist ? clamp(1 - distance(wrist, poseWrist) / 0.24) : 0.8;
    const fingers = {};

    Object.entries(FINGER_INDEXES).forEach(([name, indexes]) => {
      const [mcp, pip, dip, tip] = indexes;
      const previousFinger = previous?.fingers?.[name];
      const tipPoint = landmarks[tip] ?? landmarks[dip] ?? landmarks[pip] ?? landmarks[mcp] ?? palmCenter;
      const jointPoint = landmarks[pip] ?? landmarks[mcp] ?? palmCenter;
      const tipDistance = distance(tipPoint, wrist) / palmSize;
      const jointDistance = distance(jointPoint, wrist) / palmSize;
      const extensionRatio = name === "thumb"
        ? distance(tipPoint, landmarks[5] ?? palmCenter) / palmSize
        : tipDistance / Math.max(0.1, jointDistance);
      const threshold = name === "thumb" ? 0.88 : 1.23;
      const releaseThreshold = name === "thumb" ? 0.76 : 1.12;
      const extended = previousFinger?.extended
        ? extensionRatio > releaseThreshold
        : extensionRatio > threshold;
      const curl = clamp(name === "thumb"
        ? (1.1 - extensionRatio) / 0.45
        : (1.42 - extensionRatio) / 0.42);
      const openness = clamp(name === "thumb"
        ? (extensionRatio - 0.55) / 0.68
        : (extensionRatio - 0.9) / 0.56);
      const previousPoint = previousFinger ? { x: previousFinger.x, y: previousFinger.y } : null;
      const dx = previousPoint ? tipPoint.x - previousPoint.x : 0;
      const dy = previousPoint ? tipPoint.y - previousPoint.y : 0;
      const velocity = clamp(Math.hypot(dx, dy) / deltaSeconds / Math.max(palmSize, 0.05) * 0.12);
      const acceleration = clamp(Math.abs(velocity - (previousFinger?.velocity ?? 0)) / deltaSeconds * 0.08);
      fingers[name] = {
        detected: Boolean(tipPoint),
        extended,
        curled: curl >= 0.64,
        curl,
        openness,
        x: tipPoint.x,
        y: tipPoint.y,
        velocity,
        acceleration,
        direction: direction(dx, dy),
        distanceToPalm: clamp(distance(tipPoint, palmCenter) / (palmSize * 2.5)),
      };
    });

    const nonThumb = ["index", "middle", "ring", "pinky"];
    const extendedCount = Object.values(fingers).filter((finger) => finger.extended).length;
    const averageCurl = nonThumb.reduce((sum, name) => sum + fingers[name].curl, 0) / nonThumb.length;
    const fingertipSpread = distance(landmarks[8], landmarks[20]) / (palmSize * 3.6);
    const openness = clamp(extendedCount / 5 * 0.72 + fingertipSpread * 0.28);
    const centerDx = previous ? palmCenter.x - previous.x : 0;
    const centerDy = previous ? palmCenter.y - previous.y : 0;
    const movementSpeed = clamp(Math.hypot(centerDx, centerDy) / deltaSeconds / palmSize * 0.1);
    const confidence = clamp((detection.score ?? 0.75) * 0.78 + alignment * 0.22);

    return {
      side,
      detected: true,
      confidence,
      trackingQuality: confidence,
      x: palmCenter.x,
      y: palmCenter.y,
      palmSize,
      palmRotation: Math.atan2((landmarks[5]?.y ?? 0) - (landmarks[17]?.y ?? 0), (landmarks[5]?.x ?? 1) - (landmarks[17]?.x ?? 0)),
      openness,
      movementSpeed,
      movementDirection: direction(centerDx, centerDy),
      alignment,
      allOpen: extendedCount >= 5 && openness >= 0.72,
      closed: averageCurl >= 0.6 && extendedCount <= 1,
      landmarks,
      fingers,
      lostFor: 0,
    };
  }

  smoothLandmarks(landmarks, previous) {
    return landmarks.map((point, index) => {
      const prior = previous?.[index];
      if (!prior || !point) return { ...point };
      return {
        ...point,
        x: lerp(prior.x, point.x, SMOOTHING),
        y: lerp(prior.y, point.y, SMOOTHING),
        z: lerp(prior.z ?? 0, point.z ?? 0, SMOOTHING),
      };
    });
  }

  handleLoss(side, now) {
    const previous = this.previous[side];
    const lostFor = Number.isFinite(this.lastSeenAt[side]) ? now - this.lastSeenAt[side] : Infinity;
    if (previous && lostFor <= HAND_GRACE_MS) {
      const fade = clamp(lostFor / HAND_GRACE_MS);
      return {
        ...previous,
        detected: false,
        confidence: previous.confidence * (1 - fade * 0.65),
        trackingQuality: previous.trackingQuality * (1 - fade * 0.8),
        movementSpeed: previous.movementSpeed * (1 - fade),
        lostFor,
      };
    }
    return { ...emptyHand(side), lostFor };
  }
}
