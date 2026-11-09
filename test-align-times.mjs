import puppeteer from "puppeteer-core";
import fs from "fs";

const BASE = "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });

const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const DOH = { iata: "DOH", icao: "OTHH", name: "Hamad International", city: "Doha", lat: 25.273, lon: 51.608 };
const LHR = { iata: "LHR", icao: "EGLL", name: "Heathrow", city: "London", lat: 51.47, lon: -0.454 };

const AC = {
  takeoff: ["aa1111", "QTR101", "QTR", "B77W", 26.4, 52.1, 28000, 480, 310, "A7-AAA", 0, 12, 400],
  airborne: ["bb2222", "QTR202", "QTR", "B77W", 25.0, 50.0, 35000, 480, 90, "A7-BBB", 0, 8, 0],
  unknown: ["cc3333", "BAW9", "BAW", "B789", 40.0, -3.0, 38000, 450, 270, "G-III", 0, 10, 0],
  ground: ["dd4444", "UAE50", "UAE", "A388", 25.253, 55.364, 0, 8, 90, "A6-EEE", 1, 6, 0],
  stale: ["ee5555", "QTR303", "QTR", "A359", 28.0, 40.0, 39000, 470, 280, "A7-CCC", 0, 90, 0],
  slow: ["ff6666", "QTR404", "QTR", "A320", 25.5, 51.7, 8000, 80, 120, "A7-DDD", 0, 5, -200],
};

const TRACKS = {
  aa1111: [
    [T0, 51.608, 25.273, 0, 8, 0, 1],
    [T0 + 60000, 51.612, 25.276, 0, 18, 0, 1],
    [T0 + 120000, 51.640, 25.300, 1400, 165, 1600, 0],
    [T0 + 600000, 52.100, 26.400, 28000, 480, 400, 0],
  ],
  bb2222: [
    [T0 + 3600000, 49.5, 24.9, 35000, 480, 0, 0],
    [T0 + 3690000, 50.0, 25.0, 35000, 480, 0, 0],
  ],
  cc3333: [[T0, -2.9, 40.0, 38000, 450, 0, 0]],
  dd4444: [
    [T0, 55.30, 25.20, 2200, 180, -800, 0],
    [T0 + 180000, 55.364, 25.253, 0, 8, 0, 1],
  ],
  ee5555: [
    [T0, 39.0, 27.5, 39000, 470, 0, 0],
    [T0 + 90000, 40.0, 28.0, 39000, 470, 0, 0],
  ],
  ff6666: [[T0, 51.7, 25.5, 8000, 80, -200, 0]],
};

const ROUTES = {
  QTR101: { found: true, airline: "Qatar Airways", origin: DOH, destination: LHR },
  QTR202: { found: true, airline: "Qatar Airways", origin: DOH, destination: LHR },
  QTR303: { found: true, airline: "Qatar Airways", origin: DOH, destination: LHR },
  QTR404: { found: true, airline: "Qatar Airways", origin: DOH, destination: LHR },
  UAE50: { found: true, airline: "Emirates", origin: { iata: "DXB", icao: "OMDB", name: "Dubai International", city: "Dubai", lat: 25.253, lon: 55.364 }, destination: DOH },
  BAW9: { found: false },
};

function liveBody() {
  return JSON.stringify({
    at: new Date(Date.now() - 15000).toISOString(),
    fields: ["hex", "callsign", "airline", "type", "lat", "lon", "alt_ft", "gs_kt", "track", "reg", "on_ground", "pos_age_s", "vrate_fpm"],
    ac: Object.values(AC),
    nm: { QTR: "Qatar Airways", UAE: "Emirates", BAW: "British Airways" },
    history: [[new Date().toISOString(), 6, 6]],
  });
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function openPage(width, height) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.hidet = "0"; });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof select === "function" && typeof map !== "undefined" && map && map.getLayer && map.getLayer("sel-rem"), { timeout: 90000 });
  await page.evaluate((payload) => {
    const orig = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u.includes("/api/live")) {
        const body = {
          at: new Date(Date.now() - 15000).toISOString(),
          fields: payload.fields,
          ac: payload.ac,
          nm: payload.nm,
          history: [[new Date().toISOString(), payload.ac.length, payload.ac.length]],
        };
        return Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
      }
      if (u.includes("/api/route")) {
        const cs = new URL(u, location.origin).searchParams.get("cs") || "";
        return Promise.resolve(new Response(JSON.stringify(payload.routes[cs] || { found: false }), { headers: { "Content-Type": "application/json" } }));
      }
      if (/\/api\/track(\?|$)/.test(u)) {
        const hex = (new URL(u, location.origin).searchParams.get("hex") || "").toLowerCase();
        return Promise.resolve(new Response(JSON.stringify({ hex, points: payload.tracks[hex] || [] }), { headers: { "Content-Type": "application/json" } }));
      }
      return orig(url, opts);
    };
    return poll();
  }, {
    fields: ["hex", "callsign", "airline", "type", "lat", "lon", "alt_ft", "gs_kt", "track", "reg", "on_ground", "pos_age_s", "vrate_fpm"],
    ac: Object.values(AC),
    nm: { QTR: "Qatar Airways", UAE: "Emirates", BAW: "British Airways" },
    routes: ROUTES,
    tracks: TRACKS,
  });
  await page.waitForFunction(() => L && L.ac && L.ac.some((a) => a[0] === "aa1111") && map.getSource("live"), { timeout: 20000 });
  await page.evaluate(() => { window.__ml = map; });
  return page;
}

function measure(page) {
  return page.evaluate(() => {
    const hv = (a, b, c, d) => {
      const R2 = Math.PI / 180, x = Math.sin((c - a) * R2 / 2) ** 2 + Math.cos(a * R2) * Math.cos(c * R2) * Math.sin((d - b) * R2 / 2) ** 2;
      return 2 * 3440.065 * Math.asin(Math.sqrt(Math.min(1, x)));
    };
    const nm = (p, q) => (!p || !q) ? null : hv(p[1], p[0], q[1], q[0]);
    const hex = document.getElementById("sp").dataset.hex;
    const a = selAc();
    const shown = a ? dispLonLat(a.lat, a.lon, a.gs, a.trk, a.gnd || a.held, a.gnd || a.held ? 0 : a.alt, a.age) : null;
    const snap = a ? [a.lon, a.lat] : null;
    const sel = (map.getSource("sel")._data) || { features: [] };
    const live = (map.getSource("live")._data) || { features: [] };
    const rem = sel.features.find((f) => f.properties.k === "rem");
    const join = sel.features.find((f) => f.properties.k === "join");
    const flown = sel.features.filter((f) => f.properties.k === "flown");
    const gap = sel.features.filter((f) => f.properties.k === "gap");
    const marker = live.features.find((f) => f.properties.h === hex);
    const rem0 = rem && rem.geometry.coordinates[0];
    const join1 = join && join.geometry.coordinates.slice(-1)[0];
    const markerC = marker && marker.geometry.coordinates;
    const txt = document.getElementById("spb").innerText;
    const times = (txt.split("TIMES")[1] || txt).split("No airline schedule")[0];
    const field = (label) => {
      const m = times.match(new RegExp(label.replace(/ /g, "\\s+") + "\\s+([^\\n]+)(?:\\n(\\d{2}:\\d{2} UTC))?", "i"));
      if (!m) return null;
      return (m[1] + (m[2] ? " " + m[2] : "")).replace(/\s+/g, " ").trim();
    };
    const vis = (id) => map.getLayoutProperty(id, "visibility");
    return {
      utc: new Date().toISOString(),
      hex, cs: a && a.cs, gs: a && a.gs, age: a && a.age, gnd: a && a.gnd, held: a && a.held, src: a && a.src,
      snapshot: snap, shown, marker: markerC, remStart: rem0, joinEnd: join1,
      nmMarkerVsRem: nm(markerC, rem0), nmShownVsRem: nm(shown, rem0), nmShownVsMarker: nm(shown, markerC),
      nmSnapVsShown: nm(snap, shown), nmJoinVsMarker: nm(join1, markerC),
      nFlown: flown.length, nGap: gap.length, hasJoin: !!join, hasRem: !!rem,
      hidet: localStorage.hidet, vis: { flown: vis("sel-flown"), rem: vis("sel-rem"), join: vis("sel-join"), gap: vis("sel-gap"), live: vis("live") },
      scheduledDep: field("Scheduled departure"),
      scheduledArr: field("Scheduled arrival"),
      observedTakeoff: field("Observed takeoff"),
      trackingSince: field("Tracking since"),
      estimatedArr: field("Estimated arrival"),
      actualArr: field("Actual arrival"),
      observedLanding: field("Observed landing"),
      etaDisclaimer: txt.includes("Estimated from remaining distance"),
      notSchedule: /not schedule/i.test(txt),
      sourceNote: txt.includes("No airline schedule feed"),
      panel: txt.slice(0, 1600),
    };
  });
}

async function selectHex(page, hex) {
  await page.evaluate((h) => { setHideTracks(false); select(h); }, hex);
  await page.waitForFunction((h) => document.getElementById("sp").classList.contains("on") && document.getElementById("sp").dataset.hex === h, { timeout: 20000 }, hex);
  await page.waitForFunction(() => DB !== null, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1200));
}

const fail = [];
const results = {};

const desk = await openPage(1280, 860);

const unit = await desk.evaluate((T0) => {
  const airOnly = [[T0, 50, 25, 35000, 480, 0, 0], [T0 + 90000, 50.5, 25.1, 35000, 480, 0, 0]];
  const trans = [[T0, 51.6, 25.27, 0, 8, 0, 1], [T0 + 120000, 51.64, 25.30, 1400, 165, 1600, 0]];
  const land = [[T0, 55.3, 25.2, 2200, 180, -800, 0], [T0 + 180000, 55.36, 25.25, 0, 8, 0, 1]];
  const firstOnly = observedEvents(airOnly, { gnd: false, held: false });
  const toff = observedEvents(trans, { gnd: false, held: false });
  const ld = observedEvents(land, { gnd: true, held: false });
  const ldAir = observedEvents(land, { gnd: false, held: false });
  return {
    firstPointIsNotTakeoff: firstOnly.takeoff == null && firstOnly.since === T0,
    takeoffIsFirstAirAfterGround: toff.takeoff === T0 + 120000,
    landingOnlyWhenOnGround: ld.landing === T0 + 180000 && ldAir.landing == null,
    gap: isGapPt([T0, 10, 10, 35000, 400, 0, 0], [T0 + 20 * 60000, 40, 40, 35000, 400, 0, 0]),
    noGapCruise: !isGapPt([T0, 50, 25, 35000, 480, 0, 0], [T0 + 90000, 50.2, 25.1, 35000, 480, 0, 0]),
  };
}, T0);
results.unit = unit;
if (!unit.firstPointIsNotTakeoff) fail.push("first track point treated as takeoff");
if (!unit.takeoffIsFirstAirAfterGround) fail.push("takeoff not first airborne after ground");
if (!unit.landingOnlyWhenOnGround) fail.push("landing shown while airborne");
if (!unit.gap) fail.push("coverage gap not detected");
if (!unit.noGapCruise) fail.push("normal cruise marked as gap");

await selectHex(desk, "aa1111");
await new Promise((r) => setTimeout(r, 1500));
const tTakeoff = await measure(desk);
results.takeoff = tTakeoff;
await desk.screenshot({ path: `${OUT}/desktop_takeoff_eta.png`, fullPage: false });
await desk.evaluate(() => { const el = document.getElementById("spbd"); if (el) el.scrollTop = el.scrollHeight; });
await desk.screenshot({ path: `${OUT}/desktop_takeoff_eta_times.png`, fullPage: false });
if (!(tTakeoff.nmMarkerVsRem < 0.01)) fail.push("takeoff rem not on marker " + tTakeoff.nmMarkerVsRem);
if (tTakeoff.scheduledDep !== "Unavailable" || tTakeoff.scheduledArr !== "Unavailable") fail.push("scheduled times not Unavailable");
if (!(tTakeoff.observedTakeoff || "").includes("2026-11-08 10:02 UTC")) fail.push("observed takeoff missing " + tTakeoff.observedTakeoff);
if (tTakeoff.trackingSince) fail.push("tracking since shown despite takeoff");
if (!tTakeoff.estimatedArr || tTakeoff.estimatedArr.includes("Unavailable") || !/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(tTakeoff.estimatedArr)) fail.push("ETA missing for fresh moving dest-known flight " + tTakeoff.estimatedArr);
if (!tTakeoff.etaDisclaimer || !tTakeoff.notSchedule) fail.push("ETA disclaimer missing");
if (tTakeoff.actualArr !== "Unavailable") fail.push("actual arrival should be unavailable in air");
if (tTakeoff.observedLanding) fail.push("landing shown while airborne");

const shown1 = tTakeoff.shown;
await new Promise((r) => setTimeout(r, 3000));
const tMoved = await measure(desk);
results.moved = tMoved;
if (!(tMoved.nmMarkerVsRem < 0.01)) fail.push("after 3s rem drifted from marker " + tMoved.nmMarkerVsRem);
if (!(tMoved.nmSnapVsShown > tTakeoff.nmSnapVsShown + 0.1)) fail.push("displayed pos did not advance with dead reckoning");
if (tMoved.shown[0] === shown1[0] && tMoved.shown[1] === shown1[1]) fail.push("shown coordinates frozen");

await selectHex(desk, "bb2222");
const tAir = await measure(desk);
results.airborneNoTakeoff = tAir;
await desk.screenshot({ path: `${OUT}/desktop_tracking_since.png`, fullPage: false });
if (tAir.observedTakeoff) fail.push("airborne-only used first point as takeoff");
if (!(tAir.trackingSince || "").includes("2026-11-08 11:00 UTC")) fail.push("tracking since missing " + tAir.trackingSince);
if (!(tAir.nmMarkerVsRem < 0.01)) fail.push("airborne rem misaligned " + tAir.nmMarkerVsRem);
if (!tAir.hasJoin && tAir.nmSnapVsShown > 0.03) fail.push("missing join from snapshot to displayed");

await selectHex(desk, "cc3333");
const tUnk = await measure(desk);
results.unknownDest = tUnk;
if (tUnk.hasRem) fail.push("remaining route drawn without destination");
if (tUnk.estimatedArr !== "Unavailable") fail.push("ETA shown without destination");
if (tUnk.scheduledDep !== "Unavailable") fail.push("unknown dest still needs scheduled Unavailable");
if (!(tUnk.trackingSince || tUnk.observedTakeoff)) fail.push("unknown dest missing tracking-since/takeoff field");

await selectHex(desk, "dd4444");
const tGnd = await measure(desk);
results.ground = tGnd;
if (tGnd.estimatedArr !== "Unavailable") fail.push("ETA shown for ground aircraft");
if (!(tGnd.observedLanding || "").includes("2026-11-08 10:03 UTC")) fail.push("observed landing missing " + tGnd.observedLanding);
if (!(tGnd.nmSnapVsShown < 0.001)) fail.push("ground aircraft was dead-reckoned");

await selectHex(desk, "ee5555");
const tStale = await measure(desk);
results.stale = tStale;
if (tStale.estimatedArr !== "Unavailable") fail.push("ETA shown for stale position");

await selectHex(desk, "ff6666");
const tSlow = await measure(desk);
results.slow = tSlow;
if (tSlow.estimatedArr !== "Unavailable") fail.push("ETA shown for slow/held-like airborne");

await desk.evaluate(() => {
  GND_AC = [["hh7777", "QTRHOLD", "QTR", "B77W", 25.273, 51.608, 90, 0, "parked", 2400, 1, "held", 40, "2026-11-08T09:20:00Z"]];
  L.ac = L.ac.filter((x) => x[0] !== "hh7777");
  DB = { found: true, airline: "Qatar Airways", origin: { iata: "DOH", icao: "OTHH", name: "Hamad", city: "Doha", lat: 25.273, lon: 51.608 }, destination: { iata: "LHR", icao: "EGLL", name: "Heathrow", city: "London", lat: 51.47, lon: -0.454 } };
  SEL_T = [];
  SEL = "hh7777";
  openSp();
  selUpdate(true);
});
await new Promise((r) => setTimeout(r, 400));
const tHeld = await measure(desk);
results.held = tHeld;
if (tHeld.estimatedArr !== "Unavailable") fail.push("ETA shown for held position");
if (!tHeld.held) fail.push("held aircraft not recognized");

await selectHex(desk, "aa1111");
await desk.evaluate(() => setHideTracks(true));
const tHide = await measure(desk);
results.hide = tHide;
await desk.screenshot({ path: `${OUT}/desktop_hide_tracks_aligned.png`, fullPage: false });
if (tHide.hidet !== "1") fail.push("hidet not persisted");
if (tHide.vis.flown !== "none" || tHide.vis.rem !== "none" || tHide.vis.join !== "none" || tHide.vis.gap !== "none") fail.push("track layers visible while hidden");
if (tHide.vis.live === "none") fail.push("aircraft hidden with tracks");
await desk.evaluate(() => { map.jumpTo({ center: [35, 28], zoom: 1.2 }); map.setPadding({ top: 0, left: 0, right: 0, bottom: 0 }); });
await new Promise((r) => setTimeout(r, 600));
const nIcons = await desk.evaluate(() => map.queryRenderedFeatures({ layers: ["live"] }).length);
results.unclusteredIcons = nIcons;
if (nIcons < 4) fail.push("expected unclustered live icons, got " + nIcons);
await desk.evaluate(() => setHideTracks(false));

const gapHex = await desk.evaluate((T0) => {
  SEL = "bb2222";
  SEL_T = [
    [T0, 10, 10, 35000, 400, 0, 0],
    [T0 + 20 * 60000, 40, 40, 35000, 400, 0, 0],
  ];
  selUpdate(true);
  const sel = map.getSource("sel")._data;
  return { nGap: sel.features.filter((f) => f.properties.k === "gap").length, nFlown: sel.features.filter((f) => f.properties.k === "flown").length };
}, T0);
results.gap = gapHex;
if (gapHex.nGap < 1) fail.push("gap connector not drawn");
if (gapHex.nFlown !== 0) fail.push("coverage gap was drawn as flown");

await desk.close();

const mob = await openPage(390, 844);
await selectHex(mob, "cc3333");
const tMob = await measure(mob);
results.mobileUnknown = tMob;
await mob.screenshot({ path: `${OUT}/mobile390_unknown_dest.png`, fullPage: false });
if (tMob.estimatedArr !== "Unavailable") fail.push("mobile ETA without dest");
if (tMob.scheduledDep !== "Unavailable" || tMob.scheduledArr !== "Unavailable") fail.push("mobile scheduled not Unavailable");
await selectHex(mob, "aa1111");
const tMob2 = await measure(mob);
results.mobileTakeoff = tMob2;
await mob.evaluate(() => { const el = document.getElementById("spbd"); if (el) el.scrollTop = 900; });
await mob.screenshot({ path: `${OUT}/mobile390_takeoff_eta.png`, fullPage: false });
if (!(tMob2.nmMarkerVsRem < 0.01)) fail.push("mobile rem misaligned " + tMob2.nmMarkerVsRem);
if (!(tMob2.observedTakeoff || "").includes("10:02")) fail.push("mobile observed takeoff missing");
await mob.close();

fs.writeFileSync(`${OUT}/align_times_coords.json`, JSON.stringify({ fail, results }, null, 2));
await browser.close();
if (fail.length) {
  console.error("FAIL\n" + fail.map((x) => "- " + x).join("\n"));
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}
console.log("OK " + JSON.stringify({
  nmMarkerVsRem_takeoff: results.takeoff.nmMarkerVsRem,
  nmMarkerVsRem_moved: results.moved.nmMarkerVsRem,
  nmSnapVsShown_takeoff: results.takeoff.nmSnapVsShown,
  nmSnapVsShown_moved: results.moved.nmSnapVsShown,
  takeoff: results.takeoff.observedTakeoff,
  trackingSince: results.airborneNoTakeoff.trackingSince,
  eta: results.takeoff.estimatedArr,
  unknownEta: results.unknownDest.estimatedArr,
  groundLanding: results.ground.observedLanding,
  hideLive: results.hide.vis.live,
  unclusteredIcons: results.unclusteredIcons,
  unit: results.unit,
}, null, 2));
