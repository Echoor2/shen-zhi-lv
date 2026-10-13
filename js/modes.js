export const MODES = {
  "gu-yun": {
    id: "gu-yun",
    name: "五声古韵",
    scale: [0, 2, 4, 7, 9],
    root: 60,
    oscillator: "sine",
    harmony: "soft",
    chordIntervals: [0, 4, 7],
    extensionInterval: 11,
    harmonyProgressions: [[0, -3, 5, 7], [0, 5, 7, 0], [-3, 5, 0, 7]],
    explain: {
      description: "以 C 宫五声音阶组织身体驱动的旋律，采用正弦合成主音色。",
      scaleLabel: "Scale: C D E G A",
    },
    visual: { accent: "#a8d9bf", accentRgb: "168, 217, 191", glow: "#d5efd9", particleLife: 1.2, turbulence: 0.18 },
  },
  electronic: {
    id: "electronic",
    name: "电子律动",
    scale: [0, 3, 5, 7, 10],
    root: 48,
    oscillator: "sawtooth",
    harmony: "wide",
    chordIntervals: [0, 3, 7],
    extensionInterval: 10,
    harmonyProgressions: [[0, 8, 3, 10], [0, 3, 10, 0], [8, 3, 10, 0]],
    explain: {
      description: "以五音集合和锯齿波主音色表达运动，并采用更积极的节拍门控。",
      scaleLabel: "Scale: C D♯ F G A♯",
    },
    visual: { accent: "#71c9dd", accentRgb: "113, 201, 221", glow: "#b6eff6", particleLife: 0.85, turbulence: 0.52 },
  },
  nature: {
    id: "nature",
    name: "自然声境",
    scale: [0, 2, 5, 7, 9],
    root: 57,
    oscillator: "triangle",
    harmony: "air",
    chordIntervals: [0, 5, 7],
    extensionInterval: 14,
    harmonyProgressions: [[0, 5, 7, 0], [0, -3, 5, 7], [5, 0, 7, 0]],
    explain: {
      description: "以三角波主音色、较低滤波截止频率和较缓的粒子反馈营造声境；声音由 Web Audio 合成。",
      scaleLabel: "Scale: A B D E F♯",
    },
    visual: { accent: "#c9cf83", accentRgb: "201, 207, 131", glow: "#edf1b5", particleLife: 1.45, turbulence: 0.28 },
  },
};

export function applyModeTheme(mode) {
  const root = document.documentElement;
  root.style.setProperty("--accent", mode.visual.accent);
  root.style.setProperty("--accent-rgb", mode.visual.accentRgb);
  root.style.setProperty("--glow", mode.visual.glow);
}
