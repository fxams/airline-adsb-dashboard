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
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.hidet = "0"; localStorage.apt = "G"; localStorage.aipsid = "0"; });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof setApt === "function" && map && map.loaded && map.loaded(), { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 500));
  return page;
}

async function goApt(page, id, zoom = 12.2) {
  await page.evaluate((apt) => { APT_FLY = false; setApt(apt, { fly: false }); }, id);
  await page.waitForFunction((apt) => AIP_APT === apt && AIP && map.getSource("aip"), { timeout: 20000 }, id);
  await page.evaluate((apt, z) => {
    const h = AirportHubs.resolveApt(apt);
    map.jumpTo({ center: [h.lon, h.lat], zoom: z, bearing: 0, pitch: 0 });
    map.resize();
    if (typeof aipPaint === "function") aipPaint();
    if (typeof histPaint === "function") histPaint();
  }, id, zoom);
  await new Promise((r) => setTimeout(r, 800));
}

async function info(page) {
  return page.evaluate(() => {
    const src = map.getSource("aip") && map.getSource("aip")._data;
    const near = map.getSource("aipnear") && map.getSource("aipnear")._data;
    const vis = map.getLayer("aip-sid") && map.getLayoutProperty("aip-sid", "visibility");
    const aipp = (document.getElementById("aipp") || {}).innerText || "";
    const aipsid = document.getElementById("aipsid");
    const feats = (src && src.features) || [];
    return {
      apt: APT,
      vis,
      nProc: feats.length,
      kinds: [...new Set(feats.map((f) => f.properties.kind))],
      nNear: ((near && near.features) || []).length,
      aipp,
      toggleShown: !!(aipsid && aipsid.closest("label") && aipsid.closest("label").style.display !== "none"),
      checked: !!(aipsid && aipsid.checked),
      link: ((document.getElementById("aipp") || {}).innerHTML || "").includes("http")
    };
  });
}

async function shot(page, name) {
  await page.evaluate(() => { const el = document.getElementById("mw"); if (el) el.scrollIntoView({ block: "nearest" }); });
  await new Promise((r) => setTimeout(r, 250));
  const p = `${OUT}/${name}.png`;
  const el = await page.$("#mw");
  if (el) await el.screenshot({ path: p });
  else await page.screenshot({ path: p });
  return p;
}

const evidence = { utc: new Date().toISOString() };
const desk = await open(1280, 900, false);

await goApt(desk, "JFK", 11.6);
let jfk = await info(desk);
ok(jfk.apt === "JFK", "JFK overlay");
ok(jfk.toggleShown, "JFK shows SID/STAR toggle");
ok(jfk.nProc === 0 && jfk.vis === "none", "procedures off until toggle");
ok(/FAA CIFP|CIFP 261029|Not for navigation/i.test(jfk.aipp), `JFK panel ${jfk.aipp.slice(0, 180)}`);
evidence.jfkOff = jfk;
evidence.jfkOffShot = await shot(desk, "aip-jfk-off");

await desk.evaluate(() => { const el = document.getElementById("aipsid"); el.checked = true; localStorage.aipsid = "1"; aipPaint(); });
await new Promise((r) => setTimeout(r, 600));
jfk = await info(desk);
ok(jfk.nProc >= 4, `JFK procedures drawn ${jfk.nProc}`);
ok(jfk.kinds.includes("sid") && jfk.kinds.includes("star"), `JFK SID+STAR kinds ${jfk.kinds}`);
ok(jfk.vis === "visible", "aip-sid visible");
ok(/Not for navigation/i.test(jfk.aipp), "label not for navigation");
evidence.jfkOn = jfk;
evidence.jfkOnShot = await shot(desk, "aip-jfk-sidstar");
{
  const gp = await desk.$("#gp");
  if (gp) evidence.jfkPanel = await gp.screenshot({ path: `${OUT}/aip-jfk-panel.png` });
}

await goApt(desk, "LAX", 11.4);
await desk.evaluate(() => { const el = document.getElementById("aipsid"); el.checked = true; aipPaint(); });
await new Promise((r) => setTimeout(r, 500));
const lax = await info(desk);
ok(lax.nProc >= 4, `LAX procedures ${lax.nProc}`);
ok(lax.toggleShown, "LAX toggle");
evidence.lax = lax;
evidence.laxShot = await shot(desk, "aip-lax-sidstar");

await goApt(desk, "LHR", 12.1);
const lhr = await info(desk);
ok(lhr.apt === "LHR", "EGLL/LHR");
ok(!lhr.toggleShown, "EGLL hides SID/STAR toggle");
ok(lhr.nProc === 0, "EGLL does not redraw procedures");
ok(/not redrawn/i.test(lhr.aipp), "EGLL panel says not redrawn");
ok(/NATS|redistribute|AD 2/i.test(lhr.aipp), `EGLL cites NATS/AD 2: ${lhr.aipp.slice(0, 220)}`);
ok(/aurora\.nats\.co\.uk|AD 2/i.test(lhr.aipp) || lhr.link, "EGLL has official link");
evidence.lhr = lhr;
evidence.egllShot = await shot(desk, "aip-egll-linkonly");
{
  const gp = await desk.$("#gp");
  if (gp) evidence.egllPanel = await gp.screenshot({ path: `${OUT}/aip-egll-panel.png` });
}

await goApt(desk, "DOH", 12.3);
const doh = await info(desk);
ok(!doh.toggleShown && doh.nProc === 0, "DOH link-only, no geometry");
ok(/Qatar|QCAA|AIM/i.test(doh.aipp), `DOH panel ${doh.aipp.slice(0, 180)}`);
evidence.doh = doh;
evidence.dohShot = await shot(desk, "aip-doh-linkonly");
{
  const gp = await desk.$("#gp");
  if (gp) evidence.dohPanel = await gp.screenshot({ path: `${OUT}/aip-doh-panel.png` });
}
await desk.close();

const mob = await open(390, 844, true);
await goApt(mob, "JFK", 11.8);
await mob.evaluate(() => { const el = document.getElementById("aipsid"); if (el) { el.checked = true; aipPaint(); } });
await new Promise((r) => setTimeout(r, 500));
const jfkM = await info(mob);
ok(jfkM.nProc >= 2, "mobile JFK procedures");
evidence.jfkMob = jfkM;
evidence.jfkMobShot = await shot(mob, "aip-jfk-iphone");
await goApt(mob, "LHR", 12.2);
const lhrM = await info(mob);
ok(lhrM.nProc === 0 && /not redrawn/i.test(lhrM.aipp), "mobile EGLL link-only");
evidence.lhrMob = lhrM;
evidence.egllMobShot = await shot(mob, "aip-egll-iphone");
{
  const gp = await mob.$("#gp");
  if (gp) evidence.egllMobPanel = await gp.screenshot({ path: `${OUT}/aip-egll-iphone-panel.png` });
}
await mob.close();
await browser.close();

fs.writeFileSync(`${OUT}/aip-sidstar-evidence.json`, JSON.stringify(evidence, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS", {
  jfk: { nProc: evidence.jfkOn.nProc, kinds: evidence.jfkOn.kinds, nNear: evidence.jfkOn.nNear },
  lax: { nProc: lax.nProc },
  lhr: { nProc: lhr.nProc, snippet: lhr.aipp.slice(0, 160) },
  doh: { nProc: doh.nProc }
});
