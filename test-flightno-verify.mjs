#!/usr/bin/env node
/**
 * Live coverage of marketed-number mapping + view-only tracker cross-check.
 * FR24/FlightStats pages are evidence only — never a product feed.
 */
import fs from "fs";
import puppeteer from "puppeteer-core";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const fn = require("./public/flightno.js");

const BASE = process.env.BASE || "http://127.0.0.1:10000";
const LIVE = process.env.LIVE_URL || "https://airline-adsb-dashboard.onrender.com";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });

const fail = [];
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fail.push(m); };

function isAlpha(cs) {
  return /^[A-Z]{3}.*[A-Z]/.test(String(cs || ""));
}

const live = await fetch(LIVE + "/api/live").then((r) => r.json()).catch(() => ({ ac: [] }));
const rows = (live.ac || []).filter((a) => a[2] === "QTR" || a[2] === "UAE").map((a) => ({
  hex: a[0], cs: a[1], al: a[2], typ: a[3], lat: a[4], lon: a[5], reg: a[9]
}));
const alpha = rows.filter((a) => isAlpha(a.cs));
const numeric = rows.filter((a) => !isAlpha(a.cs));
ok(alpha.length >= 1, "live alphanumeric QTR/UAE n=" + alpha.length);

const sample = alpha;
const lookups = [];
for (const a of sample) {
  const db = await fetch(BASE + "/api/route?cs=" + encodeURIComponent(a.cs)).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  const ins = db.flight_number_lookup || fn.inspectSources({
    callsign: a.cs,
    records: db.found ? [{ source: "adsbdb.com", payload: { callsign_iata: db.callsign_iata, callsign: db.callsign_icao || a.cs }, origin: db.origin, destination: db.destination }] : []
  });
  const shown = fn.acceptMarketedFlight({
    callsign: a.cs,
    lookup: ins,
    route: db.found ? { od: { oi: db.origin && db.origin.iata, di: db.destination && db.destination.iata, o: db.origin, d: db.destination }, unverified: false, conflict: false } : { od: null, unverified: true }
  });
  const extra = {};
  if (lookups.length < 3) {
    extra.hexdb = await fetch("https://hexdb.io/v2/routes/" + encodeURIComponent(a.cs), { headers: { "User-Agent": "airline-adsb-dashboard-verify" }, signal: AbortSignal.timeout(8000) }).then(async (r) => ({ http: r.status, body: await r.json().catch(() => null) })).catch((e) => ({ error: String(e.message || e).slice(0, 120) }));
    extra.adsbim = await fetch("https://adsb.im/api/0/routeset", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "airline-adsb-dashboard-verify" },
      body: JSON.stringify({ planes: [{ callsign: a.cs, lat: a.lat, lng: a.lon }] }),
      signal: AbortSignal.timeout(8000)
    }).then(async (r) => ({ http: r.status, body: await r.json().catch(() => null) })).catch((e) => ({ error: String(e.message || e).slice(0, 120) }));
  }
  lookups.push({
    cs: a.cs, hex: a.hex, reg: a.reg, typ: a.typ,
    adsbdb_iata: db.callsign_iata || null,
    adsbdb_od: db.found ? ((db.origin && db.origin.iata) + "→" + (db.destination && db.destination.iata)) : null,
    product: shown.found ? shown.number : "Unavailable",
    source: shown.source,
    note: shown.note,
    candidate: ins.candidate || null,
    extra
  });
}
const confirmed = lookups.filter((x) => x.product !== "Unavailable");
ok(confirmed.length === 0, "connected free sources confirm 0/" + lookups.length + " alphanumeric samples (prefix spelling is not used)");
ok(lookups.every((x) => x.product === "Unavailable"), "product stays Unavailable for every sampled alphanumeric callsign");
ok(lookups.some((x) => x.adsbdb_iata && x.adsbdb_iata !== x.product), "adsbdb callsign_iata exists and is not shown as the flight number");

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"]
});
const trackers = [];
for (const a of sample.slice(0, 4)) {
  if (!a.reg) continue;
  const url = "https://www.flightradar24.com/data/aircraft/" + String(a.reg).toLowerCase();
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  let status = "unopened";
  let snippet = "";
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    status = resp ? String(resp.status()) : "no-response";
    snippet = ((await page.evaluate(() => (document.body && document.body.innerText) || "")) || "").replace(/\s+/g, " ").slice(0, 400);
  } catch (e) {
    status = "error:" + (e.message || e).slice(0, 80);
  }
  trackers.push({ cs: a.cs, reg: a.reg, url, http: status, snippet, note: "View-only. Not a product source." });
  await page.close();
  await new Promise((r) => setTimeout(r, 1500));
}
await browser.close();

const evidence = {
  utc: new Date().toISOString(),
  live_at: live.at,
  qtr_uae: rows.length,
  alphanumeric: alpha.length,
  numeric: numeric.length,
  coverage: { confirmed: confirmed.length, sampled: lookups.length, share: lookups.length ? confirmed.length / lookups.length : 0 },
  product_source_policy: "Explicit marketed field + PR9-consistent OD only. Prefix conversion forbidden. FR24/FlightStats not connected.",
  lookups,
  trackers_view_only: trackers,
  researched: fn.RESEARCHED
};
fs.writeFileSync(OUT + "/flightno-coverage.json", JSON.stringify(evidence, null, 2));
console.log("coverage", evidence.coverage);
console.log("wrote", OUT + "/flightno-coverage.json");

if (fail.length) {
  console.error("FAILED\n" + fail.join("\n"));
  process.exit(1);
}
console.log("OK");
