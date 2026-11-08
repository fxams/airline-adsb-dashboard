import puppeteer from "puppeteer-core";
import fs from "fs";

const BASE = "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

const fail = [];
const evidence = { utc: new Date().toISOString(), samples: [] };

async function open(w, h) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.hidet = "0"; localStorage.reglab = "1"; });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof select === "function" && map && map.getLayer && map.getLayer("live") && L && L.ac && L.ac.length > 20, { timeout: 120000 });
  return page;
}

function pickLive(ac) {
  const num = (a) => /^[A-Z]{3}\d+$/.test(a[1]);
  const alpha = (a) => /^[A-Z]{3}\d*[A-Z]/.test(a[1]);
  const qtrN = ac.find((a) => a[2] === "QTR" && num(a) && a[9]);
  const qtrA = ac.find((a) => a[2] === "QTR" && alpha(a) && a[9]);
  const uaeN = ac.find((a) => a[2] === "UAE" && num(a) && a[9]);
  const uaeA = ac.find((a) => a[2] === "UAE" && alpha(a) && a[9]);
  const noreg = ac.find((a) => !a[9] || !String(a[9]).trim());
  return { qtrN, qtrA, uaeN, uaeA, noreg };
}

const desk = await open(1280, 860);
const live = await desk.evaluate(() => ({ at: L.at, n: L.ac.length, ac: L.ac }));
const picks = pickLive(live.ac);
evidence.liveAt = live.at;
evidence.liveN = live.n;
evidence.picks = Object.fromEntries(Object.entries(picks).map(([k, a]) => [k, a && { hex: a[0], cs: a[1], al: a[2], typ: a[3], reg: a[9] }]));

if (!picks.qtrN || !picks.qtrA || !picks.uaeN || !picks.uaeA) fail.push("missing live QTR/UAE numeric or alphanumeric sample");

async function adsbdb(cs) {
  const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, { headers: { "User-Agent": "airline-adsb-dashboard-audit" } });
  const j = await r.json().catch(() => ({}));
  const f = (j.response && j.response.flightroute) || {};
  return { http: r.status, callsign: f.callsign, callsign_icao: f.callsign_icao, callsign_iata: f.callsign_iata, airline_iata: f.airline && f.airline.iata, o: f.origin && f.origin.iata_code, d: f.destination && f.destination.iata_code };
}

for (const key of ["qtrN", "qtrA", "uaeN", "uaeA"]) {
  const a = picks[key];
  if (!a) continue;
  const db = await adsbdb(a[1]);
  evidence.samples.push({ kind: key, adsB: { cs: a[1], reg: a[9], hex: a[0] }, adsbdb: db });
  await new Promise((r) => setTimeout(r, 1100));
}

async function panelOf(page, hex) {
  await page.evaluate((h) => select(h), hex);
  await page.waitForFunction((h) => document.getElementById("sp").classList.contains("on") && document.getElementById("sp").dataset.hex === h, { timeout: 20000 }, hex);
  await new Promise((r) => setTimeout(r, 900));
  return page.evaluate(() => {
    const t = document.getElementById("spb").innerText;
    const id = (t.split("IDENTITY")[1] || t).split("POSITION")[0];
    const field = (label) => {
      const m = id.match(new RegExp(label.replace(/ /g, "\\s+") + "\\s+([^\\n]+)", "i"));
      return m ? m[1].trim() : null;
    };
    return {
      header: document.getElementById("spcs").textContent,
      headerKind: document.querySelector(".spk") && document.querySelector(".spk").textContent,
      callsign: field("Callsign"),
      flightNo: field("Flight number"),
      iataForm: field("IATA-form callsign") || field("IATA-prefix spelling"),
      identity: id.slice(0, 900),
    };
  });
}

if (picks.qtrA) {
  const p = await panelOf(desk, picks.qtrA[0]);
  evidence.panelAlpha = p;
  if (p.header !== picks.qtrA[1]) fail.push("header is not ADS-B callsign " + p.header);
  if (!/callsign/i.test(p.headerKind || "")) fail.push("header not labelled ADS-B callsign");
  if (p.flightNo !== "Unavailable") fail.push("alphanumeric flight number not Unavailable: " + p.flightNo);
  if (p.iataForm && !/not a ticketed|unavailable/i.test(p.iataForm)) fail.push("IATA prefix shown as if it were a flight number: " + p.iataForm);
  if (/IATA-prefix spelling|IATA-form callsign/i.test(p.identity) && !/not a verified|not a ticketed/i.test(p.identity)) fail.push("IATA spelling cell without disclaimer");
  if (p.callsign && p.callsign !== picks.qtrA[1] && p.callsign !== picks.qtrA[1].toUpperCase()) fail.push("panel callsign mismatch");
  await desk.screenshot({ path: `${OUT}/desktop_identity_alpha.png` });
}
if (picks.qtrN) {
  const p = await panelOf(desk, picks.qtrN[0]);
  evidence.panelNum = p;
  if (p.flightNo !== "Unavailable") fail.push("numeric callsign treated as flight number: " + p.flightNo);
  await desk.screenshot({ path: `${OUT}/desktop_identity_numeric.png` });
}

const searchCases = [];
async function typeSearch(page, q) {
  await page.evaluate(() => { document.getElementById("qs").value = ""; });
  await page.type("#qs", q, { delay: 20 });
  await page.waitForFunction(() => { const el = document.getElementById("qres"); return el && !el.hidden; }, { timeout: 8000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 350));
  return page.evaluate(() => {
    const box = document.getElementById("qres");
    return { hidden: box.hidden, text: box.innerText, html: box.innerHTML.slice(0, 1200) };
  });
}

if (picks.qtrA) {
  const cs = picks.qtrA[1];
  const iata = "QR" + cs.slice(3);
  const trunc = iata.replace(/[A-Z]$/, "");
  const alias = await typeSearch(desk, iata);
  searchCases.push({ q: iata, expect: "alias", ...alias });
  if (!/callsign alias/i.test(alias.text)) fail.push("IATA prefix not labelled callsign alias: " + iata);
  if (/ticketed flight number result|flight no\./i.test(alias.text) && !/not a ticketed/i.test(alias.text)) fail.push("alias claimed as flight number");
  if (trunc !== iata) {
    const t = await typeSearch(desk, trunc);
    searchCases.push({ q: trunc, expect: "no alpha suffix match", ...t });
    if (t.text.includes(cs) && /callsign alias/i.test(t.text) && trunc.length < iata.length) {
      fail.push("truncated IATA " + trunc + " matched alphanumeric " + cs);
    }
  }
  const exact = await typeSearch(desk, cs);
  searchCases.push({ q: cs, expect: "callsign", ...exact });
  if (!/Callsign/.test(exact.text)) fail.push("exact callsign not labelled Callsign");
}
if (picks.qtrN) {
  const cs = picks.qtrN[1];
  const iata = "QR" + cs.slice(3);
  const alias = await typeSearch(desk, iata);
  searchCases.push({ q: iata, expect: "numeric alias", ...alias });
  if (alias.text.includes(cs) && !/callsign alias/i.test(alias.text)) fail.push("numeric IATA match not labelled alias");
  const reg = picks.qtrN[9];
  if (reg) {
    const r1 = await typeSearch(desk, reg);
    const r2 = await typeSearch(desk, reg.replace("-", " ").toLowerCase());
    searchCases.push({ q: reg, expect: "reg exact", ...r1 }, { q: "forgiving " + reg, ...r2 });
    if (!r1.text.includes(cs) && !r1.text.includes(reg)) fail.push("registration exact missed " + reg);
    if (!r2.text.includes(cs) && !r2.text.includes(reg.replace("-", ""))) fail.push("forgiving registration missed");
    const partial = reg.replace("-", "").slice(0, 4);
    const rp = await typeSearch(desk, partial);
    searchCases.push({ q: partial, expect: "reg partial", ...rp });
  }
}
const miss = await typeSearch(desk, "ZZ9ZZZ99");
searchCases.push({ q: "ZZ9ZZZ99", expect: "none", ...miss });
if (!/does not mean the flight is not operating/i.test(miss.text)) fail.push("no-match message missing");
if (!/not searched/i.test(miss.text) && !/ticketed/i.test(miss.text)) fail.push("no-match should say flight numbers are not searched");
evidence.search = searchCases;

await desk.click("#qclr");
const lgDesk = await desk.evaluate(() => {
  const el = document.querySelector(".lg");
  const s = getComputedStyle(el);
  return { display: s.display, visibility: s.visibility, w: el.getBoundingClientRect().width };
});
evidence.legendDesktop = lgDesk;
if (lgDesk.display !== "none") fail.push("desktop legend still visible");
await desk.screenshot({ path: `${OUT}/desktop_no_legend_search.png` });

await desk.evaluate(() => setRegLabels(true));
await desk.evaluate(() => map.jumpTo({ center: [51.6, 25.3], zoom: 7.2 }));
await new Promise((r) => setTimeout(r, 800));
const labsOn = await desk.evaluate(() => ({
  on: localStorage.reglab,
  vis: map.getLayoutProperty("live-reg", "visibility"),
  zoom: map.getZoom(),
}));
evidence.labelsCloseZoom = labsOn;
if (labsOn.vis !== "visible") fail.push("reg labels not visible at zoom 7.2");
await desk.screenshot({ path: `${OUT}/desktop_reg_labels_zoom.png` });
await desk.evaluate(() => map.jumpTo({ center: [35, 28], zoom: 2 }));
await new Promise((r) => setTimeout(r, 400));
const labsFar = await desk.evaluate(() => {
  const feats = map.queryRenderedFeatures({ layers: ["live-reg", "live-reg-sel"] });
  return { zoom: map.getZoom(), n: feats.length };
});
evidence.labelsWorldZoom = labsFar;
if (labsFar.n !== 0) fail.push("reg labels rendered at world zoom");
await desk.evaluate(() => setRegLabels(false));
const labsOff = await desk.evaluate(() => ({ vis: map.getLayoutProperty("live-reg", "visibility"), stored: localStorage.reglab }));
if (labsOff.vis !== "none" || labsOff.stored !== "0") fail.push("reg label toggle off not persisted");

const hidet = await desk.evaluate(() => ({ before: localStorage.hidet, visLive: map.getLayoutProperty("live", "visibility") }));
await desk.evaluate(() => setHideTracks(true));
const hide = await desk.evaluate(() => ({
  hidet: localStorage.hidet,
  rem: map.getLayoutProperty("sel-rem", "visibility"),
  live: map.getLayoutProperty("live", "visibility"),
  lab: map.getLayoutProperty("live-reg", "visibility"),
}));
evidence.hideTracks = { hidet, hide };
if (hide.live === "none") fail.push("hide tracks hid aircraft");
if (hide.rem !== "none") fail.push("hide tracks did not hide rem");
await desk.evaluate(() => setHideTracks(false));

await desk.click("#mfsb");
await new Promise((r) => setTimeout(r, 400));
const fsState = await desk.evaluate(() => ({
  btn: document.getElementById("mfsb").textContent,
  fake: document.body.classList.contains("map-fs"),
  dash: document.body.classList.contains("dash-focus"),
  native: !!(document.fullscreenElement || document.webkitFullscreenElement),
  headerFs: !!document.getElementById("fsb"),
  kpisCovered: (() => { const mw = document.getElementById("mw").getBoundingClientRect(); return mw.height >= innerHeight * 0.9 || document.body.classList.contains("map-fs") || !!(document.fullscreenElement); })(),
}));
evidence.fullscreen = fsState;
if (fsState.headerFs || fsState.dash) fail.push("dashboard fullscreen still present");
if (!/exit/i.test(fsState.btn) && !fsState.fake && !fsState.native) fail.push("map fullscreen/expand did not engage");
await desk.screenshot({ path: `${OUT}/desktop_fullscreen_or_expand.png` });
await desk.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 300));
const fs2 = await desk.evaluate(() => ({
  btn: document.getElementById("mfsb").textContent,
  fake: document.body.classList.contains("map-fs"),
  native: !!(document.fullscreenElement || document.webkitFullscreenElement),
}));
evidence.fullscreenAfterEsc = fs2;
if (fs2.fake) fail.push("Escape did not exit expanded map");

await desk.close();

const mob = await open(390, 844);
await mob.evaluate(() => {
  const i = document.getElementById("infosheet");
  if (i) i.hidden = false;
  const inf = document.getElementById("infobtn");
  if (inf) inf.setAttribute("aria-expanded", "true");
});
const lgMob = await mob.evaluate(() => {
  const sheet = document.getElementById("infosheet");
  const el = document.querySelector(".infosheet .lg, .lg");
  const s = el && getComputedStyle(el);
  return {
    display: s && s.display,
    w: el && el.getBoundingClientRect().width,
    hasSummary: !!(el && el.querySelector("summary")),
    inInfo: !!(sheet && !sheet.hidden && el && sheet.contains(el)),
  };
});
evidence.legendMobile = lgMob;
if (!lgMob.inInfo || lgMob.display === "none" || lgMob.w < 8) fail.push("mobile legend not in Info sheet");
if (picks.uaeA) {
  const p = await panelOf(mob, picks.uaeA[0]);
  evidence.mobilePanel = p;
  if (p.flightNo !== "Unavailable") fail.push("mobile flight number not Unavailable");
  await mob.screenshot({ path: `${OUT}/mobile390_identity.png` });
}
const fsMob = await mob.evaluate(() => document.getElementById("mfsb") && document.getElementById("mfsb").textContent);
evidence.mobileFsBtn = fsMob;
await mob.setViewport({ width: 1280, height: 860 });
await new Promise((r) => setTimeout(r, 300));
const lgResize = await mob.evaluate(() => getComputedStyle(document.querySelector(".lg")).display);
evidence.legendAfterResizeToDesktop = lgResize;
if (lgResize !== "none") fail.push("legend still visible after resize to desktop");
await mob.setViewport({ width: 390, height: 844 });
await new Promise((r) => setTimeout(r, 300));
await mob.evaluate(() => {
  const i = document.getElementById("infosheet");
  if (i) i.hidden = false;
  const inf = document.getElementById("infobtn");
  if (inf) inf.setAttribute("aria-expanded", "true");
});
const lgBack = await mob.evaluate(() => {
  const sheet = document.getElementById("infosheet");
  const el = document.querySelector(".infosheet .lg, .lg");
  return {
    display: el && getComputedStyle(el).display,
    inInfo: !!(sheet && !sheet.hidden && el && sheet.contains(el)),
  };
});
evidence.legendAfterResizeToMobile = lgBack;
if (!lgBack.inInfo || lgBack.display === "none") fail.push("legend not restored in Info after resize back to mobile");
await mob.screenshot({ path: `${OUT}/mobile390_legend_search.png` });
await mob.close();

fs.writeFileSync(`${OUT}/ui_search_identity_evidence.json`, JSON.stringify({ fail, evidence }, null, 2));
await browser.close();
if (fail.length) {
  console.error("FAIL\n" + fail.map((x) => "- " + x).join("\n"));
  console.log(JSON.stringify(evidence.picks, null, 2));
  process.exit(1);
}
console.log("OK " + JSON.stringify({ picks: evidence.picks, samples: evidence.samples, legendDesktop: evidence.legendDesktop, legendMobile: evidence.legendMobile, fullscreen: evidence.fullscreen }, null, 2));
