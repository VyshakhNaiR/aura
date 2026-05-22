import type { AudioFrame, MoodVector } from "../types.js";

/**
 * Builds a smoothed MoodVector from per-frame AudioFrames.
 *
 *  - energy: rms-driven, biased by bass content (kick energy reads as "loud").
 *  - brightness: spectral centroid, smoothed.
 *  - busyness: spectral flux, smoothed — proxies for how busy/dense the
 *    arrangement is.
 *  - dynamics: rolling stddev of energy — proxies for how punchy vs. flat
 *    the track feels right now (a sustained ambient pad and a punchy beat
 *    can have similar mean energy; dynamics separates them).
 *
 * All four are 0..1 with a low-pass filter so palettes blend (HSL/Lab
 * interpolation upstream) instead of hard-cutting.
 */
export class MoodAnalyzer {
  readonly mood: MoodVector = {
    energy: 0,
    brightness: 0,
    busyness: 0,
    dynamics: 0,
  };

  private readonly history: Float32Array;
  private idx = 0;
  private filled = 0;

  constructor(
    private readonly historySize = 120,
    /** Per-frame mix factor toward target. Higher = snappier. */
    private readonly alpha = 0.06,
  ) {
    this.history = new Float32Array(historySize);
  }

  update(frame: AudioFrame): MoodVector {
    const subBass = frame.bands[0]!;
    const bass = frame.bands[1]!;
    const energyTarget = Math.min(1, frame.rms * 0.7 + (subBass + bass) * 0.18);

    this.mood.energy += (energyTarget - this.mood.energy) * this.alpha;
    this.mood.brightness += (frame.centroid - this.mood.brightness) * this.alpha;
    this.mood.busyness += (frame.flux - this.mood.busyness) * this.alpha;

    this.history[this.idx] = energyTarget;
    this.idx = (this.idx + 1) % this.historySize;
    if (this.filled < this.historySize) this.filled++;

    if (this.filled > 4) {
      let sum = 0;
      let sumSq = 0;
      const n = this.filled;
      for (let i = 0; i < n; i++) {
        const v = this.history[i]!;
        sum += v;
        sumSq += v * v;
      }
      const mean = sum / n;
      const variance = Math.max(0, sumSq / n - mean * mean);
      const std = Math.sqrt(variance);
      const target = Math.min(1, std * 4);
      this.mood.dynamics += (target - this.mood.dynamics) * this.alpha;
    }

    return this.mood;
  }

  reset(): void {
    this.mood.energy = 0;
    this.mood.brightness = 0;
    this.mood.busyness = 0;
    this.mood.dynamics = 0;
    this.idx = 0;
    this.filled = 0;
    this.history.fill(0);
  }
}
