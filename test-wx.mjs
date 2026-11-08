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
  const b = Buffer.alloc(4);
  b.writeUInt32BE(0x82160ec0); // NOMADS sign-magnitude −35°
  ok(Math.abs(wx.coord32(b, 0, 90) + 35) < 1e-9, "coord32 sign-magnitude -35");
  b.writeInt32BE(-35000000);
  ok(Math.abs(wx.coord32(b, 0, 90) + 35) < 1e-9, "coord32 twos-complement -35");
  b.writeInt32BE(60000000);
  ok(Math.abs(wx.coord32(b, 0, 90) - 60) < 1e-9, "coord32 +60");
  const issued = wx.bulletinIssue("WCJP31 RJTD 081309\nRJJJ SIGMET", "2026-11-08T13:09:00.000Z");
  ok(issued === "2026-11-08T13:09:00.000Z", "bulletinIssue from WMO header " + issued);

  const hpa = wx.pressureFromMetar(1013.25, "");
  ok(hpa.pa === 101325 && hpa.via === "hPa" && /QNH/.test(hpa.ref), "hPa ×100 → Pa " + JSON.stringify(hpa));
  const inhg = wx.pressureFromMetar(29.92, "");
  ok(inhg.pa === Math.round(29.92 * 3386.389) && inhg.via === "inHg" && /altimeter/.test(inhg.ref), "inHg → Pa " + JSON.stringify(inhg));
  const qnh = wx.pressureFromMetar(null, "OTHH 081200Z 26012KT CAVOK Q1013");
  ok(qnh.pa === 101300 && qnh.via === "hPa", "raw QNH Q1013");
  const axx = wx.pressureFromMetar(null, "KJFK 081251Z 18008KT A2992");
  ok(axx.pa === Math.round(29.92 * 3386.389) && axx.via === "inHg", "raw A2992 inHg");
  const miss = wx.pressureFromMetar(null, "OTHH 081200Z 26012KT CAVOK");
  ok(miss.pa == null && miss.ref == null, "missing pressure is not invented");
  ok(wx.windFromMetar(0, 0, null, "").text === "calm", "calm");
  ok(wx.windFromMetar("VRB", 3, null, "").text === "VRB 3kt", "variable");
  ok(wx.windFromMetar(260, 12, 22, "").text === "260°T 12kt G22kt", "gusts");
  ok(wx.windFromMetar(null, null, null, "").text === "wind n/a", "missing wind");
  const row = wx.metarRow({ icaoId: "OTHH", temp: 28, wdir: 260, wspd: 12, wgst: 22, altim: 1013, rawOb: "OTHH 081200Z 26012G22KT Q1013", reportTime: "2026-11-08T12:00:00Z", lat: 25, lon: 51 });
  ok(row.pressPa === 101300 && row.windText.includes("260°T") && row.tempC === 28, "metarRow fields");
}

const tiny = "/tmp/wx/tiny.grib2";
if (fs.existsSync(tiny)) {
  const msgs = wx.decodeGrib2Simple(fs.readFileSync(tiny));
  ok(msgs.length >= 1, "tiny grib messages");
  ok(msgs[0].lat1 === 20 && msgs[0].lat2 === 30, "tiny grib lat1/lat2 " + msgs[0].lat1 + " " + msgs[0].lat2);
  ok(msgs[0].lon1 === 50 && msgs[0].name === "UGRD", "tiny grib lon/name");
}
const full = "/tmp/wx/full.grib2";
if (fs.existsSync(full)) {
  const msgs = wx.decodeGrib2Simple(fs.readFileSync(full));
  ok(msgs.length === 12, "full grib 12 messages got " + msgs.length);
  ok(Math.abs(msgs[0].lat1 + 35) < 0.01, "full grib lat1 -35 got " + msgs[0].lat1);
  ok(Math.abs(msgs[0].lat2 - 60) < 0.01, "full grib lat2 60 got " + msgs[0].lat2);
  ok(msgs.every((m) => m.lat1 > -40 && m.lat1 < 70), "all messages geographic lats");
}

async function api(path) {
  const r = await fetch(BASE + path);
  const j = await r.json();
  return { status: r.status, j };
}

const haz = await api("/api/wx/hazards");
ok(haz.status === 200, "hazards HTTP " + haz.status);
ok(!haz.j.error, "hazards error " + haz.j.error);
ok(haz.j.counts && haz.j.counts.current > 0, "hazards current count");
ok(haz.j.counts.expired === 0 || haz.j.expiredOmitted === haz.j.counts.expired, "expired omitted");
const feats = (haz.j.features && haz.j.features.features) || [];
ok(feats.length === haz.j.counts.current, "features match current");
ok(feats.every((f) => f.properties && f.properties.origLabel), "every advisory has origLabel");
ok(feats.every((f) => f.properties.validFrom && f.properties.validTo), "every advisory has valid UTC");
ok(feats.every((f) => f.properties.expired === false), "expired not in overlay");
ok(feats.some((f) => f.properties.product === "isigmet"), "international SIGMET present");
ok(/not for operational/i.test(haz.j.note || ""), "hazards note");
const lab = feats[0].properties;
evidence.haz = { n: feats.length, sample: { origLabel: lab.origLabel, rawHeader: lab.rawHeader, validFrom: lab.validFrom, validTo: lab.validTo, issueTime: lab.issueTime, product: lab.product } };

const st = await api("/api/wx/stations");
ok(st.status === 200, "stations HTTP");
ok(!st.j.error, "stations error " + st.j.error);
ok((st.j.metar || []).length > 10, "hub METARs");
ok((st.j.taf || []).length > 10, "hub TAFs");
ok(st.j.metar.every((m) => m.kind === "observation" && m.obsTime && m.icao), "METAR kind/time/icao");
ok(st.j.taf.every((t) => t.kind === "forecast" && t.validFrom && t.icao), "TAF kind/time/icao");
ok(st.j.metar.every((m) => m.pressPa == null || (Number.isInteger(m.pressPa) && m.pressRef)), "Pa integer with original QNH/altimeter ref, or omitted");
ok(st.j.metar.every((m) => m.pressPa !== 101325 || m.pressRef), "never a bare default 1013 hPa");
ok(st.j.metar.every((m) => m.windText), "every METAR has honest windText");
evidence.st = { metar: st.j.metar.length, taf: st.j.taf.length, sample: { icao: st.j.metar[0].icao, obsTime: st.j.metar[0].obsTime, fltCat: st.j.metar[0].fltCat, pressPa: st.j.metar[0].pressPa, pressRef: st.j.metar[0].pressRef, windText: st.j.metar[0].windText, tempC: st.j.metar[0].tempC } };

const wnd = await api("/api/wx/winds");
ok(wnd.status === 200, "winds HTTP");
evidence.wnd = { available: wnd.j.available, status: wnd.j.status, reason: (wnd.j.reason || "").slice(0, 240), cycle: wnd.j.cycle_utc, lats0: wnd.j.lats && wnd.j.lats[0], latsN: wnd.j.lats && wnd.j.lats[wnd.j.lats.length - 1], nlat: (wnd.j.lats || []).length, nlon: (wnd.j.lons || []).length, levels: wnd.j.levels, times: wnd.j.times };
if (!wnd.j.available) {
  fail.push("winds unavailable: " + (wnd.j.reason || wnd.j.status));
} else {
  ok(wnd.j.lats[0] >= -36 && wnd.j.lats[0] <= -30, "wind grid starts near 35S got " + wnd.j.lats[0]);
  ok(wnd.j.lats.every((x) => x >= -40 && x <= 70), "wind lats geographic");
  ok(wnd.j.lons[0] === 0, "wind lons from 0");
  ok((wnd.j.levels || []).includes(300), "300 hPa");
  const rec = wnd.j.fields["6:300"] || Object.values(wnd.j.fields || {})[0];
  ok(rec && rec.u.length === wnd.j.lats.length * wnd.j.lons.length, "u grid size");
  const j = wnd.j.lats.reduce((b, lat, i) => Math.abs(lat - 25.25) < Math.abs(wnd.j.lats[b] - 25.25) ? i : b, 0);
  const i = wnd.j.lons.reduce((b, lon, k) => Math.abs(lon - 55.36) < Math.abs(wnd.j.lons[b] - 55.36) ? k : b, 0);
  const u = rec.u[j * wnd.j.lons.length + i], v = rec.v[j * wnd.j.lons.length + i];
  const kt = Math.round(Math.hypot(u, v) * 1.94384);
  ok(kt >= 0 && kt < 250, "DXB 300 hPa kt plausible " + kt);
  evidence.wnd.dxb = { lat: wnd.j.lats[j], lon: wnd.j.lons[i], u, v, kt, valid: rec.valid_utc };
}

await waitLive();

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function waitLive() {
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    try {
      const j = await (await fetch(BASE + "/api/live")).json();
      if ((j.ac || []).length > 10) return j;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("live snapshot never populated");
}

async function open(w, h, ls = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument((init) => {
    localStorage.clear();
    localStorage.hidet = "0";
    localStorage.reglab = "1";
    Object.assign(localStorage, init);
  }, ls);
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof select === "function" && map && map.getLayer && map.getLayer("live") && map.getLayer("wxhaz-fill") && L && L.ac && L.ac.length > 10, { timeout: 120000 });
  return page;
}

function srcData(page, id) {
  return page.evaluate((sid) => {
    const s = map.getSource(sid);
    if (!s) return { type: "FeatureCollection", features: [] };
    if (s._data && s._data.features) return s._data;
    const ser = s.serialize && s.serialize();
    return (ser && ser.data) || { type: "FeatureCollection", features: [] };
  }, id);
}

async function shot(page, name) {
  const p = `${OUT}/${name}.png`;
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

const desk = await open(1280, 860);
const ui1280 = await desk.evaluate(() => {
  const lg = document.querySelector(".lg");
  const cs = lg ? getComputedStyle(lg) : null;
  return {
    wxctl: !!document.getElementById("wxctl"),
    wxhaz: document.getElementById("wxhaz") && document.getElementById("wxhaz").checked,
    legendDisplay: cs && cs.display,
    search: !!document.getElementById("qs"),
    fsb: !!document.getElementById("fsb"),
    mfsb: !!document.getElementById("mfsb"),
    rlb: !!document.getElementById("rlb"),
    htb: !!document.getElementById("htb"),
    wxLayers: ["wxhaz-fill", "wxhaz-line", "wxhaz-lab", "wxmet", "wxwnd"].filter((id) => map.getLayer(id)),
    trackVis: ["trails", "tk"].map((id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility")),
    footnote: (document.querySelector("#t-overview p.mu:nth-of-type(2)") || {}).textContent || "",
  };
});
ok(ui1280.wxctl, "desktop weather control");
ok(ui1280.legendDisplay === "none", "desktop legend hidden got " + ui1280.legendDisplay);
ok(ui1280.search && ui1280.mfsb && !ui1280.fsb && ui1280.rlb, "search/map-fullscreen/reg; no dashboard fullscreen button");
ok(ui1280.wxLayers.includes("wxhaz-fill") && ui1280.wxLayers.includes("wxhaz-lab"), "wx layers registered");
ok(!/unavailable on this host/i.test(ui1280.footnote || ""), "footnote no longer says winds unavailable");

await desk.evaluate(() => { document.getElementById("wxctl").open = true; });
await desk.click("#wxhaz");
await desk.waitForFunction(() => WX.haz && WX.haz.features && WX.haz.features.features.length > 0, { timeout: 30000 });
const hazUi = await desk.evaluate(() => {
  const st = document.getElementById("wxst").textContent + " " + ((document.getElementById("wxfull") && document.getElementById("wxfull").textContent) || "");
  const src = (id) => { const s = map.getSource(id); const d = (s && s._data) || (s && s.serialize && s.serialize().data) || { features: [] }; return d; };
  const n = src("wxhaz").features.length;
  const labs = src("wxhaz-pts").features;
  const lab0 = labs && labs[0] && labs[0].properties.origLabel;
  const vis = map.getLayoutProperty("wxhaz-fill", "visibility");
  const labVis = map.getLayoutProperty("wxhaz-lab", "visibility");
  return { st, n, lab0, vis, labVis, nLab: labs && labs.length, persist: localStorage.wxhaz };
});
ok(hazUi.vis === "visible" && hazUi.labVis === "visible", "hazard layers visible");
ok(hazUi.n > 0 && hazUi.nLab > 0, "hazard polygons and origLabel points");
ok(!!hazUi.lab0, "origLabel on point " + hazUi.lab0);
ok(/current advisories|\d+ adv\./i.test(hazUi.st), "status current advisories: " + hazUi.st);
ok(hazUi.persist === "1", "hazard toggle persisted");
ok(!/no hazards/i.test(hazUi.st) || /current advisories|\d+ adv\./i.test(hazUi.st), "status not a false all-clear");
evidence.deskHaz = hazUi;
await desk.evaluate(() => map.flyTo({ center: [55, 25], zoom: 4, duration: 0 }));
await new Promise((r) => setTimeout(r, 800));
await shot(desk, "wx-hazards-1280");

await desk.click("#wxmet");
await desk.waitForFunction(() => WX.st && WX.st.metar && WX.st.metar.length > 0, { timeout: 30000 });
const metUi = await desk.evaluate(() => {
  const src = (id) => { const s = map.getSource(id); return (s && s._data) || (s && s.serialize && s.serialize().data) || { features: [] }; };
  const n = src("wxmet").features.length;
  const vis = map.getLayoutProperty("wxmet", "visibility");
  const st = document.getElementById("wxst").textContent;
  const p = src("wxmet").features.find((f) => f.properties.icao === "OMDB") || src("wxmet").features[0];
  const type = map.getLayer("wxmet") && map.getLayer("wxmet").type;
  return { n, vis, st, persist: localStorage.wxmet, sample: p && p.properties, err: document.getElementById("wxst").classList.contains("err"), type };
});
ok(metUi.vis === "visible" && metUi.n > 10, "METAR airport features");
ok(metUi.type === "symbol", "airport layer is symbol icon not circle");
ok(metUi.sample && /Pa|QNH n\/a/.test(metUi.sample.lab || ""), "METAR label has Pa or honest QNH n/a");
ok(metUi.sample && (metUi.sample.windText || "").length > 0, "METAR wind text on feature");
ok(/METAR/i.test(metUi.st), "status mentions METAR");
ok(!metUi.err, "status not error when overlays ok");
evidence.deskMet = metUi;
await shot(desk, "wx-metar-1280");

await desk.click("#wxwnd");
await desk.waitForFunction(() => WX.wnd && (WX.wnd.available === true || WX.wnd.available === false), { timeout: 90000 });
const wndUi = await desk.evaluate(() => {
  const w = WX.wnd || {};
  const lev = document.getElementById("wxlev");
  const hr = document.getElementById("wxhr");
  const src = (id) => { const s = map.getSource(id); return (s && s._data) || (s && s.serialize && s.serialize().data) || { features: [] }; };
  const n = src("wxwnd").features.length;
  const vis = map.getLayoutProperty("wxwnd", "visibility");
  const st = document.getElementById("wxst").textContent;
  const f0 = src("wxwnd").features[0];
  return {
    available: w.available, reason: w.reason, n, vis, st,
    levDisabled: lev.disabled, levVal: lev.value, hrVal: hr.value,
    persist: localStorage.wxwnd, sample: f0 && { kt: f0.properties.kt, from: f0.properties.from, coord: f0.geometry.coordinates, hpa: f0.properties.hpa },
    err: document.getElementById("wxst").classList.contains("err")
  };
});
evidence.deskWnd = wndUi;
if (!wndUi.available) {
  fail.push("UI winds unavailable: " + wndUi.reason);
  ok(/unavailable/i.test(wndUi.st), "unavailable note in status");
  ok(wndUi.levDisabled, "level select disabled when winds down");
} else {
  ok(wndUi.vis === "visible" && wndUi.n > 50, "wind arrows " + wndUi.n);
  ok(!wndUi.levDisabled && wndUi.levVal, "level select enabled");
  ok(wndUi.sample && wndUi.sample.coord[1] >= -40 && wndUi.sample.coord[1] <= 70, "wind arrow geographic");
  ok(/GFS winds/i.test(wndUi.st), "status GFS cycle");
  ok(!wndUi.err, "winds-on is not treated as error");
}
await desk.evaluate(() => map.flyTo({ center: [45, 25], zoom: 3.2, duration: 0 }));
await new Promise((r) => setTimeout(r, 800));
await shot(desk, "wx-winds-1280");

const hide = await desk.evaluate(() => {
  setHideTracks(true);
  const wx = map.getLayoutProperty("wxhaz-fill", "visibility");
  const tr = map.getLayoutProperty("trails", "visibility");
  const live = map.getLayoutProperty("live", "visibility");
  setHideTracks(false);
  return { wx, tr, live };
});
ok(hide.wx === "visible", "hide tracks does not hide SIGMETs");
ok(hide.tr === "none", "hide tracks hides trail layer");
ok(hide.live !== "none", "hide tracks keeps aircraft");

const air = await desk.evaluate(() => (L.ac.find((a) => !a[10] && a[6] > 10000) || L.ac[0])[0]);
await desk.evaluate((h) => select(h), air);
await desk.waitForFunction(() => document.getElementById("sp").classList.contains("on") && document.getElementById("spwx").innerText.length > 40, { timeout: 30000 });
const panel = await desk.evaluate(() => {
  const t = document.getElementById("spwx").innerText;
  return {
    t: t.slice(0, 900),
    hasOrig: /SIGMET|G-AIRMET|advisory/i.test(t),
    hasUtc: /UTC/.test(t),
    hasNote: /not for operational/i.test(t),
    hasMetar: /METAR/i.test(t),
    provisional: /provisional/i.test(t) || /great-circle/i.test(t) || /destination is unknown/i.test(t),
    headerKind: document.querySelector(".spk") && document.querySelector(".spk").textContent
  };
});
ok(panel.hasOrig && panel.hasUtc && panel.hasNote && panel.hasMetar, "selected-aircraft weather block");
ok(panel.provisional, "remaining-route intersections labelled provisional");
ok(/ADS-B callsign/i.test(panel.headerKind || ""), "identity still ADS-B callsign");
evidence.panel = panel;
await shot(desk, "wx-panel-1280");

const persist = await open(1280, 860, { wxhaz: "1", wxmet: "1", wxwnd: "1" });
await persist.waitForFunction(() => WX.haz && WX.haz.features, { timeout: 30000 });
const persisted = await persist.evaluate(() => ({
  haz: document.getElementById("wxhaz").checked,
  met: document.getElementById("wxmet").checked,
  wnd: document.getElementById("wxwnd").checked,
  vis: map.getLayoutProperty("wxhaz-fill", "visibility")
}));
ok(persisted.haz && persisted.met && persisted.wnd, "weather toggles restore from localStorage");
await persist.close();

const search = await desk.evaluate(() => {
  const a = L.ac.find((x) => x[1] && x[9]);
  if (!a) return { ok: false };
  document.getElementById("qs").value = a[1];
  search();
  const hits = [...document.querySelectorAll("#qres .qhit")].map((e) => e.textContent);
  return { ok: hits.some((t) => t.includes(a[1])), n: hits.length, cs: a[1], reg: a[9] };
});
ok(search.ok, "search still finds callsign");

const mob = await open(390, 844);
const ui390 = await mob.evaluate(() => {
  const wxbtn = document.getElementById("wxbtn");
  const infobtn = document.getElementById("infobtn");
  if (typeof toggleInfo === "function") toggleInfo();
  const lg = document.querySelector(".infosheet .lg, .lg");
  const cs = lg ? getComputedStyle(lg) : null;
  const sheet = document.getElementById("infosheet");
  return {
    wxText: (wxbtn && wxbtn.textContent || "").replace(/\s+/g, " ").trim(),
    wxH: wxbtn && wxbtn.getBoundingClientRect().height,
    info: !!(infobtn && infobtn.getBoundingClientRect().height > 20),
    legendInInfo: !!(sheet && !sheet.hidden && cs && cs.display !== "none"),
    fsb: !!document.getElementById("fsb"),
    mfsb: !!document.getElementById("mfsb")
  };
});
ok(/Weather/.test(ui390.wxText) && ui390.wxH >= 44, "mobile Weather control with text");
ok(ui390.info && ui390.legendInInfo, "mobile legend lives in Info sheet");
ok(!ui390.fsb && ui390.mfsb, "mobile has map fullscreen only");
await mob.evaluate(() => { if (typeof closeSheets === "function") closeSheets(); document.getElementById("wxctl").open = true; setWx("haz", true); });
await mob.waitForFunction(() => WX.haz && WX.haz.features && WX.haz.features.features.length > 0, { timeout: 30000 });
await mob.evaluate(() => map.flyTo({ center: [55, 25], zoom: 3.5, duration: 0 }));
await new Promise((r) => setTimeout(r, 800));
await shot(mob, "wx-hazards-390");
await mob.evaluate(() => setWx("met", true));
await mob.waitForFunction(() => WX.st && WX.st.metar && WX.st.metar.length > 0, { timeout: 30000 });
await shot(mob, "wx-metar-390");
await mob.evaluate(() => setWx("wnd", true));
await mob.waitForFunction(() => WX.wnd && (WX.wnd.available === true || WX.wnd.available === false), { timeout: 90000 });
await mob.evaluate(() => map.flyTo({ center: [45, 25], zoom: 3, duration: 0 }));
await new Promise((r) => setTimeout(r, 800));
await shot(mob, "wx-winds-390");
const mobSt = await mob.evaluate(() => (document.getElementById("wxst").textContent || "") + " " + (document.getElementById("wxfull") && document.getElementById("wxfull").textContent || ""));
ok(/advisory|METAR|GFS|unavailable/i.test(mobSt), "mobile status populated");
evidence.mob = { ui390, st: mobSt };

await desk.close();
await mob.close();
await browser.close();

evidence.fail = fail;
fs.writeFileSync(OUT + "/wx-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ fail, evidence: { haz: evidence.haz, st: evidence.st, wnd: evidence.wnd, deskWnd: evidence.deskWnd, panelOk: panel.hasMetar } }, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
