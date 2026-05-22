import type { AudioSource } from "../types.js";

/**
 * Captures audio from a browser tab or the system via getDisplayMedia and
 * exposes it as an AudioSource the feature extractor can analyze.
 *
 * This is THE universal path for streaming services. Spotify, YouTube Music,
 * Apple Music web, SoundCloud — none of them give us audio data through
 * their APIs (the relevant Spotify endpoints are deprecated as of 2024).
 * Instead we have the user share the tab playing the music, and we tap its
 * audio track into our AudioContext.
 *
 * Browser support gotcha: tab audio capture works reliably in Chromium
 * (Chrome / Edge / Brave / Arc). Firefox and Safari are limited. Detect
 * capability and surface a useful message.
 *
 * UX gotcha (Chrome): the user must tick "Share tab audio" in the picker
 * dialog. If they don't, the resulting stream has no audio tracks — we
 * detect and explain.
 */
export class DisplayMediaAudioSource implements AudioSource {
  readonly id = "display";
  readonly label: string;

  private stream: MediaStream | null = null;
  private node: MediaStreamAudioSourceNode | null = null;
  private silentSink: HTMLAudioElement | null = null;
  private startedAt = 0;

  constructor(label = "Tab capture") {
    this.label = label;
  }

  /**
   * Capability check — call before constructing to fail fast with a
   * useful message instead of an unhandled rejection.
   */
  static isSupported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getDisplayMedia === "function"
    );
  }

  async start(ctx: AudioContext): Promise<AudioNode> {
    if (!DisplayMediaAudioSource.isSupported()) {
      throw new Error(
        "This browser doesn't support tab/system audio capture. Try Chrome, Edge, or Brave.",
      );
    }

    let stream: MediaStream;
    try {
      // video:true is required on most Chromium builds even though we
      // only want audio — without it, the audio checkbox is hidden in
      // the picker dialog. We discard the video track immediately.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Tab capture cancelled or denied: ${msg}`);
    }

    // Drop the video track — we never look at it.
    for (const track of stream.getVideoTracks()) track.stop();

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      // Most common cause: user didn't tick "Share tab audio".
      for (const t of stream.getTracks()) t.stop();
      throw new Error(
        'No audio captured. In the share dialog, make sure to tick "Share tab audio".',
      );
    }

    this.stream = stream;
    const node = ctx.createMediaStreamSource(stream);
    this.node = node;

    // Critical: MediaStreamSourceNode does NOT route to ctx.destination by
    // default — that's actually what we want. The original tab is still
    // playing the audio out of speakers. If we connected to destination
    // we'd hear it doubled.
    //
    // However, some browsers will pause the captured stream if nothing
    // is "pulling" it through to an output. As a defensive measure we
    // attach the stream to a muted hidden <audio> element to keep it
    // alive without producing duplicate sound.
    const sink = new Audio();
    sink.srcObject = stream;
    sink.muted = true;
    sink.play().catch(() => {
      // ignore — best-effort
    });
    this.silentSink = sink;

    // Auto-tear-down if the user stops sharing from the browser UI.
    audioTracks[0]!.addEventListener("ended", () => this.stop());

    this.startedAt = ctx.currentTime;
    return node;
  }

  position(): number | null {
    return null; // Live stream — no absolute position.
  }

  stop(): void {
    this.node?.disconnect();
    this.node = null;
    if (this.silentSink) {
      this.silentSink.pause();
      this.silentSink.srcObject = null;
      this.silentSink = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }
}
