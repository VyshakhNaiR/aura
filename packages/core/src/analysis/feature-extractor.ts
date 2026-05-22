import { BAND_COUNT, createEmptyFrame, type AudioFrame } from "../types.js";
import { OnsetDetector } from "./onset-detector.js";
import { BpmTracker } from "./bpm-tracker.js";

/**
 * Perceptual frequency bands (Hz). Order matches AudioFrame.bands indices.
 *  0 sub-bass · 1 bass · 2 low-mid · 3 mid · 4 high-mid · 5 presence · 6 brilliance
 */
const BAND_HZ: ReadonlyArray<readonly [number, number]> = [
  [20, 60],
  [60, 250],
  [250, 500],
  [500, 2000],
  [2000, 4000],
  [4000, 6000],
  [6000, 20000],
];

/**
 * Per-frame audio analyser. Owns two AnalyserNodes:
 *
 *  - visual (fftSize=2048, smoothing=0.78) — produces bands, centroid, rms, zcr.
 *    Smoothing makes the visuals feel coherent.
 *
 *  - beat (fftSize=1024, smoothing=0) — produces spectral flux for onset
 *    detection. Smoothing destroys transients, so it MUST be zero here.
 *
 * The frame is allocated once and mutated in place every call — never
 * construct one in the render loop.
 */
export class FeatureExtractor {
  readonly frame: AudioFrame = createEmptyFrame();

  private readonly visual: AnalyserNode;
  private readonly beat: AnalyserNode;

  private readonly freq: Uint8Array<ArrayBuffer>;
  private readonly time: Uint8Array<ArrayBuffer>;
  private beatFreq: Uint8Array<ArrayBuffer>;
  private beatFreqPrev: Uint8Array<ArrayBuffer>;

  private readonly bandStart: Int32Array;
  private readonly bandEnd: Int32Array;

  // Running max + slow decay normalizers so the frame range stays 0..1
  // across quiet vs loud tracks without clipping on transients.
  private rmsMax = 0.001;
  private centroidMax = 0.001;
  private fluxMax = 0.001;

  private readonly onset = new OnsetDetector();
  private readonly bpmTracker = new BpmTracker();

  constructor(private readonly ctx: AudioContext) {
    this.visual = ctx.createAnalyser();
    this.visual.fftSize = 2048;
    this.visual.smoothingTimeConstant = 0.78;

    this.beat = ctx.createAnalyser();
    this.beat.fftSize = 1024;
    this.beat.smoothingTimeConstant = 0.0;

    this.freq = new Uint8Array(this.visual.frequencyBinCount);
    this.time = new Uint8Array(this.visual.fftSize);
    this.beatFreq = new Uint8Array(this.beat.frequencyBinCount);
    this.beatFreqPrev = new Uint8Array(this.beat.frequencyBinCount);

    const hzPerBin = ctx.sampleRate / this.visual.fftSize;
    this.bandStart = new Int32Array(BAND_COUNT);
    this.bandEnd = new Int32Array(BAND_COUNT);
    for (let i = 0; i < BAND_COUNT; i++) {
      const range = BAND_HZ[i]!;
      this.bandStart[i] = Math.max(1, Math.round(range[0] / hzPerBin));
      this.bandEnd[i] = Math.min(
        this.freq.length - 1,
        Math.max(this.bandStart[i]!, Math.round(range[1] / hzPerBin)),
      );
    }
  }

  /** Wire an audio source into both analysers. */
  connectFrom(source: AudioNode): void {
    source.connect(this.visual);
    source.connect(this.beat);
  }

  /** Called once per RAF tick. Mutates and returns this.frame. */
  process(nowMs: number): AudioFrame {
    this.visual.getByteFrequencyData(this.freq);
    this.visual.getByteTimeDomainData(this.time);
    this.beat.getByteFrequencyData(this.beatFreq);

    this.computeBands();
    this.computeRms();
    this.computeCentroid();
    const flux = this.computeFlux();
    this.computeZcr();

    const isBeat = this.onset.detect(flux, nowMs);
    this.frame.beat = isBeat;
    if (isBeat) this.bpmTracker.registerBeat(nowMs);
    this.frame.bpm = this.bpmTracker.current();
    this.frame.beatPhase = this.bpmTracker.beatPhase(nowMs);
    this.frame.t = this.ctx.currentTime;

    // Rotate buffers: this frame's beatFreq becomes next frame's prev.
    const tmp = this.beatFreqPrev;
    this.beatFreqPrev = this.beatFreq;
    this.beatFreq = tmp;

    return this.frame;
  }

  bpmConfidence(): number {
    return this.bpmTracker.conf();
  }

  setSensitivity(s: number): void {
    this.onset.setSensitivity(s);
  }

  reset(): void {
    this.onset.reset();
    this.bpmTracker.reset();
    this.beatFreqPrev.fill(0);
    this.beatFreq.fill(0);
    this.rmsMax = 0.001;
    this.centroidMax = 0.001;
    this.fluxMax = 0.001;
  }

  // ---------- per-feature kernels (kept inlined for tight loops) ----------

  private computeBands(): void {
    for (let b = 0; b < BAND_COUNT; b++) {
      const s = this.bandStart[b]!;
      const e = this.bandEnd[b]!;
      let sum = 0;
      for (let i = s; i <= e; i++) sum += this.freq[i]!;
      const count = e - s + 1;
      this.frame.bands[b] = sum / (count * 255);
    }
  }

  private computeRms(): void {
    let sumSq = 0;
    const n = this.time.length;
    for (let i = 0; i < n; i++) {
      const v = (this.time[i]! - 128) / 128;
      sumSq += v * v;
    }
    const raw = Math.sqrt(sumSq / n);
    this.rmsMax = Math.max(this.rmsMax * 0.9995, raw);
    this.frame.rms = Math.min(1, raw / this.rmsMax);
  }

  private computeCentroid(): void {
    let mag = 0;
    let weighted = 0;
    const n = this.freq.length;
    for (let i = 0; i < n; i++) {
      const m = this.freq[i]!;
      mag += m;
      weighted += i * m;
    }
    const bin = mag > 0 ? weighted / mag : 0;
    const raw = bin / n;
    this.centroidMax = Math.max(this.centroidMax * 0.999, raw);
    this.frame.centroid = Math.min(1, raw / this.centroidMax);
  }

  private computeFlux(): number {
    let flux = 0;
    const n = this.beatFreq.length;
    for (let i = 0; i < n; i++) {
      const d = this.beatFreq[i]! - this.beatFreqPrev[i]!;
      if (d > 0) flux += d;
    }
    flux /= 255;
    this.fluxMax = Math.max(this.fluxMax * 0.9995, flux);
    this.frame.flux = Math.min(1, flux / this.fluxMax);
    // Return the raw (pre-normalized) flux for the onset detector — it
    // keeps its own rolling baseline; double-normalizing would flatten
    // the contrast it relies on.
    return flux;
  }

  private computeZcr(): void {
    let crossings = 0;
    const n = this.time.length;
    let prev = this.time[0]! - 128;
    for (let i = 1; i < n; i++) {
      const curr = this.time[i]! - 128;
      if ((prev < 0) !== (curr < 0)) crossings++;
      prev = curr;
    }
    this.frame.zcr = crossings / n;
  }
}
