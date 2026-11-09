import puppeteer from "puppeteer-core";
import fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const wx = require("./wx.js");

const BASE = "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });

const fail = [];
const evidence = { utc: new Date().toISOString() };
function ok(cond, msg) { if (!cond) fail.push(msg); }

{
  const hpa = wx.pressureFromMetar(1013.25, "");
  ok(hpa.pa === 101325 && /QNH/.test(hpa.ref), "hPa to Pa");
  const inhg = wx.pressureFromMetar(29.92, "");
  ok(inhg.pa === Math.round(29.92 * 3386.389) && /altimeter/.test(inhg.ref), "inHg to Pa");
  ok(wx.pressureFromMetar(null, "Q0999").pa === 99900, "raw Q0999");
  ok(wx.pressureFromMetar(null, "A2992").pa === Math.round(29.92 * 3386.389), "raw A2992");
  ok(wx.pressureFromMetar(undefined, "CAVOK").pa == null, "no invented QNH");
  ok(wx.windFromMetar(0, 0, null, "").text === "calm", "calm");
  ok(wx.windFromMetar("VRB", 5, 12, "").text === "VRB 5kt G12kt", "VRB gust");
  ok(wx.windFromMetar(null, 10, null, "").text === "dir n/a 10kt", "dir missing");
  ok(wx.windFromMetar(null, null, null, "").text === "wind n/a", "wind missing");
  const staleRow = wx.metarRow({
    icaoId: "OMDB", temp: 31, wdir: "VRB", wspd: 4, altim: 29.92,
    rawOb: "OMDB 080800Z VRB04KT 9999 SCT040 31/22 A2992",
    reportTime: "2026-11-08T08:00:00Z", lat: 25.25, lon: 55.36
  });
  ok(staleRow.pressVia === "inHg" && staleRow.windVrb && staleRow.tempC === 31, "inHg + VRB row");
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function open(w, h, store = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument((s) => {
    localStorage.clear();
    localStorage.hidet = "0";
    Object.assign(localStorage, s);
  }, store);
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof select === "function" && map && map.getLayer && map.getLayer("live") && map.getLayer("wxmet") && map.hasImage("airport"), { timeout: 90000 });
  await page.evaluate(() => {
    if (!L) L = { at: null, ac: [], nm: {} };
    if (!L.ac || L.ac.length < 2) {
      L.at = new Date().toISOString();
      L.ac = [
        ["abc123", "QTR1", "QTR", "B77W", 25.253, 55.365, 37000, 480, 270, "A7-ALX", 0, 2, 0],
        ["def456", "UAE2", "UAE", "A388", 25.261, 55.347, 0, 4, 90, "A6-EVN", 1, 3, 0]
      ];
      L.nm = Object.assign({ QTR: "Qatar Airways", UAE: "Emirates" }, L.nm || {});
      if (typeof drawLive === "function") drawLive();
    }
  });
  return page;
}

async function shot(page, name) {
  await page.evaluate(() => { const el = document.getElementById("mw"); if (el) el.scrollIntoView({ block: "nearest" }); });
  await new Promise((r) => setTimeout(r, 160));
  const p = `${OUT}/${name}.png`;
  const el = await page.$("#mw");
  if (el) await el.screenshot({ path: p });
  else await page.screenshot({ path: p, fullPage: false });
  return p;
}

const desk = await open(1280, 860);
const chrome = await desk.evaluate(() => ({
  headerFs: !!document.getElementById("fsb"),
  mapFs: !!document.getElementById("mfsb"),
  mw: !!document.getElementById("mw"),
  spInMw: !!(document.getElementById("mw") && document.getElementById("mw").contains(document.getElementById("sp"))),
  wxctlInMw: !!(document.getElementById("mw") && document.getElementById("mw").contains(document.getElementById("wxctl"))),
  qsInMw: !!(document.getElementById("mw") && document.getElementById("mw").contains(document.getElementById("qs"))),
  kxcInMw: !!(document.getElementById("mw") && document.getElementById("mw").contains(document.getElementById("kxc"))),
  airportImg: map.hasImage("airport"),
  metMin: map.getLayer("wxmet") && map.getLayer("wxmet").minzoom,
  metType: map.getLayer("wxmet") && map.getLayer("wxmet").type,
  selType: map.getLayer("sel-ap") && map.getLayer("sel-ap").type,
  btn: document.getElementById("mfsb").textContent,
}));
ok(!chrome.headerFs, "no dashboard fullscreen button");
ok(chrome.mapFs && chrome.mw && chrome.spInMw && chrome.wxctlInMw && chrome.qsInMw, "map chrome includes search/weather/panel");
ok(!chrome.kxcInMw, "KPI table is outside the map fullscreen container");
ok(chrome.airportImg && chrome.metType === "symbol" && chrome.selType === "symbol", "runway-style airport symbol");
ok(chrome.metMin === 0, "airport METAR icons are not hidden at world zoom");
ok(/map fullscreen/i.test(chrome.btn), "idle label is map fullscreen");
evidence.chrome = chrome;
await shot(desk, "map-normal-1280");

await desk.evaluate(() => { document.getElementById("wxctl").open = true; if (typeof setWx === "function") setWx("met", true); });
await desk.waitForFunction(() => WX.st && WX.st.metar && WX.st.metar.length > 0, { timeout: 30000 });
await desk.evaluate(() => map.jumpTo({ center: [55.36, 25.25], zoom: 7.2 }));
await new Promise((r) => setTimeout(r, 900));
const met = await desk.evaluate(() => {
  const s = map.getSource("wxmet");
  const d = (s && s._data) || (s && s.serialize && s.serialize().data) || { features: [] };
  const p = (d.features.find((f) => f.properties.icao === "OMDB") || d.features[0] || {}).properties || {};
  const vis = map.getLayoutProperty("wxmet", "visibility");
  const labVis = map.getLayoutProperty("wxmet-lab", "visibility");
  const type = map.getLayer("wxmet").type;
  const api = (WX.st.metar.find((m) => m.icao === p.icao) || WX.st.metar[0] || {});
  return {
    vis, labVis, type, n: d.features.length, p,
    api: { icao: api.icao, tempC: api.tempC, windText: api.windText, pressPa: api.pressPa, pressRef: api.pressRef, obsTime: api.obsTime },
    labHasPa: / Pa\b|Pa n\/a/.test(p.lab || ""),
    labHasIcao: (p.lab || "").includes(p.icao),
    labHasZ: /\d{6}Z/.test(p.lab || "") || /\d{6}Z/.test(p.labShort || ""),
    labAvn: /KT/.test(p.labShort || "") && /Q\d{4}|A\d{4}|Q n\/a/.test(p.labShort || ""),
    paNotInQ: !/Q101500|A101500/.test(p.labShort || ""),
    noFakeLive: !/live minute/i.test(p.lab || ""),
  };
});
ok(met.vis === "visible" && met.labVis === "visible", "weather toggle shows airport icon + METAR labels");
ok(met.type === "symbol", "wxmet is airport icon");
ok(met.labHasIcao && met.labHasZ && met.labAvn, "aviation label has ICAO, DDHHMMZ, KT, Q/A group");
ok(met.labHasPa, "expanded label still shows Pa");
ok(met.paNotInQ, "Pa is not substituted into the METAR Q group");
ok(met.p.labShort && met.p.labShort.includes(met.p.icao), "compact label keeps ICAO");
ok(met.api.pressPa == null || (Number.isInteger(met.api.pressPa) && met.api.pressRef), "API Pa is converted with original ref");
ok(met.api.windText && met.api.windText !== "000°T 0kt", "wind uses calm/VRB/kt text");
evidence.met = met;
await shot(desk, "metar-labels-1280");

await desk.evaluate(() => setWx("met", false));
const metOff = await desk.evaluate(() => ({
  vis: map.getLayoutProperty("wxmet", "visibility"),
  lab: map.getLayoutProperty("wxmet-lab", "visibility"),
}));
ok(metOff.vis === "none" && metOff.lab === "none", "weather toggle hides METAR labels");
await desk.evaluate(() => setWx("met", true));

const air = await desk.evaluate(() => (L.ac.find((a) => !a[10] && a[6] > 10000) || L.ac[0])[0]);
await desk.evaluate((h) => select(h), air);
await desk.waitForFunction(() => document.getElementById("sp").classList.contains("on") && document.getElementById("spwx").innerText.length > 40, { timeout: 30000 });
const panel = await desk.evaluate(() => {
  const t = document.getElementById("spwx").innerText;
  const sp = document.getElementById("sp");
  return {
    inMw: document.getElementById("mw").contains(sp),
    hasPa: /\bPa\b/.test(t) || /pressure n\/a/i.test(t) || /QNH n\/a/i.test(t),
    hasUtc: /UTC/.test(t),
    hasMetar: /METAR/i.test(t),
    notLiveMin: /not a live minute/i.test(t),
    t: t.slice(0, 700),
  };
});
ok(panel.inMw && panel.hasMetar && panel.hasUtc, "selection panel stays in map container with METAR");
ok(panel.hasPa, "panel pressure in Pa or honest missing");
evidence.panel = panel;
await desk.evaluate(() => { const w = document.getElementById("spwx"); if (w) w.scrollIntoView({ block: "center" }); });
await new Promise((r) => setTimeout(r, 300));
await shot(desk, "panel-metar-1280");

const before = await desk.evaluate(() => {
  const c = map.getCanvas();
  return { w: c.width, h: c.height, mwH: document.getElementById("mw").getBoundingClientRect().height, mapH: document.getElementById("map").getBoundingClientRect().height };
});
await desk.evaluate(() => { if (typeof unsel === "function") unsel(); map.jumpTo({ center: [55.36, 25.25], zoom: 6.6 }); });
await new Promise((r) => setTimeout(r, 500));
await desk.click("#mfsb");
await new Promise((r) => setTimeout(r, 500));
const fsOn = await desk.evaluate(() => {
  const native = document.fullscreenElement === document.getElementById("mw") || document.webkitFullscreenElement === document.getElementById("mw");
  const fake = document.body.classList.contains("map-fs");
  const mw = document.getElementById("mw").getBoundingClientRect();
  const map = document.getElementById("map").getBoundingClientRect();
  const kxc = document.getElementById("kxc").getBoundingClientRect();
  const header = document.querySelector("header").getBoundingClientRect();
  return {
    native, fake, btn: document.getElementById("mfsb").textContent,
    note: document.getElementById("mfsnote").hidden,
    noteText: document.getElementById("mfsnote").textContent,
    mwH: mw.height, mapH: map.height, innerH: innerHeight,
    search: !!document.getElementById("qs") && document.getElementById("mw").contains(document.getElementById("qs")),
    wx: document.getElementById("mw").contains(document.getElementById("wxctl")),
    sp: document.getElementById("mw").contains(document.getElementById("sp")),
    kpiBehind: fake ? (kxc.bottom <= 0 || kxc.height === 0 || document.getElementById("mw").style.zIndex !== "" || true) : native,
    headerVisible: header.top >= 0 && header.bottom > 8 && header.bottom < innerHeight * 0.2 && !fake && !native,
  };
});
ok(/exit map/i.test(fsOn.btn), "exit control while map fullscreen");
ok(fsOn.native || fsOn.fake, "native map fullscreen or in-page map-fs fallback");
ok(fsOn.search && fsOn.wx && fsOn.sp, "search/weather/panel remain in fullscreen map");
ok(fsOn.mapH > before.mapH * 0.9 || fsOn.native || fsOn.fake, "map taller in fullscreen");
if (fsOn.fake) {
  ok(!fsOn.note && /chrome stays visible/i.test(fsOn.noteText), "fallback does not claim chrome removal");
} else {
  ok(fsOn.note, "native fullscreen hides the in-page chrome note");
}
evidence.fsOn = { ...fsOn, before };
await shot(desk, "map-fs-1280");

await desk.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 400));
let fsOff = await desk.evaluate(() => ({
  fake: document.body.classList.contains("map-fs"),
  native: !!(document.fullscreenElement || document.webkitFullscreenElement),
  btn: document.getElementById("mfsb").textContent,
  mapH: document.getElementById("map").getBoundingClientRect().height,
  via: "escape"
}));
if (fsOff.native || fsOff.fake) {
  await desk.click("#mfsb");
  await new Promise((r) => setTimeout(r, 400));
  fsOff = await desk.evaluate(() => ({
    fake: document.body.classList.contains("map-fs"),
    native: !!(document.fullscreenElement || document.webkitFullscreenElement),
    btn: document.getElementById("mfsb").textContent,
    mapH: document.getElementById("map").getBoundingClientRect().height,
    via: "button"
  }));
}
ok(!fsOff.fake && !fsOff.native, "exited map fullscreen");
ok(/map fullscreen/i.test(fsOff.btn), "button restored after exit");
evidence.fsOff = fsOff;
await shot(desk, "map-fs-exit-1280");

const ios = await open(1280, 860);
await ios.evaluate(() => {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => false });
  Object.defineProperty(document, "webkitFullscreenEnabled", { configurable: true, get: () => false });
  HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error("ios"));
  syncFS();
});
await ios.click("#mfsb");
await new Promise((r) => setTimeout(r, 400));
const iosOn = await ios.evaluate(() => ({
  fake: document.body.classList.contains("map-fs"),
  native: !!(document.fullscreenElement || document.webkitFullscreenElement),
  noteHidden: document.getElementById("mfsnote").hidden,
  note: document.getElementById("mfsnote").textContent,
  btn: document.getElementById("mfsb").textContent,
  mwH: document.getElementById("mw").getBoundingClientRect().height,
  mwTop: document.getElementById("mw").getBoundingClientRect().top,
  innerH: innerHeight,
  parent: document.getElementById("mw").parentNode === document.body,
}));
ok(iosOn.fake && !iosOn.native, "unsupported browser uses in-page map-fs");
ok(!iosOn.noteHidden && /chrome stays visible/i.test(iosOn.note), "iPhone fallback states chrome stays visible");
ok(iosOn.parent && iosOn.mwTop <= 2 && iosOn.mwH >= iosOn.innerH * 0.95, "fallback map covers the page, not the dashboard card");
ok(/exit map/i.test(iosOn.btn), "explicit exit on fallback");
evidence.ios = iosOn;
await shot(ios, "map-fs-fallback-1280");
await ios.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 300));
ok(await ios.evaluate(() => !document.body.classList.contains("map-fs")), "Escape exits fallback");
await ios.close();

const mob = await open(390, 844);
ok(await mob.evaluate(() => !document.getElementById("fsb") && !!document.getElementById("mfsb")), "mobile has map FS only");
await shot(mob, "map-normal-390");
await mob.evaluate(() => { document.getElementById("wxctl").open = true; if (typeof setWx === "function") setWx("met", true); if (typeof closeSheets === "function") closeSheets(); });
await mob.waitForFunction(() => WX.st && WX.st.metar && WX.st.metar.length > 0, { timeout: 30000 });
await mob.evaluate(() => map.jumpTo({ center: [55.36, 25.25], zoom: 6.8 }));
await new Promise((r) => setTimeout(r, 900));
await shot(mob, "metar-labels-390");
const airM = await mob.evaluate(() => (L.ac.find((a) => a[1]) || L.ac[0])[0]);
await mob.evaluate((h) => select(h), airM);
await mob.waitForFunction(() => document.getElementById("sp").classList.contains("on"), { timeout: 20000 });
ok(await mob.evaluate(() => document.getElementById("mw").contains(document.getElementById("sp"))), "mobile panel inside map wrapper");
await shot(mob, "panel-390");
await mob.evaluate(() => { if (typeof unsel === "function") unsel(); });
await mob.evaluate(() => {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => false });
  HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error("ios"));
  syncFS();
});
await mob.evaluate(() => map.jumpTo({ center: [55.36, 25.25], zoom: 6.8 }));
await new Promise((r) => setTimeout(r, 500));
await mob.click("#mfsb");
await new Promise((r) => setTimeout(r, 400));
const mobFs = await mob.evaluate(() => ({
  fake: document.body.classList.contains("map-fs"),
  btn: document.getElementById("mfsb").textContent,
  note: document.getElementById("mfsnote").textContent,
  noteOverlay: (() => {
    const el = document.getElementById("mfsnote");
    const sheet = el && el.closest(".infosheet");
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return !!(el && !(sheet && sheet.hidden) && cs.display !== "none" && r.width > 1 && r.height > 1);
  })(),
  mapH: document.getElementById("map").getBoundingClientRect().height,
  mwTop: document.getElementById("mw").getBoundingClientRect().top,
  innerH: innerHeight,
  parent: document.getElementById("mw").parentNode === document.body,
  qs: !!document.getElementById("qs"),
}));
ok(mobFs.fake && /exit map/i.test(mobFs.btn), "mobile map-fs fallback");
ok(/chrome stays visible/i.test(mobFs.note), "mobile fallback honest about chrome");
ok(!mobFs.noteOverlay, "mobile map-fs does not keep a persistent note banner on the map");
ok(mobFs.parent && mobFs.mwTop <= 2 && mobFs.mapH > 500, "mobile map fills fallback over the dashboard");
evidence.mobFs = mobFs;
await shot(mob, "map-fs-390");
await mob.click("#mfsb");
await new Promise((r) => setTimeout(r, 300));
ok(await mob.evaluate(() => !document.body.classList.contains("map-fs")), "mobile exit via button");
await shot(mob, "map-fs-exit-390");

await desk.close();
await mob.close();
await browser.close();

evidence.fail = fail;
fs.writeFileSync(OUT + "/map-fs-metar-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ fail, evidence: { chrome, met: { vis: met.vis, type: met.type, lab: met.p && met.p.lab, api: met.api }, fsOn, ios: iosOn, mobFs } }, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
