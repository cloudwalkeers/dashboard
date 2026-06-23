import { Composition, staticFile } from "remotion";
import { AnnotatedReel } from "./AnnotatedReel";
import { RecapVideo } from "./RecapVideo";
import type { Analysis } from "./types";
import sample from "./sample.json";

const FPS = 30;
const data = sample as Analysis;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* The reel itself with retention + drop-off + frame notes composited on top.
          Place the reel video at remotion/public/reel.mp4 (or override videoUrl via --props). */}
      <Composition
        id="AnnotatedReel"
        component={AnnotatedReel}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={{ data, videoUrl: staticFile("reel.mp4") }}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(1, Math.round((props.data.video.durationSec || 10) * FPS)),
        })}
      />

      {/* A branded performance recap (no source video needed). */}
      <Composition
        id="RecapVideo"
        component={RecapVideo}
        fps={FPS}
        width={1080}
        height={1350}
        durationInFrames={Math.round(14 * FPS)}
        defaultProps={{ data }}
      />
    </>
  );
};
