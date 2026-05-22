/**
 * One parsed LRC line. Word-level timing is optional and rare (see
 * lrclib-lyrics skill). Baseline rendering is line-level only.
 */
export interface LyricLine {
  timeMs: number;
  text: string;
  /** Optional per-word timing when enhanced LRC is available. */
  words?: { timeMs: number; text: string }[];
}

export interface LyricsResult {
  /** True when LRCLIB reports the track is instrumental — render animation only. */
  instrumental: boolean;
  /** Sorted ascending by timeMs. Empty when no synced lyrics. */
  lines: LyricLine[];
  /** Plain unsynced fallback, if synced lyrics are missing. */
  plain?: string;
}

/**
 * Snapshot consumed by the lyric scene each frame.
 */
export interface LyricView {
  prevLine?: LyricLine;
  currentLine?: LyricLine;
  nextLine?: LyricLine;
  /** 0..1 progress within currentLine. */
  lineProgress: number;
  /** Active word index when enhanced LRC is present. */
  wordIndex?: number;
}

export interface LyricsProvider {
  /** Look up synced lyrics for a track. Aggressively cached. */
  fetch(query: {
    title: string;
    artist: string;
    album?: string;
    durationSec?: number;
  }): Promise<LyricsResult | null>;
}
