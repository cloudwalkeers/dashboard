// Shared visual aggregation. Turns per-frame structured labels (person_visible, scene,
// app_shown, big_text_overlay, caption_subtitle, action) into measured reel-level
// aggregates (person-visible %, screen-demo %, scene cuts…), bucketed contrast features,
// and the per-second frame_track used by the drop analyzer. One source of truth for the
// live pipeline (analyze.mjs) and the feature builder (causal.buildFeatures).

export function bucketFeatures(stats) {
  const person = stats.person_visible_pct || 0, screen = stats.screen_demo_pct || 0;
  const anim = stats.animation_pct || 0, cap = stats.caption_pct || 0, cuts = stats.scene_cuts || 0;
  return {
    person_presence: person < 30 ? "mostly_screen" : person > 70 ? "mostly_person" : "balanced",
    screen_demo_level: screen < 10 ? "none" : screen > 50 ? "heavy" : "some",
    scene_variety: cuts < 3 ? "low" : cuts > 6 ? "high" : "medium",
    motion_style: anim >= 20 ? "dynamic" : "static",
    caption_style: cap > 60 ? "full_captions" : cap > 10 ? "some_captions" : "no_captions",
    has_big_hook_text: !!stats.big_text_early,
    primary_app: stats.primary_app || "none",
  };
}

// items: [{ t, scene, app_shown, person_visible, big_text_overlay, caption_subtitle, action }]
export function aggregateFrames(items) {
  const fr = (items || []).filter((f) => f && f.scene);
  if (fr.length < 3) return null; // not enough structured frames to trust an aggregate
  const n = fr.length;
  const pct = (p) => Math.round(fr.filter(p).length / n * 100);
  let cuts = 0; for (let i = 1; i < fr.length; i++) if (fr[i].scene !== fr[i - 1].scene) cuts++;
  const apps = {}; for (const f of fr) if (f.app_shown && f.app_shown !== "none") apps[f.app_shown] = (apps[f.app_shown] || 0) + 1;
  const primary_app = (Object.entries(apps).sort((a, b) => b[1] - a[1])[0] || ["none"])[0];
  const person = pct((f) => f.person_visible);
  const screen = pct((f) => f.scene === "screen_demo" || f.scene === "overlay_on_face" || (f.app_shown && f.app_shown !== "none"));
  const anim = pct((f) => ["typing", "scrolling", "transition"].includes(f.action) || f.scene === "animation");
  const cap = pct((f) => f.caption_subtitle);
  const bigtxt = pct((f) => f.big_text_overlay);
  const early = fr.slice(0, Math.max(1, Math.round(fr.length * 0.12)));
  const stats = { person_visible_pct: person, screen_demo_pct: screen, animation_pct: anim, caption_pct: cap, big_text_pct: bigtxt, scene_cuts: cuts, primary_app, frames_analyzed: n, big_text_early: early.some((f) => f.big_text_overlay) };
  const track = fr.map((f) => ({ t: Math.round(f.t), sc: f.scene, app: f.app_shown, p: f.person_visible ? 1 : 0, a: f.action, big: f.big_text_overlay ? 1 : 0, cap: f.caption_subtitle ? 1 : 0 }));
  return { stats, feats: bucketFeatures(stats), track };
}
