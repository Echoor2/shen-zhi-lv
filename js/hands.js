import { MEDIAPIPE_ASSETS } from "./mediapipe-assets.js";

const HAND_SAMPLE_INTERVAL = 62;
const HAND_INITIALIZATION_TIMEOUT = 9000;

const withTimeout = (promise, timeoutMs, message) => new Promise((resolve, reject) => {
  const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  promise.then(
    (value) => {
      window.clearTimeout(timeout);
      resolve(value);
    },
    (error) => {
      window.clearTimeout(timeout);
      reject(error);
    },
  );
});

export class HandEngine {
  constructor(video, onResults) {
    this.video = video;
    this.onResults = onResults;
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.lastDetectionAt = 0;
    this.initializationAttempt = 0;
    this.status = "STANDBY";
    this.delegate = null;
    this.lastError = null;
    this.lastInferenceMs = null;
  }

  async initialize() {
    if (this.landmarker) {
      this.status = "READY";
      return;
    }
    this.status = "LOADING";
    this.lastError = null;
    const attempt = ++this.initializationAttempt;
    try {
      const landmarker = await this.createLandmarker("GPU");
      if (attempt !== this.initializationAttempt) {
        landmarker.close?.();
        return;
      }
      this.landmarker = landmarker;
      this.delegate = "GPU";
      this.status = "READY";
    } catch (gpuError) {
      console.warn("GPU hand delegate unavailable; trying CPU fallback.", gpuError);
      try {
        const landmarker = await this.createLandmarker("CPU");
        if (attempt !== this.initializationAttempt) {
          landmarker.close?.();
          return;
        }
        this.landmarker = landmarker;
        this.delegate = "CPU";
        this.status = "READY";
        return;
      } catch (cpuError) {
        this.status = "UNAVAILABLE";
        this.lastError = cpuError?.message ?? String(cpuError);
        throw new Error("HAND_LOAD_FAILED", { cause: cpuError });
      }
    }
  }

  async createLandmarker(delegate) {
    const task = (async () => {
      const { FilesetResolver, HandLandmarker } = await import(MEDIAPIPE_ASSETS.visionBundle);
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_ASSETS.wasmRoot);
      return HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MEDIAPIPE_ASSETS.handModel, delegate },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.45,
      });
    })();
    return withTimeout(task, HAND_INITIALIZATION_TIMEOUT, "HAND_INITIALIZATION_TIMEOUT");
  }

  detect(now) {
    const ready = this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    if (!this.landmarker || !ready || now - this.lastDetectionAt < HAND_SAMPLE_INTERVAL) return;
    if (this.video.currentTime === this.lastVideoTime) return;

    this.lastVideoTime = this.video.currentTime;
    this.lastDetectionAt = now;
    try {
      const startedAt = performance.now();
      const result = this.landmarker.detectForVideo(this.video, now);
      this.lastInferenceMs = performance.now() - startedAt;
      this.status = "RUNNING";
      const hands = (result.landmarks ?? []).map((landmarks, index) => {
        const handedness = result.handednesses?.[index]?.[0];
        const confidence = handedness?.score ?? 0.75;
        return {
          landmarks,
          handedness: handedness?.categoryName ?? null,
          label: handedness?.categoryName?.toLowerCase() ?? null,
          confidence,
          score: confidence,
          detected: true,
          trackingQuality: confidence,
        };
      });
      this.onResults(hands, now);
    } catch (error) {
      // A transient detector error must never stop V3's independent music clock.
      console.warn("Hand detection frame skipped.", error);
      this.lastError = error?.message ?? String(error);
    }
  }

  reset() {
    this.lastVideoTime = -1;
    this.lastDetectionAt = 0;
    this.initializationAttempt += 1;
    this.status = "STANDBY";
  }
}
