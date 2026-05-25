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

// Divergence-free 2D velocity field. We sample a scalar potential and
// take a finite-difference gradient rotated 90° — gives organic, fluid
// flow without sources or sinks. The result is what makes the scene
// "ink in water" / aurora curtains, not "rotating kaleidoscope".
vec2 curlFlow(vec2 p, float t) {
  const float e = 0.085;
  vec2 q = p + vec2(t * 0.13, t * -0.07);
  float n1 = noise2(q + vec2(0.0, e));
  float n2 = noise2(q - vec2(0.0, e));
  float n3 = noise2(q + vec2(e, 0.0));
  float n4 = noise2(q - vec2(e, 0.0));
  return vec2((n1 - n2), -(n3 - n4)) / (2.0 * e);
}

// Two-color mood gradient. Three "stops" — shadow, mid, highlight —
// blended cool→warm by energy. No more 3-palette switching: just a
// coherent ramp like a graded photograph.
vec3 moodGradient(float t, float energy) {
  vec3 shadowCool = vec3(0.025, 0.045, 0.110);
  vec3 midCool    = vec3(0.110, 0.250, 0.490);
  vec3 highCool   = vec3(0.620, 0.820, 0.980);

  vec3 shadowWarm = vec3(0.090, 0.020, 0.080);
  vec3 midWarm    = vec3(0.480, 0.120, 0.270);
  vec3 highWarm   = vec3(1.000, 0.690, 0.480);

  vec3 shadow = mix(shadowCool, shadowWarm, energy);
  vec3 mid    = mix(midCool,    midWarm,    energy);
  vec3 high   = mix(highCool,   highWarm,   energy);

  // Two-stop interpolation through the three colors.
  t = clamp(t, 0.0, 1.0);
  return t < 0.5
    ? mix(shadow, mid,  smoothstep(0.0, 0.5, t))
    : mix(mid,    high, smoothstep(0.5, 1.0, t));
}

// Album palette as shadow/mid/high stops instead of a rotating wheel.
// Index 0 = shadow, 1 = mid, 2 = highlight. (4th color unused; the
// extractor returns up to 4 by popularity so the most-frequent three
// drive the gradient.)
vec3 albumGradient(float t) {
  vec3 shadow = vec3(u_albumColors[0], u_albumColors[1], u_albumColors[2]) * 0.35;
  vec3 mid    = vec3(u_albumColors[3], u_albumColors[4], u_albumColors[5]);
  vec3 high   = vec3(u_albumColors[6], u_albumColors[7], u_albumColors[8]) * 1.05;
  t = clamp(t, 0.0, 1.0);
  return t < 0.5
    ? mix(shadow, mid,  smoothstep(0.0, 0.5, t))
    : mix(mid,    high, smoothstep(0.5, 1.0, t));
}

// Sample one "stratum" of the aurora field at a given scale + time speed.
// scale  : noise frequency multiplier (smaller = larger features)
// timeMul: how fast this layer evolves (smaller = slower)
// warpAmp: amplitude of the curl-flow domain warp
// thresh : density threshold (smoothstep lower/upper) — controls how
//          much of the layer reads as "filled" vs "transparent"
float aurora(vec2 uv, float scale, float timeMul, float warpAmp, vec2 thresh) {
  vec2 p = uv * scale;
  // Domain warp via curl flow — gives the field its asymmetric drift.
  vec2 v = curlFlow(p, u_time * timeMul) * warpAmp;
  // Sample fbm at the advected position; that's the density.
  float d = fbm(p + v);
  d = d * 0.5 + 0.5;
  return smoothstep(thresh.x, thresh.y, d);
}

void main() {
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 uv0 = (vUv - 0.5) * aspect;

  // Mouse parallax — gentler, asymmetric (more on X than Y).
  uv0 -= u_mouse * vec2(0.09, 0.06);

  // Slow always-on drift current so the field is alive even without audio.
  uv0 += vec2(
    sin(u_time * 0.06) + 0.55 * sin(u_time * 0.011),
    cos(u_time * 0.043) + 0.45 * sin(u_time * 0.018)
  ) * 0.035;

  // Beat zoom kick — restrained, intensity-scaled.
  float kickZoom = 1.0 - u_beatKick * 0.04 * u_intensity;
  uv0 *= kickZoom;

  float r0 = length(uv0);
  float bass   = u_bands[1];
  float treble = u_bands[5];

  // ----- THREE DEPTH STRATA -----
  // Back: large, very slow, soft — establishes background tone.
  // Mid : the headline layer; primary signal, medium scale, beat-aware.
  // Front: smaller features, sharper edges, more reactive — "wisps".
  //
  // Each stratum is independently warped so they appear to drift at
  // different rates → parallax depth without an actual 3D camera.
  float dBack = aurora(uv0, 0.55, 0.045, 0.45 + u_brightness * 0.3,
                       vec2(0.30, 0.78));
  float dMid  = aurora(uv0, 1.25, 0.085 + u_dynamics * 0.05,
                       0.55 + treble * 0.40 + bass * 0.20,
                       vec2(0.42, 0.80));
  float dFront = aurora(uv0, 2.40, 0.13 + u_busyness * 0.06,
                        0.65 + treble * 0.55,
                        vec2(0.55, 0.82));

  // ----- COLOR — coherent gradient, mood-driven warmth -----
  float warmth = clamp(u_energy * 0.75 + u_dynamics * 0.4, 0.0, 1.0);

  // Each stratum takes a different position in the gradient. The back
  // layer biases toward shadows (deep tones), front toward highlights.
  vec3 cBack  = moodGradient(dBack * 0.55 + 0.05 + u_centroid * 0.10, warmth);
  vec3 cMid   = moodGradient(dMid  * 0.70 + 0.15, warmth);
  vec3 cFront = moodGradient(dFront * 0.85 + 0.20, warmth);

  // If we have an album-art palette, override the gradient with it
  // (eased in by u_albumStrength).
  if (u_albumStrength > 0.0) {
    cBack  = mix(cBack,  albumGradient(dBack  * 0.55 + 0.05), u_albumStrength);
    cMid   = mix(cMid,   albumGradient(dMid   * 0.70 + 0.15), u_albumStrength);
    cFront = mix(cFront, albumGradient(dFront * 0.85 + 0.20), u_albumStrength);
  }

  // Composite back→front. Each layer is a soft additive contribution
  // weighted by its own density.
  vec3 col = cBack * dBack * 0.55
           + cMid  * dMid  * 0.85
           + cFront * dFront * 0.95;

  // RMS pushes overall luminance gently. Capped so loud peaks don't blast.
  col *= 0.70 + u_rms * 0.55;

  // Specular highlights only on the front layer's brightest crests —
  // gives "wet ink" / "silk" surface feel. Intensity-gated.
  col += vec3(0.55, 0.60, 0.90) * pow(dFront, 6.0)
       * (0.10 + treble * 0.55) * (0.45 + u_intensity * 0.85);

  // ----- BEAT RINGS — palette-coherent, no garish magenta anymore -----
  float ringSum = 0.0;
  for (int i = 0; i < 4; i++) {
    float age = u_ringAges[i];
    float radR = age * 0.85;
    float width = 0.06 + age * 0.07;
    ringSum += exp(-pow((r0 - radR) / width, 2.0)) * u_ringPulses[i];
  }
  vec3 ringTint = moodGradient(0.92, warmth);
  col += ringTint * ringSum * 0.55 * u_intensity;

  // ----- VIGNETTE — strong, oval, soft falloff — sells the depth -----
  float vigR = length(uv0 * vec2(0.92, 1.06));
  float vig = smoothstep(1.18, 0.18, vigR);
  col *= vig;

  // ----- DUST / GRAIN -----
  // Two scales of grain: micro-grain for film texture, plus a sparser
  // luminous dust at lower frequency that drifts with the scene.
  float grain = (hash22(vUv * u_resolution + u_time).x - 0.5) * 0.020;
  float dustSeed = hash22(floor(vUv * u_resolution / 3.0) + floor(u_time * 0.5)).x;
  float dust = step(0.998, dustSeed) * 0.12;
  col += grain;
  col += vec3(1.0, 0.95, 0.85) * dust;

  // ----- LGG CINEMATIC GRADE -----
  col = max(col, 0.0);
  vec3 lift  = vec3(-0.010, -0.004, 0.014);
  vec3 gammaCurve = vec3(0.96, 0.95, 0.90);
  vec3 gain  = vec3(1.04, 1.02, 0.98);
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
