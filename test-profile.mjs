import puppeteer from "puppeteer-core";
import fs from "fs";

const BASE = "http://127.0.1:10000".replace("127.0.1", "127.0.0.1");
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });

const fail = [];
const evidence = { utc: new Date().toISOString() };
function ok(cond, msg) { if (!cond) fail.push(msg); }

const t0 = Date.parse("2026-11-09T01:00:00Z");
const climb = [
  [t0, 51.6, 25.2, 5000, 280, 1800, 0],
  [t0 + 120000, 51.7, 25.25, 12000, 340, 1400, 0],
  [t0 + 240000, 51.8, 25.3, 24000, 410, 900, 0],
  [t0 + 360000, 51.9, 25.35, 35000, 470, 200, 0],
  [t0 + 480000, 52.0, 25.4, 37000, 485, 0, 0],
];
const missing = [
  [t0, 55.3, 25.2, 33000, 460, 100, 0],
  [t0 + 90000, 55.35, 25.22, 33500, null, null, 0],
  [t0 + 180000, 55.4, 25.24, 34000, 470, -50, 0],
];
const descent = [
  [t0, 55.36, 25.25, 38000, 490, -200, 0],
  [t0 + 180000, 55.4, 25.22, 22000, 360, -1500, 0],
  [t0 + 360000, 55.45, 25.2, 4000, 210, -800, 0],
];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function open(w, h, tracks, { mobile = w <= 700 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument((trk) => {
    localStorage.clear();
    const orig = window.fetch;
    window.fetch = function (url, opts) {
      const u = String(url);
      if (/\/api\/track(\?|$)/.test(u)) {
        const m = /hex=([^&]+)/.exec(u);
        const hex = decodeURIComponent((m && m[1]) || "").toLowerCase();
        const points = trk[hex] || [];
        return Promise.resolve(new Response(JSON.stringify({ hex, points }), { headers: { "Content-Type": "application/json" } }));
      }
      if (u.includes("/api/route")) {
        return Promise.resolve(new Response(JSON.stringify({ found: false }), { headers: { "Content-Type": "application/json" } }));
      }
      return orig.apply(this, arguments);
    };
  }, tracks);
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof select === "function" && map && map.getLayer && map.getLayer("live"), { timeout: 90000 });
  await page.evaluate(() => {
    L = L || { at: null, ac: [], nm: {} };
    L.at = "2026-11-09T01:08:00.000Z";
    L.ac = [
      ["abc123", "QTR1", "QTR", "B77W", 25.4, 52.0, 37000, 485, 90, "A7-ALX", 0, 2, 0],
      ["def456", "UAE2", "UAE", "A388", 25.2, 55.45, 4000, 210, 270, "A6-EVN", 0, 3, -800]
    ];
    L.nm = { QTR: "Qatar Airways", UAE: "Emirates" };
    if (typeof drawLive === "function") drawLive();
  });
  return page;
}

async function shot(page, name) {
  const p = `${OUT}/${name}.png`;
  const el = await page.$("#sp") || await page.$("#mw");
  if (el) await el.screenshot({ path: p });
  else await page.screenshot({ path: p });
  return p;
}

async function chartState(page) {
  return page.evaluate(() => {
    const c = charts && charts.prof;
    const opt = c && c.getOption && c.getOption();
    const series = (opt && opt.series) || [];
    const names = series.map((s) => s.name || (s[0] && s[0].name) || "").join("|");
    const yNames = ((opt && opt.yAxis) || []).map((y) => (y && y.name) || "").join("|");
    const graphic = JSON.stringify((opt && opt.graphic) || []);
    const nSeries = series.length;
    const tipOn = opt && opt.tooltip && (Array.isArray(opt.tooltip) ? opt.tooltip[0] : opt.tooltip);
    return {
      nSeries,
      names,
      yNames,
      graphic,
      triggerOn: tipOn && tipOn.triggerOn,
      trigger: tipOn && tipOn.trigger,
      profpt: (document.getElementById("profpt") && document.getElementById("profpt").innerText) || "",
      hidden: document.getElementById("prof").style.display === "none",
      nPts: typeof PROF_PTS !== "undefined" ? PROF_PTS.length : 0,
      note: (document.getElementById("spn") && document.getElementById("spn").textContent) || "",
    };
  });
}

async function showIdx(page, i) {
  await page.evaluate((idx) => {
    const c = charts.prof;
    c.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: idx });
    if (typeof PROF_PTS !== "undefined" && PROF_PTS[idx]) showProfPoint(PROF_PTS[idx]);
  }, i);
  await new Promise((r) => setTimeout(r, 80));
  return page.evaluate(() => ({
    pt: (document.getElementById("profpt") && document.getElementById("profpt").innerText) || "",
    tip: [...document.querySelectorAll("#prof div, body > div")].map((e) => e.innerText).find((t) => t && /FL\d|GS |VS /.test(t) && /UTC/.test(t)) || "",
  }));
}

const desk = await open(1280, 860, { abc123: climb, def456: descent }, { mobile: false });
await desk.evaluate(() => select("abc123"));
await desk.waitForFunction(() => document.getElementById("sp").classList.contains("on") && charts && charts.prof, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 400));
let st = await chartState(desk);
ok(st.nSeries === 1 && /FL/.test(st.names), "only the barometric FL series is plotted");
ok(!/Ground speed|Vertical rate/i.test(st.names), "speed and vertical speed are not plotted");
ok(/FL \(baro\)/.test(st.yNames), "Y axis is FL in hundreds of feet, labelled baro");
ok(/avg /.test(st.graphic) && /kt/.test(st.graphic), "average GS annotation on the chart");
ok(/avg /.test(st.graphic) && /ft\/min/.test(st.graphic), "average signed VS annotation on the chart");
ok(/mousemove\|click/.test(st.triggerOn || "") && st.trigger === "axis", "hover and click/tap both trigger point details");
ok(/not a certified flight level/i.test(st.note), "FL source caveat in the note");
ok(/Point/.test(st.profpt) && /FL370/.test(st.profpt) && /485 kt/.test(st.profpt), "default selected point is the last sample, not the average");
ok(!/^avg /m.test(st.profpt), "point readout is distinct from avg annotations");
evidence.climb = { names: st.names, yNames: st.yNames, profpt: st.profpt, graphic: st.graphic.slice(0, 400) };
await shot(desk, "profile-climb-1280");

const p0 = await showIdx(desk, 0);
ok(/FL050|FL50/.test(p0.pt) && /280 kt/.test(p0.pt) && /\+1800 ft\/min/.test(p0.pt), "climb sample shows FL, GS and VS");
ok(/2026-11-09 01:00:00 UTC/.test(p0.pt), "point timestamp is UTC");
evidence.p0 = p0.pt;

const pCruise = await showIdx(desk, 4);
ok(/FL370/.test(pCruise.pt) && /485 kt/.test(pCruise.pt) && /(\+0|0) ft\/min/.test(pCruise.pt), "cruise sample keeps sourced 0 fpm, not n/a");
ok(/Point/.test(pCruise.pt) && !/avg 480/.test(pCruise.pt), "point values are not replaced by the average");

await desk.evaluate(() => select("def456"));
await desk.waitForFunction(() => PROF_PTS && PROF_PTS[0] && PROF_PTS[0].alt === 38000, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 300));
st = await chartState(desk);
ok(/FL040|FL380|FL038/.test(st.profpt) && /−800|avg −/.test(st.graphic + st.profpt), "switching aircraft redraws descent profile");
const d1 = await showIdx(desk, 1);
ok(/FL220/.test(d1.pt) && /360 kt/.test(d1.pt) && /−1500 ft\/min/.test(d1.pt), "descent point keeps signed VS");
evidence.descent = { profpt: st.profpt, d1: d1.pt };
await shot(desk, "profile-descent-1280");
await desk.close();

const miss = await open(1280, 860, { abc123: missing, def456: descent }, { mobile: false });
await miss.evaluate(() => select("abc123"));
await miss.waitForFunction(() => PROF_PTS && PROF_PTS.length >= 3, { timeout: 20000 });
const mid = await showIdx(miss, 1);
ok(/GS n\/a/.test(mid.pt) && /VS n\/a/.test(mid.pt), "missing per-point GS/VS stay n/a");
ok(!/460 kt/.test(mid.pt) && !/100 ft\/min/.test(mid.pt), "missing fields are not filled from a neighbour");
ok(!/avg /.test(mid.pt.split("\n")[0] + mid.pt.split("\n")[1]), "n/a is not the chart average");
st = await chartState(miss);
ok(/avg /.test(st.graphic), "averages remain on the chart while a sparse point is selected");
evidence.missing = { mid: mid.pt, graphic: st.graphic.slice(0, 300) };
await shot(miss, "profile-missing-1280");
await miss.close();

const mob = await open(390, 844, { abc123: climb, def456: descent }, { mobile: true });
await mob.evaluate(() => select("abc123"));
await mob.waitForFunction(() => document.getElementById("sp").classList.contains("on") && charts && charts.prof, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 400));
st = await chartState(mob);
ok(st.nSeries === 1, "mobile still plots FL only");
ok(/click/.test(st.triggerOn || ""), "mobile tap uses click trigger");
await mob.evaluate(() => {
  const c = charts.prof;
  c.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: 2 });
  showProfPoint(PROF_PTS[2]);
});
const tap = await mob.evaluate(() => document.getElementById("profpt").innerText);
ok(/FL240/.test(tap) && /410 kt/.test(tap) && /\+900 ft\/min/.test(tap), "mobile tap/select shows that point's FL, GS and VS");
await mob.evaluate(() => {
  const el = document.getElementById("prof");
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.x + r.width * 0.4, clientY: r.y + r.height * 0.4 }));
});
ok(await mob.evaluate(() => !document.getElementById("profpt").hidden && /Point/.test(document.getElementById("profpt").innerText)), "mobile click on the chart keeps a point readout");
await shot(mob, "profile-tap-390");

await mob.evaluate(() => {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => false });
  HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error("ios"));
  if (typeof syncFS === "function") syncFS();
});
await mob.click("#mfsb");
await new Promise((r) => setTimeout(r, 400));
ok(await mob.evaluate(() => document.body.classList.contains("map-fs") && document.getElementById("mw").contains(document.getElementById("prof"))), "profile stays in map-only fullscreen");
await mob.evaluate(() => { charts.prof.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: 0 }); showProfPoint(PROF_PTS[0]); });
ok(/FL050|FL50/.test(await mob.evaluate(() => document.getElementById("profpt").innerText)), "point details still work in fullscreen");
await shot(mob, "profile-fs-390");
await mob.close();

await browser.close();
evidence.fail = fail;
fs.writeFileSync(OUT + "/profile-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ fail, evidence }, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
