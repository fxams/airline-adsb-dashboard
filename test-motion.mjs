import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const LM = require("./public/motion.js");

const fail = [];
function ok(cond, msg) { if (!cond) fail.push(msg); }
function almost(a, b, eps) { return Math.abs(a - b) < eps; }
function nm(a, b) {
  const R2 = Math.PI / 180;
  const x = Math.sin((b[1] - a[1]) * R2 / 2) ** 2 + Math.cos(a[1] * R2) * Math.cos(b[1] * R2) * Math.sin((b[0] - a[0]) * R2 / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(x)));
}

ok(LM.BLEND_MS === 1600, "blend is ~1.6 s");
ok(LM.STALE_S === 1200, "stale gate is 20 min (type last-good window)");
ok(LM.MAX_EXTRAP_S === 900, "time cap 15 min");
ok(LM.MAX_EXTRAP_NM === 120, "distance cap 120 nm");

ok(!LM.canExtrap(0, 90, 0, 35000, 3), "no extrap at 0 kt");
ok(!LM.canExtrap(480, 90, 1, 0, 3), "no extrap on ground");
ok(!LM.canExtrap(null, 90, 0, 35000, 3), "no extrap missing gs");
ok(!LM.canExtrap(480, null, 0, 35000, 3), "no extrap missing track");
ok(!LM.canExtrap(480, 90, 0, 375, 3), "no extrap below 1000 ft");
ok(LM.canExtrap(480, 90, 0, 35000, 90), "extrap with 90 s type-cycle lag");
ok(LM.canExtrap(480, 90, 0, 35000, 400), "extrap with 400 s lag (production cycle ~6 min)");
ok(!LM.canExtrap(480, 90, 0, 35000, 1200), "no extrap when pos_age is 20 min");
ok(LM.canExtrap(480, 90, 0, 35000, 12), "extrap cruise with fresh pos_age");

const east = LM.dest(25, 50, 360, 90, 10);
ok(almost(east[1], 25, 1e-6), "eastbound dest keeps lat");
ok(east[0] > 50, "eastbound dest increases lon");
ok(almost(nm([50, 25], east), 1, 0.02), "360 kt × 10 s is 1 nm");

const cap = LM.dest(25, 50, 480, 90, 1800);
ok(nm([50, 25], cap) <= LM.MAX_EXTRAP_NM + 0.25, "distance cap 120 nm even if dt is huge got " + nm([50, 25], cap).toFixed(3));

const store = {};
const t0 = Date.parse("2026-11-10T12:00:00.000Z");
const row = { lat: 25, lon: 50, gs: 360, trk: 90, onG: 0, alt: 35000, age: 0 };
const m0 = LM.upsert(store, "abc", row, t0, t0);
const d0 = LM.display(m0, t0);
ok(almost(d0[0], 50, 1e-9) && almost(d0[1], 25, 1e-9), "first fix sits on the snapshot");

const d1 = LM.display(m0, t0 + 10000);
ok(d1[0] > d0[0], "coasts east between snapshots");
ok(almost(nm([d0[0], d0[1]], [d1[0], d1[1]]), 1, 0.05), "10 s at 360 kt is ~1 nm");
ok(almost(d1[2], 90, 1e-6), "heading holds between snapshots");

const frozen = {};
LM.upsert(frozen, "gnd", { lat: 25.27, lon: 51.61, gs: 0, trk: 156, onG: 1, alt: 0, age: 2 }, t0, t0);
const g1 = LM.display(frozen.gnd, t0 + 20000);
ok(almost(g1[0], 51.61, 1e-9) && almost(g1[1], 25.27, 1e-9), "on-ground 0 kt does not coast");

const lag = {};
LM.upsert(lag, "st", { lat: 26, lon: 52, gs: 480, trk: 90, onG: 0, alt: 37000, age: 200 }, t0, t0);
const s0 = LM.display(lag.st, t0);
ok(s0[0] > 52, "packed type-cycle age coasts immediately");
const s1 = LM.display(lag.st, t0 + 20000);
ok(s1[0] > s0[0], "keeps coasting through a 6–7 min refresh gap");
ok(nm([52, 26], [s1[0], s1[1]]) > 20, "200+20 s at 480 kt is tens of nm, not a 45 s freeze");

const lost = {};
LM.upsert(lost, "lost", { lat: 26, lon: 52, gs: 480, trk: 90, onG: 0, alt: 37000, age: 1200 }, t0, t0);
const lost1 = LM.display(lost.lost, t0 + 5000);
ok(almost(lost1[0], 52, 1e-9) && almost(lost1[1], 26, 1e-9), "20 min pos_age does not coast");

const miss = {};
LM.upsert(miss, "m", { lat: 26, lon: 52, gs: 480, trk: null, onG: 0, alt: 37000, age: 3 }, t0, t0);
const miss1 = LM.display(miss.m, t0 + 15000);
ok(almost(miss1[0], 52, 1e-9), "missing track does not coast");

const low = {};
LM.upsert(low, "l", { lat: 25.29, lon: 51.59, gs: 147, trk: 156, onG: 0, alt: 375, age: 6 }, t0, t0);
const low1 = LM.display(low.l, t0 + 8000);
ok(almost(low1[0], 51.59, 1e-9) && almost(low1[1], 25.29, 1e-9), "375 ft runway sample does not coast");

const far = {};
const mf = LM.upsert(far, "f", { lat: 25, lon: 50, gs: 600, trk: 90, onG: 0, alt: 40000, age: 2 }, t0, t0);
const dFar = LM.display(mf, t0 + 120000);
ok(nm([50, 25], [dFar[0], dFar[1]]) <= LM.MAX_EXTRAP_NM + 0.05, "ghost cap even after 120 s");

const blendStore = {};
LM.upsert(blendStore, "b", { lat: 25, lon: 50, gs: 360, trk: 90, onG: 0, alt: 35000, age: 3 }, t0, t0);
const coasted = LM.display(blendStore.b, t0 + 20000);
LM.upsert(blendStore, "b", { lat: 25.02, lon: 50.4, gs: 360, trk: 95, onG: 0, alt: 35000, age: 2 }, t0 + 20000, t0 + 20000);
const mid = LM.display(blendStore.b, t0 + 20000 + 800);
ok(mid[0] !== coasted[0] && mid[0] !== 50.4, "blend is between previous display and new fix");
ok(mid[2] > 90 && mid[2] < 95, "heading eases toward the new track");
const done = LM.display(blendStore.b, t0 + 20000 + LM.BLEND_MS);
const landed = LM.dest(25.02, 50.4, 360, 95, 2 + LM.BLEND_MS / 1000);
ok(almost(done[0], landed[0], 1e-6) && almost(done[1], landed[1], 1e-6), "blend completes onto the coasted new fix");
ok(almost(done[2], 95, 1e-6), "heading lands on the new track");

const wrap = LM.lerpAng(350, 10, 0.5);
ok(almost(wrap, 0, 0.6) || almost(wrap, 360, 0.6), "heading interpolates across 360: " + wrap);

LM.upsert(store, "abc", row, t0 + 500, t0);
ok(store.abc === m0 || (store.abc.fixLat === 25 && store.abc.bDur === 0) || LM.sameFix(store.abc, 25, 50, 360, 90, 0), "same snapshot does not restart the blend");

const seen = new Set(["abc"]);
LM.prune(store, seen);
ok(store.abc, "prune keeps seen hex");
ok(!store.zzz, "prune drops unseen");

const html = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
ok(/src="\/motion\.js"/.test(html), "index loads /motion.js");
ok(/setInterval\(poll,15000\)/.test(html), "browser polls /api/live every 15 s");
const srv = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
ok(/REFRESH_SECONDS \|\| 90/.test(srv), "backend type-cycle default stays 90 s");
ok(/u === "\/motion\.js"/.test(srv), "server serves /motion.js");
const mapjs = fs.readFileSync(new URL("./public/map.js", import.meta.url), "utf8");
ok(/requestAnimationFrame\(tick\)/.test(mapjs) && /paintLive\(\{view:true\}\)/.test(mapjs), "rAF paints live markers");
ok(/animGap/.test(mapjs) && /document\.hidden/.test(mapjs), "anim throttles on hidden tabs / phones");

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS", { blendMs: LM.BLEND_MS, staleS: LM.STALE_S, maxExtrapS: LM.MAX_EXTRAP_S, maxExtrapNm: LM.MAX_EXTRAP_NM, coastNm10s: +nm([d0[0], d0[1]], [d1[0], d1[1]]).toFixed(3) });
