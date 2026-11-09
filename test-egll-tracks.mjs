import puppeteer from "puppeteer-core";
import fs from "fs";
import http from "http";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const A = require("./public/airports.js");

const BASE = "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });

const fail = [];
const evidence = { utc: new Date().toISOString() };
function ok(cond, msg) { if (!cond) fail.push(msg); }

const EGLL = A.resolveApt("EGLL");
ok(EGLL && EGLL.id === "LHR", "catalog EGLL");

// Observed-style QTR arrival (descending from the east) and departure (climbing west).
const ARR = [
  [51.455, -0.20],
  [51.460, -0.28],
  [51.465, -0.36],
  [51.468, -0.42],
  [51.470, -0.45]
];
const DEP = [
  [51.471, -0.47],
  [51.478, -0.55],
  [51.490, -0.68],
  [51.505, -0.85]
];
const GND = [EGLL.lat, EGLL.lon];

const MOCK_GROUND = {
  airport: "LHR", icao: "EGLL", iata: "LHR", name: EGLL.name,
  center: [EGLL.lon, EGLL.lat], radius_nm: 8, air_radius_nm: 40,
  time_utc: new Date().toISOString(),
  live: 1, held: 0,
  ac: [[
    "abcqtr", "QTR11", "QTR", "A359", GND[0], GND[1], 270, 8, "taxi", 4, 1, "live", null, null, "A7-ANB", "LHR"
  ]],
  air: [
    ["qarr1", "QTR17", "QTR", "B77W", ARR[ARR.length - 1][0], ARR[ARR.length - 1][1], 1800, 210, 270, "A7-BAE", 0, 3, -800],
    ["qdep1", "QTR8", "QTR", "A359", DEP[DEP.length - 1][0], DEP[DEP.length - 1][1], 4200, 280, 280, "A7-ALH", 0, 2, 1200]
  ],
  source: "test mock"
};

function api(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    }).on("error", reject);
  });
}

{
  const egll = await api("/api/ground?apt=EGLL");
  const lhr = await api("/api/ground?apt=LHR");
  const bad = await api("/api/ground?apt=XXXX");
  const list = await api("/api/airports");
  ok(egll.status === 200, "GET /api/ground?apt=EGLL is accepted");
  ok(lhr.status === 200, "GET /api/ground?apt=LHR is accepted");
  ok(bad.status === 400, "unknown apt is 400");
  const j = JSON.parse(list.body);
  ok(j.presets && j.presets.includes("LHR"), "/api/airports lists LHR preset");
  ok((j.hubs || []).some((h) => h.icao === "EGLL"), "/api/airports includes EGLL");
  const ge = JSON.parse(egll.body);
  evidence.groundLive = { status: egll.status, airport: ge.airport, icao: ge.icao, live: ge.live, held: ge.held, air: (ge.air || []).length, err: ge.error || null, src: ge.source };
  ok(ge.airport === "LHR" && ge.icao === "EGLL", "EGLL request normalises to LHR/EGLL");
  ok(ge.air_radius_nm === 40 && ge.radius_nm === 8, "40 nm airborne / 8 nm surface in payload");
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function open(w, h, { mobile = w <= 700, intercept = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.setCacheEnabled(false);
  if (intercept) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("/api/ground")) {
        req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_GROUND) });
      } else req.continue();
    });
  }
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.hidet = "0"; localStorage.apt = "G"; });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof setApt === "function" && map && map.loaded && map.loaded() && typeof AirportHubs !== "undefined", { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 400));
  return page;
}

async function seedTracks(page) {
  return page.evaluate((cfg) => {
    L = L || { at: null, ac: [], nm: {} };
    L.at = new Date().toISOString();
    L.nm = Object.assign({ QTR: "Qatar Airways" }, L.nm || {});
    const lastArr = cfg.arr[cfg.arr.length - 1];
    const lastDep = cfg.dep[cfg.dep.length - 1];
    L.ac = [
      ["qarr1", "QTR17", "QTR", "B77W", lastArr[0], lastArr[1], 1800, 210, 270, "A7-BAE", 0, 3, -800],
      ["qdep1", "QTR8", "QTR", "A359", lastDep[0], lastDep[1], 4200, 280, 280, "A7-ALH", 0, 2, 1200]
    ];
    TR.qarr1 = cfg.arr.map(([la, lo]) => [lo, la]);
    TR.qdep1 = cfg.dep.map(([la, lo]) => [lo, la]);
    LOCAL_AIR = cfg.air;
    GND_AC = cfg.gnd;
    const trl = document.getElementById("trl"); if (trl) trl.checked = true;
    if (typeof gSetup === "function") gSetup();
    if (typeof gPaint === "function") gPaint(GND_AC);
    if (typeof drawLive === "function") drawLive();
  }, { arr: ARR, dep: DEP, air: MOCK_GROUND.air, gnd: MOCK_GROUND.ac });
}

async function shot(page, name) {
  await page.evaluate(() => { const el = document.getElementById("mw"); if (el) el.scrollIntoView({ block: "nearest" }); });
  await new Promise((r) => setTimeout(r, 250));
  const p = `${OUT}/${name}.png`;
  const el = await page.$("#mw");
  if (el) await el.screenshot({ path: p });
  else await page.screenshot({ path: p, fullPage: false });
  return p;
}

async function measure(page) {
  return page.evaluate((egll) => {
    const btns = [...document.querySelectorAll("#aps button")].map((b) => ({ a: b.dataset.a, t: b.textContent.trim(), on: b.classList.contains("on") }));
    const sat = map.getLayer("sat") && map.getLayoutProperty("sat", "visibility");
    const gnd = map.getLayer("gnd") && map.getLayoutProperty("gnd", "visibility");
    const trails = map.getSource("trails") && map.getSource("trails")._data;
    const live = map.getSource("live") && map.getSource("live")._data;
    const gsrc = map.getSource("gnd") && map.getSource("gnd")._data;
    const c = map.getCenter();
    const nTrail = trails && trails.features ? trails.features.length : 0;
    const liveCs = (live && live.features || []).map((f) => f.properties.cs);
    const trailCs = (trails && trails.features || []).map((f) => f.properties.a);
    return {
      btns, sat, gndVis: gnd, apt: APT, zoom: map.getZoom(),
      center: [c.lng, c.lat], nTrail, liveCs, trailCs,
      nGnd: gsrc && gsrc.features ? gsrc.features.length : 0,
      gp: document.getElementById("gp") && getComputedStyle(document.getElementById("gp")).display,
      gpt: (document.getElementById("gpt") || {}).textContent || "",
      hidet: localStorage.hidet,
      nearEgll: typeof hv === "function" ? hv(c.lat, c.lng, egll.lat, egll.lon) : null
    };
  }, EGLL);
}

const desk = await open(1280, 860, { mobile: false });
{
  const chrome = await desk.evaluate(() => ({
    labels: [...document.querySelectorAll("#aps button")].map((b) => b.textContent.trim()),
    ids: [...document.querySelectorAll("#aps button")].map((b) => b.dataset.a),
    title: (document.querySelector('#aps button[data-a="LHR"]') || {}).title || ""
  }));
  ok(chrome.ids.includes("LHR") && chrome.labels.includes("LHR"), "LHR preset button in chrome");
  ok(/EGLL/i.test(chrome.title), "LHR button titles EGLL");
  evidence.chrome = chrome;
}

await desk.evaluate(() => { APT_FLY = false; setApt("LHR", { fly: false }); });
await desk.evaluate((ll) => { map.jumpTo({ center: ll, zoom: 12.2, bearing: 0, pitch: 0 }); map.resize(); }, [EGLL.lon, EGLL.lat]);
await new Promise((r) => setTimeout(r, 500));
await seedTracks(desk);
await new Promise((r) => setTimeout(r, 400));
const stLhr = await measure(desk);
ok(stLhr.apt === "LHR", "setApt(LHR) stores LHR");
ok(stLhr.sat === "visible", "satellite on at LHR/EGLL");
ok(stLhr.gndVis === "visible", "ground layer on at LHR/EGLL");
ok(stLhr.zoom >= 11, "airport zoom at LHR");
ok(stLhr.nearEgll != null && stLhr.nearEgll < 8, "map centre is at EGLL");
ok(stLhr.liveCs.includes("QTR17") && stLhr.liveCs.includes("QTR8"), "QTR arrival and departure in live layer");
ok(stLhr.nTrail >= 2, "flown trails drawn for EGLL QTR");
ok(stLhr.nGnd >= 1, "QTR ground marker at EGLL");
ok(/EGLL/i.test(stLhr.gpt), "ground panel names EGLL");
evidence.lhr = stLhr;
evidence.desk = await shot(desk, "egll-tracks-desk");

await desk.evaluate(() => { if (typeof select === "function") select("qarr1"); });
await new Promise((r) => setTimeout(r, 300));
const sel = await desk.evaluate(() => {
  const src = map.getSource("sel") && map.getSource("sel")._data;
  const flown = (src && src.features || []).filter((f) => f.properties.k === "flown");
  return { cs: (document.getElementById("spcs") || {}).textContent, nFlown: flown.length, vis: map.getLayoutProperty("sel-flown", "visibility") };
});
ok(sel.cs === "QTR17", "selected EGLL arrival callsign");
ok(sel.vis === "visible", "selected flown track visible");
evidence.sel = sel;
evidence.deskSel = await shot(desk, "egll-qtr-arrival-sel");
await desk.close();

const mob = await open(390, 844);
await mob.evaluate(() => { APT_FLY = false; setApt("LHR", { fly: false }); });
await mob.evaluate((ll) => { map.jumpTo({ center: ll, zoom: 12.4 }); map.resize(); }, [EGLL.lon, EGLL.lat]);
await seedTracks(mob);
await new Promise((r) => setTimeout(r, 400));
const stMob = await measure(mob);
ok(stMob.apt === "LHR" && stMob.sat === "visible", "mobile LHR satellite");
ok(stMob.nTrail >= 2, "mobile EGLL trails");
const apsBox = await mob.evaluate(() => {
  const aps = document.getElementById("aps").getBoundingClientRect();
  const mw = document.getElementById("mw").getBoundingClientRect();
  return { apsH: aps.height, mwH: mw.height, apsW: aps.width, overflow: getComputedStyle(document.getElementById("aps")).overflowX };
});
ok(apsBox.apsH < apsBox.mwH * 0.2 || apsBox.apsH < 56, "mobile airport chips stay compact");
evidence.mob = stMob;
evidence.apsBox = apsBox;
evidence.mobShot = await shot(mob, "egll-tracks-iphone");
await mob.close();

const auto = await open(1280, 860, { mobile: false });
await auto.evaluate(() => { APT_FLY = false; setApt("G", { fly: false }); });
await auto.evaluate((ll) => { map.jumpTo({ center: ll, zoom: 11.2 }); }, [EGLL.lon, EGLL.lat]);
await auto.evaluate(() => { if (typeof onAptMove === "function") onAptMove(); });
await new Promise((r) => setTimeout(r, 400));
const stAuto = await measure(auto);
ok(stAuto.apt === "LHR", "zooming into EGLL auto-enables LHR overlay");
ok(stAuto.sat === "visible", "auto EGLL zoom turns satellite on");
evidence.auto = stAuto;
evidence.autoShot = await shot(auto, "egll-auto-zoom");
await auto.close();

const doh = await open(1280, 860, { mobile: false });
await doh.evaluate(() => { APT_FLY = false; setApt("DOH", { fly: false }); });
await doh.evaluate(() => { map.jumpTo({ center: [51.6081, 25.2731], zoom: 13 }); });
const stDoh = await measure(doh);
ok(stDoh.apt === "DOH" && stDoh.sat === "visible", "DOH preset still enables satellite");
evidence.doh = { apt: stDoh.apt, sat: stDoh.sat };
await doh.close();

await browser.close();
evidence.fail = fail;
fs.writeFileSync(OUT + "/egll-tracks-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ fail, evidence: { chrome: evidence.chrome, lhr: stLhr, auto: stAuto, groundLive: evidence.groundLive, shots: [evidence.desk, evidence.deskSel, evidence.mobShot, evidence.autoShot] } }, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
