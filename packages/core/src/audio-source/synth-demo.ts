import type { AudioSource } from "../types.js";

/**
 * Built-in synthesized demo track. Useful when the user has no audio file
 * handy — gives the visualizer something to chew on so the engine and
 * beat detector can be exercised end-to-end.
 *
 * 120 BPM, four-on-the-floor kick, 8th-note hi-hats, a simple bass line.
 * Scheduled with the classic lookahead pattern so the audio clock and
 * the RAF clock stay independent (no jitter on the beat).
 */
export class SynthDemoAudioSource implements AudioSource {
  readonly id = "demo";
  readonly label = "Demo track (120 BPM)";

  private ctx: AudioContext | null = null;
  private output: GainNode | null = null;
  private hatNoise: AudioBuffer | null = null;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private nextStepTime = 0;
  private step = 0;
  private startedAt = 0;

  private readonly bpm = 120;
  /** 16th-note step length in seconds. */
  private get stepDur(): number {
    return 60 / this.bpm / 4;
  }

  async start(ctx: AudioContext): Promise<AudioNode> {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0.55;
    this.output.connect(ctx.destination);

    // Pre-bake 50ms of white noise once; the hi-hat reuses this buffer.
    const noiseLen = Math.floor(ctx.sampleRate * 0.05);
    const noise = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.hatNoise = noise;

    this.startedAt = ctx.currentTime;
    this.nextStepTime = ctx.currentTime + 0.08;
    this.step = 0;
    this.runScheduler();

    return this.output;
  }

  private runScheduler = (): void => {
    const ctx = this.ctx;
    const out = this.output;
    if (!ctx || !out) return;

    // Schedule everything that falls in the next 120ms.
    const lookahead = 0.12;
    while (this.nextStepTime < ctx.currentTime + lookahead) {
      this.scheduleStep(this.nextStepTime, this.step);
      this.nextStepTime += this.stepDur;
      this.step++;
    }
    this.schedulerTimer = setTimeout(this.runScheduler, 25);
  };

  private scheduleStep(time: number, step: number): void {
    const isQuarter = step % 4 === 0;
    const isEighth = step % 2 === 0;

    if (isQuarter) this.playKick(time);
    if (isEighth && !isQuarter) this.playHat(time, 0.22);
    if (!isEighth) this.playHat(time, 0.12);

    // 16-step bass progression: A1 — C2 — D2 — G1
    const bar = step % 16;
    if (bar === 0) this.playBass(time, 55.0);
    else if (bar === 4) this.playBass(time, 65.4);
    else if (bar === 8) this.playBass(time, 73.4);
    else if (bar === 12) this.playBass(time, 49.0);
  }

  private playKick(time: number): void {
    const ctx = this.ctx!;
    const out = this.output!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.15);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(1.0, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.35);
    osc.connect(gain).connect(out);
    osc.start(time);
    osc.stop(time + 0.4);
  }

  private playHat(time: number, volume: number): void {
    const ctx = this.ctx!;
    const out = this.output!;
    if (!this.hatNoise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.hatNoise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 6000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(volume, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    src.connect(hp).connect(gain).connect(out);
    src.start(time);
  }

  private playBass(time: number, freq: number): void {
    const ctx = this.ctx!;
    const out = this.output!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, time);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, time);
    lp.frequency.exponentialRampToValueAtTime(220, time + 0.3);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.45, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.35);
    osc.connect(lp).connect(gain).connect(out);
    osc.start(time);
    osc.stop(time + 0.4);
  }

  position(): number | null {
    return this.ctx ? this.ctx.currentTime - this.startedAt : null;
  }

  stop(): void {
    if (this.schedulerTimer !== null) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    this.output?.disconnect();
    this.output = null;
    this.hatNoise = null;
    this.ctx = null;
  }
}
