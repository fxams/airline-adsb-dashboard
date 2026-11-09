#!/usr/bin/env node
import puppeteer from "puppeteer-core";
import fs from "fs";

const BASE = process.env.BASE || "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });

const fail = [];
const evidence = { utc: new Date().toISOString() };
function ok(cond, msg) {
  console.log((cond ? "PASS  " : "FAIL  ") + msg);
  if (!cond) fail.push(msg);
}

const BUDDOH = {
  found: true, source: "adsbdb.com", callsign: "QTR35P",
  origin: { iata: "BUD", icao: "LHBP", name: "Budapest", city: "Budapest", lat: 47.42976, lon: 19.26109 },
  destination: { iata: "DOH", icao: "OTHH", name: "Hamad International", city: "Doha", lat: 25.27306, lon: 51.60806 },
  airline: "Qatar Airways"
};
const IADDOH = {
  found: true, source: "adsbdb.com", callsign: "QTR9",
  origin: { iata: "IAD", icao: "KIAD", name: "Dulles", city: "Washington", lat: 38.944, lon: -77.456 },
  destination: { iata: "DOH", icao: "OTHH", name: "Hamad International", city: "Doha", lat: 25.27306, lon: 51.60806 },
  airline: "Qatar Airways"
};
const DOHDXB = {
  found: true, source: "adsbdb.com", callsign: "QTR1",
  origin: { iata: "DOH", icao: "OTHH", name: "Hamad International", city: "Doha", lat: 25.273, lon: 51.608 },
  destination: { iata: "DXB", icao: "OMDB", name: "Dubai International", city: "Dubai", lat: 25.253, lon: 55.365 },
  airline: "Qatar Airways"
};

const HAZ = {
  at: "2026-11-09T08:00:00.000Z", available: true, stale: false,
  counts: { current: 1 }, expiredOmitted: 0,
  features: { type: "FeatureCollection", features: [{
    type: "Feature",
    properties: { product: "isigmet", origLabel: "TEST TURB", hazard: "TURB", validFrom: "2026-11-09T07:00:00.000Z", validTo: "2026-11-09T12:00:00.000Z" },
    geometry: { type: "Polygon", coordinates: [[[40, 30], [55, 30], [55, 45], [40, 45], [40, 30]]] }
  }]}
};

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function open(w, h, { route, hex = "06a124", cs = "QTR35P", lat = 65.07351, lon = -14.85008, alt = 37000, gs = 536, trk = 114, gnd = 0, held = false, history = null, mobile = w <= 700 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument((cfg) => {
    localStorage.clear();
    localStorage.hidet = "0";
    const orig = window.fetch;
    window.fetch = function (url, opts) {
      const u = String(url);
      if (/\/api\/track(\?|$)/.test(u)) {
        return Promise.resolve(new Response(JSON.stringify({ hex: cfg.hex, points: [] }), { headers: { "Content-Type": "application/json" } }));
      }
      if (u.includes("/api/route")) {
        return Promise.resolve(new Response(JSON.stringify(cfg.route), { headers: { "Content-Type": "application/json" } }));
      }
      if (u.includes("/api/wx/hazards")) {
        return Promise.resolve(new Response(JSON.stringify(cfg.haz), { headers: { "Content-Type": "application/json" } }));
      }
      return orig.apply(this, arguments);
    };
  }, { route, hex, haz: HAZ });
  await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => typeof select === "function" && typeof pickRoute === "function" && map && map.getLayer && map.getLayer("live") && CSR, { timeout: 120000 });
  await page.evaluate((cfg) => {
    L = L || { at: null, ac: [], nm: {} };
    L.at = "2026-11-09T08:21:35.000Z";
    if (cfg.held) {
      L.ac = [];
      GND_AC = [[cfg.hex, cfg.cs, "QTR", "A35K", cfg.lat, cfg.lon, cfg.trk, 0, "parked", 0, 1, "held", 40, "2026-11-09T07:40:00.000Z", "A7-ANH", "DOH"]];
    } else {
      L.ac = [[cfg.hex, cfg.cs, "QTR", "A35K", cfg.lat, cfg.lon, cfg.alt, cfg.gs, cfg.trk, "A7-ANH", cfg.gnd, 5, 0]];
      GND_AC = [];
    }
    L.nm = { QTR: "Qatar Airways" };
    if (cfg.history && CSR) {
      CSR.cs = CSR.cs || {};
      CSR.ap = CSR.ap || {};
      CSR.cs[cfg.cs] = cfg.history.pair;
      if (cfg.history.ap) Object.assign(CSR.ap, cfg.history.ap);
    }
    if (typeof drawLive === "function") drawLive();
  }, { hex, cs, lat, lon, alt, gs, trk, gnd, held, history });
  return page;
}

async function selectHex(page, hex) {
  await page.evaluate((h) => select(h), hex);
  await page.waitForFunction((h) => document.getElementById("sp").classList.contains("on") && document.getElementById("sp").dataset.hex === h && document.getElementById("spb").innerHTML.length > 40, { timeout: 20000 }, hex);
  await new Promise((r) => setTimeout(r, 600));
}

async function panel(page) {
  return page.evaluate(() => {
    function visText(root) {
      const el = typeof root === "string" ? document.querySelector(root) : root;
      if (!el) return "";
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const cs = getComputedStyle(p);
          if (cs.display === "none" || cs.visibility === "hidden") return NodeFilter.FILTER_REJECT;
          const det = p.closest("details");
          if (det && !det.open && !p.closest("summary")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let t = "";
      while (w.nextNode()) t += w.currentNode.textContent + " ";
      return t.replace(/\s+/g, " ").trim();
    }
    const field = (label) => {
      const cells = [...document.querySelectorAll("#spb .sc")];
      const hit = cells.find((c) => ((c.querySelector("span") || {}).textContent || "").trim() === label);
      return hit ? ((hit.querySelector("b") || {}).textContent || "").replace(/\s+/g, " ").trim() : null;
    };
    const a = typeof selAc === "function" ? selAc() : null;
    const re = a && typeof routeEnds === "function" ? routeEnds(a.cs, a) : {};
    return {
      vis: visText("#sp"),
      all: (document.getElementById("sp").innerText || "").replace(/\s+/g, " "),
      tags: [...document.querySelectorAll("#sp .tg")].map((t) => t.textContent.trim()),
      route: field("Route"),
      eta: field("Estimated arrival"),
      progress: field("Progress (GC est.)"),
      iata: [...document.querySelectorAll("#spb .ode .iata")].map((e) => e.textContent.trim()),
      cities: [...document.querySelectorAll("#spb .ode .city")].map((e) => e.textContent.trim()),
      rem: (re.od && !re.unverified && !re.conflict) ? 1 : 0,
      ap: re.od && !re.unverified && !re.conflict ? [re.od.oi, re.od.di] : [],
      unverified: !!re.unverified,
      src: re.src || null,
      wx: (document.getElementById("spwx") && document.getElementById("spwx").innerText || "").replace(/\s+/g, " "),
      h: document.getElementById("sp").getBoundingClientRect().height,
      vh: innerHeight,
    };
  });
}

{
  const page = await open(1280, 860, { route: BUDDOH, mobile: false });
  await selectHex(page, "06a124");
  const st = await panel(page);
  evidence.icelandBudDoh = st;
  await page.evaluate(() => {
    const h = [...document.querySelectorAll("#spb .spsec h3")].find((e) => /Route/i.test(e.textContent));
    if (h) h.scrollIntoView({ block: "start" });
  });
  const sp = await page.$("#sp");
  if (sp) await sp.screenshot({ path: `${OUT}/route-plaus-iceland-buddoh.png` });
  else await page.screenshot({ path: `${OUT}/route-plaus-iceland-buddoh.png` });
  ok(st.tags.includes("Unverified"), "Iceland + BUD-DOH: Unverified tag");
  ok(/unverified\/unavailable/i.test(st.route || st.vis), "Iceland + BUD-DOH: Route unverified/unavailable");
  ok(st.iata.every((x) => x === "—") && !/Budapest/i.test((st.cities || []).join(" ")), "Iceland + BUD-DOH: origin/destination boxes stay empty");
  ok(st.rem === 0, "Iceland + BUD-DOH: no remaining-route line");
  ok(!st.ap.includes("BUD") && !st.ap.includes("DOH"), "Iceland + BUD-DOH: airport markers not from rejected pair");
  ok(st.progress == null, "Iceland + BUD-DOH: no progress from rejected pair");
  ok(st.eta === "Unavailable", "Iceland + BUD-DOH: ETA unavailable");
  ok(/route unverified\/unavailable/i.test(st.wx), "Iceland + BUD-DOH: weather remaining-route gated");
  ok(!/On remaining GC|Provisional remaining-route/i.test(st.wx), "Iceland + BUD-DOH: no remaining-route weather hits");
  ok(!/Origin METAR|Destination METAR/i.test(st.wx), "Iceland + BUD-DOH: no origin/dest METAR from rejected pair");
  await page.evaluate(() => { const d = document.querySelector("#spmore details"); if (d) d.open = true; });
  const openDetails = await page.evaluate(() => (document.getElementById("spmore") && document.getElementById("spmore").innerText || "") + (document.getElementById("spb").innerText || ""));
  ok(/BUD/.test(openDetails) && /implausible/i.test(openDetails), "details may name the rejected BUD→DOH pair");
  ok(/No replacement pair is invented/i.test(openDetails), "details say no replacement is invented");
  ok(!/\bIAD\b/.test(openDetails), "does not invent IAD-DOH");
  await page.close();
}

{
  const page = await open(1280, 860, { route: IADDOH, hex: "aaaaaa", cs: "QTR9", mobile: false });
  await selectHex(page, "aaaaaa");
  const st = await panel(page);
  evidence.icelandIadDoh = st;
  await page.screenshot({ path: `${OUT}/route-plaus-iceland-iaddoh.png` });
  ok(st.tags.includes("Estimated"), "Iceland + IAD-DOH: Estimated tag");
  ok(st.iata.includes("IAD") && st.iata.includes("DOH"), "Iceland + IAD-DOH: city pair shown");
  ok(st.rem === 1, "Iceland + IAD-DOH: remaining-route line drawn");
  ok(st.progress != null, "Iceland + IAD-DOH: progress shown");
  await page.close();
}

{
  const page = await open(1280, 860, {
    route: BUDDOH, mobile: false,
    history: { pair: ["IAD-DOH", 12, 12], ap: { IAD: [38.944, -77.456, "Dulles"], DOH: [25.273, 51.608, "Doha"] } }
  });
  await selectHex(page, "06a124");
  const st = await panel(page);
  evidence.historyAlt = st;
  ok(st.iata.includes("IAD") && st.iata.includes("DOH"), "history IAD-DOH used when independently plausible");
  ok(st.rem === 1, "history alternative still draws remaining route");
  const details = await page.evaluate(() => {
    const d = document.querySelector("#spmore details");
    if (d) d.open = true;
    return (document.getElementById("spb").innerText || "") + (document.getElementById("spmore") && document.getElementById("spmore").innerText || "");
  });
  ok(/history/i.test(details) && /BUD/.test(details), "history alternative is labelled; discarded BUD named in details");
  await page.close();
}

{
  const page = await open(1280, 860, { route: DOHDXB, hex: "abc123", cs: "QTR1", lat: 25.4, lon: 52.0, alt: 37000, gs: 485, trk: 90, mobile: false });
  await selectHex(page, "abc123");
  const st = await panel(page);
  evidence.shortHop = st;
  ok(st.iata.includes("DOH") && st.iata.includes("DXB"), "short DOH-DXB near origin still shown");
  ok(st.rem === 1, "short hop remaining-route drawn");
  await page.close();
}

{
  const page = await open(1280, 860, { route: BUDDOH, hex: "held01", cs: "QTR35P", lat: 25.273, lon: 51.608, held: true, mobile: false });
  await selectHex(page, "held01");
  const st = await panel(page);
  evidence.heldDoh = st;
  ok(st.iata.includes("BUD") && st.iata.includes("DOH"), "held at DOH for BUD-DOH is allowed (at destination)");
  await page.close();
}

{
  const page = await open(390, 844, { route: BUDDOH });
  await selectHex(page, "06a124");
  const st = await panel(page);
  evidence.mobile = st;
  await page.evaluate(() => {
    const h = [...document.querySelectorAll("#spb .spsec h3")].find((e) => /Route/i.test(e.textContent));
    if (h) h.scrollIntoView({ block: "start" });
  });
  const spm = await page.$("#sp");
  if (spm) await spm.screenshot({ path: `${OUT}/route-plaus-mobile-unverified.png` });
  else await page.screenshot({ path: `${OUT}/route-plaus-mobile-unverified.png` });
  ok(st.tags.includes("Unverified"), "mobile: Unverified tag");
  ok(/unverified\/unavailable/i.test(st.vis), "mobile default view shows Route unverified/unavailable");
  ok(!/\bBUD\b/.test(st.vis) && !/\bBudapest\b/i.test(st.vis), "mobile default view hides rejected BUD");
  ok(st.h <= st.vh * 0.68, "mobile unverified panel stays compact");
  await page.evaluate(() => { $("qs").value = "QTR35P"; search(); });
  await new Promise((r) => setTimeout(r, 300));
  const q = await page.evaluate(() => document.getElementById("qres").innerText);
  ok(/QTR35P/.test(q), "search still matches callsign");
  ok(!/\bBUD\b/.test(q) && !/Budapest/i.test(q), "search results do not display the implausible city pair");
  await page.close();
}

await browser.close();
evidence.fail = fail;
fs.writeFileSync(OUT + "/route-plaus-evidence.json", JSON.stringify(evidence, null, 2));
if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS");
