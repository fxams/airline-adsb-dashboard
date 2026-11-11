#!/usr/bin/env node
// Headless smoke: map.js must parse, initMap must run, live markers must paint.
import puppeteer from "puppeteer-core";
import fs from "fs";

const BASE = process.env.BASE || "http://127.0.0.1:10000";
const CHROME = process.env.CHROME || ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
if (!CHROME) { console.error("no chrome binary"); process.exit(1); }

const SEED = [
  ["abc123", "QTR1", "QTR", "B77W", 25.253, 55.365, 37000, 480, 270, "A7-ALX", 0, 2, 0],
  ["def456", "UAE2", "UAE", "A388", 25.261, 55.347, 35000, 440, 90, "A6-EVN", 0, 3, 0],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

const fail = [];
const errors = [];
async function smoke(name, viewport) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(name + ": " + (e.message || e)));
  page.on("console", (m) => { if (m.type() === "error" && /SyntaxError|Unexpected token/.test(m.text())) errors.push(name + " console:" + m.text()); });
  await page.setViewport(viewport);
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.hidet = "0"; });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  try {
    await page.waitForFunction(() => typeof initMap === "function" && typeof map === "object" && map && map.getLayer && map.getLayer("live"), { timeout: 60000 });
  } catch (e) {
    fail.push(name + ": live layer missing (map.js parse / initMap): " + e.message);
    await page.close();
    return;
  }
  await page.evaluate((seed) => {
    if (!L) L = { at: null, ac: [], nm: {} };
    L.at = new Date().toISOString();
    L.ac = seed;
    L.nm = Object.assign({ QTR: "Qatar Airways", UAE: "Emirates" }, L.nm || {});
    if (typeof onPoll === "function") onPoll();
    else if (typeof drawLive === "function") drawLive();
  }, SEED);
  try {
    await page.waitForFunction(() => {
      const src = map && map.getSource && map.getSource("live");
      const n = src && src._data && src._data.features && src._data.features.length;
      return n > 0;
    }, { timeout: 20000 });
  } catch (e) {
    fail.push(name + ": no aircraft features painted: " + e.message);
  }
  const st = await page.evaluate(() => {
    const src = map.getSource("live");
    const el = document.getElementById("liveload");
    return {
      nFeat: (src && src._data && src._data.features && src._data.features.length) || 0,
      hasInit: typeof initMap === "function",
      liveload: el ? el.hidden : null,
      mapSrc: [...document.scripts].map((s) => s.src).find((u) => /\/map\.js/.test(u)) || ""
    };
  });
  if (!(st.nFeat > 0)) fail.push(name + ": expected painted aircraft, got " + st.nFeat);
  if (!st.hasInit) fail.push(name + ": initMap undefined");
  if (st.mapSrc && !/[?&]v=/.test(st.mapSrc)) fail.push(name + ": map.js missing cache-bust query " + st.mapSrc);
  console.log(JSON.stringify({ name, ...st }));
  await page.close();
}

await smoke("desk", { width: 1280, height: 800, deviceScaleFactor: 1 });
await smoke("mobile", { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await browser.close();

const syntax = errors.filter((e) => /SyntaxError|Unexpected token/.test(e));
if (syntax.length) fail.push(...syntax);
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  if (errors.length) console.error("pageerrors\n" + errors.join("\n"));
  process.exit(1);
}
console.log("PASS map-boot");
