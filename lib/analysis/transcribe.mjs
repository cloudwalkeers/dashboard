// Speech-to-text via OpenAI's audio transcription API. Tries whisper-1 first
// (per-segment timestamps via verbose_json), then the gpt-4o transcription
// models (text only). If none are accessible, transcription is skipped and the
// rest of the pipeline still runs.
import { createReadStream } from "node:fs";
import { getOpenAI } from "./client.mjs";

export async function transcribe(audioPath, { dryRun = false, durationSec = 0 } = {}) {
  if (dryRun) return { segments: [], text: "", lang: "", source: "dry-run" };
  if (!audioPath) return { segments: [], text: "", lang: "", source: "no-audio" };

  const client = await getOpenAI();
  const candidates = process.env.OPENAI_TRANSCRIBE_MODEL
    ? [process.env.OPENAI_TRANSCRIBE_MODEL]
    : ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"];

  let lastErr = "";
  for (const model of candidates) {
    const verbose = model === "whisper-1"; // only whisper-1 returns timestamped segments
    try {
      const res = await client.audio.transcriptions.create({
        file: createReadStream(audioPath),
        model,
        response_format: verbose ? "verbose_json" : "json",
      });
      let segments = [];
      if (verbose && Array.isArray(res.segments)) {
        segments = res.segments
          .map((s) => ({ start: s.start, end: s.end, text: String(s.text || "").trim() }))
          .filter((s) => s.text);
      } else if (res.text) {
        segments = [{ start: 0, end: durationSec || 0, text: String(res.text).trim() }];
      }
      return { segments, text: res.text || segments.map((s) => s.text).join(" "), lang: res.language || "", source: "openai:" + model };
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
  }

  return { segments: [], text: "", lang: "", source: "unavailable", error: lastErr };
}
