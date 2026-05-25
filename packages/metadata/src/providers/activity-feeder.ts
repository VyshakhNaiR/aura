import type { NowPlaying, NowPlayingProvider } from "../types.js";

interface BridgeResponse {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  artUrl?: string | null;
  durationMs?: number;
  positionMs?: number;
  isPlaying?: boolean;
  source?: string;
  serviceOk?: boolean;
  error?: string | null;
}

/**
 * Polls a local ActivityFeeder bridge for now-playing data.
 *
 * The bridge (Python; runs alongside ActivityFeeder) handles Spotify auth
 * and rate-limiting on its side, so AURA doesn't need its own OAuth flow,
 * client ID, or redirect URI. AURA just hits a localhost endpoint every
 * 2.5 s and renders whatever's there.
 *
 * Default endpoint: http://127.0.0.1:8787/spotify/current
 *
 * Start the bridge with:
 *     activityfeeder bridge
 */
export class ActivityFeederNowPlayingProvider implements NowPlayingProvider {
  readonly id = "activity-feeder";

  private np: NowPlaying | null = null;
  private subscribers = new Set<(np: NowPlaying) => void>();
  private pollHandle: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalMs = 2500;
  private consecutiveFailures = 0;

  constructor(
    private readonly endpoint = "http://127.0.0.1:8787/spotify/current",
  ) {}

  /** Quick health check before wiring as the active provider. */
  async probe(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(this.endpoint, { method: "GET" });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = (await res.json()) as BridgeResponse;
      if (data.serviceOk === false && data.error) {
        return { ok: false, error: data.error };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async start(): Promise<void> {
    this.stop();
    await this.pollOnce();
    this.schedulePoll();
  }

  stop(): void {
    if (this.pollHandle !== null) {
      clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
  }

  current(): NowPlaying | null {
    return this.np;
  }

  subscribe(cb: (np: NowPlaying) => void): () => void {
    this.subscribers.add(cb);
    if (this.np) cb(this.np);
    return () => this.subscribers.delete(cb);
  }

  private schedulePoll(): void {
    // Exponential back-off on consecutive failures so a stopped bridge
    // doesn't spam the user's network tab.
    const delay =
      this.consecutiveFailures > 0
        ? Math.min(20_000, this.pollIntervalMs * 2 ** this.consecutiveFailures)
        : this.pollIntervalMs;
    this.pollHandle = setTimeout(() => {
      void this.pollOnce().finally(() => this.schedulePoll());
    }, delay);
  }

  private async pollOnce(): Promise<void> {
    try {
      const res = await fetch(this.endpoint, { method: "GET" });
      if (!res.ok) {
        this.consecutiveFailures = Math.min(5, this.consecutiveFailures + 1);
        return;
      }
      this.consecutiveFailures = 0;
      const data = (await res.json()) as BridgeResponse;
      this.update({
        title: data.title ?? undefined,
        artist: data.artist ?? undefined,
        album: data.album ?? undefined,
        artUrl: data.artUrl ?? undefined,
        durationMs: data.durationMs ?? 0,
        positionMs: data.positionMs ?? 0,
        isPlaying: data.isPlaying ?? false,
        source: "spotify",
      });
    } catch {
      this.consecutiveFailures = Math.min(5, this.consecutiveFailures + 1);
    }
  }

  private update(np: NowPlaying): void {
    const prev = this.np;
    if (
      prev &&
      prev.title === np.title &&
      prev.artist === np.artist &&
      prev.isPlaying === np.isPlaying &&
      prev.artUrl === np.artUrl
    ) {
      this.np = np;
      return;
    }
    this.np = np;
    for (const cb of this.subscribers) cb(np);
  }
}
