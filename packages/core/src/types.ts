/**
 * Number of perceptual frequency bands emitted in every AudioFrame.
 * sub-bass, bass, low-mid, mid, high-mid, presence, brilliance
 */
export const BAND_COUNT = 7;

/**
 * Per-RAF-tick audio analysis output. Allocated once and mutated in place
 * — never construct a new AudioFrame inside the render loop.
 */
export interface AudioFrame {
  /** 7 normalized band energies, 0..1 — index order matches BAND_COUNT comment. */
  bands: Float32Array;
  /** RMS loudness 0..1, normalized with running max + decay. */
  rms: number;
  /** Spectral centroid (brightness) 0..1. */
  centroid: number;
  /** Spectral flux (change/busyness) 0..1. */
  flux: number;
  /** Zero-crossing rate 0..1. */
  zcr: number;
  /** True only on the frame an onset/beat is detected. */
  beat: boolean;
  /** Rolling BPM estimate (60..180 typically). */
  bpm: number;
  /** Position within the current beat, 0..1. */
  beatPhase: number;
  /** Audio clock seconds since source start. */
  t: number;
}

export function createEmptyFrame(): AudioFrame {
  return {
    bands: new Float32Array(BAND_COUNT),
    rms: 0,
    centroid: 0,
    flux: 0,
    zcr: 0,
    beat: false,
    bpm: 0,
    beatPhase: 0,
    t: 0,
  };
}

/**
 * Smoothed art-direction inputs. Built from AudioFrame and consumed by scenes
 * + post-processing to drive palette, motion, and camera behavior.
 */
export interface MoodVector {
  /** rms + bass weight, smoothed. */
  energy: number;
  /** Spectral centroid, smoothed. */
  brightness: number;
  /** Spectral flux, smoothed. */
  busyness: number;
  /** Rolling variance of energy — proxy for dynamics. */
  dynamics: number;
}

/**
 * Pluggable audio capture source. Concrete impls land in Phase 1+:
 *  - LocalFileAudioSource (Phase 1)
 *  - DisplayMediaAudioSource (Phase 2)
 *  - MicAudioSource (Phase 2)
 */
export interface AudioSource {
  /** Stable id, e.g. "file", "display", "mic". */
  readonly id: string;
  /** Human label for UI. */
  readonly label: string;
  /** Connect to the AudioContext destination chain and start producing samples. */
  start(ctx: AudioContext): Promise<AudioNode>;
  /** Best-effort transport position in seconds, if the source has one. */
  position(): number | null;
  /** Tear down: disconnect nodes, stop streams. */
  stop(): void;
}
