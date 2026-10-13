const assetUrl = (path) => new URL(path, import.meta.url).href;

// Keep MediaPipe runtime assets local so the installation can run in browsers
// that block third-party CDNs while still using the official fixed release.
export const MEDIAPIPE_ASSETS = Object.freeze({
  visionBundle: assetUrl("../assets/vendor/mediapipe/vision_bundle.mjs"),
  wasmRoot: assetUrl("../assets/vendor/mediapipe/wasm/"),
  poseModel: assetUrl("../assets/models/pose_landmarker_lite.task"),
  handModel: assetUrl("../assets/models/hand_landmarker.task"),
});
