const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24],
  [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
];

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

const EVENT_POINT_INDEX = { index: 8, middle: 12, ring: 16, pinky: 20, all: 9 };
const FINGER_TIPS = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const EMPHASIZED_HAND_POINTS = new Set([0, 4, 8, 12, 16, 20]);
const SIDES = ["left", "right"];

const VISUAL_CONFIG = Object.freeze({
  wristTrailCapacity: 56,
  fingerTrailCapacity: 42,
  wristTrailLifeMs: 1850,
  fingerTrailLifeMs: 1380,
  trailSampleDistance: 0.00075,
  trailSmoothing: 0.52,
  maxParticles: 760,
  particlePoolLimit: 840,
  wristRippleCooldownMs: 155,
  bodyRippleCooldownMs: 520,
  handStreamCooldownMs: 105,
  minimumMotion: 0.024,
  minimumFingerMotion: 0.075,
  maxHandParticlesPerSample: 12,
  maxFingerParticlesPerSample: 4,
});

const MODE_PROFILES = Object.freeze({
  "gu-yun": { trailWidth: 1.65, particleSpeed: 0.78, particleLife: 1.24, sharp: false },
  electronic: { trailWidth: 1.15, particleSpeed: 1.22, particleLife: 0.78, sharp: true },
  nature: { trailWidth: 1.95, particleSpeed: 0.68, particleLife: 1.42, sharp: false },
});

const COLOR_PROFILES = Object.freeze({
  // Skeleton colors stay close to the existing mode accent. Motion colors move
  // through blue into restrained indigo instead of switching to a hard contrast.
  "gu-yun": {
    particleLow: [82, 145, 199],
    particleHigh: [126, 132, 232],
    trail: [82, 112, 184],
    highlight: [218, 235, 255],
  },
  electronic: {
    particleLow: [68, 139, 208],
    particleHigh: [121, 128, 244],
    trail: [69, 103, 190],
    highlight: [215, 239, 255],
  },
  nature: {
    particleLow: [98, 145, 190],
    particleHigh: [133, 126, 220],
    trail: [86, 111, 180],
    highlight: [224, 235, 255],
  },
});

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const lerp = (a, b, amount) => a + (b - a) * amount;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const colorString = (rgb) => rgb.map((value) => Math.round(value)).join(", ");
const mixColor = (a, b, amount) => a.map((value, index) => lerp(value, b[index], amount));

class TrailBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.time = new Float64Array(capacity);
    this.cursor = 0;
    this.count = 0;
    this.lastX = null;
    this.lastY = null;
    this.lastTime = 0;
    this.lastDx = 0;
    this.lastDy = 0;
    this.lastDistance = 0;
  }

  add(point, now, smoothing, minDistance) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    const x = this.lastX === null ? point.x : lerp(this.lastX, point.x, smoothing);
    const y = this.lastY === null ? point.y : lerp(this.lastY, point.y, smoothing);
    const dx = this.lastX === null ? 0 : x - this.lastX;
    const dy = this.lastY === null ? 0 : y - this.lastY;
    const moved = Math.hypot(dx, dy);
    const elapsed = now - this.lastTime;

    if (this.count && moved < minDistance && elapsed < 75) return false;
    this.x[this.cursor] = x;
    this.y[this.cursor] = y;
    this.time[this.cursor] = now;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    this.lastX = x;
    this.lastY = y;
    this.lastTime = now;
    this.lastDx = dx;
    this.lastDy = dy;
    this.lastDistance = moved;
    return true;
  }

  forEachSegment(now, lifeMs, callback) {
    let previous = null;
    const start = (this.cursor - this.count + this.capacity) % this.capacity;
    for (let offset = 0; offset < this.count; offset += 1) {
      const index = (start + offset) % this.capacity;
      const age = now - this.time[index];
      if (age > lifeMs) {
        previous = null;
        continue;
      }
      const point = { x: this.x[index], y: this.y[index], age };
      if (previous) callback(previous, point, clamp(1 - age / lifeMs));
      previous = point;
    }
  }
}

export class VisualEngine {
  constructor(canvas, getMode) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.getMode = getMode;
    this.metrics = null;
    this.hands = null;
    this.particles = [];
    this.particlePool = [];
    this.ripples = [];
    this.handRipples = [];
    this.wristTrails = {
      left: new TrailBuffer(VISUAL_CONFIG.wristTrailCapacity),
      right: new TrailBuffer(VISUAL_CONFIG.wristTrailCapacity),
    };
    this.fingerTrails = Object.fromEntries(
      SIDES.flatMap((side) => Object.keys(FINGER_TIPS).map((finger) => [`${side}:${finger}`, new TrailBuffer(VISUAL_CONFIG.fingerTrailCapacity)])),
    );
    this.lastWristRippleAt = { left: -Infinity, right: -Infinity };
    this.lastBodyRippleAt = -Infinity;
    this.lastStreamAt = -Infinity;
    this.lastTime = 0;
    this.seed = 0;
    this.pixelRatio = 1;
    this.resize();
  }

  resize() {
    const bounds = this.canvas.getBoundingClientRect();
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(bounds.width * this.pixelRatio);
    this.canvas.height = Math.round(bounds.height * this.pixelRatio);
    this.context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.width = bounds.width;
    this.height = bounds.height;
  }

  setMetrics(metrics) { this.metrics = metrics; }
  setHands(hands) { this.hands = hands; }

  handEvent(event, hands = this.hands) {
    const hand = hands?.[event.hand];
    const point = hand?.landmarks?.[EVENT_POINT_INDEX[event.finger] ?? 9];
    if (!point) return;
    const thumb = hand.landmarks?.[4];
    const source = event.type === "pinch" && thumb
      ? { x: (point.x + thumb.x) / 2, y: (point.y + thumb.y) / 2 }
      : point;
    const intensity = clamp(0.38 + (event.intensity ?? event.velocity ?? 0) * 0.62);
    this.handRipples.push({
      x: source.x,
      y: source.y,
      radius: event.type === "close" ? 18 : event.type === "open" ? 15 : 7,
      alpha: event.type === "pinch" ? 0.94 : 0.64,
      speed: event.type === "pinch" ? 1.85 : event.type === "open" ? 1.25 : 0.98,
      kind: event.type,
      intensity,
    });

  }

  note(event) {
    const source = this.getDominantWristPoint() ?? event.center ?? { x: 0.5, y: 0.55 };
    const kind = event.finger ? "ornament" : event.accent ? "accent" : "melody";
    this.ripples.push({
      x: source.x,
      y: source.y,
      radius: event.accent ? 12 : event.finger ? 5 : 8,
      alpha: event.accent ? 0.9 : event.finger ? 0.56 : 0.76,
      speed: event.accent ? 1.75 : event.finger ? 0.84 : 1.16,
      kind,
      intensity: clamp(event.energy ?? 0.3),
    });
    this.spawnRadial(source, clamp(event.energy ?? 0.28), event.accent ? 14 : event.finger ? 4 : 7, kind);
  }

  frame(now) {
    const delta = Math.min((now - this.lastTime) / 1000 || 0.016, 0.05);
    this.lastTime = now;
    this.context.clearRect(0, 0, this.width, this.height);
    const metrics = this.metrics;
    if (!metrics) return;

    const mode = this.getMode();
    const profile = MODE_PROFILES[mode.id] ?? MODE_PROFILES["gu-yun"];
    const center = this.toCanvas(this.getBodyCenter(metrics));

    this.updateMotionVisuals(now, metrics, this.hands, mode, profile);
    this.drawCore(center, metrics, now, mode);
    this.drawRipples(delta, mode);
    this.drawHandRipples(delta, mode);
    this.drawParticles(delta, center, metrics, mode);
    this.drawSkeleton(metrics.landmarks, metrics.motionEnergy, mode);
    this.drawHands(this.hands, metrics.motionEnergy, mode, now);
  }

  toCanvas(point) {
    return { x: (1 - point.x) * this.width, y: point.y * this.height };
  }

  getBodyCenter(metrics) {
    return {
      x: metrics.shoulderCenterX ?? metrics.center?.x ?? 0.5,
      y: metrics.shoulderCenterY ?? metrics.center?.y ?? 0.45,
    };
  }

  getColorProfile(mode, energy = 0) {
    const profile = COLOR_PROFILES[mode.id] ?? COLOR_PROFILES["gu-yun"];
    const particle = mixColor(profile.particleLow, profile.particleHigh, clamp(energy));
    const core = mixColor(
      mode.visual.accentRgb.split(",").map((value) => Number(value.trim())),
      particle,
      0.16 + clamp(energy) * 0.28,
    );
    return { ...profile, particle, core };
  }

  getDominantWristPoint() {
    const candidates = SIDES
      .map((side) => {
        const hand = this.hands?.[side];
        return hand?.detected && hand.landmarks?.[0]
          ? { point: hand.landmarks[0], speed: hand.movementSpeed ?? 0 }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.speed - a.speed);
    return candidates[0]?.point ?? null;
  }

  getWristVisualInput(side, metrics, hands) {
    const hand = hands?.[side];
    if (hand?.detected && hand.trackingQuality >= 0.22 && hand.landmarks?.[0]) {
      return { point: hand.landmarks[0], speed: hand.movementSpeed ?? 0, direction: hand.movementDirection };
    }
    const index = side === "left" ? 15 : 16;
    const point = metrics.landmarks?.[index];
    if (!point || (point.visibility ?? 1) < 0.28 || metrics.trackingState === "idle") return null;
    return {
      point,
      speed: metrics[side === "left" ? "leftWristSpeed" : "rightWristSpeed"] ?? 0,
      direction: metrics.handsDirection,
    };
  }

  updateMotionVisuals(now, metrics, hands, mode, profile) {
    SIDES.forEach((side) => {
      const input = this.getWristVisualInput(side, metrics, hands);
      if (!input) return;
      const trail = this.wristTrails[side];
      const sampled = trail.add(input.point, now, VISUAL_CONFIG.trailSmoothing, VISUAL_CONFIG.trailSampleDistance);
      if (!sampled || trail.lastDistance < VISUAL_CONFIG.trailSampleDistance) return;

      const speed = clamp(Math.max(input.speed ?? 0, trail.lastDistance * 22));
      if (speed < VISUAL_CONFIG.minimumMotion) return;

      if (now - this.lastWristRippleAt[side] >= VISUAL_CONFIG.wristRippleCooldownMs) {
        this.lastWristRippleAt[side] = now;
        this.handRipples.push({
          x: input.point.x,
          y: input.point.y,
          radius: 8 + speed * 7,
          alpha: 0.32 + speed * 0.42,
          speed: 0.82 + speed * 0.82,
          kind: "wrist",
          intensity: speed,
        });
      }
    });

    if (metrics.motionEnergy > 0.16 && now - this.lastBodyRippleAt >= VISUAL_CONFIG.bodyRippleCooldownMs) {
      this.lastBodyRippleAt = now;
      const center = this.getBodyCenter(metrics);
      this.ripples.push({
        x: center.x,
        y: center.y,
        radius: 16,
        alpha: 0.16 + metrics.motionEnergy * 0.2,
        speed: 0.38 + metrics.motionEnergy * 0.38,
        kind: "body",
        intensity: metrics.motionEnergy,
      });
    }

  }

  trailDirection(trail, fallback = { x: 0, y: 0 }) {
    const dx = trail.lastDistance > 0.0002 ? trail.lastDx : fallback?.x ?? 0;
    const dy = trail.lastDistance > 0.0002 ? trail.lastDy : fallback?.y ?? 0;
    // Canvas is mirrored horizontally, matching the displayed camera and skeleton.
    return { x: -dx, y: dy };
  }

  emitHandStream(now, hands, metrics, mode, profile) {
    const left = hands?.left;
    const right = hands?.right;
    if (!left?.detected || !right?.detected || !left.landmarks?.[0] || !right.landmarks?.[0]) return;
    if (now - this.lastStreamAt < VISUAL_CONFIG.handStreamCooldownMs) return;

    this.lastStreamAt = now;
    const from = left.landmarks[0];
    const to = right.landmarks[0];
    const handDistance = distance(from, to);
    const density = Math.max(1, Math.round((1 - clamp(handDistance / 0.78)) * 2 + metrics.motionEnergy * 3));
    const direction = { x: to.x - from.x, y: to.y - from.y };
    for (let index = 0; index < density; index += 1) {
      const progress = (index + 1) / (density + 1);
      const point = { x: lerp(from.x, to.x, progress), y: lerp(from.y, to.y, progress) };
      this.emitDirectional(point, direction, 0.17 + metrics.motionEnergy * 0.28, 1, "hand-stream", mode, profile, 0.42);
    }
  }

  emitDirectional(point, direction, intensity, count, source, mode = this.getMode(), profile = MODE_PROFILES[mode.id] ?? MODE_PROFILES["gu-yun"], speedScale = 1) {
    const magnitude = Math.hypot(direction?.x ?? 0, direction?.y ?? 0);
    const directionX = magnitude > 0.0001 ? direction.x / magnitude : 0;
    const directionY = magnitude > 0.0001 ? direction.y / magnitude : -0.2;
    for (let index = 0; index < count; index += 1) {
      const spread = (this.noise(index, count) - 0.5) * (0.7 + intensity * 0.65);
      const perpendicularX = -directionY * spread;
      const perpendicularY = directionX * spread;
      const velocity = (34 + intensity * 188) * profile.particleSpeed * speedScale * (0.78 + this.noise(index, 13) * 0.4);
      this.spawnParticle(
        point,
        (directionX + perpendicularX) * velocity,
        (directionY + perpendicularY) * velocity,
        0.46 + intensity * 0.54,
        source,
        mode,
      );
    }
  }

  spawnRadial(point, intensity, count, source, inward = false) {
    const mode = this.getMode();
    const profile = MODE_PROFILES[mode.id] ?? MODE_PROFILES["gu-yun"];
    for (let index = 0; index < count; index += 1) {
      const angle = this.noise(index, count + 31) * Math.PI * 2;
      const speed = (32 + intensity * 128) * profile.particleSpeed;
      const direction = inward ? -1 : 1;
      const offset = inward ? 24 + this.noise(index, 5) * 32 : 2;
      const radial = { x: Math.cos(angle), y: Math.sin(angle) };
      const canvasPoint = this.toCanvas(point);
      this.spawnParticle(
        { x: 1 - (canvasPoint.x + radial.x * offset) / this.width, y: (canvasPoint.y + radial.y * offset) / this.height },
        radial.x * speed * direction,
        radial.y * speed * direction,
        intensity,
        source,
        mode,
      );
    }
  }

  spawnParticle(point, vx, vy, intensity, source, mode) {
    if (this.particles.length >= VISUAL_CONFIG.maxParticles) return;
    const particle = this.particlePool.pop() ?? {};
    const origin = this.toCanvas(point);
    const jitter = (this.noise(this.particles.length, this.seed) - 0.5) * 9;
    particle.x = origin.x + jitter;
    particle.y = origin.y - jitter;
    particle.vx = vx;
    particle.vy = vy;
    particle.age = 0;
    particle.life = (0.36 + intensity * 0.68) * mode.visual.particleLife;
    particle.size = 0.7 + intensity * 1.9;
    particle.intensity = intensity;
    particle.source = source;
    this.particles.push(particle);
  }

  releaseParticle(index) {
    const removed = this.particles[index];
    const last = this.particles.pop();
    if (index < this.particles.length) this.particles[index] = last;
    if (removed && this.particlePool.length < VISUAL_CONFIG.particlePoolLimit) this.particlePool.push(removed);
  }

  noise(index, salt = 0) {
    this.seed += 1;
    const value = Math.sin((this.seed + index * 17.13 + salt * 43.7) * 12.9898) * 43758.5453;
    return value - Math.floor(value);
  }

  drawCore(center, metrics, now, mode) {
    const { context: ctx } = this;
    const energy = metrics.motionEnergy ?? 0;
    const breath = (Math.sin(now * 0.0017) + 1) * 0.5;
    const radius = Math.min(this.width, this.height) * (0.048 + energy * 0.14 + breath * 0.009);
    const colors = this.getColorProfile(mode, energy);
    const core = colorString(colors.core);
    const glow = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius * 2.4);
    glow.addColorStop(0, `rgba(${core}, ${0.12 + energy * 0.17})`);
    glow.addColorStop(0.42, `rgba(${core}, ${0.045 + energy * 0.065})`);
    glow.addColorStop(1, `rgba(${core}, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(${core}, ${0.18 + energy * 0.27})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = `rgba(${core}, ${0.1 + energy * 0.18})`;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius * (1.34 + breath * 0.09), 0, Math.PI * 2);
    ctx.stroke();
  }

  drawTrails(now, metrics, mode, profile) {
    const energy = metrics.motionEnergy ?? 0;
    const colors = this.getColorProfile(mode, energy);
    SIDES.forEach((side) => {
      this.drawTrail(this.wristTrails[side], now, VISUAL_CONFIG.wristTrailLifeMs, 1.8 + energy * 2.05, 0.42, profile, colors);
      Object.entries(FINGER_TIPS).forEach(([finger]) => {
        const width = finger === "index" ? 1.25 + energy * 1.05 : 0.6 + energy * 0.55;
        const alpha = finger === "index" ? 0.46 : 0.24;
        this.drawTrail(this.fingerTrails[`${side}:${finger}`], now, VISUAL_CONFIG.fingerTrailLifeMs, width, alpha, profile, colors);
      });
    });
  }

  drawTrail(trail, now, lifeMs, width, opacity, profile, colors) {
    const { context: ctx } = this;
    const trailColor = colorString(colors.trail);
    ctx.save();
    ctx.lineCap = profile.sharp ? "square" : "round";
    trail.forEachSegment(now, lifeMs, (from, to, alpha) => {
      const start = this.toCanvas(from);
      const end = this.toCanvas(to);
      const fade = Math.pow(alpha, 1.45);
      ctx.strokeStyle = `rgba(${trailColor}, ${fade * opacity})`;
      ctx.lineWidth = Math.max(0.5, width * profile.trailWidth * (0.24 + fade * 0.76));
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    });
    ctx.restore();
  }

  drawSkeleton(landmarks, energy, mode) {
    if (!landmarks) return;
    const { context: ctx } = this;
    const accent = mode.visual.accentRgb;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    CONNECTIONS.forEach(([start, end]) => {
      const a = landmarks[start];
      const b = landmarks[end];
      if (!a || !b || (a.visibility ?? 1) < 0.4 || (b.visibility ?? 1) < 0.4) return;
      const from = this.toCanvas(a);
      const to = this.toCanvas(b);
      ctx.strokeStyle = `rgba(${accent}, ${0.22 + energy * 0.37})`;
      ctx.lineWidth = 0.8 + energy * 1.3;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    });
    [11, 12, 13, 14, 15, 16, 23, 24].forEach((index) => {
      const point = landmarks[index];
      if (!point || (point.visibility ?? 1) < 0.4) return;
      const { x, y } = this.toCanvas(point);
      const radius = 2.5 + energy * 3.7;
      ctx.fillStyle = `rgba(${accent}, 0.94)`;
      ctx.shadowColor = mode.visual.glow;
      ctx.shadowBlur = 6 + energy * 13;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  drawHands(hands, energy, mode, now) {
    if (!hands) return;
    const { context: ctx } = this;
    SIDES.forEach((side) => {
      const hand = hands[side];
      if (!hand?.landmarks || hand.trackingQuality < 0.12) return;
      const activity = clamp(Math.max(hand.movementSpeed ?? 0, energy * 0.58));
      const opacity = (hand.detected ? 1 : 0.34) * (0.46 + activity * 0.38);
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      HAND_CONNECTIONS.forEach(([start, end]) => {
        const a = hand.landmarks[start];
        const b = hand.landmarks[end];
        if (!a || !b) return;
        const from = this.toCanvas(a);
        const to = this.toCanvas(b);
        ctx.strokeStyle = `rgba(${mode.visual.accentRgb}, ${opacity})`;
        ctx.lineWidth = 0.8 + activity * 1.15;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      });
      hand.landmarks.forEach((point, index) => {
        if (!point) return;
        const { x, y } = this.toCanvas(point);
        const emphasized = EMPHASIZED_HAND_POINTS.has(index);
        const radius = emphasized ? 2.25 + activity * 2.4 : 1 + activity;
        ctx.fillStyle = `rgba(${mode.visual.accentRgb}, ${emphasized ? Math.min(1, opacity + 0.32) : opacity})`;
        ctx.shadowColor = mode.visual.glow;
        ctx.shadowBlur = emphasized ? 9 + activity * 12 : 3;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      });
      this.drawWristCore(hand, activity, mode, now);
      ctx.restore();
    });
  }

  drawWristCore(hand, activity, mode, now) {
    const wrist = hand.landmarks?.[0];
    if (!wrist) return;
    const { context: ctx } = this;
    const { x, y } = this.toCanvas(wrist);
    const breath = (Math.sin(now * 0.003 + (hand.side === "left" ? 0 : 1.2)) + 1) * 0.5;
    const radius = 6 + activity * 18 + breath * 2;
    const colors = this.getColorProfile(mode, activity);
    const core = colorString(colors.core);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * 2.3);
    gradient.addColorStop(0, `rgba(${core}, ${0.26 + activity * 0.25})`);
    gradient.addColorStop(0.35, `rgba(${core}, ${0.075 + activity * 0.1})`);
    gradient.addColorStop(1, `rgba(${core}, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius * 2.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(${core}, ${0.3 + activity * 0.31})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawHandConnection(hands, metrics, mode) {
    const left = hands?.left;
    const right = hands?.right;
    if (!left?.landmarks?.[0] || !right?.landmarks?.[0]) return;
    if (left.trackingQuality < 0.2 || right.trackingQuality < 0.2) return;
    const from = this.toCanvas(left.landmarks[0]);
    const to = this.toCanvas(right.landmarks[0]);
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    const closeness = clamp(1 - span / Math.max(this.width * 0.62, 1));
    const openness = (left.openness + right.openness) / 2;
    const alpha = 0.1 + closeness * 0.28 + openness * 0.16 + (metrics.motionEnergy ?? 0) * 0.12;
    const middleX = (from.x + to.x) / 2;
    const middleY = (from.y + to.y) / 2 - Math.min(60, span * 0.12);
    const { context: ctx } = this;
    ctx.save();
    ctx.strokeStyle = `rgba(${mode.visual.accentRgb}, ${alpha})`;
    ctx.lineWidth = 0.6 + closeness * 1.2;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(middleX, middleY, to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }

  drawParticles(delta, center, metrics, mode) {
    const { context: ctx } = this;
    const colors = this.getColorProfile(mode, metrics.motionEnergy ?? 0);
    const particleColor = colorString(colors.particle);
    const highlight = colorString(colors.highlight);
    const flowX = (metrics.handsDirection?.x ?? 0) * -34;
    const flowY = (metrics.handsDirection?.y ?? 0) * 34;
    const spin = (metrics.bodyRotation ?? 0) * mode.visual.turbulence;

    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      const particle = this.particles[index];
      particle.age += delta;
      if (particle.age >= particle.life) {
        this.releaseParticle(index);
        continue;
      }
      if (particle.source.startsWith("wrist") || particle.source.startsWith("finger") || particle.source === "hand-stream") {
        continue;
      }
      const dx = particle.x - center.x;
      const dy = particle.y - center.y;
      particle.vx += (-dy * spin * 0.12 + flowX) * delta;
      particle.vy += (dx * spin * 0.12 + flowY) * delta;
      particle.vx *= particle.source === "hand-stream" ? 0.991 : 0.976;
      particle.vy *= particle.source === "hand-stream" ? 0.991 : 0.976;
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      if (particle.x < -44 || particle.x > this.width + 44 || particle.y < -44 || particle.y > this.height + 44) {
        this.releaseParticle(index);
        continue;
      }
      const fade = 1 - particle.age / particle.life;
      const sourceAlpha = particle.source.startsWith("wrist") ? 0.82 : particle.source.startsWith("finger") ? 0.68 : 0.48;
      const alpha = fade * sourceAlpha * (0.38 + particle.intensity * 0.5);
      ctx.fillStyle = `rgba(${particle.intensity > 0.82 ? highlight : particleColor}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size * (0.55 + fade * 0.72), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawRipples(delta, mode) {
    const { context: ctx } = this;
    const colors = this.getColorProfile(mode, this.metrics?.motionEnergy ?? 0);
    const accent = mode.visual.accentRgb;
    const particle = colorString(colors.particle);
    const harmony = colorString(mixColor(
      mode.visual.accentRgb.split(",").map((value) => Number(value.trim())),
      colors.particle,
      0.55,
    ));
    const maxRadius = Math.max(this.width, this.height) * 0.48;
    for (let index = this.ripples.length - 1; index >= 0; index -= 1) {
      const ripple = this.ripples[index];
      ripple.radius += 210 * ripple.speed * delta;
      ripple.alpha -= delta * (ripple.kind === "body" ? 0.25 : 0.62);
      if (ripple.alpha <= 0 || ripple.radius >= maxRadius) {
        this.ripples.splice(index, 1);
        continue;
      }
      const width = ripple.kind === "accent" ? 1.8 : ripple.kind === "harmony" ? 1.5 : ripple.kind === "ornament" ? 0.7 : 1;
      const color = ripple.kind === "body" ? accent : ripple.kind === "harmony" ? harmony : particle;
      ctx.strokeStyle = `rgba(${color}, ${ripple.alpha * (ripple.kind === "body" ? 0.55 : 0.64)})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc((1 - ripple.x) * this.width, ripple.y * this.height, ripple.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawHandRipples(delta, mode) {
    const { context: ctx } = this;
    const colors = this.getColorProfile(mode, this.metrics?.motionEnergy ?? 0);
    const particle = colorString(colors.particle);
    for (let index = this.handRipples.length - 1; index >= 0; index -= 1) {
      const ripple = this.handRipples[index];
      ripple.radius += 154 * ripple.speed * delta;
      ripple.alpha -= delta * (ripple.kind === "wrist" ? 0.58 : 0.9);
      if (ripple.alpha <= 0) {
        this.handRipples.splice(index, 1);
        continue;
      }
      const width = ripple.kind === "pinch" ? 1.45 : ripple.kind === "open" || ripple.kind === "close" ? 1.2 : 0.8;
      ctx.strokeStyle = `rgba(${particle}, ${ripple.alpha * 0.62})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc((1 - ripple.x) * this.width, ripple.y * this.height, ripple.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
