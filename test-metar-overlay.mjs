#!/usr/bin/env node
// CI smoke: Airport METAR/TAF overlay with hazards + GFS winds (the iPhone state
// that showed "METAR error" while 181 adv. and GFS still loaded).
import puppeteer from "puppeteer-core";
import fs from "fs";
import http from "http";
import zlib from "zlib";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const wx = require("./wx.js");

const BASE = process.env.BASE || "http://127.0.0.1:10000";
const CHROME = process.env.CHROME || ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
if (!CHROME) { console.error("no chrome binary"); process.exit(1); }

const fail = [];
function ok(cond, msg) { if (!cond) fail.push(msg); }

function rawGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const req = http.request(u, { headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(90000, () => { req.destroy(new Error("timeout " + path)); });
    req.end();
  });
}
function decode(r) {
  const enc = String(r.headers["content-encoding"] || "");
  let b = r.body;
  if (enc === "gzip") b = zlib.gunzipSync(b);
  return JSON.parse(b.toString("utf8"));
}

{
  const hpa = wx.pressureFromMetar(1013.25, "");
  ok(hpa.pa === 101325, "Pa conversion");
}

const gzipH = { "Accept-Encoding": "gzip", Accept: "application/json" };
const idH = { "Accept-Encoding": "identity", Accept: "application/json" };

const stPlain = await rawGet("/api/wx/stations", idH);
ok(stPlain.status === 200, "stations identity HTTP " + stPlain.status);
ok(stPlain.headers["content-length"] && +stPlain.headers["content-length"] === stPlain.body.length, "stations identity Content-Length");
ok(!stPlain.headers["content-encoding"] || stPlain.headers["content-encoding"] === "identity", "stations identity not gzip");
const stJ = decode(stPlain);
ok((stJ.metar || []).length > 10, "hub METARs n=" + (stJ.metar || []).length);
ok(!stJ.error || (stJ.metar || []).length > 0, "stations error field vs rows: " + stJ.error);
ok(stJ.metar.every((m) => m.pressPa == null || (Number.isInteger(m.pressPa) && m.pressPa > 80000 && m.pressPa < 110000)), "pressPa in Pa not hPa");
ok(stJ.metar.every((m) => m.raw), "raw METAR present");
const othh = stJ.metar.find((m) => m.icao === "OTHH");
ok(!!othh, "OTHH in hub set");

const stGz = await rawGet("/api/wx/stations", gzipH);
ok(stGz.status === 200, "stations gzip HTTP");
ok(stGz.headers["content-encoding"] === "gzip", "stations Content-Encoding gzip");
ok(stGz.headers["content-length"] && +stGz.headers["content-length"] === stGz.body.length, "stations gzip Content-Length matches body (not chunked-without-length)");
ok(stGz.body[0] === 0x1f && stGz.body[1] === 0x8b, "stations gzip magic");
const stGzJ = decode(stGz);
ok((stGzJ.metar || []).length === (stJ.metar || []).length, "gzip body matches identity");

// Extra ICAO used to be concatenated into one AWC ids= list; a 429/empty extra
// pull wiped the hub METARs and the chip became "METAR error".
const extra = await rawGet("/api/wx/stations?ids=ZZZZ,EIDW", idH);
ok(extra.status === 200, "stations?ids extra HTTP");
const extraJ = decode(extra);
ok((extraJ.metar || []).some((m) => m.icao === "OTHH"), "extra ids keep hub OTHH, n=" + (extraJ.metar || []).length);
ok(!(extraJ.error && !(extraJ.metar || []).length), "extra ids do not pin empty METAR error " + extraJ.error);

const t0 = Date.now();
const [hR, sR, wR] = await Promise.all([
  rawGet("/api/wx/hazards", gzipH),
  rawGet("/api/wx/stations", gzipH),
  rawGet("/api/wx/winds", gzipH)
]);
ok(hR.status === 200 && sR.status === 200 && wR.status === 200, "concurrent wx HTTP");
const hJ = decode(hR), sJ = decode(sR), wJ = decode(wR);
ok((sJ.metar || []).length > 10, "concurrent stations still have METARs n=" + (sJ.metar || []).length);
ok(!(sJ.error && !(sJ.metar || []).length), "concurrent stations not a fatal empty METAR " + sJ.error);
ok(wJ.available === true, "concurrent winds available");
ok(hJ.counts && hJ.counts.current > 0, "concurrent hazards current");
console.log(JSON.stringify({
  apiMs: Date.now() - t0,
  stations: { n: (sJ.metar || []).length, error: sJ.error, cl: sR.headers["content-length"], enc: sR.headers["content-encoding"] },
  extra: { n: (extraJ.metar || []).length, error: extraJ.error, extraError: extraJ.extraError },
  hazards: hJ.counts, winds: { available: wJ.available, cycle: wJ.cycle_utc }
}));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function overlaySmoke(name, viewport, ua) {
  const page = await browser.newPage();
  const pageErrors = [];
  const failedWx = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  page.on("requestfailed", (req) => { if (/\/api\/wx\//.test(req.url())) failedWx.push(req.url() + " " + (req.failure() && req.failure().errorText)); });
  await page.setViewport(viewport);
  if (ua) await page.setUserAgent(ua);
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    localStorage.hidet = "0";
    localStorage.wxmet = "1";
    localStorage.wxhaz = "1";
    localStorage.wxwnd = "1";
  });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof setWx === "function" && map && map.getLayer && map.getLayer("live") && map.getLayer("wxmet"), { timeout: 90000 });
  try {
    await page.waitForFunction(() => {
      const t = ((document.getElementById("wxst") || {}).textContent) || "";
      return /METAR|adv|GFS|error/i.test(t) || (typeof WX !== "undefined" && WX && WX.st);
    }, { timeout: 90000 });
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 4000));
  await page.evaluate(() => { if (map && map.jumpTo) map.jumpTo({ center: [51.61, 25.26], zoom: 10.5 }); });
  await new Promise((r) => setTimeout(r, 800));
  const st = await page.evaluate(() => {
    const chip = document.getElementById("wxst");
    const src = map.getSource && map.getSource("wxmet");
    const feats = (src && src._data && src._data.features) || [];
    const othh = feats.find((f) => f.properties && f.properties.icao === "OTHH");
    return {
      chip: chip ? chip.textContent : "",
      chipErr: !!(chip && chip.classList.contains("err")),
      nFeat: feats.length,
      nIcon: map.getLayer("wxmet") ? map.queryRenderedFeatures({ layers: ["wxmet"] }).length : 0,
      WXn: WX && WX.st && (WX.st.metar || []).length,
      WXerr: WX && WX.st && WX.st.error,
      othh: othh && { icao: othh.properties.icao, pressPa: othh.properties.pressPa, fltCat: othh.properties.fltCat, stale: othh.properties.stale, raw: othh.properties.raw },
      checks: {
        met: document.getElementById("wxmet") && document.getElementById("wxmet").checked,
        haz: document.getElementById("wxhaz") && document.getElementById("wxhaz").checked,
        wnd: document.getElementById("wxwnd") && document.getElementById("wxwnd").checked
      }
    };
  });
  ok(st.checks.met && st.checks.haz && st.checks.wnd, name + " all three wx toggles on");
  ok(!/METAR error/i.test(st.chip) || !(st.WXn > 0), name + " chip must not say METAR error when rows exist: " + st.chip);
  if (st.WXn > 0) {
    ok(!st.chipErr || /GFS unavailable|hazards error/i.test(st.chip), name + " chip err class with METARs: " + st.chip);
    ok(st.nFeat > 0, name + " wxmet source has features");
    ok(st.nIcon > 0, name + " METAR icon at OTHH zoom");
    ok(st.othh && st.othh.raw && !/raw METAR unavailable/i.test(st.othh.raw), name + " OTHH raw present");
    ok(st.othh && +st.othh.pressPa > 80000 && +st.othh.pressPa < 110000, name + " OTHH Pa " + (st.othh && st.othh.pressPa));
  } else {
    fail.push(name + " no METAR rows in overlay (chip=" + st.chip + " err=" + st.WXerr + ")");
  }
  ok(!pageErrors.length, name + " pageerrors " + pageErrors.join(" | "));
  ok(!failedWx.length, name + " wx requestfailed " + failedWx.join(" | "));
  console.log(JSON.stringify({ name, ...st, pageErrors, failedWx }));
  await page.close();
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1";
await overlaySmoke("iphone", { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, IPHONE);
await overlaySmoke("desk", { width: 1400, height: 900, deviceScaleFactor: 1 }, null);
await browser.close();

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("test-metar-overlay OK");
