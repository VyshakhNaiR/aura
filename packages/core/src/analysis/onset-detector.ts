/**
 * Energy-flux onset detector with rolling-mean + stddev adaptive threshold
 * and a refractory window to suppress double-triggers.
 *
 * Spectral flux is computed externally (clean / unsmoothed) and fed in via
 * detect(). This keeps the detector independent of any specific analyser.
 *
 * Tuning knobs:
 *  - sensitivity (~1.3–1.6) — how many σ above mean to count as a beat
 *  - refractoryMs (~250–300) — minimum gap between consecutive beats
 *  - historySize (~60 frames ≈ 1s @ 60fps) — adaptation window
 *
 * No per-detect allocations.
 */
export class OnsetDetector {
  private readonly history: Float32Array;
  private idx = 0;
  private filled = 0;
  private lastBeatMs = -Infinity;

  constructor(
    private readonly historySize = 60,
    private sensitivity = 1.45,
    private readonly refractoryMs = 280,
  ) {
    this.history = new Float32Array(historySize);
  }

  /**
   * Feed one frame's spectral flux value. Returns true on a beat.
   */
  detect(flux: number, nowMs: number): boolean {
    // Need some history before we can compute a meaningful threshold.
    if (this.filled < 8) {
      this.push(flux);
      return false;
    }

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
    const threshold = mean + this.sensitivity * std;

    const isBeat =
      flux > threshold && nowMs - this.lastBeatMs > this.refractoryMs;
    this.push(flux);
    if (isBeat) this.lastBeatMs = nowMs;
    return isBeat;
  }

  private push(flux: number): void {
    this.history[this.idx] = flux;
    this.idx = (this.idx + 1) % this.history.length;
    if (this.filled < this.history.length) this.filled++;
  }

  setSensitivity(s: number): void {
    this.sensitivity = s;
  }

  reset(): void {
    this.idx = 0;
    this.filled = 0;
    this.lastBeatMs = -Infinity;
    this.history.fill(0);
  }
}
