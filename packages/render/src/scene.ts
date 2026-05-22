import type { AudioFrame, MoodVector } from "@aura/core";
import type * as THREE from "three";

/**
 * Per-renderer context handed to scenes on init().
 */
export interface RenderContext {
  renderer: THREE.WebGLRenderer;
  width: number;
  height: number;
  pixelRatio: number;
}

/**
 * A swappable visual scene. Phase 3+ ships 4–6 of these.
 * Scenes must not allocate inside update().
 */
export interface Scene {
  readonly id: string;
  init(ctx: RenderContext): void;
  update(frame: AudioFrame, mood: MoodVector, dt: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
