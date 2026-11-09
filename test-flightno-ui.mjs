#!/usr/bin/env node
import puppeteer from "puppeteer-core";
import fs from "fs";

const BASE = process.env.BASE || "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });
const fail = [];
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fail.push(m); };

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function open(w, h, routeJson) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: w <= 700 ? 2 : 1, isMobile: w <= 700, hasTouch: w <= 700 });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument((rj) => {
    localStorage.clear();
    localStorage.hidet = "0";
    const orig = window.fetch;
    window.fetch = function (url, opts) {
      const u = String(url);
      if (u.includes("/api/route")) {
        return Promise.resolve(new Response(JSON.stringify(rj), { headers: { "Content-Type": "application/json" } }));
      }
      if (/\/api\/track(\?|$)/.test(u)) {
        return Promise.resolve(new Response(JSON.stringify({ hex: "abc123", points: [] }), { headers: { "Content-Type": "application/json" } }));
      }
      return orig.apply(this, arguments);
    };
  }, routeJson);
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => typeof select === "function" && map && map.getLayer && map.getLayer("live"), { timeout: 120000 });
  await page.evaluate(() => {
    L = L || { at: null, ac: [], nm: {} };
    L.at = "2026-11-09T08:00:00.000Z";
    L.ac = [["abc123", "QTR1", "QTR", "B77W", 25.4, 52.0, 37000, 485, 90, "A7-ALX", 0, 2, 0]];
    L.nm = { QTR: "Qatar Airways" };
    if (typeof drawLive === "function") drawLive();
  });
  return page;
}

async function panel(page) {
  await page.evaluate(() => select("abc123"));
  await page.waitForFunction(() => document.getElementById("sp").classList.contains("on") && document.getElementById("spb").innerHTML.length > 40, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 500));
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll("#spb .sc")];
    const field = (label) => {
      const hit = cells.find((c) => ((c.querySelector("span") || {}).textContent || "").trim() === label);
      return hit ? ((hit.querySelector("b") || {}).textContent || "").replace(/\s+/g, " ").trim() : null;
    };
    const more = document.querySelector("#spmore details");
    return {
      flightNo: field("Flight number"),
      callsign: field("Callsign") || document.getElementById("spcs").textContent,
      note: [...document.querySelectorAll("#spb .spsec > p.mu")].map((p) => p.textContent).join(" "),
      moreSummary: more && more.querySelector("summary") ? more.querySelector("summary").textContent.trim() : "",
      moreText: more ? more.innerText : "",
      moreOpen: !!(more && more.open)
    };
  });
}

const none = {
  found: true,
  origin: { iata: "DOH", icao: "OTHH", name: "Hamad", city: "Doha", lat: 25.273, lon: 51.608 },
  destination: { iata: "DXB", icao: "OMDB", name: "Dubai", city: "Dubai", lat: 25.253, lon: 55.365 },
  callsign_iata: "QR1",
  flight_number: null,
  flight_number_lookup: {
    found: false,
    candidate: null,
    consulted: [{ source: "adsbdb.com", accepted: false, reason: "no explicit marketed field; callsign_iata=QR1 is not a ticket" }],
    researched: [{ source: "adsbdb.com", queried: true, note: "callsign_iata is prefix spelling" }],
    note: "No connected free source exposes an explicit marketed flight_number for this callsign."
  }
};
const yes = {
  ...none,
  flight_number_lookup: {
    found: false,
    candidate: { number: "QR883", source: "mock-schedule", field: "flight_number", origin: "DOH", destination: "DXB" },
    consulted: [{ source: "mock-schedule", accepted: true, field: "flight_number", value: "QR883", origin: "DOH", destination: "DXB" }],
    researched: none.flight_number_lookup.researched,
    note: "Explicit flight_number from mock-schedule."
  }
};

const mobile = await open(390, 844, none);
const m1 = await panel(mobile);
ok(m1.flightNo === "Unavailable", "mobile Unavailable without explicit source: " + m1.flightNo);
ok(m1.moreSummary === "Details / sources", "mobile Details / sources");
await mobile.evaluate(() => { const s = document.querySelector("#spmore summary"); if (s) s.click(); });
await new Promise((r) => setTimeout(r, 200));
const opened = await mobile.evaluate(() => (document.querySelector("#spmore details") || {}).innerText || "");
ok(/adsbdb|callsign_iata|prefix|ticket|marketed/i.test(opened), "mobile details name the lookup");
await mobile.screenshot({ path: `${OUT}/flightno-mobile-unavailable.png` });
await mobile.close();

const desk = await open(1280, 800, yes);
const d1 = await panel(desk);
ok(d1.flightNo === "QR883", "desktop shows QR883 from explicit source: " + d1.flightNo);
ok(/mock-schedule/.test(d1.note), "desktop identity note labels source");
ok(d1.callsign === "QTR1", "callsign remains ATC QTR1");
ok(!/^QR1$/.test(d1.flightNo), "does not show prefix-converted QR1 as the number");
await desk.screenshot({ path: `${OUT}/flightno-desktop-explicit.png` });
await desk.close();

const mobileYes = await open(390, 844, yes);
const m2 = await panel(mobileYes);
ok(m2.flightNo === "QR883", "mobile compact shows QR883: " + m2.flightNo);
await mobileYes.evaluate(() => { const s = document.querySelector("#spmore summary"); if (s) s.click(); });
await new Promise((r) => setTimeout(r, 200));
const opened2 = await mobileYes.evaluate(() => (document.querySelector("#spmore details") || {}).innerText || "");
ok(/mock-schedule/.test(opened2) && /QR883/.test(opened2), "mobile collapsed details label source of the number");
await mobileYes.screenshot({ path: `${OUT}/flightno-mobile-explicit.png` });
await mobileYes.close();

await browser.close();
if (fail.length) {
  console.error("FAILED\n" + fail.join("\n"));
  process.exit(1);
}
console.log("OK");
