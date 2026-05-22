import * as THREE from "three";
import { BAND_COUNT, type AudioFrame, type MoodVector } from "@aura/core";
import type { Scene, RenderContext } from "../scene.js";

/**
 * Phase-1 debug scene: one reactive bar per perceptual band, plus a
 * full-screen flash overlay that punches on every detected beat.
 *
 * Uses a 0..1 orthographic camera so layout math reads in unit space and
 * aspect-stretches with the canvas (fine for a debug view).
 *
 * No per-frame allocation: meshes + materials + a scratch Color are all
 * pre-created in the constructor, only their properties mutate inside update().
 */
export class BarsScene implements Scene {
  readonly id = "bars-debug";

  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer | null = null;

  private readonly bars: THREE.Mesh[] = [];
  private readonly barMats: THREE.MeshBasicMaterial[] = [];
  private readonly flash: THREE.Mesh;
  private readonly flashMat: THREE.MeshBasicMaterial;
  private flashOpacity = 0;

  private readonly bg: THREE.Mesh;
  private readonly bgMat: THREE.MeshBasicMaterial;

  private readonly scratchColor = new THREE.Color();

  constructor() {
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);

    // Subtle gradient background via a single tinted quad — mood-reactive.
    this.bgMat = new THREE.MeshBasicMaterial({ color: 0x05060a });
    this.bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.bgMat);
    this.bg.position.set(0.5, 0.5, -0.5);
    this.scene.add(this.bg);

    // 7 reactive bars.
    for (let i = 0; i < BAND_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x6cf0c2 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      // Anchor bars to the bottom so .scale.y grows upward from there.
      mesh.geometry.translate(0, 0.5, 0);
      this.bars.push(mesh);
      this.barMats.push(mat);
      this.scene.add(mesh);
    }

    // Full-screen beat flash overlay.
    this.flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthTest: false,
    });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.flashMat);
    this.flash.position.set(0.5, 0.5, 0.5);
    this.scene.add(this.flash);
  }

  init(ctx: RenderContext): void {
    this.renderer = ctx.renderer;
    this.layout();
  }

  resize(_w: number, _h: number): void {
    this.layout();
  }

  private layout(): void {
    const sideMargin = 0.04;
    const bottomMargin = 0.06;
    const usable = 1 - sideMargin * 2;
    const slot = usable / BAND_COUNT;
    const barW = slot * 0.78;

    for (let i = 0; i < BAND_COUNT; i++) {
      const mesh = this.bars[i]!;
      mesh.position.x = sideMargin + slot * (i + 0.5);
      mesh.position.y = bottomMargin;
      mesh.scale.x = barW;
      mesh.scale.y = 0.002; // tiny seed height
    }
  }

  update(frame: AudioFrame, mood: MoodVector, dt: number): void {
    if (!this.renderer) return;

    // Bars
    for (let i = 0; i < BAND_COUNT; i++) {
      const v = frame.bands[i]!;
      // Soft gamma to make the response feel musical, not linear.
      const h = Math.pow(v, 0.7);
      const mesh = this.bars[i]!;
      mesh.scale.y = 0.001 + h * 0.78;

      // Palette walks from warm (lows) to cool (highs); mood brightness
      // nudges the whole hue; energy lifts saturation; band level lifts L.
      const hue = wrap01(0.62 - i * 0.05 + mood.brightness * 0.08);
      const sat = 0.45 + mood.energy * 0.45;
      const lit = 0.32 + h * 0.45;
      this.scratchColor.setHSL(hue, sat, lit);
      this.barMats[i]!.color.copy(this.scratchColor);
    }

    // Background: very dark, faintly warmed by energy
    const bgL = 0.018 + mood.energy * 0.04;
    this.bgMat.color.setHSL(0.6 + mood.brightness * 0.12, 0.4, bgL);

    // Beat flash: instant punch, ~250ms exponential decay
    if (frame.beat) this.flashOpacity = 0.55;
    // dt is in ms; tune decay so half-life ≈ 90ms
    const decay = Math.exp(-dt / 90);
    this.flashOpacity *= decay;
    if (this.flashOpacity < 0.002) this.flashOpacity = 0;
    this.flashMat.opacity = this.flashOpacity;

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (let i = 0; i < this.bars.length; i++) {
      this.bars[i]!.geometry.dispose();
      this.barMats[i]!.dispose();
    }
    this.flash.geometry.dispose();
    this.flashMat.dispose();
    this.bg.geometry.dispose();
    this.bgMat.dispose();
    this.bars.length = 0;
    this.barMats.length = 0;
  }
}

function wrap01(x: number): number {
  const m = x - Math.floor(x);
  return m < 0 ? m + 1 : m;
}
