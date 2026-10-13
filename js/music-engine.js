import { AudioEngine } from "./audio.js";
import {
  HarmonyGenerator,
  MelodyGenerator,
  MotionMusicMapper,
  PhrasePlanner,
  RhythmGenerator,
} from "./sequencer.js";
import { FingerMusicLayer } from "./finger-music.js";

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const lerp = (current, target, amount) => current + (target - current) * amount;

export const MUSIC_STATES = {
  IDLE: "IDLE",
  LISTENING: "LISTENING",
  PLAYING: "PLAYING",
  FLOW: "FLOW",
  PAUSE: "PAUSE",
};

export class MusicEngine {
  constructor() {
    this.audio = new AudioEngine();
    this.mode = null;
    this.running = false;
    this.state = MUSIC_STATES.IDLE;
    this.currentBpm = 60;
    this.nextStepAt = 0;
    this.step = 0;
    this.currentChord = null;
    this.currentCenter = { x: 0.5, y: 0.55 };
    this.phraseState = "BUILDING";
    this.pendingAccent = false;
    this.pendingHarmonyReset = false;
    this.mapper = new MotionMusicMapper();
    this.melody = new MelodyGenerator();
    this.harmony = new HarmonyGenerator();
    this.rhythm = new RhythmGenerator();
    this.phrases = new PhrasePlanner();
    this.fingerMusic = new FingerMusicLayer();
    this.lastMelodyDegree = null;
    this.noteBudget = { ornament: [], accent: [] };
    this.onNote = null;
    // Observation hook for P2. Scheduling does not depend on this callback.
    this.lastMusicState = null;
    this.lastScheduledNote = null;
  }

  async start(mode) {
    await this.audio.start(mode);
    this.mode = mode;
    this.running = true;
    this.state = MUSIC_STATES.LISTENING;
    this.currentBpm = 60;
    this.nextStepAt = this.audio.context.currentTime + 0.08;
    this.step = 0;
    this.currentChord = null;
    this.phraseState = "BUILDING";
    this.pendingAccent = false;
    this.pendingHarmonyReset = false;
    this.mapper.reset();
    this.melody.reset();
    this.harmony.reset();
    this.phrases.reset();
    this.fingerMusic.reset();
    this.lastMelodyDegree = null;
    this.noteBudget = { ornament: [], accent: [] };
    this.lastMusicState = null;
    this.lastScheduledNote = null;
  }

  setMode(mode) {
    this.mode = mode;
    this.audio.setMode(mode);
    // Keep the current chord until the next bar; mode switches never tear harmony mid-phrase.
    this.pendingHarmonyReset = true;
  }

  update(metrics, hands = null, fingerEvents = []) {
    if (!this.running || !this.audio.context || !this.mode) {
      return { state: MUSIC_STATES.IDLE, bpm: 60, activityLevel: 0, phraseState: "REST", musicState: null };
    }

    const now = this.audio.context.currentTime;
    const baseState = this.mapper.map(metrics, now);
    const fingerControls = this.fingerMusic.update(hands, fingerEvents);
    const musicState = this.enrichWithFingerControls(baseState, fingerControls, fingerEvents);
    this.lastMusicState = musicState;
    this.currentCenter = metrics.center ?? this.currentCenter;
    this.pendingAccent ||= musicState.accent || fingerControls.highAccent;
    this.currentBpm = lerp(this.currentBpm, musicState.tempo, 0.045);
    this.state = this.getState(musicState);

    if (!this.currentChord) this.beginBar(musicState);
    this.audio.setMasterLevel(this.getMasterLevel(musicState));
    this.audio.setBrightness(musicState);
    this.audio.setStereoWidth?.(musicState.stereoWidth);
    this.audio.updatePad({
      chord: this.currentChord,
      activityLevel: musicState.activity,
      armSpread: metrics.armSpread,
      trackingState: musicState.trackingState,
      pan: musicState.pan,
      stereoWidth: musicState.stereoWidth,
    });
    this.scheduleFingerEvents(fingerEvents, musicState, now);

    const scheduleUntil = now + 0.18;
    // A suspended tab or a long inference frame can leave the clock far behind.
    // Skip stale steps and re-anchor near the audio clock instead of scheduling
    // a burst of notes in the past.
    if (this.nextStepAt < now - 0.35) {
      this.nextStepAt = now + 0.04;
    }
    while (this.nextStepAt < scheduleUntil) {
      this.scheduleStep(musicState, this.nextStepAt);
      this.step += 1;
      this.nextStepAt += this.getStepDuration();
    }

    return {
      state: this.state,
      bpm: Math.round(this.currentBpm),
      activityLevel: musicState.activity,
      phraseState: this.phraseState,
      musicState,
    };
  }

  getPublicState() {
    const note = this.lastScheduledNote;
    return {
      state: this.state,
      bpm: Math.round(this.currentBpm),
      activityLevel: this.lastMusicState?.activity ?? 0,
      phraseState: this.phraseState,
      musicState: this.lastMusicState,
      currentNote: note?.frequency ?? null,
      midi: note?.midi ?? null,
      pitchClass: note ? ((note.midi % 12) + 12) % 12 : null,
      scaleDegree: note?.degree ?? null,
    };
  }

  enrichWithFingerControls(baseState, controls, fingerEvents = []) {
    const harmonyRichness = controls.harmonicClose
      ? Math.min(baseState.harmonyRichness, 0.16)
      : clamp(Math.max(baseState.harmonyRichness, controls.handHarmonyRichness, controls.harmonyOpen ? 0.76 : 0));
    return {
      ...baseState,
      // Finger detail may only nudge the next arm-led melody target by two
      // pentatonic steps; it never replaces the V3 hand-height pitch source.
      pitch: clamp(baseState.pitch + controls.detailPitchOffset / 12 + controls.melodyBias),
      harmonyRichness,
      harmonyInterval: controls.handInterval ?? baseState.harmonyInterval,
      timbreBrightness: controls.timbreBrightness,
      stereoWidth: controls.stereoWidth,
      ornamentDensity: controls.ornamentDensity,
      fingerVelocity: controls.fingerVelocity,
      sustain: clamp(baseState.sustain + controls.sustainBoost),
      articulation: controls.articulation ?? baseState.articulation,
      harmonyOpen: controls.harmonyOpen,
      harmonicClose: controls.harmonicClose,
      finger: {
        handDistance: controls.handDistance,
        handOpenness: controls.handOpenness,
        harmonyInterval: controls.handInterval,
        detailPitchOffset: controls.detailPitchOffset,
        ornamentDensity: controls.ornamentDensity,
        sustain: controls.sustainBoost,
        articulation: controls.articulation,
        brightness: controls.timbreBrightness,
        events: fingerEvents,
      },
    };
  }

  beginBar(musicState) {
    if (this.pendingHarmonyReset) {
      this.harmony.reset();
      this.phrases.reset();
      this.pendingHarmonyReset = false;
    }
    this.phraseState = this.phrases.advance(musicState);
    this.currentChord = this.harmony.advance(this.mode, musicState);
  }

  getStepDuration() {
    // The engine schedules eighth notes, independent from camera and render frame rates.
    return 30 / this.currentBpm;
  }

  getState(musicState) {
    if (musicState.trackingState === "paused") return MUSIC_STATES.PAUSE;
    if (musicState.trackingState === "idle") return MUSIC_STATES.IDLE;
    if (musicState.activity >= 3) return MUSIC_STATES.FLOW;
    if (musicState.activity >= 1) return MUSIC_STATES.PLAYING;
    return MUSIC_STATES.LISTENING;
  }

  getMasterLevel(musicState) {
    if (this.state === MUSIC_STATES.IDLE || this.state === MUSIC_STATES.PAUSE) return 0.0001;
    const movement = clamp(musicState.movementSpeed ?? musicState.velocity ?? 0);
    return 0.003 + movement * 0.052 + musicState.energy * 0.012 + musicState.amplitude * 0.008;
  }

  scheduleStep(musicState, when) {
    const stepInBar = this.step % 8;
    if (stepInBar === 0 && this.step !== 0) this.beginBar(musicState);

    const beatDuration = 60 / this.currentBpm;
    const accent = this.pendingAccent || (stepInBar === 0 && musicState.energy > 0.48);
    const nearStill = musicState.movementSpeed < 0.045 && musicState.energy < 0.045;
    if (!nearStill && this.melody.shouldEmit(stepInBar, musicState, this.phraseState)) {
      const degree = this.melody.next(musicState);
      this.lastMelodyDegree = degree;
      const duration = this.melody.duration(beatDuration, musicState);
      const midi = this.degreeToMidi(degree);
      this.lastScheduledNote = {
        midi,
        degree,
        frequency: 440 * (2 ** ((midi - 69) / 12)),
        at: when,
        finger: false,
      };
      const gain = 0.008 + (musicState.movementSpeed ?? musicState.velocity ?? 0) * 0.034 + musicState.energy * 0.012;
      this.audio.scheduleNote({
        midi,
        gain,
        pan: musicState.pan,
        when,
        duration,
        accent: accent ? 1.2 : 1,
        articulation: musicState.articulation,
      });
      this.scheduleCounterMelody(degree, musicState, when, duration);
      this.scheduleFingerOrnaments(degree, musicState, when, duration, stepInBar);
      this.onNote?.({
        frequency: 440 * (2 ** ((midi - 69) / 12)),
        energy: clamp(musicState.energy + (accent ? 0.16 : 0)),
        center: this.currentCenter,
        accent,
      });
    }

    (nearStill ? [] : this.rhythm.events(stepInBar, musicState, this.mode, this.phraseState)).forEach((type) => {
      this.audio.schedulePercussion({
        type,
        gain: 0.012 + musicState.energy * (type === "kick" ? 0.055 : 0.034),
        pan: musicState.pan * (type === "kick" ? 0.2 : 0.72),
        when,
      });
    });

    if (accent && !nearStill) {
      this.audio.schedulePercussion({
        type: "accent",
        gain: 0.024 + musicState.energy * 0.052,
        pan: musicState.pan,
        when,
      });
      this.pendingAccent = false;
    }
  }

  scheduleCounterMelody(degree, musicState, when, duration) {
    this.harmony.counterMelody(degree, musicState).forEach((harmonyDegree, index) => {
      this.audio.scheduleHarmony({
        midi: this.degreeToMidi(harmonyDegree),
        gain: (0.011 + musicState.amplitude * 0.028) * (index === 0 ? 1 : 0.7),
        pan: clamp(musicState.pan + (index === 0 ? -0.23 : 0.23), -0.8, 0.8),
        when,
        duration: duration * (index === 0 ? 1.08 : 1.2),
        articulation: "legato",
      });
    });
  }

  scheduleFingerOrnaments(degree, musicState, when, duration, stepInBar) {
    if (musicState.ornamentDensity < 0.34 || !this.canSchedule("ornament", when)) return;
    // Finger movement enriches a scheduled arm-led melody; it never creates a new clock.
    const direction = musicState.direction.vertical || 1;
    const ornamentDegree = degree + direction;
    const ornamentWhen = when + Math.min(0.13, duration * 0.28);
    const gain = (0.008 + musicState.ornamentDensity * 0.014) * (stepInBar % 2 ? 0.75 : 1);
    this.scheduleFingerNote({
      degree: ornamentDegree,
      gain,
      pan: clamp(musicState.pan + direction * 0.12, -0.72, 0.72),
      when: ornamentWhen,
      duration: Math.min(0.22, duration * 0.36),
      articulation: "staccato",
      energy: musicState.energy * 0.7,
      accent: false,
    });
  }

  scheduleFingerEvents(events, musicState, now) {
    const pinchEvents = events.filter((event) => event.type === "pinch");
    const leftPinch = pinchEvents.find((event) => event.hand === "left");
    const rightPinch = pinchEvents.find((event) => event.hand === "right");
    const simultaneousPinch = leftPinch
      && rightPinch
      && Number.isFinite(leftPinch.timestamp)
      && Number.isFinite(rightPinch.timestamp)
      && Math.abs(leftPinch.timestamp - rightPinch.timestamp) <= 80;
    if (simultaneousPinch) {
      this.scheduleDoublePinch(leftPinch, rightPinch, musicState, now);
    }
    events.forEach((event) => {
      if (event.type === "pinch" && simultaneousPinch) return;
      if (event.type === "pinch") this.schedulePinch(event, musicState, now);
      if (event.type === "swipe" && event.finger === "index") this.scheduleSwipe(event, musicState, now);
    });
  }

  scheduleDoublePinch(leftEvent, rightEvent, musicState, now) {
    if (!this.reserveBudget("ornament", now, 2)) return;
    const baseDegree = this.lastMelodyDegree ?? this.degreeFromHandHeight(
      (leftEvent.handY + rightEvent.handY) / 2,
      musicState,
    );
    const interval = Math.max(2, Math.abs(musicState.harmonyInterval || 0));
    const velocity = clamp((leftEvent.velocity + rightEvent.velocity + leftEvent.intensity + rightEvent.intensity) / 4);
    [
      { degree: baseDegree, pan: -0.13 },
      { degree: baseDegree + interval, pan: 0.13 },
    ].forEach(({ degree, pan }) => {
      this.scheduleFingerNote({
        degree,
        gain: 0.011 + velocity * 0.017,
        pan: clamp(musicState.pan + pan, -0.76, 0.76),
        when: now + 0.04,
        duration: 0.34 + musicState.sustain * 0.18,
        articulation: "legato",
        energy: clamp(musicState.energy + velocity * 0.2),
        accent: false,
      });
    });
  }

  schedulePinch(event, musicState, now) {
    const baseDegree = this.lastMelodyDegree ?? this.degreeFromHandHeight(event.handY, musicState);
    const velocity = clamp(event.velocity + event.intensity * 0.42);
    const config = {
      index: { degree: baseDegree, duration: 0.28, accent: false, offset: 0 },
      middle: { degree: baseDegree + (musicState.harmonyInterval || 2), duration: 0.34, accent: false, offset: 0.08 },
      ring: { degree: baseDegree + 1, duration: 0.7 + musicState.sustain * 0.4, accent: false, offset: 0.14 },
      pinky: { degree: baseDegree + 5, duration: 0.2, accent: true, offset: 0.2 },
    }[event.finger];
    if (!config) return;
    if (config.accent && !this.canSchedule("accent", now)) return;
    if (!config.accent && !this.canSchedule("ornament", now)) return;
    const gain = (0.01 + velocity * 0.018) * (config.accent ? 1.4 : 1);
    this.scheduleFingerNote({
      degree: config.degree,
      gain,
      pan: clamp(musicState.pan + (event.hand === "left" ? -0.12 : 0.12), -0.76, 0.76),
      when: now + 0.04,
      duration: config.duration,
      articulation: event.finger === "ring" ? "legato" : "staccato",
      energy: clamp(musicState.energy + velocity * 0.28),
      accent: config.accent,
    });
    if (config.accent) {
      this.audio.schedulePercussion({
        type: "accent",
        gain: 0.018 + velocity * 0.028,
        pan: musicState.pan,
        when: now + 0.04,
      });
    }
  }

  scheduleSwipe(event, musicState, now) {
    if (!this.canSchedule("ornament", now)) return;
    const baseDegree = this.lastMelodyDegree ?? this.degreeFromHandHeight(event.handY, musicState);
    const direction = event.direction.vertical || 1;
    const duration = event.velocity > 0.62 ? 0.13 : 0.18;
    this.scheduleFingerNote({
      degree: baseDegree + direction,
      gain: 0.009 + event.velocity * 0.012,
      pan: clamp(musicState.pan + direction * 0.12, -0.72, 0.72),
      when: now + 0.035,
      duration,
      articulation: "staccato",
      energy: musicState.energy * 0.72,
      accent: false,
    });
  }

  scheduleFingerNote({ degree, gain, pan, when, duration, articulation, energy, accent }) {
    const midi = this.degreeToMidi(clamp(Math.round(degree), -5, 9));
    this.lastScheduledNote = {
      midi,
      degree: Math.round(degree),
      frequency: 440 * (2 ** ((midi - 69) / 12)),
      at: when,
      finger: true,
    };
    this.audio.scheduleNote({
      midi,
      gain,
      pan,
      when,
      duration,
      accent: accent ? 1.16 : 0.82,
      articulation,
      oscillatorType: this.mode.id === "electronic" ? "triangle" : "sine",
    });
    this.onNote?.({
      frequency: 440 * (2 ** ((midi - 69) / 12)),
      energy,
      center: this.currentCenter,
      accent,
      finger: true,
    });
  }

  degreeFromHandHeight(handY, musicState) {
    const height = Number.isFinite(handY) ? clamp(1 - handY) : musicState.pitch;
    return Math.round(height * 10 - 4);
  }

  canSchedule(kind, now) {
    const limits = { ornament: 6, accent: 2 };
    const history = this.noteBudget[kind];
    while (history.length && history[0] < now - 1) history.shift();
    if (history.length >= limits[kind]) return false;
    history.push(now);
    return true;
  }

  reserveBudget(kind, now, count) {
    const limits = { ornament: 6, accent: 2 };
    const history = this.noteBudget[kind];
    while (history.length && history[0] < now - 1) history.shift();
    if (history.length + count > limits[kind]) return false;
    history.push(...Array.from({ length: count }, () => now));
    return true;
  }

  degreeToMidi(degree) {
    const octave = Math.floor(degree / this.mode.scale.length);
    const scaleDegree = ((degree % this.mode.scale.length) + this.mode.scale.length) % this.mode.scale.length;
    return this.mode.root + this.mode.scale[scaleDegree] + octave * 12;
  }

  async stop() {
    this.running = false;
    this.state = MUSIC_STATES.IDLE;
    this.currentChord = null;
    this.fingerMusic.reset();
    this.lastMelodyDegree = null;
    this.noteBudget = { ornament: [], accent: [] };
    this.lastMusicState = null;
    this.lastScheduledNote = null;
    await this.audio.stop();
  }
}
