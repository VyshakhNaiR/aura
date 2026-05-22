import type { AudioSource } from "../types.js";

/**
 * Plays a local audio File through an HTMLAudioElement and exposes the
 * resulting MediaElementAudioSourceNode to the feature extractor.
 *
 * Important Web Audio rule: after createMediaElementSource(), the element's
 * normal output is rerouted to the AudioContext. We MUST also connect the
 * source to ctx.destination or playback is silent.
 *
 * MediaElementSource can only be created once per element — we always create
 * a fresh element per source instance so re-renders can't double-create.
 */
export class LocalFileAudioSource implements AudioSource {
  readonly id = "file";
  readonly label: string;

  private audio: HTMLAudioElement | null = null;
  private node: MediaElementAudioSourceNode | null = null;
  private objectUrl: string | null = null;

  constructor(private readonly file: File) {
    this.label = file.name;
  }

  async start(ctx: AudioContext): Promise<AudioNode> {
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.loop = false;
    this.objectUrl = URL.createObjectURL(this.file);
    audio.src = this.objectUrl;

    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Could not load "${this.file.name}"`));
      };
      const cleanup = () => {
        audio.removeEventListener("canplay", onReady);
        audio.removeEventListener("error", onError);
      };
      audio.addEventListener("canplay", onReady, { once: true });
      audio.addEventListener("error", onError, { once: true });
    });

    const node = ctx.createMediaElementSource(audio);
    node.connect(ctx.destination);

    this.audio = audio;
    this.node = node;

    try {
      await audio.play();
    } catch (e) {
      // Autoplay can still fail in some browsers if the AudioContext wasn't
      // resumed inside the same user gesture. Surface a useful message.
      throw new Error(
        `Playback rejected: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return node;
  }

  position(): number | null {
    return this.audio?.currentTime ?? null;
  }

  duration(): number | null {
    const d = this.audio?.duration;
    return d && Number.isFinite(d) ? d : null;
  }

  /** Pause/resume helpers — useful for a play/pause UI control. */
  pause(): void {
    this.audio?.pause();
  }
  async resume(): Promise<void> {
    if (this.audio) await this.audio.play();
  }
  isPaused(): boolean {
    return this.audio?.paused ?? true;
  }

  stop(): void {
    this.audio?.pause();
    if (this.audio) this.audio.src = "";
    this.node?.disconnect();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.audio = null;
    this.node = null;
    this.objectUrl = null;
  }
}
