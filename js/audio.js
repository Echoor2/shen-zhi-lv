const MIN_GAIN = 0.0001;
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const toFrequency = (midi) => 440 * (2 ** ((midi - 69) / 12));

export class AudioEngine {
  constructor() {
    this.context = null;
    this.master = null;
    this.filter = null;
    this.mode = null;
    this.baseCutoff = 3200;
    this.stereoWidth = 0.24;
    this.padVoices = [];
  }

  async start(mode) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error("AUDIO_UNSUPPORTED");
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
    if (!this.master) this.createSignalPath();
    this.setMode(mode);
  }

  createSignalPath() {
    this.master = this.context.createGain();
    this.master.gain.value = MIN_GAIN;
    this.filter = this.context.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 3000;
    this.filter.Q.value = 0.55;
    this.filter.connect(this.master);
    this.master.connect(this.context.destination);
  }

  setMode(mode) {
    this.mode = mode;
    if (!this.filter || !this.context) return;
    this.baseCutoff = mode.id === "electronic" ? 4300 : mode.id === "nature" ? 2500 : 3200;
    this.filter.frequency.setTargetAtTime(this.baseCutoff, this.context.currentTime, 0.16);
  }

  setBrightness({ amplitude = 0, energy = 0, timbreBrightness = 0 }) {
    if (!this.filter || !this.context) return;
    const cutoff = Math.min(6200, this.baseCutoff + amplitude * 1100 + energy * 650 + timbreBrightness * 1250);
    this.filter.frequency.setTargetAtTime(cutoff, this.context.currentTime, 0.16);
  }

  setStereoWidth(width = 0.24) {
    this.stereoWidth = Math.max(0.12, Math.min(1, width));
  }

  setMasterLevel(level) {
    if (!this.master || !this.context) return;
    this.master.gain.setTargetAtTime(Math.max(level, MIN_GAIN), this.context.currentTime, level <= MIN_GAIN * 1.1 ? 0.32 : 0.16);
  }

  ensurePad(chord) {
    if (this.padVoices.length) return;
    const notes = chord?.notes ?? [0, 7, 12];
    this.padVoices = Array.from({ length: 4 }, (_, index) => {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      const panner = this.context.createStereoPanner();
      oscillator.type = this.mode.id === "electronic" ? "triangle" : "sine";
      oscillator.frequency.value = toFrequency((chord?.rootMidi ?? this.mode.root - 12) + (notes[index] ?? notes.at(-1) + 12));
      gain.gain.value = MIN_GAIN;
      panner.pan.value = [-0.35, -0.13, 0.13, 0.35][index];
      oscillator.connect(gain);
      gain.connect(panner);
      panner.connect(this.filter);
      oscillator.start();
      return { oscillator, gain, panner };
    });
  }

  updatePad({ chord, activityLevel, armSpread, trackingState, pan = 0, stereoWidth = this.stereoWidth }) {
    if (!this.context || !this.mode) return;
    this.ensurePad(chord);
    const now = this.context.currentTime;
    const paused = trackingState === "paused" || trackingState === "idle";
    const notes = chord?.notes ?? [0, 7, 12];
    const rootMidi = chord?.rootMidi ?? this.mode.root - 12;
    const baseGain = paused ? MIN_GAIN : 0.001 + clamp(armSpread) * 0.004 + activityLevel * 0.0015;
    this.padVoices.forEach((voice, index) => {
      const interval = notes[index] ?? notes.at(-1) + 12;
      const voiceGain = index < notes.length
        ? baseGain * (index === 0 ? 1 : index === 1 ? 0.58 : 0.4)
        : MIN_GAIN;
      voice.oscillator.frequency.setTargetAtTime(toFrequency(rootMidi + interval), now, 0.28);
      voice.gain.gain.setTargetAtTime(voiceGain, now, 0.38);
      const spread = [-0.35, -0.13, 0.13, 0.35][index] * Math.max(0.2, stereoWidth);
      voice.panner.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, pan * 0.22 + spread)), now, 0.24);
    });
  }

  scheduleNote({ midi, gain, pan = 0, when, duration, accent = 1, articulation = "flow", oscillatorType = this.mode?.oscillator }) {
    if (!this.context || !this.mode) return;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    const panner = this.context.createStereoPanner();
    const attack = articulation === "staccato" ? 0.01 : articulation === "legato" ? 0.055 : this.mode.id === "electronic" ? 0.014 : 0.04;
    const decay = Math.min(0.2, duration * (articulation === "staccato" ? 0.18 : 0.28));
    const release = articulation === "staccato"
      ? Math.max(0.09, duration * 0.34)
      : articulation === "legato" ? Math.max(0.34, duration * 0.94) : Math.max(0.16, duration * 0.62);
    const sustainGain = Math.max(MIN_GAIN, gain * (articulation === "legato" ? 0.62 : 0.48));
    oscillator.type = oscillatorType;
    oscillator.frequency.setValueAtTime(toFrequency(midi), when);
    if (this.mode.id === "gu-yun") oscillator.frequency.exponentialRampToValueAtTime(toFrequency(midi) * 0.997, when + duration);
    envelope.gain.setValueAtTime(MIN_GAIN, when);
    envelope.gain.linearRampToValueAtTime(gain * accent, when + attack);
    envelope.gain.exponentialRampToValueAtTime(sustainGain, when + attack + decay);
    envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, when + duration + release);
    panner.pan.setValueAtTime(pan, when);
    oscillator.connect(envelope);
    envelope.connect(panner);
    panner.connect(this.filter);
    oscillator.start(when);
    oscillator.stop(when + duration + release + 0.03);
  }

  scheduleHarmony({ midi, gain, pan = 0, when, duration, articulation = "legato" }) {
    this.scheduleNote({
      midi,
      gain,
      pan,
      when,
      duration,
      articulation,
      accent: 0.82,
      oscillatorType: this.mode?.id === "electronic" ? "triangle" : "sine",
    });
  }

  schedulePercussion({ type, gain, pan = 0, when }) {
    if (!this.context || !this.filter) return;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    const panner = this.context.createStereoPanner();
    const filter = this.context.createBiquadFilter();
    const isKick = type === "kick";
    const isAccent = type === "accent";
    const duration = isKick ? 0.22 : isAccent ? 0.16 : type === "click" ? 0.08 : 0.05;
    oscillator.type = isKick ? "sine" : isAccent ? "triangle" : "square";
    filter.type = isKick ? "lowpass" : "bandpass";
    filter.Q.value = isKick ? 0.7 : 1.4;
    filter.frequency.setValueAtTime(isKick ? 750 : isAccent ? 1400 : type === "click" ? 2100 : 3200, when);
    oscillator.frequency.setValueAtTime(isKick ? 128 : isAccent ? 360 : type === "click" ? 1080 : 1760, when);
    if (isKick) oscillator.frequency.exponentialRampToValueAtTime(44, when + duration);
    if (isAccent) oscillator.frequency.exponentialRampToValueAtTime(170, when + duration);
    envelope.gain.setValueAtTime(MIN_GAIN, when);
    envelope.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, gain), when + 0.008);
    envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, when + duration);
    panner.pan.setValueAtTime(Math.max(-0.8, Math.min(0.8, pan)), when);
    oscillator.connect(filter);
    filter.connect(envelope);
    envelope.connect(panner);
    panner.connect(this.filter);
    oscillator.start(when);
    oscillator.stop(when + duration + 0.03);
  }

  async stop() {
    if (!this.context) return;
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(MIN_GAIN, now, 0.08);
    this.padVoices.forEach((voice) => {
      voice.gain.gain.setTargetAtTime(MIN_GAIN, now, 0.08);
      voice.oscillator.stop(now + 0.3);
    });
    this.padVoices = [];
    await this.context.suspend();
  }
}
