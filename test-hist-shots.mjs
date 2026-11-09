import fs from "fs";
import puppeteer from "puppeteer-core";

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

async function open(w, h, mobile) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.hidet = "0"; localStorage.apt = "G"; });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof setApt === "function" && map && map.loaded && map.loaded(), { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 500));
  return page;
}

async function goApt(page, id, zoom = 12.3) {
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

async function info(page) {
  return page.evaluate(() => {
    const src = map.getSource("hist") && map.getSource("hist")._data;
    const raw = map.getSource("histraw") && map.getSource("histraw")._data;
    const labs = map.getSource("histlab") && map.getSource("histlab")._data;
    const vis = map.getLayer("hist-rep") && map.getLayoutProperty("hist-rep", "visibility");
    const hpt = (document.getElementById("hpt") || {}).innerText || "";
    const feats = (src && src.features) || [];
    return {
      apt: APT, vis, nRep: feats.length,
      dirs: [...new Set(feats.map((f) => f.properties.rwy + ":" + f.properties.dir))],
      labs: ((labs && labs.features) || []).map((f) => f.properties.lab),
      nRaw: ((raw && raw.features) || []).length,
      rawVis: map.getLayer("hist-raw") && map.getLayoutProperty("hist-raw", "visibility"),
      hpt, hraw: !!(document.getElementById("hraw") && document.getElementById("hraw").checked),
      sid: /published SID\/STAR/.test(hpt) && !/not published SID\/STAR/i.test(hpt)
    };
  });
}

async function shot(page, name) {
  await page.evaluate(() => { const el = document.getElementById("mw"); if (el) el.scrollIntoView({ block: "nearest" }); });
  await new Promise((r) => setTimeout(r, 200));
  const p = `${OUT}/${name}.png`;
  const el = await page.$("#mw");
  if (el) await el.screenshot({ path: p });
  else await page.screenshot({ path: p });
  return p;
}

const evidence = { utc: new Date().toISOString() };
const desk = await open(1280, 900, false);
await goApt(desk, "LHR", 12.15);
const lhr = await info(desk);
ok(lhr.apt === "LHR", "EGLL/LHR overlay");
ok(lhr.nRep >= 2, `EGLL representative paths ${lhr.nRep}`);
ok(lhr.dirs.some((d) => d.endsWith(":arr")) && lhr.dirs.some((d) => d.endsWith(":dep")), `EGLL arr+dep ${lhr.dirs}`);
ok(lhr.vis === "visible", "hist-rep visible by default");
ok(lhr.nRaw === 0 && lhr.rawVis === "none", "smoothed tracks off by default");
ok(/not published SID\/STAR/i.test(lhr.hpt), "panel says not SID/STAR");
ok(!lhr.sid, "does not claim published SID/STAR");
evidence.lhr = lhr;
evidence.egllDesk = await shot(desk, "hist-egll-desk");
{
  const gp = await desk.$("#gp");
  if (gp) evidence.egllPanel = await gp.screenshot({ path: `${OUT}/hist-egll-panel.png` });
}

await desk.evaluate(() => { const el = document.getElementById("hraw"); if (el) { el.checked = true; histPaint(); } });
await new Promise((r) => setTimeout(r, 400));
const lhrRaw = await info(desk);
ok(lhrRaw.nRaw > 0 && lhrRaw.rawVis === "visible", "smoothed-track toggle shows clutter");
evidence.lhrRaw = { nRaw: lhrRaw.nRaw, vis: lhrRaw.rawVis };
evidence.egllRaw = await shot(desk, "hist-egll-smoothed");
await desk.evaluate(() => { const el = document.getElementById("hraw"); if (el) { el.checked = false; histPaint(); } });

await goApt(desk, "DOH", 12.4);
const doh = await info(desk);
ok(doh.nRep >= 2, `DOH representative paths ${doh.nRep}`);
ok(/not published SID\/STAR/i.test(doh.hpt), "DOH not SID/STAR");
evidence.doh = doh;
evidence.dohDesk = await shot(desk, "hist-doh-desk");

await goApt(desk, "CDG", 12.2);
const cdg = await info(desk);
ok(cdg.nRep >= 1 || /no terminal-area/i.test(cdg.hpt), "CDG has paths or honest gap");
evidence.cdg = cdg;
evidence.cdgDesk = await shot(desk, "hist-cdg-desk");

await goApt(desk, "JFK", 12.0);
const jfk = await info(desk);
evidence.jfk = jfk;
evidence.jfkDesk = await shot(desk, "hist-jfk-desk");
await desk.close();

const mob = await open(390, 844, true);
await goApt(mob, "LHR", 12.3);
const lhrM = await info(mob);
ok(lhrM.nRep >= 2, "mobile EGLL representatives");
evidence.lhrMob = lhrM;
evidence.egllMob = await shot(mob, "hist-egll-iphone");
await goApt(mob, "DOH", 12.4);
evidence.dohMob = await info(mob);
evidence.dohMobShot = await shot(mob, "hist-doh-iphone");
await mob.close();

await browser.close();
fs.writeFileSync(OUT + "/hist-shots-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ fail, lhr: lhr.dirs, doh: doh.dirs, cdg: cdg.dirs, shots: [evidence.egllDesk, evidence.egllRaw, evidence.dohDesk, evidence.cdgDesk, evidence.jfkDesk, evidence.egllMob, evidence.dohMobShot] }, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
