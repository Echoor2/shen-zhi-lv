const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const lerp = (current, target, amount) => current + (target - current) * amount;
const sign = (value, threshold = 0.001) => (value > threshold ? 1 : value < -threshold ? -1 : 0);

const ACTIVITY = ["BREATH", "EXPLORING", "PLAYING", "FLOW"];

export class MotionMusicMapper {
  constructor() {
    this.reset();
  }

  reset() {
    this.previous = null;
    this.lastAccentAt = -Infinity;
  }

  map(metrics, now) {
    const energy = clamp(metrics.motionEnergy ?? metrics.upperBodyEnergy ?? 0);
    const amplitude = clamp(metrics.motionAmplitude ?? metrics.armSpread ?? 0);
    const speed = clamp(metrics.wristSpeed ?? 0);
    const acceleration = clamp(metrics.wristAcceleration ?? 0);
    const stillness = clamp(metrics.stillness ?? 1 - energy / 0.18);
    const direction = metrics.gestureDirection ?? { horizontal: 0, vertical: 0 };
    const bodyX = metrics.shoulderCenterX ?? metrics.center?.x ?? 0.5;
    const leftHandAvailable = metrics.leftHandVisible !== false && Number.isFinite(metrics.leftHandHeight);
    const rightHandAvailable = metrics.rightHandVisible !== false && Number.isFinite(metrics.rightHandHeight);
    // Left hand leads when available; a single visible right hand takes over seamlessly.
    const pitch = clamp(
      leftHandAvailable
        ? metrics.leftHandHeight
        : rightHandAvailable
          ? metrics.rightHandHeight
          : metrics.averageHandHeight ?? 0.5,
    );
    const harmonyPitch = clamp(rightHandAvailable ? metrics.rightHandHeight : pitch);
    const gestureDuration = Math.max(0, metrics.gestureDuration ?? 0);
    const bodyMovement = clamp(metrics.bodyMovement ?? 0);
    const movementSpeed = clamp(speed * 0.76 + bodyMovement * 0.18 + energy * 0.06);
    const density = clamp(
      speed * 0.72
      + bodyMovement * 0.2
      + energy * 0.08
      + (metrics.intentionalMotion && movementSpeed > 0.12 ? 0.06 : 0),
    );
    const tempo = 60 + movementSpeed * 45;
    const harmonyRichness = clamp((metrics.armSpread - 0.16) / 0.72);
    const handHeightDifference = leftHandAvailable && rightHandAvailable
      ? Math.abs(metrics.leftHandHeight - metrics.rightHandHeight)
      : 0;
    const interval = handHeightDifference < 0.08 ? 0 : handHeightDifference < 0.2 ? 2 : handHeightDifference < 0.36 ? 3 : 4;
    const intervalDirection = sign(harmonyPitch - pitch) || 1;
    const activity = energy >= 0.62 ? 3 : energy >= 0.23 || metrics.intentionalMotion ? 2 : energy >= 0.055 ? 1 : 0;
    const accentReady = acceleration >= 0.42 && energy >= 0.12 && now - this.lastAccentAt >= 0.32;
    if (accentReady) this.lastAccentAt = now;

    const next = {
      pitch,
      harmonyPitch,
      velocity: speed,
      movementSpeed,
      acceleration,
      amplitude,
      energy,
      tempo,
      direction: {
        horizontal: direction.horizontal ?? sign(direction.x ?? 0),
        vertical: direction.vertical ?? sign(-(direction.y ?? 0)),
      },
      pan: clamp((bodyX - 0.5) * 1.3, -0.65, 0.65),
      density,
      harmonyRichness,
      harmonyInterval: interval * intervalDirection,
      handHeightDifference,
      chordBias: clamp((metrics.shoulderAngle ?? 0) / 0.42, -1, 1),
      gestureDuration,
      stillness,
      sustain: clamp(0.3 + stillness * 0.62 + gestureDuration * 0.08),
      articulation: density > 0.72 ? "staccato" : density < 0.2 ? "legato" : "flow",
      activity,
      activityName: ACTIVITY[activity],
      accent: accentReady,
      trackingState: metrics.trackingState ?? "idle",
    };

    if (!this.previous) {
      this.previous = next;
      return next;
    }

    const smooth = {
      ...next,
      pitch: lerp(this.previous.pitch, next.pitch, 0.18),
      harmonyPitch: lerp(this.previous.harmonyPitch, next.harmonyPitch, 0.18),
      velocity: lerp(this.previous.velocity, next.velocity, 0.24),
      movementSpeed: lerp(this.previous.movementSpeed, next.movementSpeed, 0.12),
      amplitude: lerp(this.previous.amplitude, next.amplitude, 0.16),
      energy: lerp(this.previous.energy, next.energy, 0.18),
      tempo: lerp(this.previous.tempo, next.tempo, 1),
      pan: lerp(this.previous.pan, next.pan, 0.12),
      density: lerp(this.previous.density, next.density, 0.18),
      harmonyRichness: lerp(this.previous.harmonyRichness, next.harmonyRichness, 0.16),
      stillness: lerp(this.previous.stillness, next.stillness, 0.16),
      sustain: lerp(this.previous.sustain, next.sustain, 0.15),
    };
    this.previous = smooth;
    return smooth;
  }
}

export class MelodyGenerator {
  constructor() {
    this.reset();
  }

  reset() {
    this.lastDegree = null;
    this.targetDegree = null;
    this.history = [];
  }

  shouldEmit(stepInBar, musicState, phraseState) {
    if (musicState.trackingState === "idle" || musicState.trackingState === "paused") return false;
    if (musicState.movementSpeed < 0.045 && musicState.energy < 0.045) return false;
    if (phraseState === "REST") return stepInBar === 0 && musicState.stillness < 0.9;
    if (musicState.density < 0.14) return stepInBar === 0;
    if (musicState.density < 0.34) return stepInBar % 4 === 0;
    if (musicState.density < 0.50) return stepInBar % 2 === 0;
    return true;
  }

  next(musicState) {
    const target = this.getTargetDegree(musicState.pitch);
    if (this.lastDegree === null) {
      this.lastDegree = target;
      return this.remember(target);
    }

    const maxStep = musicState.velocity > 0.72 ? 2 : 1;
    const vertical = musicState.direction.vertical;
    const towardTarget = sign(target - this.lastDegree);
    let direction = vertical || towardTarget;
    if (direction === 0 && Math.abs(target - this.lastDegree) >= 2) direction = towardTarget;
    if (this.lastDegree >= 7 && direction > 0) direction = -1;
    if (this.lastDegree <= -5 && direction < 0) direction = 1;

    const distance = Math.abs(target - this.lastDegree);
    const step = direction === 0 ? 0 : Math.min(maxStep, Math.max(1, distance || 1)) * direction;
    const candidate = clamp(this.lastDegree + step, -5, 7);
    this.lastDegree = candidate;
    return this.remember(candidate);
  }

  getTargetDegree(pitch) {
    const position = clamp(pitch) * 12 - 5;
    const rawTarget = Math.round(position);
    if (this.targetDegree === null) {
      this.targetDegree = rawTarget;
      return rawTarget;
    }

    // Hold the current pitch cell until the hand crosses a wider boundary.
    // This prevents C/D chatter when the wrist hovers near a quantization edge.
    const hysteresis = 0.62;
    if (position >= this.targetDegree + hysteresis) {
      this.targetDegree = Math.min(rawTarget, this.targetDegree + 1);
    } else if (position <= this.targetDegree - hysteresis) {
      this.targetDegree = Math.max(rawTarget, this.targetDegree - 1);
    }
    return this.targetDegree;
  }

  duration(beatDuration, musicState) {
    if (musicState.stillness > 0.84) return beatDuration * 2;
    if (musicState.gestureDuration > 1.15 && musicState.velocity < 0.24) return beatDuration * 2;
    if (musicState.density > 0.74) return beatDuration * 0.5;
    const sustainTail = 0.84 + (musicState.sustain ?? 0.5) * 0.24;
    if (musicState.density < 0.28) return beatDuration * sustainTail;
    return beatDuration * 0.75 * sustainTail;
  }

  remember(degree) {
    this.history.push(degree);
    if (this.history.length > 16) this.history.shift();
    return degree;
  }
}

export class HarmonyGenerator {
  constructor() {
    this.reset();
  }

  reset() {
    this.bar = -1;
    this.current = null;
  }

  advance(mode, musicState) {
    this.bar += 1;
    const progressions = mode.harmonyProgressions;
    const progressionIndex = musicState.chordBias < -0.24 ? 1 : musicState.chordBias > 0.24 ? 2 : 0;
    const progression = progressions[progressionIndex] ?? progressions[0];
    const rootOffset = progression[this.bar % progression.length];
    const intervals = musicState.harmonyRichness > 0.72
      ? [...mode.chordIntervals, mode.extensionInterval ?? 10]
      : musicState.harmonyRichness > 0.34 ? mode.chordIntervals : [0, mode.chordIntervals.at(-1)];
    this.current = {
      rootMidi: mode.root - 12 + rootOffset,
      notes: intervals,
      richness: musicState.harmonyRichness,
      progressionIndex,
    };
    return this.current;
  }

  counterMelody(degree, musicState) {
    if (musicState.harmonyRichness < 0.22) return [];
    const interval = musicState.harmonyInterval || 2;
    const notes = [degree + interval];
    if (musicState.harmonyRichness > 0.74) notes.push(degree + (interval > 0 ? 4 : -4));
    return notes;
  }
}

export class RhythmGenerator {
  events(stepInBar, musicState, mode, phraseState) {
    if (phraseState === "REST" || musicState.energy < 0.18) return [];
    const events = [];
    const electronic = mode.id === "electronic";
    const active = electronic ? musicState.energy >= 0.23 : musicState.energy >= 0.38;
    if (active && (stepInBar === 0 || (electronic && stepInBar === 4))) events.push("kick");
    if (musicState.density > 0.52 && (stepInBar === 2 || stepInBar === 6)) events.push("click");
    if (electronic && musicState.density > 0.72 && stepInBar % 2 === 1) events.push("tick");
    return events;
  }
}

export class PhrasePlanner {
  constructor() {
    this.reset();
  }

  reset() {
    this.bar = -1;
    this.state = "BUILDING";
  }

  advance(musicState) {
    this.bar += 1;
    const phase = this.bar % 8;
    if (phase <= 2) this.state = musicState.energy > 0.68 ? "PEAK" : "BUILDING";
    else if (phase <= 4) this.state = musicState.energy > 0.38 ? "PEAK" : "BUILDING";
    else if (phase <= 5) this.state = "RELEASE";
    else this.state = musicState.energy > 0.46 ? "BUILDING" : "REST";
    return this.state;
  }
}
