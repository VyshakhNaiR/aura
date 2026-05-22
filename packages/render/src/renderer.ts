import * as THREE from "three";
import type { AudioFrame, MoodVector } from "@aura/core";
import type { Scene } from "./scene.js";

const MAX_DPR = 1.75;

/**
 * Phase 0 renderer: owns the WebGL context, the RAF loop, resize handling,
 * and an optional active Scene. Scenes plug in via setScene().
 *
 * No per-frame allocation: dt/now are stack locals, no object literals
 * pass through update().
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: THREE.WebGLRenderer;
  private clearScene: THREE.Scene;
  private clearCamera: THREE.OrthographicCamera;
  private currentScene: Scene | null = null;
  private rafId = 0;
  private running = false;
  private lastFrameNs = 0;
  private width = 0;
  private height = 0;
  private resizeObserver: ResizeObserver | null = null;

  /** Set by host on each frame before update is called. */
  frame: AudioFrame | null = null;
  mood: MoodVector | null = null;

  /**
   * Normalized pointer coords in [-1..+1] (origin centre, y-up). Smoothed
   * toward the raw pointer per frame so movement feels organic in scenes.
   */
  readonly mouse = new THREE.Vector2(0, 0);
  private readonly mouseTarget = new THREE.Vector2(0, 0);
  private mouseListenerTarget: HTMLElement | null = null;
  private mouseHandler: ((e: PointerEvent) => void) | null = null;

  /** Called every RAF with (nowMs, dtMs). Host hooks perf-meter / extractor here. */
  onTick: ((now: number, dt: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });
    this.gl.setClearColor(0x05060a, 1);
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    // Cinematic baseline: scenes output in linear HDR-ish space, three
    // tone-maps to sRGB. UnrealBloom and the shader scenes rely on this.
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;

    this.clearScene = new THREE.Scene();
    this.clearCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.handleResize = this.handleResize.bind(this);
    this.loop = this.loop.bind(this);
  }

  attachResize(target: HTMLElement = this.canvas.parentElement ?? document.body): void {
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(target);
    this.handleResize();
  }

  attachMouse(target: HTMLElement = this.canvas.parentElement ?? document.body): void {
    this.detachMouse();
    const handler = (e: PointerEvent) => {
      const rect = target.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      this.mouseTarget.set(nx, ny);
    };
    target.addEventListener("pointermove", handler);
    this.mouseListenerTarget = target;
    this.mouseHandler = handler;
  }

  private detachMouse(): void {
    if (this.mouseListenerTarget && this.mouseHandler) {
      this.mouseListenerTarget.removeEventListener(
        "pointermove",
        this.mouseHandler,
      );
    }
    this.mouseListenerTarget = null;
    this.mouseHandler = null;
  }

  setScene(scene: Scene | null): void {
    if (this.currentScene) this.currentScene.dispose();
    this.currentScene = scene;
    if (scene && this.width > 0) {
      scene.init({
        renderer: this.gl,
        width: this.width,
        height: this.height,
        pixelRatio: this.gl.getPixelRatio(),
      });
      scene.resize(this.width, this.height);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameNs = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.detachMouse();
    this.currentScene?.dispose();
    this.gl.dispose();
  }

  getGpuInfo(): string {
    const ext = this.gl.getContext().getExtension("WEBGL_debug_renderer_info");
    if (!ext) return "WebGL";
    const renderer = this.gl.getContext().getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
    return renderer.length > 40 ? renderer.slice(0, 37) + "…" : renderer;
  }

  private handleResize(): void {
    const parent = this.canvas.parentElement ?? document.body;
    const w = parent.clientWidth || window.innerWidth;
    const h = parent.clientHeight || window.innerHeight;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.gl.setSize(w, h, false);
    this.currentScene?.resize(w, h);
  }

  private loop(now: number): void {
    if (!this.running) return;
    const dt = now - this.lastFrameNs;
    this.lastFrameNs = now;

    // Ease the visible mouse toward the raw pointer (tracking lag = smoother
    // parallax than dead-snapping every frame).
    const lerp = Math.min(1, dt / 90);
    this.mouse.x += (this.mouseTarget.x - this.mouse.x) * lerp;
    this.mouse.y += (this.mouseTarget.y - this.mouse.y) * lerp;

    this.onTick?.(now, dt);

    if (this.currentScene && this.frame && this.mood) {
      this.currentScene.update(this.frame, this.mood, dt);
    } else {
      // Phase 0: no scene yet — just clear to background so the canvas
      // proves the loop is running.
      this.gl.render(this.clearScene, this.clearCamera);
    }

    this.rafId = requestAnimationFrame(this.loop);
  }
}
