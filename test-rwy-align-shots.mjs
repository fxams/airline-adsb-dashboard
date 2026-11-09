import fs from "fs";
import puppeteer from "puppeteer-core";

const BASE = "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });
const fail = [];
function ok(cond, msg) { if (!cond) fail.push(msg); }

const rows = JSON.parse(fs.readFileSync(OUT + "/rwy-offset-measure.json", "utf8"));

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function open() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    localStorage.hidet = "0";
    localStorage.rwy = "1";
    localStorage.apt = "G";
  });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof setApt === "function" && map && map.loaded && map.loaded(), { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 400));
  return page;
}

async function goApt(page, id) {
  await page.evaluate((apt) => { APT_FLY = false; setApt(apt, { fly: false }); }, id);
  await page.waitForFunction((apt) => HIST_APT === apt && HIST && map.getSource("hist"), { timeout: 20000 }, id);
}

const page = await open();
const evidence = { utc: new Date().toISOString(), rows: [] };

for (const row of rows) {
  await goApt(page, row.apt);
  await page.evaluate((row) => {
    const el = document.getElementById("rwy-measure");
    if (el) el.remove();
    if (map.getLayer("oa-rwy")) map.removeLayer("oa-rwy");
    if (map.getLayer("obs-pt")) map.removeLayer("obs-pt");
    if (map.getSource("rwy-measure")) map.removeSource("rwy-measure");
    map.addSource("rwy-measure", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { k: "oa" },
            geometry: { type: "LineString", coordinates: [[row.rwy_lon, row.rwy_lat], [row.rwy_end_lon, row.rwy_end_lat]] },
          },
          {
            type: "Feature",
            properties: { k: "obs" },
            geometry: { type: "Point", coordinates: [row.lon, row.lat] },
          },
        ],
      },
    });
    map.addLayer({
      id: "oa-rwy", type: "line", source: "rwy-measure", filter: ["==", ["get", "k"], "oa"],
      paint: { "line-color": "#ffff00", "line-width": 2, "line-opacity": 0.9 },
    });
    map.addLayer({
      id: "obs-pt", type: "circle", source: "rwy-measure", filter: ["==", ["get", "k"], "obs"],
      paint: { "circle-radius": 7, "circle-color": "#00e5ff", "circle-stroke-width": 2, "circle-stroke-color": "#000" },
    });
    APT_FLY = true;
    map.jumpTo({ center: [row.lon, row.lat], zoom: 16.2, bearing: row.hdg, pitch: 0 });
    map.resize();
    const box = document.createElement("div");
    box.id = "rwy-measure";
    box.style.cssText = "position:absolute;z-index:20;left:12px;top:86px;background:rgba(6,12,24,.92);border:1px solid #00e5ff;border-radius:10px;padding:10px 12px;color:#e6f1ff;font:13px/1.4 sans-serif;max-width:340px";
    box.innerHTML = `<b>${row.apt} RWY ${row.rwy} ${row.dir}</b><br>lateral offset from OurAirports centreline: <b>${row.cross_m} m</b> (|${row.abs_cross_m}| m)<br>along-track from threshold: ${row.along_m} m · n=${row.n} observed clips<br>cyan = observed path vertex (not snapped) · yellow = OurAirports centreline<br>Imagery © Esri, Maxar. Not for navigation.`;
    document.getElementById("mw").appendChild(box);
  }, row);
  await new Promise((r) => setTimeout(r, 900));
  const name = `rwy-${row.apt.toLowerCase()}-${row.rwy.toLowerCase()}-${row.dir}`;
  const el = await page.$("#mw");
  const p = `${OUT}/${name}.png`;
  if (el) await el.screenshot({ path: p });
  else await page.screenshot({ path: p });
  ok(row.abs_cross_m <= 80, `${row.apt} ${row.rwy} ${row.dir} |cross|=${row.abs_cross_m} m`);
  evidence.rows.push({ ...row, shot: p });
}

// Zoomed-out EGLL / DOH: paths remain, labels off.
for (const apt of ["LHR", "DOH"]) {
  await goApt(page, apt);
  await page.evaluate((id) => {
    const h = AirportHubs.resolveApt(id);
    APT_FLY = false;
    map.jumpTo({ center: [h.lon, h.lat], zoom: 7.4, bearing: 0, pitch: 0 });
    const el = document.getElementById("rwy-measure");
    if (el) el.remove();
  }, apt);
  await new Promise((r) => setTimeout(r, 800));
  const vis = await page.evaluate(() => ({
    apt: APT,
    hist: map.getLayer("hist-rep") && map.getLayoutProperty("hist-rep", "visibility"),
    lab: map.getLayer("hist-lab") && map.getLayoutProperty("hist-lab", "visibility"),
    zoom: map.getZoom(),
  }));
  ok(vis.hist === "visible", `${apt} hist visible at world zoom`);
  ok(vis.lab === "none", `${apt} labels hidden at world zoom`);
  const el = await page.$("#mw");
  const p = `${OUT}/rwy-${apt.toLowerCase()}-zoomout-desk.png`;
  if (el) await el.screenshot({ path: p });
  evidence[apt + "ZoomOut"] = { ...vis, shot: p };
}

await page.close();

const mob = await browser.newPage();
await mob.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await mob.setCacheEnabled(false);
await mob.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.hidet = "0"; localStorage.rwy = "1"; });
await mob.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
await mob.waitForFunction(() => typeof setApt === "function" && map && map.loaded && map.loaded(), { timeout: 90000 });
for (const apt of ["LHR", "DOH"]) {
  await mob.evaluate((id) => { APT_FLY = false; setApt(id, { fly: false }); }, apt);
  await mob.waitForFunction((id) => HIST_APT === id && HIST, { timeout: 20000 }, apt);
  await mob.evaluate((id) => {
    const h = AirportHubs.resolveApt(id);
    APT_FLY = false;
    map.jumpTo({ center: [h.lon, h.lat], zoom: 7.2, bearing: 0, pitch: 0 });
  }, apt);
  await new Promise((r) => setTimeout(r, 800));
  const vis = await mob.evaluate(() => ({
    hist: map.getLayer("hist-rep") && map.getLayoutProperty("hist-rep", "visibility"),
    rwyb: !!(document.getElementById("rwyb")),
    rwyOn: document.getElementById("rwyb") && document.getElementById("rwyb").classList.contains("on"),
  }));
  ok(vis.rwyb && vis.rwyOn, `${apt} mobile RWY paths button on`);
  ok(vis.hist === "visible", `${apt} mobile zoom-out hist visible`);
  const el = await mob.$("#mw");
  const p = `${OUT}/rwy-${apt.toLowerCase()}-zoomout-iphone.png`;
  if (el) await el.screenshot({ path: p });
  evidence[apt + "Mob"] = { ...vis, shot: p };
}
await mob.close();
await browser.close();

fs.writeFileSync(OUT + "/rwy-align-shots.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ fail, n: evidence.rows.length, offsets: evidence.rows.map((r) => `${r.apt} ${r.rwy} ${r.dir} ${r.cross_m}m`) }, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
