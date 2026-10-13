const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const lerp = (current, target, amount) => current + (target - current) * amount;
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const distance = (a, b) => (!a || !b ? 0 : Math.hypot(a.x - b.x, a.y - b.y));

const idleControls = () => ({
  timbreBrightness: 0,
  stereoWidth: 0,
  handHarmonyRichness: 0,
  handDistance: 0,
  handInterval: null,
  handOpenness: 0,
  ornamentDensity: 0,
  articulation: null,
  sustainBoost: 0,
  fingerVelocity: 0,
  detailPitchOffset: 0,
  melodyBias: 0,
  highAccent: false,
  harmonyOpen: false,
  harmonicClose: false,
});

export class FingerMusicLayer {
  constructor() {
    this.reset();
  }

  reset() {
    this.controls = idleControls();
  }

  update(hands = {}, events = []) {
    const handStates = hands ?? {};
    const detected = ["left", "right"].map((side) => handStates[side]).filter((hand) => hand?.detected);
    if (!detected.length) {
      this.controls = this.smooth(idleControls());
      return this.controls;
    }

    const thumbIndexOpenness = detected.map((hand) => {
      const thumb = hand.landmarks?.[4];
      const index = hand.landmarks?.[8];
      if (!thumb || !index) return 0;
      return clamp(Math.hypot(thumb.x - index.x, thumb.y - index.y) / Math.max(hand.palmSize * 2.2, 0.08));
    });
    const fingerVelocities = detected.flatMap((hand) => Object.values(hand.fingers).map((finger) => finger.velocity));
    const middleVelocity = Math.max(...detected.map((hand) => hand.fingers.middle.velocity), 0);
    const index = detected.sort((a, b) => b.fingers.index.velocity - a.fingers.index.velocity)[0]?.fingers.index;
    const ringExtended = detected.some((hand) => hand.fingers.ring.extended);
    const pinkyExtended = detected.some((hand) => hand.fingers.pinky.extended);
    const openHands = detected.filter((hand) => hand.allOpen).length;
    const closedHands = detected.filter((hand) => hand.closed).length;
    const left = handStates.left?.detected ? handStates.left : null;
    const right = handStates.right?.detected ? handStates.right : null;
    const handDistance = left && right ? clamp(distance(left, right) / 0.82) : 0;
    const handHeightDifference = left && right ? Math.abs(left.y - right.y) : null;
    const handInterval = handHeightDifference === null
      ? null
      : handHeightDifference < 0.08 ? 0
        : handHeightDifference < 0.2 ? 2
          : handHeightDifference < 0.36 ? 3
            : 4;
    const intervalDirection = left && right ? Math.sign(right.y - left.y) || 1 : 1;
    const indexDirection = index?.direction?.vertical ?? 0;
    const indexMotion = index?.velocity ?? 0;
    const indexHand = detected.find((hand) => hand.fingers.index === index);
    const detailPitchOffset = index?.extended && indexHand
      ? Math.round(clamp((0.5 - index.y) * 4, -2, 2))
      : 0;

    const target = {
      timbreBrightness: average(thumbIndexOpenness),
      stereoWidth: clamp(0.24 + handDistance * 0.44 + (pinkyExtended ? 0.36 : 0)),
      handHarmonyRichness: clamp(
        average(detected.map((hand) => hand.openness)) * 0.36
        + handDistance * 0.44
        + (openHands === 2 ? 0.2 : 0),
      ),
      handDistance,
      handInterval: handInterval === null ? null : handInterval * intervalDirection,
      handOpenness: average(detected.map((hand) => hand.openness)),
      ornamentDensity: clamp(middleVelocity * 0.8 + average(fingerVelocities) * 0.18),
      articulation: ringExtended ? "legato" : detected.some((hand) => hand.fingers.index.curl > 0.72) ? "staccato" : null,
      sustainBoost: ringExtended ? 0.28 : 0,
      fingerVelocity: Math.max(...fingerVelocities, 0),
      // Keep the finger layer within two pentatonic steps of the arm-led melody.
      detailPitchOffset,
      melodyBias: indexMotion > 0.18 ? indexDirection * Math.min(0.12, indexMotion * 0.16) : 0,
      highAccent: pinkyExtended && Math.max(...detected.map((hand) => hand.fingers.pinky.velocity), 0) > 0.34,
      harmonyOpen: openHands > 0 || events.some((event) => event.type === "open"),
      harmonicClose: (closedHands > 0 && closedHands === detected.length) || events.some((event) => event.type === "close"),
    };
    this.controls = this.smooth(target);
    return this.controls;
  }

  smooth(next) {
    const previous = this.controls;
    return {
      ...next,
      timbreBrightness: lerp(previous.timbreBrightness, next.timbreBrightness, 0.18),
      stereoWidth: lerp(previous.stereoWidth, next.stereoWidth, 0.16),
      handHarmonyRichness: lerp(previous.handHarmonyRichness, next.handHarmonyRichness, 0.16),
      handDistance: lerp(previous.handDistance, next.handDistance, 0.16),
      handOpenness: lerp(previous.handOpenness, next.handOpenness, 0.16),
      ornamentDensity: lerp(previous.ornamentDensity, next.ornamentDensity, 0.2),
      sustainBoost: lerp(previous.sustainBoost, next.sustainBoost, 0.18),
      fingerVelocity: lerp(previous.fingerVelocity, next.fingerVelocity, 0.22),
      detailPitchOffset: Math.round(lerp(previous.detailPitchOffset, next.detailPitchOffset, 0.3)),
      melodyBias: lerp(previous.melodyBias, next.melodyBias, 0.22),
    };
  }
}
