const POINTS = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
};

const CONFIG = {
  smoothingFactor: 0.28,
  metricSmoothing: 0.22,
  velocitySmoothing: 0.3,
  minimumPointVisibility: 0.32,
  minimumTrackingQuality: 0.4,
  poseLostGracePeriod: 1200,
  stillEnergy: 0.035,
  intentEnergy: 0.065,
  intentSpeed: 0.08,
  intentHoldMs: 140,
  neutralTempo: 60,
  maxTempo: 110,
  directionThreshold: 0.0025,
  gestureSpeedThreshold: 0.05,
};

const QUALITY_WEIGHTS = {
  leftShoulder: 0.25,
  rightShoulder: 0.25,
  leftElbow: 0.1,
  rightElbow: 0.1,
  leftWrist: 0.15,
  rightWrist: 0.15,
};

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const lerp = (current, target, amount) => current + (target - current) * amount;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const averagePoint = (points, fallback) => {
  const valid = points.filter(Boolean);
  if (!valid.length) return fallback;
  return {
    x: valid.reduce((total, point) => total + point.x, 0) / valid.length,
    y: valid.reduce((total, point) => total + point.y, 0) / valid.length,
  };
};

export class MotionAnalyzer {
  constructor() {
    this.reset();
  }

  reset() {
    this.previousPoints = {};
    this.smoothedLandmarks = null;
    this.smoothedMetrics = null;
    this.lastValidPoseTime = 0;
    this.lastTime = 0;
    this.intentDuration = 0;
    this.scaleReference = 0.22;
    this.previousWristVelocity = 0;
    this.gestureDuration = 0;
    // Read-only pre-metric-EMA observations for the explainability snapshot.
    // They are never read by the production mapping path.
    this.lastRawMetrics = null;
    this.lastInputWrists = null;
  }

  analyze(landmarks, now) {
    const points = this.extractVisiblePoints(landmarks);
    const trackingQuality = this.getTrackingQuality(points);
    this.lastInputWrists = {
      left: points.leftWrist ? { x: points.leftWrist.x, y: points.leftWrist.y } : null,
      right: points.rightWrist ? { x: points.rightWrist.x, y: points.rightWrist.y } : null,
    };
    if (trackingQuality < CONFIG.minimumTrackingQuality) return this.handlePoseLoss(now);

    const smoothedLandmarks = this.smoothLandmarks(landmarks, points);
    const smoothPoints = this.extractVisiblePoints(smoothedLandmarks);
    const metrics = this.buildMetrics(smoothPoints, smoothedLandmarks, trackingQuality, now);
    this.lastValidPoseTime = now;
    this.lastTime = now;
    this.smoothedMetrics = metrics;
    return metrics;
  }

  extractVisiblePoints(landmarks) {
    if (!landmarks) return {};
    return Object.fromEntries(
      Object.entries(POINTS).map(([name, index]) => {
        const point = landmarks[index];
        return [name, this.isVisible(point) ? point : null];
      }),
    );
  }

  isVisible(point) {
    if (!point) return false;
    return (point.visibility ?? point.presence ?? 1) >= CONFIG.minimumPointVisibility;
  }

  getTrackingQuality(points) {
    return clamp(Object.entries(QUALITY_WEIGHTS).reduce(
      (quality, [name, weight]) => quality + (points[name] ? weight : 0),
      0,
    ));
  }

  smoothLandmarks(landmarks, points) {
    const next = landmarks.map((point) => ({ ...point }));
    if (!this.smoothedLandmarks) {
      this.smoothedLandmarks = next;
      return next;
    }

    Object.entries(POINTS).forEach(([name, index]) => {
      const current = points[name];
      const previous = this.smoothedLandmarks[index];
      if (!current || !previous) return;
      next[index] = {
        ...current,
        x: lerp(previous.x, current.x, CONFIG.smoothingFactor),
        y: lerp(previous.y, current.y, CONFIG.smoothingFactor),
        z: lerp(previous.z ?? 0, current.z ?? 0, CONFIG.smoothingFactor),
      };
    });
    this.smoothedLandmarks = next;
    return next;
  }

  buildMetrics(points, landmarks, trackingQuality, now) {
    const deltaSeconds = this.lastTime ? Math.max((now - this.lastTime) / 1000, 0.016) : 0.016;
    const shoulderCenter = averagePoint(
      [points.leftShoulder, points.rightShoulder],
      this.smoothedMetrics?.center ?? { x: 0.5, y: 0.44 },
    );
    const shoulderWidth = this.getShoulderWidth(points);
    const rangeScale = clamp(0.22 / shoulderWidth, 0.62, 1.55);
    const center = this.getBodyCenter(points, shoulderCenter);
    const leftWristSpeed = this.getPointSpeed("leftWrist", points.leftWrist, deltaSeconds, rangeScale);
    const rightWristSpeed = this.getPointSpeed("rightWrist", points.rightWrist, deltaSeconds, rangeScale);
    const wristSpeed = Math.max(leftWristSpeed, rightWristSpeed);
    const averageWristVelocity = points.leftWrist && points.rightWrist
      ? (leftWristSpeed + rightWristSpeed) / 2
      : points.leftWrist ? leftWristSpeed : points.rightWrist ? rightWristSpeed : 0;
    const wristAcceleration = clamp(
      Math.abs(averageWristVelocity - this.previousWristVelocity) / deltaSeconds * 0.075,
    );
    const armSpread = this.getArmSpread(points, shoulderWidth);
    const leftHandHeight = points.leftWrist ? clamp(1 - points.leftWrist.y) : this.smoothedMetrics?.leftHandHeight ?? 0.48;
    const rightHandHeight = points.rightWrist ? clamp(1 - points.rightWrist.y) : this.smoothedMetrics?.rightHandHeight ?? 0.48;
    const averageHandHeight = points.leftWrist && points.rightWrist
      ? (leftHandHeight + rightHandHeight) / 2
      : points.leftWrist ? leftHandHeight : points.rightWrist ? rightHandHeight : this.smoothedMetrics?.averageHandHeight ?? 0.48;
    const shoulderAngle = points.leftShoulder && points.rightShoulder
      ? Math.atan2(points.rightShoulder.y - points.leftShoulder.y, points.rightShoulder.x - points.leftShoulder.x)
      : this.smoothedMetrics?.shoulderAngle ?? 0;
    const shoulderRotation = clamp(Math.abs(shoulderAngle) / 0.68);
    const bodyMovement = this.getPointSpeed("center", center, deltaSeconds, rangeScale);
    const previous = this.smoothedMetrics;
    const spreadChange = previous ? Math.abs(armSpread - previous.armSpread) / deltaSeconds : 0;
    const heightChange = previous ? Math.abs(averageHandHeight - previous.averageHandHeight) / deltaSeconds : 0;
    const rotationChange = previous ? Math.abs(shoulderAngle - previous.shoulderAngle) / deltaSeconds : 0;
    const handsDirection = this.getHandsDirection(points);
    const verticalRange = clamp(heightChange * 0.38);
    const horizontalRange = clamp(Math.abs(handsDirection.x) / deltaSeconds * rangeScale * 0.75);
    const bodyMovementRange = clamp(bodyMovement);
    const motionAmplitude = clamp(
      armSpread * 0.42
      + verticalRange * 0.25
      + horizontalRange * 0.18
      + bodyMovementRange * 0.15,
    );
    const upperBodyEnergy = clamp(
      wristSpeed * 0.5
      + clamp(spreadChange * 0.42) * 0.14
      + clamp(heightChange * 0.36) * 0.17
      + clamp(rotationChange * 0.18) * 0.12
      + wristAcceleration * 0.07,
    );
    const isMotionCandidate = upperBodyEnergy >= CONFIG.intentEnergy || wristSpeed >= CONFIG.intentSpeed;
    this.intentDuration = isMotionCandidate
      ? this.intentDuration + deltaSeconds * 1000
      : Math.max(0, this.intentDuration - deltaSeconds * 720);
    const isGestureActive = wristSpeed >= CONFIG.gestureSpeedThreshold || upperBodyEnergy >= CONFIG.stillEnergy;
    this.gestureDuration = isGestureActive ? this.gestureDuration + deltaSeconds : 0;
    const horizontalDirection = this.directionFromValue(handsDirection.x);
    const verticalDirection = this.directionFromValue(-handsDirection.y);
    const raw = {
      leftWristSpeed,
      rightWristSpeed,
      wristSpeed,
      leftWristVelocity: leftWristSpeed,
      rightWristVelocity: rightWristSpeed,
      averageWristVelocity,
      wristAcceleration,
      armSpread,
      leftHandVisible: Boolean(points.leftWrist),
      rightHandVisible: Boolean(points.rightWrist),
      leftHandHeight,
      rightHandHeight,
      averageHandHeight,
      leftHandX: points.leftWrist?.x ?? this.smoothedMetrics?.leftHandX ?? 0.42,
      rightHandX: points.rightWrist?.x ?? this.smoothedMetrics?.rightHandX ?? 0.58,
      shoulderCenterX: shoulderCenter.x,
      shoulderCenterY: shoulderCenter.y,
      shoulderAngle,
      shoulderRotation,
      bodyRotation: shoulderRotation,
      bodyMovement,
      verticalRange,
      horizontalRange,
      bodyMovementRange,
      motionAmplitude,
      upperBodyEnergy,
      motionEnergy: upperBodyEnergy,
      intentionalMotion: this.intentDuration >= CONFIG.intentHoldMs,
      isStill: upperBodyEnergy < CONFIG.stillEnergy && this.intentDuration === 0,
      stillness: clamp(1 - upperBodyEnergy / 0.2),
      gestureDuration: this.gestureDuration,
      tempo: Math.round(CONFIG.neutralTempo + upperBodyEnergy * (CONFIG.maxTempo - CONFIG.neutralTempo)),
      center,
      handsDirection,
      horizontalDirection,
      verticalDirection,
      gestureDirection: {
        x: handsDirection.x,
        y: handsDirection.y,
        horizontal: horizontalDirection,
        vertical: verticalDirection,
      },
      trackingQuality,
      trackingState: "active",
      poseLostMs: 0,
      landmarks,
    };
    this.lastRawMetrics = raw;
    const smoothed = this.smoothMetrics(raw);
    this.previousPoints = {
      leftWrist: points.leftWrist,
      rightWrist: points.rightWrist,
      center,
    };
    this.previousWristVelocity = averageWristVelocity;
    return smoothed;
  }

  getRawMetrics() {
    return this.lastRawMetrics;
  }

  getShoulderWidth(points) {
    if (points.leftShoulder && points.rightShoulder) {
      const width = Math.max(distance(points.leftShoulder, points.rightShoulder), 0.08);
      this.scaleReference = lerp(this.scaleReference, width, 0.12);
    }
    return Math.max(this.scaleReference, 0.08);
  }

  getBodyCenter(points, shoulderCenter) {
    const hipCenter = averagePoint([points.leftHip, points.rightHip], null);
    return hipCenter
      ? averagePoint([shoulderCenter, hipCenter], shoulderCenter)
      : { x: shoulderCenter.x, y: clamp(shoulderCenter.y + this.scaleReference * 0.78) };
  }

  getArmSpread(points, shoulderWidth) {
    if (points.leftWrist && points.rightWrist) {
      return clamp(distance(points.leftWrist, points.rightWrist) / (shoulderWidth * 2.45));
    }
    if (points.leftWrist && points.leftShoulder) return clamp(distance(points.leftWrist, points.leftShoulder) / (shoulderWidth * 1.3));
    if (points.rightWrist && points.rightShoulder) return clamp(distance(points.rightWrist, points.rightShoulder) / (shoulderWidth * 1.3));
    return this.smoothedMetrics?.armSpread ?? 0.24;
  }

  getPointSpeed(name, point, deltaSeconds, rangeScale) {
    const previous = this.previousPoints[name];
    if (!point || !previous) return 0;
    return clamp(distance(point, previous) / deltaSeconds * rangeScale / 1.1);
  }

  getHandsDirection(points) {
    const movements = [];
    [["leftWrist", points.leftWrist], ["rightWrist", points.rightWrist]].forEach(([name, point]) => {
      const previous = this.previousPoints[name];
      if (point && previous) movements.push({ x: point.x - previous.x, y: point.y - previous.y });
    });
    return averagePoint(movements, { x: 0, y: 0 });
  }

  directionFromValue(value) {
    if (value > CONFIG.directionThreshold) return 1;
    if (value < -CONFIG.directionThreshold) return -1;
    return 0;
  }

  smoothMetrics(next) {
    if (!this.smoothedMetrics) return next;
    const smooth = (key, amount = CONFIG.metricSmoothing) => lerp(this.smoothedMetrics[key], next[key], amount);
    return {
      ...next,
      leftWristSpeed: smooth("leftWristSpeed", CONFIG.velocitySmoothing),
      rightWristSpeed: smooth("rightWristSpeed", CONFIG.velocitySmoothing),
      wristSpeed: smooth("wristSpeed", CONFIG.velocitySmoothing),
      leftWristVelocity: smooth("leftWristVelocity", CONFIG.velocitySmoothing),
      rightWristVelocity: smooth("rightWristVelocity", CONFIG.velocitySmoothing),
      averageWristVelocity: smooth("averageWristVelocity", CONFIG.velocitySmoothing),
      wristAcceleration: smooth("wristAcceleration", CONFIG.velocitySmoothing),
      armSpread: smooth("armSpread"),
      leftHandHeight: smooth("leftHandHeight"),
      rightHandHeight: smooth("rightHandHeight"),
      averageHandHeight: smooth("averageHandHeight"),
      leftHandX: smooth("leftHandX"),
      rightHandX: smooth("rightHandX"),
      shoulderCenterX: smooth("shoulderCenterX"),
      shoulderCenterY: smooth("shoulderCenterY"),
      shoulderAngle: smooth("shoulderAngle"),
      shoulderRotation: smooth("shoulderRotation"),
      bodyRotation: smooth("bodyRotation"),
      bodyMovement: smooth("bodyMovement"),
      verticalRange: smooth("verticalRange", CONFIG.velocitySmoothing),
      horizontalRange: smooth("horizontalRange", CONFIG.velocitySmoothing),
      bodyMovementRange: smooth("bodyMovementRange", CONFIG.velocitySmoothing),
      motionAmplitude: smooth("motionAmplitude"),
      upperBodyEnergy: smooth("upperBodyEnergy", CONFIG.velocitySmoothing),
      motionEnergy: smooth("motionEnergy", CONFIG.velocitySmoothing),
      stillness: smooth("stillness"),
      gestureDuration: smooth("gestureDuration", 0.2),
      tempo: Math.round(smooth("tempo", 0.12)),
      center: {
        x: lerp(this.smoothedMetrics.center.x, next.center.x, CONFIG.metricSmoothing),
        y: lerp(this.smoothedMetrics.center.y, next.center.y, CONFIG.metricSmoothing),
      },
      handsDirection: {
        x: lerp(this.smoothedMetrics.handsDirection.x, next.handsDirection.x, CONFIG.metricSmoothing),
        y: lerp(this.smoothedMetrics.handsDirection.y, next.handsDirection.y, CONFIG.metricSmoothing),
      },
      horizontalDirection: next.horizontalDirection,
      verticalDirection: next.verticalDirection,
      gestureDirection: next.gestureDirection,
    };
  }

  handlePoseLoss(now) {
    const previous = this.smoothedMetrics;
    const lostFor = this.lastValidPoseTime ? now - this.lastValidPoseTime : Infinity;
    if (previous && lostFor <= CONFIG.poseLostGracePeriod) {
      const fade = clamp(lostFor / CONFIG.poseLostGracePeriod);
      const energy = lerp(previous.motionEnergy, 0.018, fade * 0.24);
      return {
        ...previous,
        leftWristSpeed: lerp(previous.leftWristSpeed, 0, 0.1),
        rightWristSpeed: lerp(previous.rightWristSpeed, 0, 0.1),
        wristSpeed: lerp(previous.wristSpeed, 0, 0.1),
        leftWristVelocity: lerp(previous.leftWristVelocity, 0, 0.1),
        rightWristVelocity: lerp(previous.rightWristVelocity, 0, 0.1),
        averageWristVelocity: lerp(previous.averageWristVelocity, 0, 0.1),
        wristAcceleration: lerp(previous.wristAcceleration, 0, 0.14),
        upperBodyEnergy: energy,
        motionEnergy: energy,
        motionAmplitude: lerp(previous.motionAmplitude, previous.armSpread * 0.42, 0.08),
        stillness: lerp(previous.stillness, 0.9, 0.08),
        gestureDuration: Math.max(0, previous.gestureDuration - 0.06),
        intentionalMotion: lostFor < 500 ? previous.intentionalMotion : false,
        isStill: lostFor > 500,
        trackingQuality: clamp(previous.trackingQuality * (1 - fade * 0.2)),
        trackingState: lostFor < 500 ? "active" : "grace",
        poseLostMs: lostFor,
      };
    }
    return {
      ...this.getIdleMetrics(),
      trackingState: lostFor < 3000 ? "paused" : "idle",
      poseLostMs: Number.isFinite(lostFor) ? lostFor : 0,
      center: previous?.center ?? { x: 0.5, y: 0.55 },
      landmarks: previous?.landmarks ?? null,
    };
  }

  getIdleMetrics() {
    return {
      leftWristSpeed: 0,
      rightWristSpeed: 0,
      wristSpeed: 0,
      leftWristVelocity: 0,
      rightWristVelocity: 0,
      averageWristVelocity: 0,
      wristAcceleration: 0,
      armSpread: 0.24,
      leftHandHeight: 0.48,
      rightHandHeight: 0.48,
      averageHandHeight: 0.48,
      leftHandX: 0.42,
      rightHandX: 0.58,
      shoulderCenterX: 0.5,
      shoulderCenterY: 0.44,
      shoulderAngle: 0,
      shoulderRotation: 0,
      bodyRotation: 0,
      bodyMovement: 0,
      verticalRange: 0,
      horizontalRange: 0,
      bodyMovementRange: 0,
      motionAmplitude: 0.16,
      upperBodyEnergy: 0,
      motionEnergy: 0,
      intentionalMotion: false,
      isStill: true,
      stillness: 1,
      gestureDuration: 0,
      tempo: CONFIG.neutralTempo,
      center: { x: 0.5, y: 0.55 },
      handsDirection: { x: 0, y: 0 },
      horizontalDirection: 0,
      verticalDirection: 0,
      gestureDirection: { x: 0, y: 0, horizontal: 0, vertical: 0 },
      trackingQuality: 0,
      trackingState: "idle",
      poseLostMs: 0,
      landmarks: null,
    };
  }
}
