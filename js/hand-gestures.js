const FINGERS = ["index", "middle", "ring", "pinky"];
const PINCH_START = 0.42;
const PINCH_RELEASE = 0.62;
const PINCH_COOLDOWN_MS = 150;
const SWIPE_COOLDOWN_MS = 260;
const OPEN_COOLDOWN_MS = 700;
const CLOSE_COOLDOWN_MS = 700;

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const distance = (a, b) => (!a || !b ? Infinity : Math.hypot(a.x - b.x, a.y - b.y));

const emptyTrack = () => ({
  state: "IDLE",
  pinches: Object.fromEntries(FINGERS.map((finger) => [finger, false])),
  lastPinchAt: Object.fromEntries(FINGERS.map((finger) => [finger, -Infinity])),
  lastSwipeAt: -Infinity,
  lastOpenAt: -Infinity,
  lastCloseAt: -Infinity,
  openSince: null,
  closeSince: null,
});

export class HandGestureDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.tracks = { left: emptyTrack(), right: emptyTrack() };
  }

  detect(hands, now) {
    const events = [];
    ["left", "right"].forEach((side) => {
      const hand = hands?.[side];
      const track = this.tracks[side];
      if (!hand?.detected || hand.trackingQuality < 0.28) {
        track.state = "IDLE";
        return;
      }

      const thumb = hand.fingers.thumb;
      FINGERS.forEach((fingerName) => {
        const finger = hand.fingers[fingerName];
        if (!thumb?.detected || !finger?.detected) return;
        const normalizedDistance = distance(
          hand.landmarks?.[4] ?? thumb,
          hand.landmarks?.[FINGERS.indexOf(fingerName) * 4 + 8] ?? finger,
        ) / Math.max(hand.palmSize, 0.045);
        const wasPinching = track.pinches[fingerName];
        if (!wasPinching && normalizedDistance <= PINCH_START && now - track.lastPinchAt[fingerName] >= PINCH_COOLDOWN_MS) {
          track.pinches[fingerName] = true;
          track.lastPinchAt[fingerName] = now;
          track.state = "PINCH_START";
          events.push(this.event(side, fingerName, "pinch", hand, finger, now, clamp((PINCH_START - normalizedDistance) * 2 + finger.velocity)));
        } else if (wasPinching && normalizedDistance >= PINCH_RELEASE) {
          track.pinches[fingerName] = false;
          track.state = "PINCH_RELEASE";
          events.push(this.event(side, fingerName, "pinchRelease", hand, finger, now, finger.velocity));
        } else if (track.pinches[fingerName]) {
          track.state = "PINCH_ACTIVE";
        }
      });

      const index = hand.fingers.index;
      const verticalMotion = Math.abs(index?.direction?.y ?? 0) > Math.abs(index?.direction?.x ?? 0);
      if (
        index?.extended
        && index.velocity >= 0.34
        && verticalMotion
        && now - track.lastSwipeAt >= SWIPE_COOLDOWN_MS
      ) {
        track.lastSwipeAt = now;
        track.state = index.direction.vertical > 0 ? "SWIPE_UP" : "SWIPE_DOWN";
        events.push(this.event(side, "index", "swipe", hand, index, now, index.velocity));
      } else if (!Object.values(track.pinches).some(Boolean) && hand.movementSpeed > 0.08) {
        track.state = "MOVING";
      }

      if (hand.allOpen) {
        if (track.openSince === null) track.openSince = now;
        if (now - track.openSince >= 130 && now - track.lastOpenAt >= OPEN_COOLDOWN_MS) {
          track.lastOpenAt = now;
          track.state = "OPEN";
          events.push(this.event(side, "all", "open", hand, index, now, hand.openness));
        }
      } else {
        track.openSince = null;
      }

      if (hand.closed) {
        if (track.closeSince === null) track.closeSince = now;
        if (now - track.closeSince >= 300 && now - track.lastCloseAt >= CLOSE_COOLDOWN_MS) {
          track.lastCloseAt = now;
          track.state = "CLOSE";
          events.push(this.event(side, "all", "close", hand, index, now, hand.fingers.index.curl));
        }
      } else {
        track.closeSince = null;
      }
    });
    return events;
  }

  event(hand, finger, type, handState, fingerState, timestamp, intensity) {
    return {
      hand,
      finger,
      type,
      velocity: clamp(fingerState?.velocity ?? handState.movementSpeed),
      direction: fingerState?.direction ?? handState.movementDirection,
      intensity: clamp(intensity),
      handY: handState.y,
      openness: handState.openness,
      timestamp,
    };
  }
}
