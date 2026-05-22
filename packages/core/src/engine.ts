import type { AudioFrame, AudioSource, MoodVector } from "./types.js";
import { FeatureExtractor } from "./analysis/feature-extractor.js";
import { MoodAnalyzer } from "./analysis/mood-analyzer.js";

export interface EngineTick {
  frame: AudioFrame;
  mood: MoodVector;
  bpmConfidence: number;
}

/**
 * Owns the AudioContext, the active AudioSource, and the FeatureExtractor +
 * MoodAnalyzer chain. The renderer calls tick() once per RAF.
 *
 * The AudioContext MUST be created inside a user gesture (autoplay policy).
 * The simplest way to guarantee that is to construct AudioEngine inside the
 * click handler that gets us audio in the first place.
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly extractor: FeatureExtractor;
  readonly moodAnalyzer = new MoodAnalyzer();

  private currentSource: AudioSource | null = null;

  constructor() {
    this.ctx = new AudioContext();
    this.extractor = new FeatureExtractor(this.ctx);
  }

  async setSource(source: AudioSource): Promise<void> {
    if (this.currentSource) this.currentSource.stop();
    this.currentSource = source;
    this.extractor.reset();
    this.moodAnalyzer.reset();
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    const node = await source.start(this.ctx);
    this.extractor.connectFrom(node);
  }

  source(): AudioSource | null {
    return this.currentSource;
  }

  tick(nowMs: number): EngineTick {
    const frame = this.extractor.process(nowMs);
    const mood = this.moodAnalyzer.update(frame);
    return { frame, mood, bpmConfidence: this.extractor.bpmConfidence() };
  }

  setSensitivity(s: number): void {
    this.extractor.setSensitivity(s);
  }

  async dispose(): Promise<void> {
    this.currentSource?.stop();
    this.currentSource = null;
    if (this.ctx.state !== "closed") {
      try {
        await this.ctx.close();
      } catch {
        // already closed
      }
    }
  }
}
