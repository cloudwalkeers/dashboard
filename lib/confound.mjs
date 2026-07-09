import { currentIgAccount } from "./scope.mjs";
// Confounder control for the "views" outcome. Two time effects pollute raw views:
//  (1) MATURITY — a reel posted 2 days ago simply hasn't accumulated its views yet.
//  (2) TREND — follower growth / account momentum shifts the baseline over weeks.
// We flag immature reels (incomplete views) and detrend mature reels against posting
// time, so the causal engine can contrast content on a time-adjusted residual instead of
// raw views. The fitted slope doubles as the account's view growth rate.
import { getDb, isConfigured } from "./store/supabase.mjs";
export { isConfigured };

export const MATURITY_DAYS = 5; // views are ~settled after this many days

export async function viewContext() {
  const db = await getDb();
  let q = db.from("reels").select("shortcode,published_at,reel_metrics(plays,reach,captured_date)").not("published_at", "is", null);
  const __acct = currentIgAccount(); if (__acct) q = q.eq("ig_account", __acct);
  const { data } = await q;
  const now = Date.now();
  const rows = (data || []).map((r) => {
    const m = (r.reel_metrics || []).slice().sort((a, b) => String(b.captured_date).localeCompare(String(a.captured_date)))[0] || {};
    const ageDays = (now - new Date(r.published_at).getTime()) / 86400000;
    return { shortcode: r.shortcode, published: r.published_at, ageDays: Math.round(ageDays * 10) / 10, views: m.plays || 0, reach: m.reach || 0 };
  }).filter((r) => r.published);
  if (!rows.length) return { maturityDays: MATURITY_DAYS, nMature: 0, nImmature: 0, weeklyGrowthPct: 0, rows: [] };
  const t0 = Math.min(...rows.map((r) => new Date(r.published).getTime()));
  rows.forEach((r) => { r.dayIdx = (new Date(r.published).getTime() - t0) / 86400000; r.mature = r.ageDays >= MATURITY_DAYS; });
  // fit log10(views) ~ dayIdx on MATURE reels only (immature views are still cooking)
  const mature = rows.filter((r) => r.mature && r.views > 0);
  let slope = 0, intercept = mature.length ? Math.log10(mature.reduce((a, r) => a + r.views, 0) / mature.length) : 0;
  if (mature.length >= 6) {
    const xs = mature.map((r) => r.dayIdx), ys = mature.map((r) => Math.log10(r.views));
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    slope = sxx ? sxy / sxx : 0; intercept = my - slope * mx;
  }
  // residual sd (for z-scoring the time-adjusted performance)
  const resids = mature.map((r) => Math.log10(r.views) - (intercept + slope * r.dayIdx));
  const rsd = Math.sqrt(resids.reduce((s, v) => s + v * v, 0) / (resids.length || 1)) || 1;
  rows.forEach((r) => {
    const expLog = intercept + slope * r.dayIdx;
    r.expViews = Math.round(10 ** expLog);
    r.viewResidual = r.views > 0 ? +((Math.log10(r.views) - expLog)).toFixed(3) : null; // time-adjusted over/under-performance (log10)
    r.viewZ = r.viewResidual != null ? +(r.viewResidual / rsd).toFixed(2) : null;
  });
  const weeklyGrowthPct = Math.round((10 ** (slope * 7) - 1) * 100);
  return { maturityDays: MATURITY_DAYS, nMature: mature.length, nImmature: rows.filter((r) => !r.mature).length, weeklyGrowthPct, slopeLog10PerDay: +slope.toFixed(4), rows };
}

/** shortcode -> { ageDays, mature, viewResidual, viewZ, expViews } for other modules to join on. */
export async function viewAdjustments() {
  const ctx = await viewContext();
  const by = {};
  for (const r of ctx.rows) by[r.shortcode] = { ageDays: r.ageDays, mature: r.mature, viewResidual: r.viewResidual, viewZ: r.viewZ, expViews: r.expViews };
  return { meta: { maturityDays: ctx.maturityDays, nMature: ctx.nMature, nImmature: ctx.nImmature, weeklyGrowthPct: ctx.weeklyGrowthPct }, by };
}
