import { MEDIAPIPE_ASSETS } from "./mediapipe-assets.js";

export class PoseEngine {
  constructor(video, onResults) {
    this.video = video;
    this.onResults = onResults;
    this.landmarker = null;
    this.stream = null;
    this.lastVideoTime = -1;
    this.status = "IDLE";
    this.delegate = null;
    this.lastError = null;
    this.lastInferenceMs = null;
  }

  async initialize() {
    try {
      if (this.landmarker) {
        this.status = "READY";
        return;
      }
      this.status = "LOADING";
      this.lastError = null;
      const { FilesetResolver, PoseLandmarker } = await import(MEDIAPIPE_ASSETS.visionBundle);
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_ASSETS.wasmRoot);
      const options = {
        baseOptions: { modelAssetPath: MEDIAPIPE_ASSETS.poseModel, delegate: "GPU" },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.55,
        minPosePresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      };
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(vision, options);
        this.delegate = "GPU";
      } catch (gpuError) {
        console.warn("GPU pose delegate unavailable; using CPU fallback.", gpuError);
        options.baseOptions.delegate = "CPU";
        this.landmarker = await PoseLandmarker.createFromOptions(vision, options);
        this.delegate = "CPU";
      }
      this.status = "READY";
    } catch (error) {
      this.status = "ERROR";
      this.lastError = error?.message ?? String(error);
      throw new Error("POSE_LOAD_FAILED", { cause: error });
    }
  }

  async startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.status = "ERROR";
      this.lastError = "CAMERA_UNSUPPORTED";
      throw new Error("CAMERA_UNSUPPORTED");
    }
    this.status = "CAMERA_LOADING";
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.status = "CAMERA_READY";
    } catch (error) {
      const code = error.name === "NotAllowedError" ? "CAMERA_DENIED" : "CAMERA_FAILED";
      this.status = "ERROR";
      this.lastError = code;
      throw new Error(code, { cause: error });
    }
  }

  detect(now) {
    if (!this.landmarker || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;
    try {
      const startedAt = performance.now();
      const result = this.landmarker.detectForVideo(this.video, now);
      this.lastInferenceMs = performance.now() - startedAt;
      this.status = "RUNNING";
      this.onResults(result.landmarks?.[0] || null, now);
    } catch (error) {
      // A transient detector frame failure must not kill the RAF loop.
      console.warn("Pose detection frame skipped.", error);
      this.lastError = error?.message ?? String(error);
      this.lastVideoTime = -1;
    }
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.lastVideoTime = -1;
    this.status = "STOPPED";
  }
}
