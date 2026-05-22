<div align="center">

# AURA

**A real-time, cinematic, beat-synced music visualizer that listens to the actual sound — so it works with everything.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![three.js](https://img.shields.io/badge/three.js-r169-000?logo=three.js&logoColor=white)](https://threejs.org/)
[![WebGL2](https://img.shields.io/badge/WebGL-2.0-990000?logo=webgl&logoColor=white)](https://www.khronos.org/webgl/)
[![Status](https://img.shields.io/badge/status-alpha-orange)](#status)

*Spotify · YouTube Music · Apple Music · SoundCloud · local files — anything that makes sound.*

</div>

---

## Why this exists

Most music visualizers either (a) draw a bar spectrum from a microphone, or (b) lean on Spotify's `audio-analysis` API for beats and tempo. On **November 27, 2024 Spotify deprecated** `audio-analysis`, `audio-features`, `recommendations`, and `related-artists` for every new app — the second path is closed for good. Most modern visualizers haven't caught up.

AURA goes the other way: **it never asks any service for analysis.** It captures the actual audio waveform from your browser tab, runs FFT + onset detection + BPM tracking in the browser, and renders a cinematic kaleidoscope driven by what it hears. That means it works **identically for every streaming service** at full audio quality, with no API key, no rate limit, no platform lock-in.

The bar is not "winamp." The bar is title-sequence design. AURA is built around a 6-way kaleidoscopic flow of domain-warped fractal noise, painted in palettes derived from the album cover of whatever's playing, post-processed through frame-feedback motion trails, bloom, chromatic aberration, and an ACES tone-map.

---

## What you get

| | |
|---|---|
| **Universal capture** | `getDisplayMedia` tab/system audio — point AURA at a Spotify Web tab, a YouTube Music tab, a SoundCloud tab, anything. Or drop in a local file. |
| **Live waveform analysis** | Two `AnalyserNode`s (a smoothed visual one, an onset-clean unsmoothed one). 7-band perceptual FFT, RMS, spectral centroid + flux, zero-crossing rate — emitted as a typed `AudioFrame` every RAF tick. |
| **Real beat detection** | Spectral-flux onset with rolling-mean + σ adaptive threshold and a 280 ms refractory window. IOI-histogram BPM tracker, folded into 60–180 BPM, low-passed across windows. Confidence reported. |
| **Mood-vector art direction** | A smoothed 4-axis mood vector — *energy × brightness × busyness × dynamics* — drives palette blends, motion intensity, and post-FX, not just amplitude. |
| **Album-art palettes** | When connected to Spotify, every track change downscales the album art to 24×24, bucket-quantizes the pixels into 4 dominant colors, and feeds them into the shader. The entire kaleidoscope eases into those colors over ~700 ms. |
| **Cinematic post-FX** | EffectComposer chain: AfterimagePass (frame-feedback motion trails) → UnrealBloomPass → custom ChromaticAberrationPass that spikes on every beat → ACES tone-map → LGG color grade. |
| **Interactive, smooth, abstract** | Move your mouse — the kaleidoscope centre eases toward the cursor. A slow ambient drift current keeps motion continuous even when no beats are firing. |
| **Office-mode intensity** | Master intensity from "ambient lava lamp" to "club" tuned live with `+` / `-` / `0` / `9` — calm by default so you can leave it running. |
| **Zero per-frame allocation** | Pre-allocated typed-array buffers mutated in place. One `AudioContext`, one RAF loop, no GC stutters at 60 fps. |
| **Strict TypeScript everywhere** | Five packages, all strict, all typecheck-clean, all under [tsconfig.base.json](tsconfig.base.json). |

---

## Quick start

```bash
git clone https://github.com/VyshakhNaiR/aura.git
cd aura
pnpm install
pnpm dev
```

Open **http://localhost:5173/** in Chrome / Edge / Brave / Arc — Firefox & Safari can't reliably capture tab audio. Click **Try a demo track** to see it move, or **◉ Capture from a tab** to point it at your music.

Need the toolchain? [Node 20+](https://nodejs.org), then `corepack enable && corepack prepare pnpm@latest --activate`.

---

## How it works

```
┌──────────────────┐     ┌───────────────────────┐     ┌──────────────────┐
│  AudioSource     │     │  FeatureExtractor     │     │  NebulaScene     │
│  · LocalFile     │     │  Visual analyser      │     │  shader:         │
│  · DisplayMedia  │ ──> │   fftSize=2048,       │ ──> │  kaleidoscope +  │
│    (tab capture) │     │   smoothing=0.78      │     │  fbm + warp +    │
│  · SynthDemo     │     │  Beat analyser        │     │  3-palette mood  │
│  · Microphone    │     │   fftSize=1024,       │     │  blend + sparkles│
│                  │     │   smoothing=0  ← key  │     │  + rings + ...   │
└──────────────────┘     └───────────────────────┘     └──────────────────┘
                                  │                              │
                                  ↓                              ↓
                         ┌──────────────────┐         ┌──────────────────┐
                         │ OnsetDetector    │         │ EffectComposer   │
                         │ (energy-flux +   │         │ Afterimage →     │
                         │  adaptive thresh)│         │ UnrealBloom →    │
                         │ → BpmTracker     │         │ ChromaticAberr → │
                         │ (IOI histogram)  │         │ OutputPass (ACES)│
                         └──────────────────┘         └──────────────────┘
                                  │                              │
                                  ↓                              ↓
                          AudioFrame (bands, rms,           Final frame
                          centroid, flux, zcr,              → canvas
                          beat, bpm, beatPhase)

                          MoodAnalyzer ──> MoodVector ──> palette / motion / FX

┌────────────────────────────┐                  ┌──────────────────────────┐
│ SpotifyNowPlayingProvider  │                  │ Album-palette extractor  │
│ OAuth PKCE                 │ → NowPlaying ──> │ image → 24×24 quantize → │ ──> uniform
│ /me/player/currently-      │   {title,artist, │ 4 dominant RGB colors    │     u_albumColors
│  playing polling (2.5 s)   │    art, ...}     │                          │
└────────────────────────────┘                  └──────────────────────────┘
```

**Two layers, kept independent on purpose:**

1. **Audio analysis** — *always* from the captured waveform. Platform-agnostic. Never depends on any service API.
2. **Now-playing metadata** — *optional* enhancement via Spotify Web API. If absent, AURA runs in pure-animation mode; never blocks the visuals on it.

This separation is the architectural answer to the November 2024 deprecation. AURA doesn't notice or care which platform you're listening to.

---

## Project layout

```
aura/
├── packages/
│   ├── core/       framework-agnostic engine — AudioContext, FFT,
│   │               beat/BPM, mood vector, audio sources. Emits a typed
│   │               AudioFrame per RAF tick. No DOM / render dependency.
│   ├── render/     three.js renderer + swappable scenes + post-FX.
│   │               NebulaScene + BarsScene (debug).
│   ├── lyrics/     LRCLIB types (full client coming in next phase).
│   └── metadata/   Spotify OAuth PKCE + now-playing polling.
│                   Album-art dominant-color extractor.
└── apps/
    └── web/        the React + Vite app.
```

---

## Spotify setup (optional, ~90 sec)

AURA reads Spotify's still-live `currently-playing` endpoint for title / artist / album art. Audio still comes from tab capture — Spotify can't and won't ship beats anymore.

1. Open [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → **Create app**.
2. **Redirect URI** must be exactly `http://localhost:5173/` (Spotify accepts plain `http://` only for `localhost` — that's why running on your own machine is the easy path).
3. Tick **Web API**, save, copy the **Client ID**.
4. In AURA, click **Connect Spotify (now-playing)** → paste the Client ID → **Connect → Spotify** → Agree.
5. Open Spotify Web Player or the desktop app, play a track.
6. In AURA: **◉ Capture from a tab** → pick the Spotify tab → **tick "Share tab audio"** in the picker.
7. Track title + artist + album art appear top-left. The kaleidoscope shifts to the album's colors.

---

## Controls

| Key | Action |
|---|---|
| **`1`** | Nebula scene (cinematic) |
| **`2`** | Bars scene (debug — useful to verify beat detection) |
| **`+`** / **`=`** | Intensity +0.1 |
| **`-`** | Intensity −0.1 |
| **`0`** | Snap to **ambient** (0.2) — calm, "lava lamp" feel |
| **`9`** | Snap to **cinema** (1.0) — full intensity |
| Mouse | Drifts the kaleidoscope centre toward the cursor |

HUD (top-right): `fps · ms · gpu · bpm <confidence%>` plus a pink dot that pulses on every detected beat.

---

## Tech

| Layer | Choice | Why |
|---|---|---|
| Workspace | **pnpm workspaces** | Fast install, strict deps, monorepo without overhead |
| Build | **Vite 5** | Sub-half-second dev start, ES-module workspace deps with no per-package build step |
| UI | **React 18** (strict mode) | Minimal — used only for the start screen + setup modals |
| Render | **three.js r169** + WebGL2 | Shader scenes + EffectComposer post-FX |
| Lang | **TypeScript 5.x strict** | `noUncheckedIndexedAccess`, exact typed-array generics |
| Audio | **Web Audio API** | Two `AnalyserNode`s; never `audio-analysis` |
| Auth | **OAuth Authorization Code + PKCE** | No client secret in the browser, no server required |

---

## Status

| Phase | Scope | Status |
|---|---|---|
| **0** | Skeleton: pnpm monorepo, blank WebGL canvas at 60 fps, perf meter | ✅ |
| **1** | LocalFileAudioSource + FeatureExtractor + onset/BPM + MoodAnalyzer + debug BarsScene | ✅ |
| **2** | DisplayMediaAudioSource (tab/system capture) with capability detection | ✅ |
| **3** | NebulaScene with all post-FX (Afterimage, Bloom, CA, ACES, LGG grade) | ✅ |
| **4** | SpotifyNowPlayingProvider (OAuth PKCE + polling) + album-art palette extraction wired into scene uniforms | ✅ |
| 5 | More scene variants, settings UI, palette presets | ⏳ |
| 6 | LRCLIB synced lyrics + cinematic kinetic-typography scene | ⏳ |
| 7 | Hosting + WebSocket rooms (broadcast `AudioFrame` features, not audio) | ⏳ |

---

## Performance

The Nebula scene is a 5-pass composer (RenderPass → AfterimagePass → UnrealBloom → ChromaticAberration → OutputPass) with 5-octave fbm in the fragment shader.

- **Modern dedicated GPU** at 1080p: comfortably above 60 fps.
- **Integrated GPU / laptop**: 45–60 fps. Press **`0`** for ambient mode (lower bloom + intensity) to claw back headroom.
- **Older hardware**: drop to the bars scene (`2`) to verify beat detection is healthy, or lower `MAX_DPR` in `packages/render/src/renderer.ts`.

The audio engine is allocation-free per frame; all per-feature kernels run on pre-allocated typed-array buffers. Onset + BPM tracking together cost well under 0.2 ms on a desktop CPU at the default fftSize.

---

## Troubleshooting

<details>
<summary><b>"No audio captured" when picking a tab</b></summary>

In Chrome's share dialog, **tick "Share tab audio"** at the bottom-left of the picker. Without that, the captured stream has no audio tracks. AURA detects this and surfaces an explicit error.
</details>

<details>
<summary><b>Spotify "INVALID_CLIENT" or redirect mismatch</b></summary>

The redirect URI on your Spotify app must match **exactly** what's in AURA's setup modal, including the trailing slash. Copy it directly from the modal to be safe.
</details>

<details>
<summary><b>Album art palette doesn't kick in</b></summary>

Spotify serves art with permissive CORS, but if your browser blocks it, the procedural mood palette stays active — AURA falls back silently. Check DevTools console.
</details>

<details>
<summary><b>Tab capture missing in Firefox / Safari</b></summary>

Firefox and Safari can capture screen but not reliably capture tab audio. Use Chrome / Edge / Brave / Arc — AURA capability-detects and tells you.
</details>

<details>
<summary><b><code>pnpm: command not found</code> on Linux after <code>corepack enable</code></b></summary>

Some distros prevent corepack from symlinking globally without sudo:
```bash
mkdir -p ~/.local/share/npm-global
npm config set prefix ~/.local/share/npm-global
npm install -g pnpm
echo 'export PATH="$HOME/.local/share/npm-global/bin:$PATH"' >> ~/.zshrc
```
</details>

---

## Credits

Scaffolded from a Claude Code build prompt and four matching Claude Code Skills — `webaudio-analysis`, `music-platform-apis`, `lrclib-lyrics`, `webgl-visual-scenes` — that encode the non-obvious knowledge for each subsystem (Web Audio FFT/beat detection, post-2024 streaming-platform API reality, LRCLIB sync clocks, WebGL scene art-direction). The skills auto-attach inside Claude Code when working on AURA code.

## License

MIT — see [`LICENSE`](LICENSE).
