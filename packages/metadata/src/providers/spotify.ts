import type { NowPlaying, NowPlayingProvider } from "../types.js";

const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
].join(" ");

const LS_VERIFIER = "aura.spotify.code_verifier";
const LS_TOKEN = "aura.spotify.token";
const LS_REFRESH = "aura.spotify.refresh";
const LS_EXPIRES = "aura.spotify.expires";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

interface SpotifyCurrent {
  is_playing?: boolean;
  progress_ms?: number | null;
  item?: {
    name?: string;
    artists?: { name?: string }[];
    album?: {
      name?: string;
      images?: { url: string; width?: number; height?: number }[];
    };
    duration_ms?: number;
  } | null;
}

/**
 * Spotify Web API now-playing provider. Implements OAuth Authorization Code
 * with PKCE entirely in the browser — no client secret ever leaves the
 * Spotify Developer Dashboard side of the world.
 *
 * Setup the user has to do once:
 *  1. https://developer.spotify.com/dashboard → Create app
 *  2. Add redirect URI: whatever AURA is hosted at (e.g. http://localhost:5173)
 *  3. Copy the Client ID and pass it to this constructor
 *
 * Only metadata endpoints are touched — `audio-analysis` / `audio-features`
 * are dead for new apps. Everything beat-related still comes from the
 * actual captured waveform.
 */
export class SpotifyNowPlayingProvider implements NowPlayingProvider {
  readonly id = "spotify";

  private np: NowPlaying | null = null;
  private subscribers = new Set<(np: NowPlaying) => void>();
  private pollHandle: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalMs = 2500;

  constructor(
    private readonly clientId: string,
    private readonly redirectUri: string,
  ) {}

  // -------------------------------------------------------------------------
  // OAuth (PKCE)
  // -------------------------------------------------------------------------

  /** True if we have a non-expired access token cached locally. */
  isAuthorized(): boolean {
    const token = localStorage.getItem(LS_TOKEN);
    const exp = Number(localStorage.getItem(LS_EXPIRES) ?? "0");
    return !!token && Date.now() < exp - 5_000;
  }

  /**
   * Kick off the PKCE flow. The browser navigates to Spotify; on consent
   * Spotify sends the user back to redirectUri with ?code=XXX. Call
   * handleRedirect() on app load to finalize.
   */
  async beginLogin(): Promise<void> {
    const verifier = randomString(64);
    const challenge = await sha256Base64Url(verifier);
    localStorage.setItem(LS_VERIFIER, verifier);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      scope: SCOPES,
      redirect_uri: this.redirectUri,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    window.location.assign(
      `https://accounts.spotify.com/authorize?${params.toString()}`,
    );
  }

  /**
   * If the current URL contains a Spotify auth `?code=` param, exchange it
   * for tokens and clean the URL. Safe to call on every app load — no-op
   * when there's no code.
   *
   * Returns true if a redirect was processed (the caller can immediately
   * start polling).
   */
  async handleRedirect(): Promise<boolean> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) return false;

    const verifier = localStorage.getItem(LS_VERIFIER);
    if (!verifier) return false;

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: verifier,
    });

    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Spotify token exchange failed: ${res.status}`);
    }
    const token = (await res.json()) as TokenResponse;
    this.storeToken(token);

    // Clean ?code=… out of the URL so refreshes don't try to reuse it.
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, "", url.toString());
    localStorage.removeItem(LS_VERIFIER);
    return true;
  }

  logout(): void {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_REFRESH);
    localStorage.removeItem(LS_EXPIRES);
    this.stop();
  }

  private storeToken(tok: TokenResponse): void {
    localStorage.setItem(LS_TOKEN, tok.access_token);
    if (tok.refresh_token) {
      localStorage.setItem(LS_REFRESH, tok.refresh_token);
    }
    localStorage.setItem(
      LS_EXPIRES,
      String(Date.now() + tok.expires_in * 1000),
    );
  }

  private async refreshToken(): Promise<boolean> {
    const refresh = localStorage.getItem(LS_REFRESH);
    if (!refresh) return false;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: this.clientId,
    });
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return false;
    const tok = (await res.json()) as TokenResponse;
    this.storeToken(tok);
    return true;
  }

  private async authedFetch(input: string): Promise<Response> {
    let token = localStorage.getItem(LS_TOKEN);
    if (!token) throw new Error("not authorized");
    let res = await fetch(input, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      const refreshed = await this.refreshToken();
      if (refreshed) {
        token = localStorage.getItem(LS_TOKEN);
        res = await fetch(input, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    }
    return res;
  }

  // -------------------------------------------------------------------------
  // NowPlayingProvider
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!this.isAuthorized()) return;
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
    this.pollHandle = setTimeout(() => {
      void this.pollOnce().finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
  }

  private async pollOnce(): Promise<void> {
    try {
      const res = await this.authedFetch(
        "https://api.spotify.com/v1/me/player/currently-playing",
      );
      if (res.status === 204) {
        // Nothing playing.
        this.update({ isPlaying: false, source: "spotify" });
        return;
      }
      if (res.status === 429) {
        // Rate limit — back off briefly.
        const retry = Number(res.headers.get("Retry-After") ?? "5");
        this.pollIntervalMs = Math.min(15_000, Math.max(2500, retry * 1000));
        return;
      }
      if (!res.ok) return;
      const json = (await res.json()) as SpotifyCurrent;
      this.pollIntervalMs = 2500;
      const item = json.item;
      const art = item?.album?.images?.[0]?.url;
      this.update({
        title: item?.name,
        artist: item?.artists?.map((a) => a.name).filter(Boolean).join(", "),
        album: item?.album?.name,
        artUrl: art,
        durationMs: item?.duration_ms,
        positionMs: json.progress_ms ?? undefined,
        isPlaying: json.is_playing ?? false,
        source: "spotify",
      });
    } catch {
      // Swallow — surfaced through "no metadata" UX rather than crashing.
    }
  }

  private update(np: NowPlaying): void {
    // Skip emit when nothing meaningful changed (cheap content check).
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

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function randomString(len: number): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return base64Url(arr).slice(0, len);
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(hash));
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
