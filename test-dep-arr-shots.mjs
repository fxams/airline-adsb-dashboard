import fs from "fs";
import puppeteer from "puppeteer-core";

const BASE = "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });
const fail = [];
function ok(cond, msg) { if (!cond) fail.push(msg); }

const LIVE = ["#ffc400", "#ffe14d", "#00e5ff", "#ff2fd6"];
const PATH = { dep: "#3D8BFF", arr: "#FF4B6B", sid: "#8FB8FF", star: "#FF8A9E" };

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function open(w, h, mobile, store = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument((s) => {
    localStorage.clear();
    localStorage.hidet = "0";
    localStorage.apt = "G";
    Object.assign(localStorage, s);
  }, store);
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof setApt === "function" && map && map.loaded && map.loaded(), { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 400));
  return page;
}

async function goApt(page, id, zoom = 12.2) {
  await page.evaluate((apt) => { APT_FLY = false; setApt(apt, { fly: false }); }, id);
  await page.waitForFunction((apt) => HIST_APT === apt && HIST && map.getSource("hist"), { timeout: 20000 }, id);
  await page.evaluate((apt, z) => {
    const h = AirportHubs.resolveApt(apt);
    map.jumpTo({ center: [h.lon, h.lat], zoom: z, bearing: 0, pitch: 0 });
    map.resize();
    if (typeof histPaint === "function") histPaint();
  }, id, zoom);
  await new Promise((r) => setTimeout(r, 700));
}

async function mode(page, { dep, arr, hide = true, aip = false }) {
  await page.evaluate((d, a, h, p) => {
    setDepPaths(d);
    setArrPaths(a);
    setHideTracks(h);
    if (typeof setAipOn === "function") setAipOn(p);
  }, dep, arr, hide, aip);
  await new Promise((r) => setTimeout(r, 250));
}

async function vis(page) {
  return page.evaluate((PATH) => {
    const src = map.getSource("hist") && map.getSource("hist")._data;
    const feats = (src && src.features) || [];
    const filt = map.getFilter("hist-rep");
    const css = getComputedStyle(document.documentElement);
    return {
      apt: APT,
      zoom: map.getZoom(),
      sat: map.getLayer("sat") && map.getLayoutProperty("sat", "visibility"),
      hist: map.getLayer("hist-rep") && map.getLayoutProperty("hist-rep", "visibility"),
      filt: JSON.stringify(filt || null),
      nDep: feats.filter((f) => f.properties.dir === "dep").length,
      nArr: feats.filter((f) => f.properties.dir === "arr").length,
      paint: JSON.stringify(map.getPaintProperty("hist-rep", "line-color") || []),
      trail: JSON.stringify(map.getPaintProperty("trails", "line-gradient") || map.getPaintProperty("trails", "line-color") || []),
      sid: map.getLayer("aip-sid") && map.getLayoutProperty("aip-sid", "visibility"),
      star: map.getLayer("aip-star") && map.getLayoutProperty("aip-star", "visibility"),
      sidDash: JSON.stringify(map.getPaintProperty("aip-sid", "line-dasharray") || []),
      starDash: JSON.stringify(map.getPaintProperty("aip-star", "line-dasharray") || []),
      depOn: depPathsOn(),
      arrOn: arrPathsOn(),
      depb: document.getElementById("depb") && document.getElementById("depb").classList.contains("on"),
      arrb: document.getElementById("arrb") && document.getElementById("arrb").classList.contains("on"),
      cssDep: css.getPropertyValue("--dep").trim().toUpperCase(),
      cssArr: css.getPropertyValue("--arr").trim().toUpperCase(),
      cssSid: css.getPropertyValue("--sid").trim().toUpperCase(),
      cssStar: css.getPropertyValue("--star").trim().toUpperCase(),
      legend: !!(document.querySelector("#mfl .pathleg")),
      want: PATH,
    };
  }, PATH);
}

async function shot(page, name) {
  await page.evaluate(() => { const el = document.getElementById("mw"); if (el) el.scrollIntoView({ block: "nearest" }); });
  await new Promise((r) => setTimeout(r, 220));
  const p = `${OUT}/${name}.png`;
  const el = await page.$("#mw");
  if (el) await el.screenshot({ path: p });
  else await page.screenshot({ path: p });
  return p;
}

const evidence = { utc: new Date().toISOString() };

{
  const mig = await open(800, 600, false, { rwy: "0" });
  const m = await mig.evaluate(() => ({ dep: depPathsOn(), arr: arrPathsOn(), lsDep: localStorage.dep, lsArr: localStorage.arr }));
  ok(m.dep === false && m.arr === false && m.lsDep === "0" && m.lsArr === "0", "old Runway paths off migrates to both off");
  await mig.close();
}

const desk = await open(1280, 900, false);
await goApt(desk, "LHR", 12.2);
const colors = await vis(desk);
ok(colors.nDep >= 1 && colors.nArr >= 1, `EGLL has dep+arr features ${colors.nDep}/${colors.nArr}`);
ok(colors.paint.includes(PATH.dep) && colors.paint.includes(PATH.arr), "hist-rep uses new dep/arr colours");
ok(LIVE.every((c) => !colors.paint.toLowerCase().includes(c)), "hist-rep colour is not live/airline");
ok(colors.cssDep === PATH.dep && colors.cssArr === PATH.arr, "CSS variables match path colours");
ok(colors.cssSid === PATH.sid && colors.cssStar === PATH.star, "SID/STAR CSS family shades");
ok(colors.sat === "visible", "airport view uses satellite basemap");
ok(colors.legend, "filter sheet has path colour legend");
ok(/[2-9]/.test(colors.sidDash) && /[2-9]/.test(colors.starDash), "published SID/STAR are dashed");

await mode(desk, { dep: true, arr: true, hide: true });
const both = await vis(desk);
ok(both.hist === "visible" && both.depOn && both.arrOn && both.depb && both.arrb, "both on");
ok(both.filt === "null", "both on shows every direction");
evidence.egllDeskBoth = await shot(desk, "dep-arr-egll-both-desk");

await mode(desk, { dep: true, arr: false, hide: true });
const depOnly = await vis(desk);
ok(depOnly.hist === "visible" && depOnly.depOn && !depOnly.arrOn && depOnly.depb && !depOnly.arrb, "dep only");
ok(/dep/.test(depOnly.filt), "dep-only filter");
evidence.egllDeskDep = await shot(desk, "dep-arr-egll-dep-desk");

await mode(desk, { dep: false, arr: true, hide: true });
const arrOnly = await vis(desk);
ok(arrOnly.hist === "visible" && !arrOnly.depOn && arrOnly.arrOn && !arrOnly.depb && arrOnly.arrb, "arr only");
ok(/arr/.test(arrOnly.filt), "arr-only filter");
evidence.egllDeskArr = await shot(desk, "dep-arr-egll-arr-desk");

await mode(desk, { dep: false, arr: false, hide: false });
const none = await vis(desk);
ok(none.hist === "none" && !none.depOn && !none.arrOn && !none.depb && !none.arrb, "none hides hist-rep");
evidence.egllDeskNone = await shot(desk, "dep-arr-egll-none-desk");

await mode(desk, { dep: true, arr: true, hide: true });
await desk.evaluate(() => { APT_FLY = false; map.jumpTo({ center: map.getCenter(), zoom: 7.4 }); });
await new Promise((r) => setTimeout(r, 800));
const dark = await vis(desk);
ok(dark.hist === "visible", "paths stay on dark regional zoom");
ok(dark.zoom < 10, "regional zoom is below satellite minzoom");
evidence.egllDeskDark = await shot(desk, "dep-arr-egll-both-dark-desk");
await desk.evaluate(() => {
  const h = AirportHubs.resolveApt("LHR");
  APT_FLY = false;
  map.jumpTo({ center: [h.lon, h.lat], zoom: 12.2 });
});
await new Promise((r) => setTimeout(r, 400));

await mode(desk, { dep: true, arr: true, hide: false });
await desk.evaluate(() => { if (typeof toggleFilters === "function") toggleFilters(); });
await new Promise((r) => setTimeout(r, 300));
evidence.egllDeskLegend = await shot(desk, "dep-arr-egll-legend-desk");
const legendText = await desk.evaluate(() => (document.querySelector("#mfl .pathleg") || {}).innerText || "");
ok(/365-day departures/i.test(legendText) && /365-day arrivals/i.test(legendText), "legend names both observed colours");
ok(/published SID/i.test(legendText) && /published STAR/i.test(legendText), "legend names SID/STAR family");
const togLabs = await desk.evaluate(() => ({
  dep: ((document.getElementById("depf") || {}).closest("label") || {}).innerText || "",
  arr: ((document.getElementById("arrf") || {}).closest("label") || {}).innerText || "",
}));
ok(/Departures/.test(togLabs.dep) && /Arrivals/.test(togLabs.arr), "filter pills named Departures and Arrivals");
await desk.evaluate(() => { if (typeof closeFilters === "function") closeFilters(); });

await goApt(desk, "JFK", 11.6);
await desk.waitForFunction((apt) => AIP_APT === apt && AIP && !AIP.error, { timeout: 20000 }, "JFK");
await mode(desk, { dep: true, arr: true, hide: true, aip: true });
await new Promise((r) => setTimeout(r, 600));
const jfkBoth = await vis(desk);
ok(jfkBoth.sid === "visible" && jfkBoth.star === "visible", "JFK CIFP SID and STAR follow both toggles");
evidence.jfkDeskBoth = await shot(desk, "dep-arr-jfk-aip-both-desk");
await mode(desk, { dep: true, arr: false, hide: true, aip: true });
const jfkDep = await vis(desk);
ok(jfkDep.sid === "visible" && jfkDep.star === "none", "SIDs follow Departures");
evidence.jfkDeskDep = await shot(desk, "dep-arr-jfk-aip-dep-desk");
await mode(desk, { dep: false, arr: true, hide: true, aip: true });
const jfkArr = await vis(desk);
ok(jfkArr.sid === "none" && jfkArr.star === "visible", "STARs follow Arrivals");
evidence.jfkDeskArr = await shot(desk, "dep-arr-jfk-aip-arr-desk");
await desk.close();

const mob = await open(390, 844, true);
await goApt(mob, "LHR", 12.3);
await mode(mob, { dep: true, arr: true, hide: true });
const mBoth = await vis(mob);
ok(mBoth.depb && mBoth.arrb && mBoth.sat === "visible", "mobile both on satellite");
evidence.egllMobBoth = await shot(mob, "dep-arr-egll-both-iphone");
await mode(mob, { dep: true, arr: false, hide: true });
ok((await vis(mob)).arrb === false, "mobile dep only");
evidence.egllMobDep = await shot(mob, "dep-arr-egll-dep-iphone");
await mode(mob, { dep: false, arr: true, hide: true });
ok((await vis(mob)).depb === false, "mobile arr only");
evidence.egllMobArr = await shot(mob, "dep-arr-egll-arr-iphone");
await mode(mob, { dep: false, arr: false, hide: false });
ok((await vis(mob)).hist === "none", "mobile none");
evidence.egllMobNone = await shot(mob, "dep-arr-egll-none-iphone");
await mob.close();

await browser.close();
fs.writeFileSync(OUT + "/dep-arr-shots-evidence.json", JSON.stringify({ fail, evidence, colors: PATH }, null, 2));
console.log(JSON.stringify({ fail, shots: Object.fromEntries(Object.entries(evidence).filter(([, v]) => typeof v === "string")), colors: PATH }, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
