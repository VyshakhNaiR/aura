import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { AfterimagePass } from "three/examples/jsm/postprocessing/AfterimagePass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import { BAND_COUNT, type AudioFrame, type MoodVector } from "@aura/core";
import type { Scene, RenderContext } from "../scene.js";
import type { Renderer } from "../renderer.js";

const RING_SLOTS = 4;

/**
 * Cinematic shader scene with multi-layer composite, mouse parallax,
 * beat-driven camera kick + shockwave, and chromatic aberration that
 * spikes on every detected beat.
 *
 * Render pipeline:
 *   1. Fragment shader on a fullscreen quad → linear HDR-ish output.
 *   2. UnrealBloomPass for the glow.
 *   3. ChromaticAberrationPass — RGB split that spikes on beats.
 *   4. OutputPass → ACES tone-map → sRGB.
 */
export class NebulaScene implements Scene {
  readonly id = "nebula";

  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly quad: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  private renderer: THREE.WebGLRenderer | null = null;
  private hostRenderer: Renderer | null = null;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private caPass: ShaderPass | null = null;
  private afterimagePass: AfterimagePass | null = null;

  private elapsed = 0;

  // Beat-driven smoothed impulses
  private beatKick = 0; // 1 → 0 over ~250ms, drives zoom punch + shockwave
  private beatChroma = 0; // 1 → 0 over ~300ms, drives RGB split spike

  // Album-palette easing
  private albumStrengthTarget = 0;
  private albumStrength = 0;

  // Master intensity for flash-driven events. 0 = ambient (calm office),
  // 1 = previous "cinema" defaults, 1.5 = club-mode. Default 0.5.
  // Adjust live via setIntensity().
  private intensity = 0.5;

  // Ring pool (radial pulses on every beat)
  private nextRingSlot = 0;
  private readonly ringAges: Float32Array;
  private readonly ringPulses: Float32Array;

  /**
   * Called by the host once per scene mount with a back-reference to the
   * Renderer so the scene can read .mouse without us changing the Scene
   * interface signature.
   */
  setHostRenderer(r: Renderer): void {
    this.hostRenderer = r;
  }

  /** Master flash-event intensity (clamped 0..1.5). */
  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1.5, v));
  }
  getIntensity(): number {
    return this.intensity;
  }

  /**
   * Feed an album-art-derived palette (up to 4 RGB colors). Pass an empty
   * array (or no call) to disable and fall back to the mood-driven palette.
   * Colors are eased into smoothly inside the shader via u_albumStrength.
   */
  setAlbumPalette(colors: Array<{ r: number; g: number; b: number }>): void {
    const buf = this.material.uniforms["u_albumColors"]!.value as Float32Array;
    const n = Math.min(4, colors.length);
    for (let i = 0; i < 4; i++) {
      const c = i < n ? colors[i]! : colors[n - 1] ?? { r: 0, g: 0, b: 0 };
      buf[i * 3 + 0] = c.r;
      buf[i * 3 + 1] = c.g;
      buf[i * 3 + 2] = c.b;
    }
    // Target strength — eased toward in update() so transitions don't snap.
    this.albumStrengthTarget = n > 0 ? 0.55 : 0;
  }

  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.ringAges = new Float32Array(RING_SLOTS);
    this.ringPulses = new Float32Array(RING_SLOTS);
    for (let i = 0; i < RING_SLOTS; i++) this.ringAges[i] = 99;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        u_time: { value: 0 },
        u_resolution: { value: new THREE.Vector2(1, 1) },
        u_mouse: { value: new THREE.Vector2(0, 0) },

        u_bands: { value: new Float32Array(BAND_COUNT) },
        u_rms: { value: 0 },
        u_centroid: { value: 0 },
        u_flux: { value: 0 },
        u_bpm: { value: 0 },
        u_beatPhase: { value: 0 },

        u_energy: { value: 0 },
        u_brightness: { value: 0 },
        u_busyness: { value: 0 },
        u_dynamics: { value: 0 },

        u_beatKick: { value: 0 },
        u_ringAges: { value: this.ringAges },
        u_ringPulses: { value: this.ringPulses },

        // Album-art palette: 4 RGB colors in a Float32Array of length 12.
        // Fallback to zeroed (u_albumStrength=0 disables blending).
        u_albumColors: { value: new Float32Array(12) },
        u_albumStrength: { value: 0 },

        // Master intensity multiplier for flash-driven events (sparkles,
        // rings, specular highlights, beat color punches).
        u_intensity: { value: 0.5 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene.add(this.quad);
  }

  init(ctx: RenderContext): void {
    this.renderer = ctx.renderer;
    const composer = new EffectComposer(ctx.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));

    // Longer trails for a calmer, more "fluid" feel — each frame keeps
    // 94% of the previous, so motion smears smoothly rather than flashing.
    const afterimage = new AfterimagePass(0.94);
    this.afterimagePass = afterimage;
    composer.addPass(afterimage);

    // Office-friendly bloom defaults: softer halo, higher threshold so
    // only genuinely bright pixels glow rather than every midtone. The
    // bloomPass.strength is later remapped by `intensity` each frame.
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(ctx.width, ctx.height),
      0.55,
      0.85,
      0.62,
    );
    this.bloomPass = bloom;
    composer.addPass(bloom);

    this.caPass = new ShaderPass(CHROMATIC_ABERRATION);
    composer.addPass(this.caPass);

    composer.addPass(new OutputPass());

    this.composer = composer;
    this.resize(ctx.width, ctx.height);
  }

  resize(w: number, h: number): void {
    (this.material.uniforms["u_resolution"]!.value as THREE.Vector2).set(w, h);
    if (this.composer) this.composer.setSize(w, h);
    if (this.bloomPass) this.bloomPass.resolution.set(w, h);
    if (this.caPass) {
      (this.caPass.uniforms["u_resolution"]!.value as THREE.Vector2).set(w, h);
    }
  }

  update(frame: AudioFrame, mood: MoodVector, dt: number): void {
    if (!this.renderer || !this.composer) return;

    const dtSec = dt / 1000;
    this.elapsed += dtSec;

    // ----- beat-driven impulses -----
    if (frame.beat) {
      this.beatKick = 1;
      this.beatChroma = 1;
      // Push a new ring
      this.ringAges[this.nextRingSlot] = 0;
      this.ringPulses[this.nextRingSlot] = 1;
      this.nextRingSlot = (this.nextRingSlot + 1) % RING_SLOTS;
    }
    // Exponential decay: half-life ~85ms for kick, ~120ms for chroma
    this.beatKick *= Math.exp(-dtSec / 0.12);
    this.beatChroma *= Math.exp(-dtSec / 0.17);

    for (let i = 0; i < RING_SLOTS; i++) {
      this.ringAges[i]! += dtSec;
      this.ringPulses[i]! *= Math.exp(-dtSec / 0.42);
    }

    // ----- uniform updates -----
    const u = this.material.uniforms;
    u["u_time"]!.value = this.elapsed;

    (u["u_bands"]!.value as Float32Array).set(frame.bands);
    u["u_rms"]!.value = frame.rms;
    u["u_centroid"]!.value = frame.centroid;
    u["u_flux"]!.value = frame.flux;
    u["u_bpm"]!.value = frame.bpm;
    u["u_beatPhase"]!.value = frame.beatPhase;

    u["u_energy"]!.value = mood.energy;
    u["u_brightness"]!.value = mood.brightness;
    u["u_busyness"]!.value = mood.busyness;
    u["u_dynamics"]!.value = mood.dynamics;

    u["u_beatKick"]!.value = this.beatKick;
    u["u_intensity"]!.value = this.intensity;

    // Ease album-palette strength toward target so swaps don't snap.
    this.albumStrength += (this.albumStrengthTarget - this.albumStrength) * Math.min(1, dtSec * 1.4);
    u["u_albumStrength"]!.value = this.albumStrength;

    // Live-remap post-FX intensities so the slider has real teeth.
    if (this.bloomPass) {
      // 0.32 baseline ambient glow, +0.6 per intensity unit.
      this.bloomPass.strength = 0.32 + this.intensity * 0.6;
    }

    // Mouse from renderer (already smoothed there).
    if (this.hostRenderer) {
      const m = this.hostRenderer.mouse;
      (u["u_mouse"]!.value as THREE.Vector2).set(m.x, m.y);
    }

    // Chromatic aberration: baseline very subtle; beat spike scaled by
    // intensity so calm mode keeps the RGB split barely-there.
    if (this.caPass) {
      const caStrength =
        0.001 + this.beatChroma * 0.008 * this.intensity + mood.busyness * 0.002;
      this.caPass.uniforms["u_strength"]!.value = caStrength;
    }

    this.composer.render(dtSec);
  }

  dispose(): void {
    this.quad.geometry.dispose();
    this.material.dispose();
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
    this.caPass = null;
    this.afterimagePass = null;
    this.renderer = null;
    this.hostRenderer = null;
  }
}

// ---------------------------------------------------------------------------
// Vertex
// ---------------------------------------------------------------------------

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Main fragment — multi-layer composite
// ---------------------------------------------------------------------------

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;

uniform float u_bands[7];
uniform float u_rms;
uniform float u_centroid;
uniform float u_flux;
uniform float u_bpm;
uniform float u_beatPhase;

uniform float u_energy;
uniform float u_brightness;
uniform float u_busyness;
uniform float u_dynamics;

uniform float u_beatKick;
uniform float u_ringAges[4];
uniform float u_ringPulses[4];

// Album-art derived palette — 4 RGB colors packed as 12 floats (R,G,B × 4).
// u_albumStrength=0 disables blending.
uniform float u_albumColors[12];
uniform float u_albumStrength;

// Master flash intensity. 0 = ambient (calm), 1 = cinema, 1.5 = club.
uniform float u_intensity;

#define PI 3.14159265359

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = dot(hash22(i + vec2(0.0, 0.0)) * 2.0 - 1.0, f - vec2(0.0, 0.0));
  float b = dot(hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise2(p);
    p = p * 2.02;
    a *= 0.5;
  }
  return v;
}

vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(6.28318 * (c * t + d));
}

// Three mood palettes — blended by (energy, brightness) → 2D weights.
vec3 paletteCool(float t) {
  return palette(t,
    vec3(0.18, 0.20, 0.45),
    vec3(0.45, 0.55, 0.65),
    vec3(1.0,  1.0,  1.0),
    vec3(0.00, 0.18, 0.35));
}
vec3 paletteWarm(float t) {
  return palette(t,
    vec3(0.65, 0.40, 0.45),
    vec3(0.50, 0.40, 0.35),
    vec3(1.0,  1.0,  1.0),
    vec3(0.00, 0.25, 0.50));
}
vec3 paletteIrid(float t) {
  return palette(t,
    vec3(0.55, 0.50, 0.55),
    vec3(0.55, 0.45, 0.55),
    vec3(1.0,  1.0,  0.5),
    vec3(0.80, 0.90, 0.30));
}

// Album-art palette sampler — 4 colors lerped in a wrap-around loop so
// any t produces a smooth color walk through whatever the current track
// is wearing on its cover.
vec3 samplePaletteAlbum(float t) {
  vec3 c0 = vec3(u_albumColors[0],  u_albumColors[1],  u_albumColors[2]);
  vec3 c1 = vec3(u_albumColors[3],  u_albumColors[4],  u_albumColors[5]);
  vec3 c2 = vec3(u_albumColors[6],  u_albumColors[7],  u_albumColors[8]);
  vec3 c3 = vec3(u_albumColors[9],  u_albumColors[10], u_albumColors[11]);
  float ft = fract(t) * 4.0;
  float seg = floor(ft);
  float k = fract(ft);
  k = k * k * (3.0 - 2.0 * k); // smoothstep ease
  vec3 a = c0; vec3 b = c1;
  if (seg < 0.5) { a = c0; b = c1; }
  else if (seg < 1.5) { a = c1; b = c2; }
  else if (seg < 2.5) { a = c2; b = c3; }
  else { a = c3; b = c0; }
  return mix(a, b, k);
}

void main() {
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 uv0 = (vUv - 0.5) * aspect;

  // Mouse parallax: drift the centre subtly toward the pointer.
  vec2 mouseDrift = u_mouse * vec2(0.10, 0.10);
  uv0 -= mouseDrift;

  // Slow ambient current — always-on gentle drift so the scene has
  // continuous motion even at low intensity. Two perpendicular slow sines
  // produce a soft "wind" that the whole image rides on.
  vec2 current = vec2(
    sin(u_time * 0.07) + 0.6 * sin(u_time * 0.013),
    cos(u_time * 0.05) + 0.5 * sin(u_time * 0.021)
  ) * 0.045;
  uv0 += current;

  // Beat camera kick: scaled by intensity so calm mode barely punches.
  float kickZoom = 1.0 - u_beatKick * 0.045 * u_intensity;
  uv0 *= kickZoom;

  // Radial shockwave on beat — distort uv along radial direction by a
  // travelling sine wave whose ridge expands outward as the kick fades.
  // Scaled by intensity so it's barely noticeable in calm mode.
  float r0 = length(uv0);
  float shockR = (1.0 - u_beatKick) * 0.9;
  float shockWidth = 0.08 + u_beatKick * 0.05;
  float shock = exp(-pow((r0 - shockR) / shockWidth, 2.0)) * u_beatKick * 0.05 * u_intensity;
  vec2 dirOut = (r0 > 0.0001) ? uv0 / r0 : vec2(0.0);
  uv0 += dirOut * shock;
  r0 = length(uv0);

  // -------- Layer 1: deep background nebula (slow, large scale, dark) --------
  vec2 bgUv = uv0 * 0.55;
  float bgT = u_time * 0.03;
  vec2 bgWarp = vec2(fbm(bgUv + vec2(0.0, bgT)), fbm(bgUv + vec2(7.1, -bgT))) * 0.6;
  float bg = fbm(bgUv + bgWarp + vec2(0.0, bgT * 0.5));
  bg = bg * 0.5 + 0.5;
  vec3 bgCol = paletteCool(bg + u_centroid * 0.2) * 0.35;

  // -------- Layer 2: kaleidoscope mid (the headline pattern) --------
  vec2 uv = uv0;
  float ang = atan(uv.y, uv.x);
  float radius = length(uv);
  // Slower, more meditative rotation — busyness still adds drift but the
  // baseline is calmer so the scene feels like it's breathing, not spinning.
  float spin = u_time * 0.022 + u_busyness * 0.22;
  ang += spin;
  float N = 6.0;
  float sector = 2.0 * PI / N;
  ang = mod(ang, sector);
  ang = abs(ang - sector * 0.5);
  uv = vec2(cos(ang), sin(ang)) * radius;

  float bass = u_bands[1];
  float treble = u_bands[5];

  float zoom = 1.05 + sin(u_time * 0.045) * 0.14 + bass * 0.42;
  vec2 p = uv * zoom;
  float t2 = u_time * (0.045 + u_dynamics * 0.035);
  float warpAmt = 0.5 + u_brightness * 0.55 + treble * 0.5;
  vec2 q  = vec2(fbm(p + vec2(0.0, t2)), fbm(p + vec2(5.2, -t2))) * warpAmt;
  vec2 s  = vec2(fbm(p + q + vec2(1.7, -t2)), fbm(p + q + vec2(9.2, t2)))
            * (0.55 + u_busyness * 0.7);
  float f = fbm(p + s);
  f = f * 0.5 + 0.5;

  // 2D mood-weighted palette blend: cool ↔ warm by energy, with iridescent
  // accent rising with brightness.
  vec3 cool = paletteCool(f + u_centroid * 0.25 + u_time * 0.03);
  vec3 warm = paletteWarm(f * 1.2 + u_time * 0.05);
  vec3 irid = paletteIrid(f * 0.9 + u_time * 0.04);

  float warmth   = clamp(u_energy * 0.8 + u_dynamics * 0.45, 0.0, 1.0);
  float iridMix  = clamp(u_brightness * 0.6 + u_busyness * 0.25, 0.0, 1.0);

  vec3 mid = mix(cool, warm, warmth);
  mid = mix(mid, irid, iridMix * 0.45);

  // If we have an album-art palette, blend toward it. The album palette
  // walks with the pattern (uses f as the lookup) so the visual literally
  // takes on the colors of the album cover.
  if (u_albumStrength > 0.0) {
    vec3 albumCol = samplePaletteAlbum(f + u_time * 0.04);
    mid = mix(mid, albumCol, u_albumStrength);
  }

  // Calmer base multiplier: ambient floor stays consistent, RMS only
  // adds modest brightening. (Was 0.55 + rms * 1.6 — way too punchy.)
  mid *= 0.42 + u_rms * 0.75;
  // Specular highlights — dimmer + intensity-scaled so calm mode isn't blinding.
  mid += vec3(0.55, 0.50, 0.85) * pow(f, 8.0) * (0.18 + treble * 0.7) * (0.4 + u_intensity * 0.8);

  // -------- Layer 3: foreground sparkles (high-freq dots that twinkle) --------
  // Sparkles are the worst office-flashing offender — sharper pow curve
  // (fewer pixels light up) and capped by intensity.
  vec2 spUv = uv0 * 22.0;
  float spT = u_time * 0.6 + u_beatPhase * 6.28;
  float sp = fbm(spUv + vec2(spT * 0.2, -spT * 0.1));
  float sparkle = pow(max(0.0, sp), 18.0) * (0.18 + treble * 0.7 + u_beatKick * 0.25);
  vec3 sparkleCol = vec3(0.9, 0.78, 1.05) * sparkle * (0.3 + u_intensity * 0.9);

  // -------- Composite --------
  vec3 col = bgCol + mid + sparkleCol;

  // Iridescent angular rim — dimmer + intensity-aware so calm mode keeps
  // saturation but loses the spotlight effect.
  float rimMask = pow(f, 6.0);
  float rimAng = atan(uv0.y, uv0.x);
  vec3 rim = vec3(
    0.5 + 0.5 * sin(rimAng + u_time * 0.45),
    0.5 + 0.5 * sin(rimAng + u_time * 0.45 + 2.094),
    0.5 + 0.5 * sin(rimAng + u_time * 0.45 + 4.188)
  );
  col += rim * rimMask * (0.12 + u_brightness * 0.30) * (0.5 + u_intensity * 0.6);

  // Beat rings — pre-fold radial pulses. Halved brightness + intensity gate.
  float ringSum = 0.0;
  for (int i = 0; i < 4; i++) {
    float age = u_ringAges[i];
    float pulse = u_ringPulses[i];
    float radR = age * 0.9;
    float width = 0.05 + age * 0.07;
    float ring = exp(-pow((length(uv0) - radR) / width, 2.0));
    ringSum += ring * pulse;
  }
  col += vec3(1.0, 0.78, 1.35) * ringSum * 0.45 * u_intensity;

  // Vignette — stronger so edges stay dark and don't wash out other things
  // on your screen.
  float vig = smoothstep(1.15, 0.20, length(uv0));
  col *= vig;

  // Subtle film grain.
  float grain = (hash22(vUv * u_resolution + u_time).x - 0.5) * 0.018;
  col += grain;

  // Cinematic lift / gamma / gain color grade. Crushes shadows toward
  // a cool teal, warms midtones, lifts highlights into peach — the
  // "Hollywood blockbuster" curve, gently applied.
  col = max(col, 0.0);
  vec3 lift = vec3(-0.012, -0.005, 0.018);
  vec3 gammaCurve = vec3(0.95, 0.95, 0.88);
  vec3 gain = vec3(1.04, 1.02, 0.98);
  col = pow(col, gammaCurve);
  col = col * gain + lift;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Chromatic aberration ShaderPass — RGB split radial from centre, spikes
// on every beat for the "punch" effect.
// ---------------------------------------------------------------------------

const CHROMATIC_ABERRATION = {
  uniforms: {
    tDiffuse: { value: null },
    u_strength: { value: 0 },
    u_resolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float u_strength;
    uniform vec2 u_resolution;

    void main() {
      vec2 dir = vUv - 0.5;
      float dist = length(dir);
      // Strength grows toward the edges so the centre stays sharp.
      float k = u_strength * (0.4 + dist * 1.8);
      vec2 offset = (dist > 0.0001 ? dir / dist : vec2(0.0)) * k;

      float r = texture2D(tDiffuse, vUv + offset).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - offset).b;

      gl_FragColor = vec4(r, g, b, 1.0);
    }
  `,
};
