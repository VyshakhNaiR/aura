import { useEffect, useRef, useState } from "react";
import {
  Renderer,
  PerfMeter,
  BarsScene,
  NebulaScene,
  type Scene,
} from "@aura/render";
import {
  AudioEngine,
  LocalFileAudioSource,
  SynthDemoAudioSource,
  DisplayMediaAudioSource,
  type AudioSource,
} from "@aura/core";
import {
  SpotifyNowPlayingProvider,
  ActivityFeederNowPlayingProvider,
  extractPalette,
  type NowPlaying,
  type NowPlayingProvider,
} from "@aura/metadata";

const LS_BRIDGE_URL = "aura.bridge.url";
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8787/spotify/current";

type SceneId = "nebula" | "bars";

type Live = {
  renderer: Renderer;
  engine: AudioEngine;
  perf: PerfMeter;
  canvas: HTMLCanvasElement;
  hint: HTMLDivElement;
  currentScene: SceneId;
  currentNebula: NebulaScene | null;
  intensity: number;
};

function makeScene(id: SceneId, renderer: Renderer): { scene: Scene; nebula: NebulaScene | null } {
  if (id === "nebula") {
    const s = new NebulaScene();
    s.setHostRenderer(renderer);
    return { scene: s, nebula: s };
  }
  return { scene: new BarsScene(), nebula: null };
}

// Spotify config — user has to register their own app at developer.spotify.com
// and put the Client ID in localStorage (or paste it into the UI). Free.
const LS_CLIENT_ID = "aura.spotify.client_id";
const DEFAULT_REDIRECT = typeof window !== "undefined" ? window.location.origin + window.location.pathname : "";

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const liveRef = useRef<Live | null>(null);
  const spotifyRef = useRef<SpotifyNowPlayingProvider | null>(null);
  const feederRef = useRef<ActivityFeederNowPlayingProvider | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [trackName, setTrackName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [feederConnected, setFeederConnected] = useState(false);
  const [showSpotifySetup, setShowSpotifySetup] = useState(false);
  const [showBridgeSetup, setShowBridgeSetup] = useState(false);

  // -------------------- Now-playing wiring (shared) --------------------

  const wireNowPlaying = (provider: NowPlayingProvider): void => {
    provider.subscribe((np) => {
      setNowPlaying(np);
      const live = liveRef.current;
      const nebula = live?.currentNebula;
      if (nebula && np.artUrl) {
        extractPalette(np.artUrl)
          .then((colors) => {
            if (liveRef.current?.currentNebula === nebula) {
              nebula.setAlbumPalette(colors);
            }
          })
          .catch(() => {
            // Art CORS or load fail — fall back silently.
          });
      }
    });
  };

  // -------------------- Spotify (OAuth) provider lifecycle --------------------

  const ensureSpotifyProvider = (): SpotifyNowPlayingProvider | null => {
    if (spotifyRef.current) return spotifyRef.current;
    const clientId = localStorage.getItem(LS_CLIENT_ID);
    if (!clientId) return null;
    const provider = new SpotifyNowPlayingProvider(clientId, DEFAULT_REDIRECT);
    spotifyRef.current = provider;
    wireNowPlaying(provider);
    return provider;
  };

  // -------------------- ActivityFeeder bridge (no-OAuth) --------------------

  const ensureFeederProvider = (): ActivityFeederNowPlayingProvider => {
    if (feederRef.current) return feederRef.current;
    const url = localStorage.getItem(LS_BRIDGE_URL) ?? DEFAULT_BRIDGE_URL;
    const provider = new ActivityFeederNowPlayingProvider(url);
    feederRef.current = provider;
    wireNowPlaying(provider);
    return provider;
  };

  const handleBridgeConnect = async (url: string) => {
    setError(null);
    localStorage.setItem(LS_BRIDGE_URL, url);
    feederRef.current?.stop();
    feederRef.current = null;
    const provider = ensureFeederProvider();
    const probe = await provider.probe();
    if (!probe.ok) {
      setError(
        `Couldn't reach the bridge at ${url}.${probe.error ? " " + probe.error + "." : ""} Is \`activityfeeder bridge\` running?`,
      );
      return;
    }
    setFeederConnected(true);
    await provider.start();
  };

  const handleBridgeDisconnect = () => {
    feederRef.current?.stop();
    feederRef.current = null;
    setFeederConnected(false);
    setNowPlaying(null);
  };

  // Boot: handle Spotify ?code= redirect if present, then start polling.
  useEffect(() => {
    void (async () => {
      const url = new URL(window.location.href);
      if (url.searchParams.has("code")) {
        const clientId = localStorage.getItem(LS_CLIENT_ID);
        if (clientId) {
          const provider = new SpotifyNowPlayingProvider(clientId, DEFAULT_REDIRECT);
          spotifyRef.current = provider;
          try {
            await provider.handleRedirect();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }
      }
      const provider = ensureSpotifyProvider();
      if (provider?.isAuthorized()) {
        setSpotifyConnected(true);
        await provider.start();
      }

      // Auto-reconnect to the ActivityFeeder bridge if it was used last
      // session and is still up. Probes once; silent on failure so a
      // stopped bridge doesn't spam errors.
      if (localStorage.getItem(LS_BRIDGE_URL)) {
        const feeder = ensureFeederProvider();
        const probe = await feeder.probe();
        if (probe.ok) {
          setFeederConnected(true);
          await feeder.start();
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------- Scene / engine lifecycle --------------------

  const teardown = async () => {
    const l = liveRef.current;
    if (!l) return;
    l.renderer.dispose();
    await l.engine.dispose();
    l.perf.element.remove();
    l.canvas.remove();
    l.hint.remove();
    liveRef.current = null;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const l = liveRef.current;
      if (!l) return;

      // Scene switcher
      let target: SceneId | null = null;
      if (e.key === "1") target = "nebula";
      else if (e.key === "2") target = "bars";
      if (target && target !== l.currentScene) {
        const { scene, nebula } = makeScene(target, l.renderer);
        l.renderer.setScene(scene);
        l.currentScene = target;
        l.currentNebula = nebula;
        if (nebula) nebula.setIntensity(l.intensity);
        l.hint.textContent = hintText(l);
        if (nebula && nowPlaying?.artUrl) {
          extractPalette(nowPlaying.artUrl).then((c) => nebula.setAlbumPalette(c)).catch(() => {});
        }
        return;
      }

      // Intensity controls (always available; affect nebula only).
      let nextIntensity: number | null = null;
      if (e.key === "+" || e.key === "=") nextIntensity = Math.min(1.5, l.intensity + 0.1);
      else if (e.key === "-" || e.key === "_") nextIntensity = Math.max(0, l.intensity - 0.1);
      else if (e.key === "0") nextIntensity = 0.2; // ambient
      else if (e.key === "9") nextIntensity = 1.0; // intense
      if (nextIntensity !== null) {
        l.intensity = nextIntensity;
        l.currentNebula?.setIntensity(nextIntensity);
        l.hint.textContent = hintText(l);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      void teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowPlaying]);

  const startWith = async (source: AudioSource, label: string) => {
    setError(null);
    const host = hostRef.current;
    if (!host) return;

    await teardown();

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;display:block;width:100%;height:100%";
    host.appendChild(canvas);

    const initialScene: SceneId = "nebula";
    const initialIntensity = 0.4; // office-friendly default
    const hint = document.createElement("div");
    hint.textContent = hintText({ currentScene: initialScene, intensity: initialIntensity });
    hint.style.cssText = [
      "position:fixed",
      "right:14px",
      "bottom:12px",
      "z-index:40",
      "font:11px/1.4 ui-monospace,Menlo,Consolas,monospace",
      "color:rgba(232,240,248,0.55)",
      "letter-spacing:0.06em",
      "pointer-events:none",
      "text-shadow:0 1px 3px rgba(0,0,0,0.85)",
    ].join(";");
    host.appendChild(hint);

    const renderer = new Renderer(canvas);
    const perf = new PerfMeter();
    perf.mount(host);
    renderer.attachResize(host);
    renderer.attachMouse(host);

    const engine = new AudioEngine();
    try {
      await engine.setSource(source);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      canvas.remove();
      perf.element.remove();
      hint.remove();
      renderer.dispose();
      await engine.dispose();
      return;
    }

    const { scene, nebula } = makeScene(initialScene, renderer);
    renderer.setScene(scene);
    if (nebula) nebula.setIntensity(initialIntensity);
    perf.setGpuInfo(renderer.getGpuInfo());

    // If we already have a now-playing art URL, feed the palette immediately.
    if (nebula && nowPlaying?.artUrl) {
      extractPalette(nowPlaying.artUrl).then((c) => nebula.setAlbumPalette(c)).catch(() => {});
    }

    renderer.onTick = (now) => {
      const tick = engine.tick(now);
      renderer.frame = tick.frame;
      renderer.mood = tick.mood;
      perf.tick(now);
      perf.setBpm(tick.frame.bpm, tick.bpmConfidence);
      if (tick.frame.beat) perf.flashBeat();
    };
    renderer.start();

    liveRef.current = {
      renderer,
      engine,
      perf,
      canvas,
      hint,
      currentScene: initialScene,
      currentNebula: nebula,
      intensity: initialIntensity,
    };
    setTrackName(label);
  };

  // -------------------- Source handlers --------------------

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("audio/") && !/\.(mp3|wav|ogg|flac|m4a|aac|opus|webm)$/i.test(file.name)) {
      setError("That doesn't look like an audio file.");
      return;
    }
    await startWith(new LocalFileAudioSource(file), file.name);
  };

  const handleDemo = async () => {
    await startWith(new SynthDemoAudioSource(), "Demo track · 120 BPM");
  };

  const handleTabCapture = async () => {
    if (!DisplayMediaAudioSource.isSupported()) {
      setError("Tab/system audio capture isn't supported in this browser. Try Chrome, Edge, or Brave.");
      return;
    }
    await startWith(new DisplayMediaAudioSource("Tab capture"), "Tab capture");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  // -------------------- Spotify connect handlers --------------------

  const handleSpotifyConnect = async (clientId: string) => {
    localStorage.setItem(LS_CLIENT_ID, clientId.trim());
    spotifyRef.current = null;
    const provider = ensureSpotifyProvider();
    if (!provider) return;
    try {
      await provider.beginLogin();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSpotifyLogout = () => {
    spotifyRef.current?.logout();
    spotifyRef.current = null;
    setSpotifyConnected(false);
    setNowPlaying(null);
  };

  // -------------------- Render --------------------

  return (
    <div
      ref={hostRef}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      style={{ position: "absolute", inset: 0, overflow: "hidden" }}
    >
      {!trackName && (
        <StartOverlay
          dragging={dragging}
          error={error}
          spotifyConnected={spotifyConnected}
          feederConnected={feederConnected}
          onPick={() => fileInputRef.current?.click()}
          onDemo={() => void handleDemo()}
          onTab={() => void handleTabCapture()}
          onSpotify={() => setShowSpotifySetup(true)}
          onSpotifyLogout={handleSpotifyLogout}
          onBridge={() => setShowBridgeSetup(true)}
          onBridgeLogout={handleBridgeDisconnect}
        />
      )}
      {trackName && nowPlaying && nowPlaying.title && (
        <NowPlayingOverlay np={nowPlaying} />
      )}
      {showSpotifySetup && (
        <SpotifySetupModal
          onClose={() => setShowSpotifySetup(false)}
          onConnect={async (id) => {
            setShowSpotifySetup(false);
            await handleSpotifyConnect(id);
          }}
        />
      )}
      {showBridgeSetup && (
        <BridgeSetupModal
          onClose={() => setShowBridgeSetup(false)}
          onConnect={async (url) => {
            setShowBridgeSetup(false);
            await handleBridgeConnect(url);
          }}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function hintText(l: { currentScene: SceneId; intensity: number }): string {
  const sceneLabel = l.currentScene === "nebula" ? "nebula" : "bars (debug)";
  const intensityBar = renderIntensityBar(l.intensity);
  const tier =
    l.intensity <= 0.25 ? "ambient" : l.intensity <= 0.7 ? "calm" : l.intensity <= 1.1 ? "cinema" : "intense";
  return `scene · ${sceneLabel}   intensity ${intensityBar} ${tier}   [1/2] scene · [+/-] intensity · [0] ambient · [9] intense`;
}

function renderIntensityBar(v: number): string {
  // 10-step block bar so the user gets an at-a-glance read.
  const filled = Math.round(Math.max(0, Math.min(1.5, v)) / 0.15);
  return "█".repeat(filled) + "·".repeat(Math.max(0, 10 - filled));
}

function NowPlayingOverlay({ np }: { np: NowPlaying }) {
  return (
    <div
      style={{
        position: "fixed",
        left: 14,
        top: 12,
        zIndex: 40,
        display: "flex",
        gap: 12,
        alignItems: "center",
        background: "rgba(0,0,0,0.45)",
        padding: "8px 12px 8px 8px",
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.1)",
        backdropFilter: "blur(8px)",
        pointerEvents: "none",
        color: "rgba(232,240,248,0.92)",
        font: "12px/1.35 ui-monospace,Menlo,Consolas,monospace",
        letterSpacing: "0.04em",
        maxWidth: "60ch",
      }}
    >
      {np.artUrl && (
        <img
          src={np.artUrl}
          alt=""
          style={{
            width: 44,
            height: 44,
            borderRadius: 6,
            objectFit: "cover",
            boxShadow: "0 2px 8px rgba(0,0,0,0.55)",
          }}
        />
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {np.title ?? "—"}
        </div>
        <div style={{ opacity: 0.7, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {np.artist ?? ""}
        </div>
      </div>
    </div>
  );
}

function StartOverlay({
  onPick,
  onDemo,
  onTab,
  onSpotify,
  onSpotifyLogout,
  onBridge,
  onBridgeLogout,
  dragging,
  error,
  spotifyConnected,
  feederConnected,
}: {
  onPick: () => void;
  onDemo: () => void;
  onTab: () => void;
  onSpotify: () => void;
  onSpotifyLogout: () => void;
  onBridge: () => void;
  onBridgeLogout: () => void;
  dragging: boolean;
  error: string | null;
  spotifyConnected: boolean;
  feederConnected: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeItems: "center",
        background: dragging
          ? "radial-gradient(60% 50% at 50% 40%, rgba(108,240,194,0.25), transparent 70%), #05060a"
          : "radial-gradient(60% 50% at 50% 40%, rgba(60,90,140,0.35), transparent 70%), #05060a",
        zIndex: 10,
        transition: "background 200ms ease-out",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 640, padding: 24 }}>
        <h1
          style={{
            fontSize: 64,
            margin: 0,
            letterSpacing: "0.18em",
            fontWeight: 200,
            color: "#e9f0f8",
            textShadow: "0 0 24px rgba(120,180,255,0.35)",
          }}
        >
          AURA
        </h1>
        <p style={{ opacity: 0.6, marginTop: 10, fontSize: 13, letterSpacing: "0.05em" }}>
          cinematic music visualizer · early build
        </p>

        <div style={{ marginTop: 28, display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <button onClick={onTab} style={primaryButtonStyle} title="Share a browser tab playing music (Spotify Web, YouTube Music, SoundCloud…)">
            ◉  Capture from a tab
          </button>
          <button onClick={onPick} style={secondaryButtonStyle}>
            Choose an audio file
          </button>
          <button onClick={onDemo} style={secondaryButtonStyle} title="Built-in 120 BPM synth, no file needed.">
            Demo track
          </button>
        </div>

        <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          {feederConnected ? (
            <div style={{ display: "flex", gap: 10, justifyContent: "center", alignItems: "center", fontSize: 12 }}>
              <span style={{ color: "#a8ffce" }}>● live from ActivityFeeder bridge</span>
              <button onClick={onBridgeLogout} style={linkButtonStyle}>disconnect</button>
            </div>
          ) : spotifyConnected ? (
            <div style={{ display: "flex", gap: 10, justifyContent: "center", alignItems: "center", fontSize: 12 }}>
              <span style={{ color: "#1ed760" }}>● connected to Spotify</span>
              <button onClick={onSpotifyLogout} style={linkButtonStyle}>disconnect</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              <button onClick={onBridge} style={bridgeButtonStyle} title="If you run ActivityFeeder locally, this is the easiest path.">
                Use ActivityFeeder bridge
              </button>
              <button onClick={onSpotify} style={spotifyButtonStyle}>
                Connect Spotify (OAuth)
              </button>
            </div>
          )}
        </div>

        <p style={{ opacity: 0.45, marginTop: 18, fontSize: 12, lineHeight: 1.5 }}>
          Tab capture lets AURA hear <em>any</em> web player. The bridge (or Spotify OAuth) layers in track titles & album-art-derived palettes.
          <br />Drop an audio file anywhere. Press 1 / 2 to switch scenes.
        </p>
        {error && (
          <p style={{ marginTop: 22, color: "#ff8a8a", fontSize: 12, letterSpacing: "0.04em" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function SpotifySetupModal({ onClose, onConnect }: { onClose: () => void; onConnect: (id: string) => void }) {
  const [id, setId] = useState(localStorage.getItem(LS_CLIENT_ID) ?? "");
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(5,6,10,0.75)",
        backdropFilter: "blur(6px)", zIndex: 100, display: "grid", placeItems: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0c0f17", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12,
          padding: 24, maxWidth: 520, width: "calc(100% - 32px)", color: "#e9f0f8",
          font: "13px/1.55 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500, letterSpacing: "0.04em" }}>Connect Spotify</h2>
        <p style={{ opacity: 0.7, marginTop: 12 }}>
          AURA only reads your <em>now-playing</em> metadata — audio comes from tab capture (or whatever source you pick).
        </p>
        <ol style={{ opacity: 0.85, paddingLeft: 18, marginTop: 14 }}>
          <li>
            Go to <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer" style={{ color: "#a8ffce" }}>developer.spotify.com/dashboard</a> → <b>Create app</b>.
          </li>
          <li>Add this exact redirect URI:
            <pre style={{ background: "#000", padding: "6px 8px", borderRadius: 6, marginTop: 6, overflowX: "auto" }}>
              {DEFAULT_REDIRECT}
            </pre>
          </li>
          <li>Copy the <b>Client ID</b> and paste it below.</li>
        </ol>
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="Spotify Client ID"
          style={{
            display: "block", width: "100%", boxSizing: "border-box", marginTop: 12,
            background: "#05060a", border: "1px solid rgba(255,255,255,0.18)",
            color: "#e9f0f8", padding: "10px 12px", borderRadius: 8, font: "inherit",
            letterSpacing: "0.04em",
          }}
        />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
          <button onClick={onClose} style={secondaryButtonStyle}>Cancel</button>
          <button onClick={() => id.trim() && onConnect(id.trim())} style={spotifyButtonStyle}>
            Connect → Spotify
          </button>
        </div>
      </div>
    </div>
  );
}

function BridgeSetupModal({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: (url: string) => void;
}) {
  const [url, setUrl] = useState(localStorage.getItem(LS_BRIDGE_URL) ?? DEFAULT_BRIDGE_URL);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(5,6,10,0.75)",
        backdropFilter: "blur(6px)", zIndex: 100, display: "grid", placeItems: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0c0f17", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12,
          padding: 24, maxWidth: 560, width: "calc(100% - 32px)", color: "#e9f0f8",
          font: "13px/1.55 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500, letterSpacing: "0.04em" }}>Use ActivityFeeder bridge</h2>
        <p style={{ opacity: 0.75, marginTop: 12 }}>
          Skip Spotify OAuth entirely. AURA reads now-playing data from a local
          bridge that piggybacks on the ActivityFeeder's existing Spotify auth.
        </p>
        <ol style={{ opacity: 0.85, paddingLeft: 18, marginTop: 14 }}>
          <li>
            In a terminal: <pre style={{ display: "inline", background: "#000", padding: "2px 6px", borderRadius: 4 }}>activityfeeder bridge</pre>
            <br />
            <span style={{ opacity: 0.7, fontSize: 12 }}>Boots a localhost HTTP endpoint that exposes whatever your ActivityFeeder is showing in its Now Playing panel.</span>
          </li>
          <li>Leave the URL below alone unless you started the bridge on a non-default host/port.</li>
        </ol>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={DEFAULT_BRIDGE_URL}
          style={{
            display: "block", width: "100%", boxSizing: "border-box", marginTop: 12,
            background: "#05060a", border: "1px solid rgba(255,255,255,0.18)",
            color: "#e9f0f8", padding: "10px 12px", borderRadius: 8, font: "inherit",
            letterSpacing: "0.04em",
          }}
        />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18 }}>
          <button onClick={onClose} style={secondaryButtonStyle}>Cancel</button>
          <button onClick={() => url.trim() && onConnect(url.trim())} style={bridgeButtonStyle}>
            Connect → bridge
          </button>
        </div>
      </div>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  padding: "12px 26px", background: "rgba(168,255,206,0.16)", border: "1px solid rgba(168,255,206,0.65)",
  color: "#a8ffce", borderRadius: 8, cursor: "pointer", font: "inherit", letterSpacing: "0.12em",
  fontSize: 13, textTransform: "uppercase", backdropFilter: "blur(8px)", fontWeight: 500,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "12px 26px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.2)",
  color: "rgba(232,240,248,0.85)", borderRadius: 8, cursor: "pointer", font: "inherit",
  letterSpacing: "0.12em", fontSize: 13, textTransform: "uppercase", backdropFilter: "blur(8px)",
};
const spotifyButtonStyle: React.CSSProperties = {
  padding: "10px 22px", background: "#1ed760", border: "1px solid #1ed760", color: "#05060a",
  borderRadius: 8, cursor: "pointer", font: "inherit", letterSpacing: "0.08em", fontSize: 12,
  textTransform: "uppercase", fontWeight: 600,
};
const bridgeButtonStyle: React.CSSProperties = {
  padding: "10px 22px", background: "rgba(168,255,206,0.16)",
  border: "1px solid rgba(168,255,206,0.65)", color: "#a8ffce",
  borderRadius: 8, cursor: "pointer", font: "inherit", letterSpacing: "0.08em",
  fontSize: 12, textTransform: "uppercase", fontWeight: 600,
};
const linkButtonStyle: React.CSSProperties = {
  background: "transparent", border: "none", color: "rgba(232,240,248,0.65)",
  textDecoration: "underline", cursor: "pointer", padding: 0, font: "inherit", fontSize: 11,
};
