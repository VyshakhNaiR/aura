# AURA

Real-time cinematic music visualizer for the browser. Works with **any** audio source — Spotify, YouTube Music, Apple Music web, SoundCloud, local files — by capturing tab/system audio and analyzing the actual waveform. No reliance on streaming-platform APIs for analysis.

## Quick start

### 1 · Install prerequisites (once, on your PC)

You need **Node.js 20+** and **pnpm**.

**Windows / macOS / Linux:**

1. Install Node.js 20 or newer from <https://nodejs.org> (pick the LTS installer).
2. Enable pnpm via corepack (ships with Node ≥ 16.13):

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

Verify:
```bash
node --version    # v20.x or v22.x
pnpm --version    # 9.x or 11.x
```

> If `corepack enable` complains about permissions on Linux, install with npm instead:
> `npm install -g pnpm` (may need `sudo` or a user-prefix — see Troubleshooting below).

### 2 · Run AURA

From the extracted `aura/` folder:

```bash
pnpm install     # first time only — downloads three.js, react, vite, etc.
pnpm dev
```

You should see Vite print:
```
  VITE v5.4.x  ready in ~400 ms
  ➜  Local:   http://localhost:5173/
```

Open <http://localhost:5173/> in **Chrome, Edge, Brave, or Arc** (tab audio capture needs Chromium; Firefox/Safari won't capture tab audio reliably).

### 3 · Visualize something

Three ways to feed audio in:

| Button | What it does |
|---|---|
| **◉ Capture from a tab** | Pick any browser tab playing music (Spotify Web, YouTube Music, SoundCloud, Apple Music…). **Tick "Share tab audio"** in the picker. Works for every service. |
| **Choose an audio file** | Local MP3 / WAV / FLAC / M4A / etc. Drag-and-drop anywhere also works. |
| **Demo track** | A built-in 120 BPM synth pattern, no file or stream needed — useful to verify everything works. |

Press **1** for the cinematic nebula scene, **2** for the debug bars scene.

### 4 · Optional: connect Spotify (track titles + album-art-driven palette)

Spotify's audio-analysis endpoints were killed in late 2024, so AURA never reads beats from Spotify — it derives everything from the captured waveform. We *do* still use the Spotify Web API for **title / artist / album art**.

One-time setup (~2 minutes):

1. Open <https://developer.spotify.com/dashboard> and sign in (free).
2. Click **Create app**. Name and description can be anything.
3. **Redirect URI** must be exactly `http://localhost:5173/` (note the trailing slash — copy it from AURA's setup modal to be safe).
4. Under "Which API/SDKs are you planning to use?" tick **Web API**.
5. Save and copy the **Client ID** from the app's settings page.

Then in AURA:
- Click **Connect Spotify (now-playing)**
- Paste the Client ID
- Authorize → you'll come back logged in
- Open Spotify Web Player, play a track → AURA shows the title/artist/art and the kaleidoscope shifts to the **colors of that album's cover**

When you change songs the palette eases to the new one in ~700ms.

## What's implemented

| Phase | What works | Status |
|---|---|---|
| 0 | pnpm monorepo, full-screen WebGL canvas, perf meter | ✅ |
| 1 | LocalFileAudioSource, FeatureExtractor (FFT, 7 bands, RMS, centroid, flux, ZCR), onset detection (energy-flux + adaptive threshold + refractory), BPM tracker (IOI histogram folded into 60–180 BPM), MoodAnalyzer, debug BarsScene | ✅ |
| 2 | DisplayMediaAudioSource (tab capture), capability detection | ✅ |
| 3 | NebulaScene: 6-way kaleidoscope, multi-octave domain-warped fbm, 3-palette mood blend, multi-layer composite, mouse parallax, beat-driven camera kick + radial shockwave + multi-slot pulse rings, sparkles, iridescent rim. EffectComposer: AfterimagePass (motion trails) + UnrealBloom + custom ChromaticAberration that spikes on beats + ACES tone-mapping + cinematic LGG color grade | ✅ |
| 4 | SpotifyNowPlayingProvider (OAuth PKCE, /me/player/currently-playing polling, token refresh). Album-art palette extraction → fed into NebulaScene as uniforms | ✅ partial · lyrics still pending |
| 5 | Scene picker UI (1/2 hotkeys); full settings panel still pending | ⏳ |
| 6 | Hosting + multi-user rooms | ⏳ |

## Stack

pnpm workspaces · Vite · React 18 · TypeScript 5.x (strict) · three.js 0.169 · WebGL2

## Project layout

```
aura/
├── packages/
│   ├── core/       framework-agnostic engine: AudioContext, FFT, beat/BPM,
│   │               mood vector, audio sources. Emits a typed AudioFrame
│   │               per RAF tick. No DOM / render dependency.
│   ├── render/     WebGL scenes + post-FX (three.js). Renderer owns the
│   │               canvas/RAF loop. Scenes are swappable.
│   ├── lyrics/     LRCLIB client + LRC parser + sync clock (stubs only)
│   └── metadata/   Spotify (PKCE) + MediaSession (stub) + album-palette
│                   extractor. Normalized NowPlaying interface.
└── apps/
    └── web/        the React app
```

## Controls

| Key | Action |
|---|---|
| **1** | Nebula scene (cinematic) |
| **2** | Bars scene (debug — useful to verify beat detection) |
| **Mouse** | Move it around — the kaleidoscope centre drifts toward the cursor |

HUD (top-right): `fps · ms · gpu · bpm <confidence%>` + a pink dot that pulses on every detected beat.

## Performance

The nebula scene uses a 5-pass composer (RenderPass → AfterimagePass → UnrealBloom → ChromaticAberration → OutputPass) with multi-octave fbm in the fragment shader. On a modern integrated GPU it runs comfortably at 60 fps at 1080p; on older hardware you may see 30–45 fps. If frame time stays above ~25ms switch to the bars scene (press `2`) to verify beat detection is healthy, then file an issue.

## Troubleshooting

**`pnpm: command not found` after `corepack enable`** — On some Linux distros the symlink target is read-only without sudo. Workaround:
```bash
mkdir -p ~/.local/share/npm-global
npm config set prefix ~/.local/share/npm-global
npm install -g pnpm
echo 'export PATH="$HOME/.local/share/npm-global/bin:$PATH"' >> ~/.zshrc  # or ~/.bashrc
```

**"No audio captured" when picking a tab** — In Chrome's share dialog you have to **tick "Share tab audio"** at the bottom-left. Without that, the captured stream has no audio tracks.

**Spotify "INVALID_CLIENT" error** — The redirect URI on Spotify's app page must match *exactly* what's in AURA's setup modal, including the trailing slash. Paste from the modal.

**Album art not loading the palette** — Spotify serves art with permissive CORS, but if your browser blocks it, the procedural mood palette stays active. Check DevTools console.

**Tab capture only works in Chromium browsers** — Firefox + Safari can capture screen but not tab audio. Use Chrome / Edge / Brave / Arc.

## What this project is built on

Scaffolded from a Claude Code build prompt and four matching Claude Code Skills (`webaudio-analysis`, `music-platform-apis`, `lrclib-lyrics`, `webgl-visual-scenes`) that encode the non-obvious knowledge for each subsystem — Web Audio FFT/beat detection, post-2024 streaming-platform API reality, LRCLIB sync clocks, WebGL scene art-direction. Those skills auto-attach inside Claude Code when you work on AURA code.

## License

MIT — see `LICENSE`.
