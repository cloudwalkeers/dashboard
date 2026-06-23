// Table names for the normalized reels schema (see the reels_analysis_schema
// migration). `children` are the per-reel rows cleared and re-inserted on a
// re-store; `reel_metrics` is intentionally excluded — it's a kept time-series.
export const SUPABASE_TABLES = {
  reel: "reels",
  children: ["reel_frame_text", "reel_frames", "reel_transcript_segments", "reel_dropoff", "reel_suggestions", "reel_moments"],
  metrics: "reel_metrics",
};
