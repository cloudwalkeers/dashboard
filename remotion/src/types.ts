// Shape of analysis/<id>.json produced by `npm run analyze` in the parent project.
export type Analysis = {
  id: string;
  video: { src: string; durationSec: number; frameCount: number; intervalSec: number };
  frames: { t: number; img: string; desc: string; onScreenText: string }[];
  transcript: { segments: { start: number; end: number; text: string }[]; text: string; lang: string };
  metrics: Record<string, number | string>;
  retention: number[];
  analysis: {
    summary: string;
    hook: string;
    dropoff: { t: number; why: string }[];
    suggestions: string[];
    moments: { t: number; label: string }[];
  };
  meta: { createdAt: number; dryRun: boolean; costUsd: number };
};
