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
  ok(wx.pressureFromMetar(undefined, "CAVOK").pa == null, "no invented QNH");
  ok(wx.windFromMetar(null, null, null, "").text === "wind n/a", "wind missing stays n/a");
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function open(w, h, store = {}, landscape = false) {
  const page = await browser.newPage();
  await page.setViewport({
    width: landscape ? h : w,
    height: landscape ? w : h,
    deviceScaleFactor: 2,
    isMobile: w <= 700,
    hasTouch: w <= 700,
  });
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

function overlap(a, b) {
  if (!a || !b || a.w < 2 || a.h < 2 || b.w < 2 || b.h < 2) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

async function layout(page) {
  return page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { x: r.x, y: r.y, w: r.width, h: r.height, t: (el.innerText || el.textContent || "").trim().slice(0, 80), vis: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 1 && r.height > 1 && cs.opacity !== "0" };
    };
    const wxbtn = document.getElementById("wxbtn");
    const labels = [...document.querySelectorAll("#wxctl label")].map((l) => ({ forId: (l.querySelector("input") || {}).id, text: l.textContent.trim() }));
    const src = map.getSource("wxmet");
    const clustered = !!(src && (src._options && src._options.cluster || src.serialize && src.serialize().cluster));
    return {
      wxbtn: box(wxbtn),
      infobtn: box(document.getElementById("infobtn")),
      htb: box(document.getElementById("htb")),
      depb: box(document.getElementById("depb")),
      arrb: box(document.getElementById("arrb")),
      dirpair: box(document.querySelector(".dirpair")),
      rlb: box(document.getElementById("rlb")),
      mfsb: box(document.getElementById("mfsb")),
      fbtn: box(document.getElementById("fbtn")),
      filbar: box(document.getElementById("filbar")),
      filn: box(document.getElementById("filn")),
      mfl: box(document.getElementById("mfl")),
      qs: box(document.getElementById("qs")),
      aps: box(document.getElementById("aps")),
      wxst: box(document.getElementById("wxst")),
      mfsnote: box(document.getElementById("mfsnote")),
      infosheet: box(document.getElementById("infosheet")),
      wxdock: box(document.getElementById("wxdock")),
      attrib: box(document.querySelector(".maplibregl-ctrl-attrib")),
      zoom: box(document.querySelector(".maplibregl-ctrl-bottom-right")),
      inner: { w: innerWidth, h: innerHeight },
      metDefault: document.getElementById("wxmet").checked,
      hazDefault: document.getElementById("wxhaz").checked,
      firstWxId: (document.querySelector("#wxctl input[type=checkbox]") || {}).id,
      labels,
      wxmetMin: map.getLayer("wxmet") && map.getLayer("wxmet").minzoom,
      wxlabelMin: map.getLayer("wxmet-lab") && map.getLayer("wxmet-lab").minzoom,
      clustered,
      clusterSrc: Object.keys(map.getStyle().sources).filter((k) => map.getSource(k) && map.getSource(k)._options && map.getSource(k)._options.cluster),
      wxbtnText: (wxbtn && wxbtn.textContent || "").replace(/\s+/g, " ").trim(),
    };
  });
}

async function enableMetar(page) {
  await page.evaluate(() => {
    document.getElementById("wxctl").open = true;
    if (typeof setWx === "function") setWx("met", true);
    if (typeof closeSheets === "function") closeSheets();
  });
  await page.waitForFunction(() => WX.st && WX.st.metar && WX.st.metar.length > 0, { timeout: 45000 });
}

async function rendered(page, zoom, center = [55.36, 25.25]) {
  await page.evaluate((z, c) => { map.jumpTo({ center: c, zoom: z }); }, zoom, center);
  await page.waitForFunction(() => map.loaded() && !map.isMoving(), { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 700));
  return page.evaluate(() => {
    const icons = map.queryRenderedFeatures({ layers: ["wxmet"] });
    const labs = map.queryRenderedFeatures({ layers: ["wxmet-lab"] });
    const src = map.getSource("wxmet");
    const d = (src && src._data) || { features: [] };
    const omdb = d.features.find((f) => f.properties.icao === "OMDB") || d.features[0];
    const p = (omdb && omdb.properties) || {};
    const api = (WX.st.metar.find((m) => m.icao === p.icao) || WX.st.metar[0] || {});
    return {
      zoom: map.getZoom(),
      nSrc: d.features.length,
      nIcon: icons.length,
      nLab: labs.length,
      vis: map.getLayoutProperty("wxmet", "visibility"),
      labVis: map.getLayoutProperty("wxmet-lab", "visibility"),
      p,
      api: { icao: api.icao, tempC: api.tempC, windText: api.windText, pressPa: api.pressPa, pressRef: api.pressRef, obsTime: api.obsTime, raw: (api.raw || "").slice(0, 80) },
      labHasPa: / Pa\b|Pa n\/a/.test(p.lab || ""),
      shortHasIcao: (p.labShort || "").includes(p.icao || ""),
      shortAvn: /\d{6}Z/.test(p.labShort || "") && /KT/.test(p.labShort || "") && /Q\d{4}|A\d{4}|Q n\/a/.test(p.labShort || ""),
      paNotInQ: !/Q101500|A101500/.test(p.labShort || ""),
      missingHonest: !/101325 Pa/.test(p.lab || "") || api.pressPa != null,
      iconColor: JSON.stringify(map.getPaintProperty("wxmet", "icon-color") || ""),
    };
  });
}

const mobile = await open(390, 844);
const lay = await layout(mobile);
evidence.lay390 = lay;
ok(lay.wxbtn && lay.wxbtn.vis, "Weather button visible at 390");
ok(/Weather/.test(lay.wxbtnText), "Weather button has text");
ok(lay.wxbtn.h >= 44 && lay.wxbtn.w >= 44, "Weather tap target at least 44px");
ok(lay.infobtn && lay.infobtn.vis && /Info/i.test(lay.infobtn.t), "Info button visible");
ok(lay.htb && lay.htb.vis && lay.rlb && lay.rlb.vis, "tracks and registration on the mobile bar");
ok(lay.depb && lay.depb.vis && lay.arrb && lay.arrb.vis && /Dep/i.test(lay.depb.t) && /Arr/i.test(lay.arrb.t), "Dep/Arr pills on the mobile bar");
ok(lay.depb.h >= 44 && lay.arrb.h >= 44, "Dep/Arr tap targets at least 44px");
ok(lay.dirpair && lay.dirpair.x >= 0 && lay.dirpair.x + lay.dirpair.w <= lay.inner.w + 1, "Dep/Arr pair stays on the bar");
ok(lay.mfsb && lay.mfsb.vis && lay.fbtn && lay.fbtn.vis && lay.qs && lay.qs.vis, "filters, search, fullscreen reachable");
ok(lay.filbar && lay.filbar.vis, "mobile airline chips are on the map");
ok(lay.fbtn.h >= 44 && lay.fbtn.w >= 44, "Filters tap target at least 44px");
ok(lay.filn && lay.filn.vis, "left-side live counts are on the map");
ok(lay.firstWxId === "wxmet", "Airport METAR is the first weather checkbox");
ok(!lay.metDefault && !lay.hazDefault, "METAR and hazards default off");
ok(lay.wxmetMin >= 8.5 && lay.wxmetMin <= 10, "airport icons start at close airport zoom");
ok(lay.wxlabelMin >= 8.5, "METAR labels also wait for close airport zoom");
ok(!lay.clustered && (!lay.clusterSrc || !lay.clusterSrc.length), "no clustering");
ok(!overlap(lay.wxbtn, lay.attrib) && !overlap(lay.wxbtn, lay.zoom), "Weather does not overlap zoom/attribution");
ok(!overlap(lay.wxbtn, lay.mfsnote), "Weather does not sit under the fullscreen note");
ok(!(lay.wxst && lay.wxst.vis) || !overlap(lay.wxbtn, lay.wxst), "Weather not covered by status banner");
ok(!(lay.wxst && lay.wxst.vis && /Not for operational/.test(lay.wxst.t)), "verbose caveat is not a persistent map banner");
await shot(mobile, "mobile-chrome-390");

await mobile.click("#wxbtn");
await new Promise((r) => setTimeout(r, 250));
const dock = await mobile.evaluate(() => {
  const d = document.getElementById("wxdock");
  const lead = document.querySelector(".wxlead");
  return {
    open: d.classList.contains("open"),
    lead: lead && lead.textContent,
    metText: document.querySelector("label[for=wxmet], #wxmet") && document.getElementById("wxmet").closest("label").textContent,
    expanded: document.getElementById("wxbtn").getAttribute("aria-expanded"),
  };
});
ok(dock.open && dock.expanded === "true", "Weather sheet opens from the bar button");
ok(/Airport METAR/i.test(dock.metText) && /circled|circle|encircled/i.test(dock.lead) && /zoom 9/i.test(dock.lead), "sheet explains circled-aircraft METAR at close zoom");
evidence.dock = dock;
await shot(mobile, "mobile-weather-sheet-390");

await enableMetar(mobile);
const world = await rendered(mobile, 1.15, [35, 28]);
ok(world.vis === "visible" && world.nSrc > 0, "METAR source populated after toggle");
ok(world.nIcon === 0 && world.nLab === 0, "no airport station icons or labels at world zoom");
ok(world.api.icao, "station identity is sourced");
ok(world.api.pressPa == null || Number.isInteger(world.api.pressPa), "Pa is integer or omitted");
ok(world.p.pressPa === "" || /^\d+$/.test(world.p.pressPa), "marker does not invent pressure");
evidence.world = { nIcon: world.nIcon, nSrc: world.nSrc, icao: world.api.icao, pressPa: world.api.pressPa, zoom: world.zoom };
await shot(mobile, "mobile-metar-world-390");

const gulf = await rendered(mobile, 6.8);
ok(gulf.nIcon === 0 && gulf.nLab === 0, "no airport station icons at regional Gulf zoom");
evidence.gulf = { nIcon: gulf.nIcon, nLab: gulf.nLab, zoom: gulf.zoom };
await shot(mobile, "mobile-metar-gulf-390");

const apt = await rendered(mobile, 10.4);
ok(apt.nIcon > 0, "circled-aircraft icons visible at airport zoom");
ok(apt.nLab > 0, "METAR labels render at close airport zoom");
ok(apt.shortHasIcao && apt.shortAvn, "compact label is METAR-style ICAO/time/wind/Q");
ok(apt.labHasPa && apt.paNotInQ, "Pa stays on the expanded label, not in the Q group");
ok(!/ff5a36|ff2fd6/.test(apt.iconColor || ""), "airport icon is not hazard red/magenta");
ok(apt.api.windText && apt.api.tempC != null, "sourced temp and wind on the station");
ok(!/live minute/i.test(apt.p.lab || ""), "labels do not claim live-minute readings");
evidence.apt = { nIcon: apt.nIcon, nLab: apt.nLab, lab: apt.p.lab, labShort: apt.p.labShort, api: apt.api, zoom: apt.zoom };
await shot(mobile, "mobile-metar-airport-390");
await mobile.evaluate(() => map.jumpTo({ center: [55.36, 25.25], zoom: 11.6 }));
await new Promise((r) => setTimeout(r, 700));
const hit = await mobile.evaluate(() => {
  const feats = map.queryRenderedFeatures({ layers: ["wxmet"] });
  const omdb = feats.find((f) => f.properties.icao === "OMDB") || feats[0];
  if (!omdb) return { n: feats.length };
  const pt = map.project(omdb.geometry.coordinates);
  const around = map.queryRenderedFeatures(pt, { layers: ["wxmet"] });
  return { n: feats.length, hit: around.some((f) => f.properties.icao === omdb.properties.icao), icao: omdb.properties.icao };
});
ok(hit.n > 0 && hit.hit, "airport icon is queryable at the station point");
evidence.hit = hit;
await shot(mobile, "mobile-airport-icon-closeup-390");
await mobile.evaluate(() => setHideTracks(true));
const hid = await rendered(mobile, 10.4);
ok(hid.nIcon > 0 && hid.nLab > 0, "Hide tracks does not hide airport METAR");
const hidWorld = await rendered(mobile, 2.2, [35, 28]);
ok(hidWorld.nIcon === 0, "zooming back out hides airport stations again");
await mobile.evaluate(() => setHideTracks(false));

await mobile.click("#infobtn");
await new Promise((r) => setTimeout(r, 200));
const info = await mobile.evaluate(() => {
  const el = document.getElementById("infosheet");
  const full = document.getElementById("wxfull");
  return {
    open: !el.hidden,
    text: el.innerText.slice(0, 500),
    full: (full && full.textContent) || "",
    dockClosed: !document.getElementById("wxdock").classList.contains("open"),
    caveat: /Not for operational/i.test(el.innerText),
    noHazards: /not .no hazards.|Upstream errors are not/i.test(el.innerText),
  };
});
ok(info.open && info.dockClosed, "Info sheet replaces the weather sheet");
ok(info.caveat && info.noHazards, "operational caveat and honest error wording in Info");
evidence.info = { open: info.open, caveat: info.caveat };
await shot(mobile, "mobile-info-390");
await mobile.click("#infox");

await mobile.evaluate(() => { if (typeof unsel === "function") unsel(); });
await mobile.evaluate(() => {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => false });
  HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error("ios"));
  syncFS();
});
await mobile.click("#mfsb");
await new Promise((r) => setTimeout(r, 400));
const fsLay = await layout(mobile);
const fsFar = await rendered(mobile, 6.8);
const fsMet = await rendered(mobile, 10.4);
ok(await mobile.evaluate(() => document.body.classList.contains("map-fs")), "mobile map-only fullscreen fallback");
ok(fsLay.wxbtn && fsLay.wxbtn.vis && /Weather/.test(fsLay.wxbtnText), "Weather remains in map-only fullscreen");
ok(!overlap(fsLay.wxbtn, fsLay.attrib) && !overlap(fsLay.wxbtn, fsLay.zoom), "fullscreen Weather clear of zoom/attribution");
ok(fsFar.nIcon === 0, "fullscreen still hides airport stations at regional zoom");
ok(fsMet.nIcon > 0 && fsMet.nLab > 0, "airport METAR markers in map-only fullscreen at airport zoom");
ok(!(fsLay.mfsnote && fsLay.mfsnote.vis), "persistent fullscreen notes are hidden on mobile map-fs");
ok(!(fsLay.wxst && fsLay.wxst.vis && /Not for operational/i.test(fsLay.wxst.t || "")), "verbose weather notes are not a map-fs banner");
const fsHaz = await mobile.evaluate(async () => {
  await setWx("haz", true);
  map.setZoom(3.4);
  await new Promise((r) => setTimeout(r, 500));
  const fills = map.queryRenderedFeatures({ layers: ["wxhaz-fill"] });
  return { nFill: fills.length, vis: map.getLayoutProperty("wxhaz-fill", "visibility") };
});
ok(fsHaz.vis === "visible", "hazard polygons remain available and are not the airport icon");
evidence.fs390 = { wx: fsLay.wxbtn, nIcon: fsMet.nIcon, nLab: fsMet.nLab, noteVis: !!(fsLay.mfsnote && fsLay.mfsnote.vis), nHaz: fsHaz.nFill };
await shot(mobile, "mobile-metar-fs-390");
await mobile.click("#mfsb");
await new Promise((r) => setTimeout(r, 300));
ok(await mobile.evaluate(() => !document.body.classList.contains("map-fs")), "exit map fullscreen");
await mobile.close();

const restored = await open(390, 844, { wxmet: "1" });
ok(await restored.evaluate(() => document.getElementById("wxmet").checked && map.getLayoutProperty("wxmet", "visibility") === "visible"), "METAR restore from localStorage");
await restored.close();

const n320 = await open(320, 568);
const lay320 = await layout(n320);
ok(lay320.wxbtn && lay320.wxbtn.vis && lay320.wxbtn.h >= 44, "Weather visible at 320");
ok(lay320.mfsb && lay320.mfsb.vis && lay320.qs && lay320.qs.vis, "search and fullscreen still on 320");
ok(lay320.filbar && lay320.filbar.vis && lay320.fbtn && lay320.fbtn.vis, "320 airline chips and Filters button");
ok(!overlap(lay320.wxbtn, lay320.zoom), "320 Weather clear of zoom");
await enableMetar(n320);
const g320far = await rendered(n320, 5.4);
ok(g320far.nIcon === 0, "320 hides airport stations at regional zoom");
const g320 = await rendered(n320, 10.4);
ok(g320.nIcon > 0, "airport icons at 320 when zoomed on the field");
evidence.n320 = { wx: lay320.wxbtn, nIcon: g320.nIcon, nLab: g320.nLab };
await shot(n320, "mobile-chrome-320");
await shot(n320, "mobile-metar-320");
await n320.close();

const n430 = await open(430, 932);
const lay430 = await layout(n430);
ok(lay430.wxbtn && lay430.wxbtn.vis, "Weather visible at 430");
ok(lay430.filbar && lay430.filbar.vis, "430 airline chips visible");
await enableMetar(n430);
await rendered(n430, 10.4);
await shot(n430, "mobile-metar-430");
await n430.close();

const land = await open(390, 844, { wxmet: "1" }, true);
const layL = await layout(land);
ok(layL.wxbtn && layL.wxbtn.vis, "Weather visible in landscape");
ok(layL.fbtn && layL.fbtn.vis, "Filters button remains in landscape");
ok(!overlap(layL.wxbtn, layL.zoom), "landscape Weather clear of zoom");
await land.waitForFunction(() => WX.st && WX.st.metar && WX.st.metar.length > 0, { timeout: 45000 }).catch(() => {});
if (!(await land.evaluate(() => WX.st && WX.st.metar && WX.st.metar.length))) await enableMetar(land);
const gLfar = await rendered(land, 6.4);
ok(gLfar.nIcon === 0, "landscape hides airport stations at regional zoom");
const gL = await rendered(land, 10.4);
ok(gL.nIcon > 0, "landscape airport icons when zoomed on the field");
evidence.land = { inner: layL.inner, nIcon: gL.nIcon };
await shot(land, "mobile-metar-landscape-390");
await land.close();

const desk = await open(1280, 860);
const dLay = await layout(desk);
ok(dLay.mfsb && dLay.mfsb.vis, "desktop map fullscreen remains");
ok(dLay.fbtn && dLay.fbtn.vis, "desktop Filters button is in the map chrome");
ok(await desk.evaluate(() => document.getElementById("wxctl") && document.getElementById("mw").contains(document.getElementById("wxctl")) && document.getElementById("mw").contains(document.getElementById("mfl"))), "desktop weather and filters still in the map");
ok(!dLay.clustered, "desktop still has no clustering");
await enableMetar(desk);
const dFar = await rendered(desk, 7.0);
ok(dFar.nIcon === 0, "desktop hides airport stations at regional zoom");
const dG = await rendered(desk, 10.4);
ok(dG.nIcon > 0 && dG.nLab > 0 && dG.labHasPa, "desktop METAR icons and Pa labels at airport zoom");
await shot(desk, "desktop-metar-1280");
await desk.evaluate(() => { if (typeof unsel === "function") unsel(); });
await desk.click("#mfsb");
await new Promise((r) => setTimeout(r, 500));
const dFs = await rendered(desk, 10.4);
ok(dFs.nIcon > 0, "desktop map-only fullscreen still shows airport METAR at airport zoom");
await shot(desk, "desktop-metar-fs-1280");
if (await desk.evaluate(() => document.body.classList.contains("map-fs") || document.fullscreenElement)) {
  await desk.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
  if (await desk.evaluate(() => document.body.classList.contains("map-fs") || document.fullscreenElement)) await desk.click("#mfsb");
}
await desk.close();

await browser.close();
evidence.fail = fail;
fs.writeFileSync(OUT + "/mobile-map-chrome-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ fail, evidence: { lay390: { wx: lay.wxbtn, firstWxId: lay.firstWxId, wxmetMin: lay.wxmetMin }, world: evidence.world, gulf: evidence.gulf, fs390: evidence.fs390 } }, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
