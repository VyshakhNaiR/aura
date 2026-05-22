/**
 * Rolling BPM estimate from inter-onset intervals (IOIs).
 *
 * Each detected beat is registered with a timestamp; the delta from the prior
 * beat is the IOI. IOIs are folded into the 60–180 BPM range (so half/double
 * time still resolves to the right tempo) and histogrammed; the peak bin is
 * the current BPM estimate, low-passed across windows for stability.
 *
 * Confidence is the fraction of recent IOIs that landed in the peak bin —
 * low when tempo is uncertain, high when steady.
 */
export class BpmTracker {
  private readonly ioi: Float32Array;
  private idx = 0;
  private filled = 0;
  private lastBeatMs = -Infinity;
  private bpm = 0;
  private confidence = 0;

  /** 121 bins covering BPM 60..180 inclusive. */
  private readonly bins = new Int32Array(121);

  constructor(private readonly bufferSize = 24) {
    this.ioi = new Float32Array(bufferSize);
  }

  registerBeat(nowMs: number): void {
    if (this.lastBeatMs >= 0) {
      const dt = nowMs - this.lastBeatMs;
      // plausible IOI window: ~30..400 BPM equivalents
      if (dt >= 150 && dt <= 2000) {
        this.ioi[this.idx] = dt;
        this.idx = (this.idx + 1) % this.bufferSize;
        if (this.filled < this.bufferSize) this.filled++;
        this.recompute();
      }
    }
    this.lastBeatMs = nowMs;
  }

  private recompute(): void {
    if (this.filled < 4) {
      this.confidence = this.filled / 4;
      return;
    }
    this.bins.fill(0);
    for (let i = 0; i < this.filled; i++) {
      let b = 60000 / this.ioi[i]!;
      while (b < 60) b *= 2;
      while (b > 180) b /= 2;
      const idx = Math.round(b) - 60;
      if (idx >= 0 && idx < this.bins.length) this.bins[idx]!++;
    }
    let peak = 0;
    let peakCount = 0;
    for (let i = 0; i < this.bins.length; i++) {
      const c = this.bins[i]!;
      if (c > peakCount) {
        peakCount = c;
        peak = i;
      }
    }
    const target = peak + 60;
    this.bpm = this.bpm === 0 ? target : this.bpm * 0.7 + target * 0.3;
    this.confidence = Math.min(1, peakCount / this.filled);
  }

  /** Current rolling BPM estimate (0 until enough data). */
  current(): number {
    return this.bpm;
  }

  /** 0..1 — how concentrated the histogram peak is. */
  conf(): number {
    return this.confidence;
  }

  /** 0..1 — position within the current beat at nowMs. */
  beatPhase(nowMs: number): number {
    if (this.bpm <= 0 || this.lastBeatMs < 0) return 0;
    const beatMs = 60000 / this.bpm;
    const elapsed = nowMs - this.lastBeatMs;
    const phase = (elapsed % beatMs) / beatMs;
    return phase < 0 ? 0 : phase;
  }

  reset(): void {
    this.idx = 0;
    this.filled = 0;
    this.lastBeatMs = -Infinity;
    this.bpm = 0;
    this.confidence = 0;
    this.ioi.fill(0);
    this.bins.fill(0);
  }
}
