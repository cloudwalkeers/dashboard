// Demo dataset so the dashboard works with zero setup. Shape matches exactly
// what transform.toPayload() produces from live data, so the front-end can't
// tell the difference — only meta.source says "demo".
import { engagementRates } from "./transform.mjs";

function makeRet(hookLoss, floor, wob) {
  const p = [100];
  for (let i = 1; i <= 20; i++) {
    const x = i / 20;
    let t;
    if (x <= 0.15) t = 100 - hookLoss * (x / 0.15);
    else {
      const u = (x - 0.15) / 0.85;
      t = 100 - hookLoss - (100 - hookLoss - floor) * Math.pow(u, 0.85);
    }
    t += Math.sin(i * 1.7) * wob;
    p.push(Math.max(3, Math.min(100, Math.round(t))));
  }
  return p;
}
const meanFrac = (p) => p.reduce((a, b) => a + b, 0) / p.length / 100;

const DEFS = [
  { id: "r1", cap: "I quit my 9–5 to make pottery 🏺", len: 22, reach: 248000, plays: 326000, replays: 78000, likes: 11200, comments: 740, shares: 4200, saves: 6800, follows: 3120, hl: 14, fl: 38, wob: 3 },
  { id: "r2", cap: "3 ingredients. 1 pan. Dinner in 8 min", len: 15, reach: 187000, plays: 271000, replays: 84000, likes: 8900, comments: 410, shares: 5600, saves: 9200, follows: 1640, hl: 10, fl: 46, wob: 2 },
  { id: "r3", cap: "Watch till the end 👀 (the reveal!)", len: 30, reach: 96000, plays: 112000, replays: 16000, likes: 2100, comments: 240, shares: 700, saves: 600, follows: 410, hl: 35, fl: 20, wob: 4 },
  { id: "r4", cap: "Apartment tour: 38m² in Lisbon", len: 41, reach: 71000, plays: 82000, replays: 11000, likes: 2400, comments: 320, shares: 600, saves: 2100, follows: 690, hl: 22, fl: 14, wob: 3 },
  { id: "r5", cap: "Things I wish I knew at 25", len: 19, reach: 133000, plays: 168000, replays: 35000, likes: 6800, comments: 1040, shares: 2900, saves: 3900, follows: 1380, hl: 18, fl: 30, wob: 3 },
  { id: "r6", cap: "GRWM — rainy Sunday ☔", len: 27, reach: 58000, plays: 64000, replays: 6000, likes: 1700, comments: 190, shares: 380, saves: 520, follows: 240, hl: 28, fl: 17, wob: 4 },
  { id: "r7", cap: "How I edit my Reels (free preset)", len: 24, reach: 164000, plays: 221000, replays: 57000, likes: 8400, comments: 1300, shares: 3900, saves: 12800, follows: 2870, hl: 12, fl: 34, wob: 2 },
  { id: "r8", cap: "Trying the viral cloud bread ☁️", len: 12, reach: 89000, plays: 124000, replays: 35000, likes: 4100, comments: 300, shares: 1500, saves: 1100, follows: 520, hl: 16, fl: 40, wob: 2 },
];

export function demoPayload() {
  const now = Date.now();
  const defs = DEFS.map((d, i) => {
    const avgWatchSec = Math.round(meanFrac(makeRet(d.hl, d.fl, d.wob)) * d.len * 10) / 10;
    const ts = now - (i * 1.7 + 1) * 86400000;
    return {
      id: d.id,
      cap: d.cap,
      permalink: "#",
      ts,
      date: fmtDate(ts),
      time: fmtTime(ts),
      len: d.len,
      lenKnown: true,
      reach: d.reach,
      plays: d.plays,
      replays: d.replays,
      likes: d.likes,
      comments: d.comments,
      shares: d.shares,
      saves: d.saves,
      follows: d.follows,
      avgWatchSec,
      looping: avgWatchSec > d.len,
      rates: engagementRates(d),
    };
  });

  const reachS = [];
  const playsS = [];
  for (let i = 0; i < 90; i++) {
    const b = 5200 + i * 30 + Math.sin(i / 3) * 1100 + Math.sin(i / 1.4) * 500 + Math.sin(i * 1.1) * 300;
    const rv = Math.max(900, Math.round(b));
    reachS.push(rv);
    playsS.push(Math.round(rv * (1.28 + Math.sin(i / 2.5) * 0.12)));
  }

  return {
    defs,
    trend: { reachS, playsS, reachModeled: false, playsModeled: false },
    meta: {
      source: "demo",
      fetchedAt: now,
      count: defs.length,
      username: "@studio.lina · Instagram (demo)",
      followers: 48230,
    },
  };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(ts) {
  const d = new Date(ts);
  return MON[d.getMonth()] + " " + d.getDate();
}
function fmtTime(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + String(m).padStart(2, "0") + " " + ap;
}
