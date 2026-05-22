/**
 * Normalized "now playing" shape across all providers (Spotify, MediaSession,
 * manual entry, ID3 tags). Any field except isPlaying may be absent.
 */
export interface NowPlaying {
  title?: string;
  artist?: string;
  album?: string;
  artUrl?: string;
  durationMs?: number;
  positionMs?: number;
  isPlaying: boolean;
  source: "spotify" | "media-session" | "manual" | "id3" | "none";
}

export interface NowPlayingProvider {
  readonly id: string;
  start(): Promise<void>;
  stop(): void;
  /** Latest snapshot, or null if no data yet. */
  current(): NowPlaying | null;
  /** Subscribe to updates. Returns an unsubscribe fn. */
  subscribe(cb: (np: NowPlaying) => void): () => void;
}
