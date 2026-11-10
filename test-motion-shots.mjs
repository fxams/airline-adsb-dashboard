import puppeteer from "puppeteer-core";
import fs from "fs";

const BASE = "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });

const fail = [];
function ok(cond, msg) { if (!cond) fail.push(msg); }

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
await page.setCacheEnabled(false);
await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.hidet = "0"; localStorage.reglab = "1"; });
await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => typeof LiveMotion === "object" && typeof paintLive === "function" && map && map.getLayer && map.getLayer("live"), { timeout: 90000 });

const js = await page.evaluate(() => !!document.querySelector('script[src="/motion.js"]'));
ok(js, "motion.js script tag present");
const mot = await fetch(BASE + "/motion.js").then((r) => r.status);
ok(mot === 200, "/motion.js HTTP 200");

await page.evaluate(() => {
  L = { at: new Date().toISOString(), ac: [
    ["air1", "QTR99", "QTR", "B77W", 25.40, 52.00, 37000, 480, 90, "A7-HI", 0, 3, 0],
    ["gnd1", "QTR0", "QTR", "A359", 25.2731, 51.6081, 0, 0, 156, "A7-GND", 1, 2, 0]
  ], nm: { QTR: "Qatar Airways" } };
  if (typeof MOT === "object") Object.keys(MOT).forEach((k) => delete MOT[k]);
  if (typeof TR === "object") Object.keys(TR).forEach((k) => delete TR[k]);
  if (typeof onPoll === "function") onPoll();
  $("trl").checked = true;
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => false });
  HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error("ios"));
  if (typeof syncFS === "function") syncFS();
  document.body.classList.add("map-fs");
  if (typeof padMap === "function") padMap();
  map.resize();
  map.jumpTo({ center: [52.04, 25.40], zoom: 8.8, bearing: 0, pitch: 0 });
  if (typeof paintLive === "function") paintLive({ view: false });
  document.body.classList.remove("map-fs");
  document.querySelectorAll("header,nav,#kpis,#kxc,#t-overview .g").forEach((e) => { if (e) e.style.display = "none"; });
  document.querySelectorAll("#t-overview > .card").forEach((c) => { if (!c.querySelector("#mw")) c.style.display = "none"; });
  const mapEl = document.getElementById("map");
  if (mapEl) mapEl.style.height = "520px";
  map.resize();
});
await new Promise((r) => setTimeout(r, 800));

async function shot(name) {
  const el = await page.$("#mw");
  if (el) await el.screenshot({ path: `${OUT}/${name}.png` });
  else await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function pos() {
  return page.evaluate(() => {
    const live = map.getSource("live") && map.getSource("live")._data;
    const feat = (h) => (live.features || []).find((f) => f.properties.h === h);
    const air = feat("air1"), gnd = feat("gnd1");
    const trails = map.getSource("trails") && map.getSource("trails")._data;
    const tr = (trails.features || []).find((f) => {
      const c = f.geometry.coordinates;
      return air && c && Math.abs(c[c.length - 1][0] - air.geometry.coordinates[0]) < 1e-4;
    });
    return {
      air: air && air.geometry.coordinates,
      airTrk: air && air.properties.trk,
      gnd: gnd && gnd.geometry.coordinates,
      trailEnd: tr && tr.geometry.coordinates[tr.geometry.coordinates.length - 1],
      nLive: (live.features || []).length,
    };
  });
}

const t0 = await pos();
await shot("motion-after-t0");
await new Promise((r) => setTimeout(r, 2000));
await page.evaluate(() => paintLive({ view: false }));
const t1 = await pos();
await shot("motion-after-2s");

ok(t0.air && t1.air, "airborne marker present");
ok(t0.gnd && t1.gnd, "ground marker present");
const dlon = t1.air && t0.air ? t1.air[0] - t0.air[0] : 0;
ok(dlon > 0.002, "airborne marker moved east in 2 s (dlon=" + dlon + ")");
ok(t0.gnd && t1.gnd && Math.abs(t1.gnd[0] - t0.gnd[0]) < 1e-7 && Math.abs(t1.gnd[1] - t0.gnd[1]) < 1e-7, "ground 0 kt stayed put");
ok(t1.trailEnd && t1.air && Math.abs(t1.trailEnd[0] - t1.air[0]) < 1e-5 && Math.abs(t1.trailEnd[1] - t1.air[1]) < 1e-5, "amber trail ends on displayed position");

await page.evaluate(() => {
  const air = L.ac.find((a) => a[0] === "air1");
  air[4] = 25.42; air[5] = 52.12; air[8] = 95;
  L.at = new Date().toISOString();
  if (typeof onPoll === "function") onPoll();
});
const b0 = await pos();
await new Promise((r) => setTimeout(r, 900));
await page.evaluate(() => paintLive({ view: false }));
const b1 = await pos();
ok(b1.airTrk > 90 && b1.airTrk < 95, "heading is blending toward 95, got " + b1.airTrk);
ok(b1.air[0] !== b0.air[0], "position keeps moving during blend");

await shot("motion-after-blend");

const evidence = { utc: new Date().toISOString(), t0, t1, dlon, b0, b1, fail };
fs.writeFileSync(OUT + "/motion-evidence.json", JSON.stringify(evidence, null, 2));
await browser.close();
console.log(JSON.stringify(evidence, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
