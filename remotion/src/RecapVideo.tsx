import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Analysis } from "./types";

const ACCENT = "#6366f1";
const fmtK = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
};

// A branded MP4 recap of one reel's performance — no source video required.
export const RecapVideo: React.FC<{ data: Analysis }> = ({ data }) => {
  const m = data.metrics || {};
  const cards = [
    { label: "Reach", value: fmtK(Number(m.reach) || 0) },
    { label: "Plays", value: fmtK(Number(m.plays) || 0) },
    { label: "Avg watch", value: (Number(m.avgWatchSec) || 0) + "s" },
  ];
  return (
    <AbsoluteFill style={{ background: "#0b0b12", color: "#fff", fontFamily: "-apple-system,Segoe UI,sans-serif", padding: 72 }}>
      <Sequence durationInFrames={120}>
        <Title cap={String(m.cap || data.id)} />
      </Sequence>
      <Sequence from={70}>
        <div style={{ display: "flex", gap: 24, marginTop: 220 }}>
          {cards.map((c, i) => (
            <KpiCard key={c.label} delay={i * 6} {...c} />
          ))}
        </div>
        <Suggestions items={data.analysis?.suggestions || []} />
      </Sequence>
    </AbsoluteFill>
  );
};

const Title: React.FC<{ cap: string }> = ({ cap }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 200 } });
  return (
    <div style={{ opacity: s, transform: `translateY(${interpolate(s, [0, 1], [20, 0])}px)` }}>
      <div style={{ font: "650 22px/1 inherit", letterSpacing: 2, color: ACCENT, textTransform: "uppercase" }}>Reel recap</div>
      <div style={{ font: "700 56px/1.15 inherit", marginTop: 14, maxWidth: 820 }}>{cap}</div>
    </div>
  );
};

const KpiCard: React.FC<{ label: string; value: string; delay: number }> = ({ label, value, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return (
    <div style={{ flex: 1, background: "#16161f", border: "1px solid #25252f", borderRadius: 18, padding: 28, opacity: s, transform: `scale(${interpolate(s, [0, 1], [0.9, 1])})` }}>
      <div style={{ font: "650 18px/1 inherit", letterSpacing: 1.5, color: "#8b8b9a", textTransform: "uppercase" }}>{label}</div>
      <div style={{ font: "700 52px/1 inherit", marginTop: 16 }}>{value}</div>
    </div>
  );
};

const Suggestions: React.FC<{ items: string[] }> = ({ items }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ marginTop: 56 }}>
      <div style={{ font: "650 20px/1 inherit", letterSpacing: 1.5, color: "#8b8b9a", textTransform: "uppercase", marginBottom: 22 }}>What to try next</div>
      {items.slice(0, 3).map((s, i) => {
        const sp = spring({ frame: frame - 30 - i * 14, fps, config: { damping: 200 } });
        return (
          <div key={i} style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 18, opacity: sp, transform: `translateX(${interpolate(sp, [0, 1], [-16, 0])}px)` }}>
            <div style={{ width: 12, height: 12, borderRadius: 6, background: ACCENT, marginTop: 10, flex: "none" }} />
            <div style={{ font: "500 30px/1.4 inherit", maxWidth: 880 }}>{s}</div>
          </div>
        );
      })}
    </div>
  );
};
