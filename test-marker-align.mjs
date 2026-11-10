import puppeteer from "puppeteer-core";
import fs from "fs";

const BASE = "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });

const fail = [];
const evidence = { utc: new Date().toISOString() };
function ok(cond, msg) { if (!cond) fail.push(msg); }

// OurAirports public-domain OTHH runway ends (runways.csv, airport 44686).
const OTHH_16L = { lat: 25.296100616455078, lon: 51.60879898071289, hdg: 156, widthFt: 197 };
const OTHH_34R = { lat: 25.255399703979492, lon: 51.626800537109375, hdg: 336 };
const OTHH_16R = { lat: 25.291000366210938, lon: 51.589698791503906, hdg: 156 };
const ARP = { lat: 25.2731, lon: 51.6081 };

{
  const lat = OTHH_16L.lat;
  const e3 = Math.abs(lat - +lat.toFixed(3)) * 60 * 1852;
  const e5 = Math.abs(lat - +lat.toFixed(5)) * 60 * 1852;
  const halfCell3 = 0.0005 * 60 * 1852;
  ok(e3 > 10, "3-decimal packing drops more than 10 m on this 16L threshold");
  ok(e5 < 1.2, "5-decimal packing stays within ~1.1 m");
  ok(halfCell3 > (OTHH_16L.widthFt * 0.3048) / 2, "3-decimal half-step exceeds half of OTHH 16L width — can place a centreline report on the grass");
  evidence.quant = { e3m: +e3.toFixed(2), e5m: +e5.toFixed(2), halfCell3m: +halfCell3.toFixed(2), rwyWidthM: +(OTHH_16L.widthFt * 0.3048).toFixed(1), source: "OurAirports runways.csv OTHH 16L/34R" };
}

function packOld(lat, lon) { return [+lat.toFixed(3), +lon.toFixed(3)]; }
function packNew(lat, lon) { return [+lat.toFixed(5), +lon.toFixed(5)]; }
{
  const [la3, lo3] = packOld(OTHH_16L.lat, OTHH_16L.lon);
  const [la5, lo5] = packNew(OTHH_16L.lat, OTHH_16L.lon);
  ok(la5 !== la3 || lo5 !== lo3, "5dp pack is not the 3dp grid");
  ok(la5 === 25.2961 && lo5 === 51.6088, "5dp pack keeps OurAirports 16L to 1e-4 deg");
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function open(w, h, { mobile = w <= 700 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.hidet = "0"; localStorage.reglab = "1"; });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof select === "function" && map && map.loaded && map.loaded() && map.getLayer && map.getLayer("live"), { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 600));
  return page;
}

async function seed(page) {
  return page.evaluate((pts) => {
    L = L || { at: null, ac: [], nm: {} };
    L.at = new Date().toISOString();
    L.nm = { QTR: "Qatar Airways", UAE: "Emirates" };
    L.ac = [
      ["g16l", "QTR16L", "QTR", "A359", pts.l16.lat, pts.l16.lon, 0, 12, pts.l16.hdg, "A7-AMF", 1, 4, 0],
      ["a16r", "QTR16R", "QTR", "A359", pts.l16r.lat, pts.l16r.lon, 375, 147, pts.l16r.hdg, "A7-LOW", 0, 6, -200],
      ["air1", "QTR99", "QTR", "B77W", 25.40, 52.00, 37000, 480, 90, "A7-HI", 0, 3, 0],
      ["stale", "QTRST", "QTR", "A320", pts.r34.lat, pts.r34.lon, 12000, 220, 336, "A7-ST", 0, 70, 0]
    ];
    GND_AC = [
      ["g16l", "QTR16L", "QTR", "A359", pts.l16.lat, pts.l16.lon, pts.l16.hdg, 12, "taxi", 4, 1, "live", null, null, "A7-AMF", "DOH"],
      ["held1", "QTRH", "QTR", "B77W", pts.arp.lat, pts.arp.lon, 90, 0, "parked", 2400, 1, "held", 40, "2026-11-09T00:00:00Z", "A7-HLD", "DOH"]
    ];
    APT = "DOH";
    if (typeof gSetup === "function") gSetup();
    ["sat", "gnd"].forEach((l) => { if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", "visible"); });
    if (typeof drawLive === "function") drawLive();
    if (typeof gPaint === "function") gPaint(GND_AC);
    if (map.stop) map.stop();
    map.jumpTo({ center: [pts.l16.lon, pts.l16.lat], zoom: 16, bearing: 0, pitch: 0 });
    map.resize();
  }, { l16: OTHH_16L, l16r: OTHH_16R, r34: OTHH_34R, arp: ARP });
}

async function measure(page) {
  return page.evaluate((pts) => {
    const live = map.getSource("live") && map.getSource("live")._data;
    const gnd = map.getSource("gnd") && map.getSource("gnd")._data;
    const feat = (fc, h) => (fc.features || []).find((f) => f.properties.h === h);
    const L16 = feat(live, "g16l"), G16 = feat(gnd, "g16l"), LOW = feat(live, "a16r"), AIR = feat(live, "air1"), ST = feat(live, "stale"), HLD = feat(gnd, "held1");
    const nm = (a, b) => {
      const R2 = Math.PI / 180;
      const x = Math.sin((b[1] - a[1]) * R2 / 2) ** 2 + Math.cos(a[1] * R2) * Math.cos(b[1] * R2) * Math.sin((b[0] - a[0]) * R2 / 2) ** 2;
      return 2 * 3440.065 * Math.asin(Math.sqrt(Math.min(1, x)));
    };
    const proj = (ll) => map.project(ll);
    const pL = L16 && proj(L16.geometry.coordinates);
    const pG = G16 && proj(G16.geometry.coordinates);
    const layout = map.getLayer("live") && map.getStyle().layers.find((l) => l.id === "live");
    const shownLow = typeof dispLonLat === "function" ? dispLonLat(pts.l16r.lat, pts.l16r.lon, 147, pts.l16r.hdg, 0, 375, 6) : null;
    const shownAir = typeof dispLonLat === "function" ? dispLonLat(25.40, 52.00, 480, 90, 0, 37000, 3) : null;
    const shownGnd = typeof dispLonLat === "function" ? dispLonLat(pts.l16.lat, pts.l16.lon, 12, pts.l16.hdg, 1, 0, 4) : null;
    const shownHeld = typeof dispLonLat === "function" ? dispLonLat(pts.arp.lat, pts.arp.lon, 0, 90, 1, 0, 2400) : null;
    const shownStale = typeof dispLonLat === "function" ? dispLonLat(pts.r34.lat, pts.r34.lon, 220, 336, 0, 12000, 70) : null;
    const liveLay = map.getLayer("live") && {
      anchor: map.getLayoutProperty("live", "icon-anchor"),
      rot: map.getLayoutProperty("live", "icon-rotation-alignment"),
      offset: map.getLayoutProperty("live", "icon-offset"),
    };
    const gndLay = map.getLayer("gnd") && {
      anchor: map.getLayoutProperty("gnd", "icon-anchor"),
      rot: map.getLayoutProperty("gnd", "icon-rotation-alignment"),
    };
    return {
      live16: L16 && L16.geometry.coordinates,
      gnd16: G16 && G16.geometry.coordinates,
      liveLow: LOW && LOW.geometry.coordinates,
      liveAir: AIR && AIR.geometry.coordinates,
      liveStale: ST && ST.geometry.coordinates,
      gndHeld: HLD && HLD.geometry.coordinates,
      trk16: L16 && L16.properties.trk,
      trG: G16 && G16.properties.tr,
      g16: L16 && L16.properties.g,
      pxDelta: pL && pG ? Math.hypot(pL.x - pG.x, pL.y - pG.y) : null,
      nmLiveGnd: L16 && G16 ? nm(L16.geometry.coordinates, G16.geometry.coordinates) : null,
      shownLow, shownAir, shownGnd, shownHeld, shownStale,
      snap16: [pts.l16.lon, pts.l16.lat],
      snapLow: [pts.l16r.lon, pts.l16r.lat],
      snapAir: [52.00, 25.40],
      snapStale: [pts.r34.lon, pts.r34.lat],
      liveLay, gndLay,
      zoom: map.getZoom(),
      sat: map.getLayoutProperty("sat", "visibility"),
      fs: document.body.classList.contains("map-fs") || document.fullscreenElement === document.getElementById("mw"),
    };
  }, { l16: OTHH_16L, l16r: OTHH_16R, r34: OTHH_34R, arp: ARP });
}

function almost(a, b, eps) {
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

async function shot(page, name) {
  const p = `${OUT}/${name}.png`;
  const el = await page.$("#mw");
  if (el) await el.screenshot({ path: p });
  else await page.screenshot({ path: p });
  return p;
}

async function exercise(page, tag, { fullscreen = false } = {}) {
  await seed(page);
  await page.waitForFunction(() => map && map.getLayer && map.getLayer("gnd") && map.getLayer("sat"), { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate((pts) => {
    ["sat", "gnd"].forEach((l) => { if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", "visible"); });
    if (map.stop) map.stop();
    map.jumpTo({ center: [pts.lon, pts.lat], zoom: 16, bearing: 0, pitch: 0 });
  }, OTHH_16L);
  await new Promise((r) => setTimeout(r, 800));
  if (fullscreen) {
    await page.evaluate(() => {
      Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => false });
      HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error("ios"));
      if (typeof syncFS === "function") syncFS();
    });
    await page.click("#mfsb");
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate((pts) => map.jumpTo({ center: [pts.lon, pts.lat], zoom: 16 }), OTHH_16L);
    await new Promise((r) => setTimeout(r, 200));
  }
  const st = await measure(page);
  ok(st.sat === "visible", `${tag}: airport satellite layer on at DOH`);
  ok(st.zoom >= 15.5, `${tag}: close airport zoom`);
  ok(almost(st.live16, st.snap16, 1e-7), `${tag}: live ground marker stays on ADS-B lat/lon (not 3dp grid, not snapped)`);
  ok(almost(st.gnd16, st.snap16, 1e-7), `${tag}: ground overlay uses the same snapshot`);
  ok(st.nmLiveGnd != null && st.nmLiveGnd < 0.001, `${tag}: live and ground overlays share coordinates`);
  ok(st.pxDelta != null && st.pxDelta < 1.5, `${tag}: live and ground project to the same pixel (${st.pxDelta})`);
  ok(almost(st.liveLow, st.snapLow, 1e-7) && almost(st.shownLow, st.snapLow, 1e-7), `${tag}: low-altitude (375 ft / 147 kt) is not dead-reckoned off the runway`);
  ok(almost(st.shownGnd, st.snap16, 1e-7), `${tag}: taxiing sample is not dead-reckoned`);
  ok(almost(st.shownHeld, [ARP.lon, ARP.lat], 1e-7), `${tag}: held last-ground stays on stored lat/lon`);
  ok(!almost(st.liveStale, st.snapStale, 1e-5) || !almost(st.shownStale, st.snapStale, 1e-5), `${tag}: pos_age 70 s airborne still coasts (type-cycle lag)`);
  ok(!almost(st.shownAir, st.snapAir, 1e-5), `${tag}: high airborne still coasts between snapshots`);
  ok(st.trk16 === OTHH_16L.hdg && st.trG === OTHH_16L.hdg, `${tag}: icon-rotate uses sourced track, not a runway heading we invented`);
  ok(st.liveLay && st.liveLay.anchor === "center" && st.liveLay.rot === "map", `${tag}: live icon anchored at centre, aligned to map/track`);
  ok(st.gndLay && st.gndLay.anchor === "center", `${tag}: ground icon anchored at centre`);
  ok(Math.abs(st.live16[1] - +OTHH_16L.lat.toFixed(3)) > 1e-6, `${tag}: displayed lat is not quantized to 0.001°`);
  await shot(page, `align-${tag}`);
  evidence[tag] = {
    live16: st.live16, gnd16: st.gnd16, pxDelta: st.pxDelta, zoom: st.zoom, fs: st.fs,
    low: st.liveLow, airMoved: !almost(st.shownAir, st.snapAir, 1e-5)
  };
}

const desk = await open(1280, 860, { mobile: false });
await exercise(desk, "desk-1280");
await desk.close();

const mob = await open(390, 844);
await exercise(mob, "mob-390");
await exercise(mob, "mob-390-fs", { fullscreen: true });
await mob.close();

const m320 = await open(320, 568);
await exercise(m320, "mob-320");
await m320.close();

await browser.close();
evidence.fail = fail;
fs.writeFileSync(OUT + "/marker-align-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ fail, evidence }, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
