import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import type { Analysis } from "./types";

const W = 1080;

// Plays the reel with a retention curve, drop-off markers, the AI's current
// frame note, and the live transcript line composited over it.
export const AnnotatedReel: React.FC<{ data: Analysis; videoUrl: string }> = ({ data, videoUrl }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const dur = data.video.durationSec || 1;
  const progress = Math.min(1, t / dur);

  const ret = data.retention && data.retention.length ? data.retention : [100, 50];
  const curveH = 150;
  const pt = (i: number) => {
    const x = (i / (ret.length - 1)) * W;
    const y = 20 + (1 - ret[i] / 100) * (curveH - 30);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const poly = ret.map((_, i) => pt(i)).join(" ");
  const cursorX = progress * W;

  const curFrame = [...(data.frames || [])].filter((f) => f.t <= t + 0.001).pop();
  const line = (data.transcript?.segments || []).find((s) => t >= s.start && t < s.end);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <OffthreadVideo src={videoUrl} />

      {/* retention curve, pinned to the top */}
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <svg width={W} height={curveH} style={{ position: "absolute", top: 0, left: 0 }}>
          <rect x={0} y={0} width={W} height={curveH} fill="rgba(0,0,0,0.45)" />
          <polyline points={poly} fill="none" stroke="#a5b4fc" strokeWidth={4} />
          {(data.analysis?.dropoff || []).map((d, i) => {
            const x = Math.min(1, (d.t || 0) / dur) * W;
            return <line key={i} x1={x} y1={16} x2={x} y2={curveH - 6} stroke="#f87171" strokeWidth={3} strokeDasharray="6 6" />;
          })}
          <line x1={cursorX} y1={8} x2={cursorX} y2={curveH - 4} stroke="#fff" strokeWidth={3} />
          <circle cx={cursorX} cy={20 + (1 - retAt(ret, progress) / 100) * (curveH - 30)} r={7} fill="#fff" />
        </svg>
        <div style={{ position: "absolute", top: 12, left: 16, color: "#fff", font: "600 26px/1 -apple-system,sans-serif" }}>
          {Math.round(retAt(ret, progress))}% watching
        </div>
      </AbsoluteFill>

      {/* current AI frame note */}
      {curFrame ? (
        <div style={{ position: "absolute", top: curveH + 24, left: 24, right: 24, color: "#fff", font: "500 30px/1.3 -apple-system,sans-serif", textShadow: "0 2px 8px rgba(0,0,0,.8)" }}>
          {curFrame.desc}
          {curFrame.onScreenText ? <span style={{ opacity: 0.7 }}>{`  ·  on-screen: "${curFrame.onScreenText}"`}</span> : null}
        </div>
      ) : null}

      {/* live transcript caption */}
      {line ? (
        <div style={{ position: "absolute", bottom: 120, left: 60, right: 60, textAlign: "center" }}>
          <span style={{ background: "rgba(0,0,0,.7)", color: "#fff", font: "700 40px/1.4 -apple-system,sans-serif", padding: "8px 16px", borderRadius: 12, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>
            {line.text}
          </span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

function retAt(ret: number[], progress: number) {
  const f = progress * (ret.length - 1);
  const i = Math.floor(f);
  const j = Math.min(ret.length - 1, i + 1);
  return ret[i] + (ret[j] - ret[i]) * (f - i);
}
