#!/usr/bin/env node
/**
 * Cross-check displayed identifiers vs public sources (investigation + UI contract).
 * Public tracker pages are evidence only — not a live product feed.
 */
import puppeteer from "puppeteer-core";
import fs from "fs";

const BASE = process.env.BASE || "http://127.0.0.1:10000";
const OUT = "/opt/cursor/artifacts";
fs.mkdirSync(OUT, { recursive: true });
const fail = [];
const ok = (c, m) => {
  console.log((c ? "PASS  " : "FAIL  ") + m);
  if (!c) fail.push(m);
};

const icaoAlias = (q) => {
  const m = String(q || "").toUpperCase().replace(/\s+/g, "").match(/^([A-Z]{2})(\d[A-Z0-9]*)$/);
  if (!m) return "";
  const map = { QR: "QTR", EK: "UAE", BA: "BAW", AA: "AAL", DL: "DAL", UA: "UAL", LH: "DLH", AF: "AFR", KL: "KLM", SQ: "SIA", QF: "QFA", EY: "ETD", TK: "THY", VS: "VIR", CX: "CPA" };
  return map[m[1]] ? map[m[1]] + m[2] : "";
};
ok(icaoAlias("QR68M") === "QTR68M", "search alias QR68M -> QTR68M (radio-callsign spelling only)");
ok(icaoAlias("EK81W") === "UAE81W", "search alias EK81W -> UAE81W (not a ticketed number)");
ok(icaoAlias("EK255") === "UAE255", "search EK255 does not alias to UAE81W");
ok(icaoAlias("EK81") === "UAE81", "search EK81 does not equal UAE81W");

const live = await fetch(BASE + "/api/live").then((r) => r.json());
const ac = (live.ac || []).map((r) => ({ hex: r[0], flight: r[1], al: r[2], t: r[3], lat: r[4], lon: r[5], alt_baro: r[6], gs: r[7], trk: r[8], r: r[9] }));
const pick = (pred) => ac.find(pred);
const samples = [
  pick((a) => a.flight === "UAE229" && a.r === "A6-EWJ"),
  pick((a) => a.flight === "UAE58" && a.r === "A6-END"),
  pick((a) => a.flight === "UAE81W" && a.r === "A6-EWC"),
  pick((a) => a.flight === "QTR1181" && a.r === "A7-LAB"),
  pick((a) => a.flight === "QTR68M"),
  pick((a) => a.flight === "QTR2X"),
].filter(Boolean);
if (!samples.length) {
  const q = ac.find((a) => a.al === "QTR" && a.flight && a.r);
  const u = ac.find((a) => a.al === "UAE" && a.flight && a.r);
  if (q) samples.push(q);
  if (u) samples.push(u);
}
ok(samples.length >= 1, "live sample includes at least one Qatar/Emirates aircraft");

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await page.setCacheEnabled(false);
await page.goto(BASE + "/#overview", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForFunction(() => typeof select === "function" && map && map.getLayer && map.getLayer("live") && L && L.ac && L.ac.length > 0, { timeout: 120000 });

const ui = {};
const targets = [];
for (const want of ["UAE81W", "UAE229", "QTR1181", "QTR68M", "QTR2X", "UAE58"]) {
  if (ac.some((a) => a.flight === want)) targets.push(want);
}
if (!targets.length && samples[0]) targets.push(samples[0].flight);

for (const cs of targets) {
  const found = await page.evaluate((callsign) => {
    const hit = L.ac.find((a) => a[1] === callsign);
    if (!hit) return { missing: true };
    select(hit[0]);
    return { missing: false, hex: hit[0] };
  }, cs);
  if (found.missing) continue;
  await page.waitForFunction((h) => document.getElementById("sp").classList.contains("on") && document.getElementById("sp").dataset.hex === h, { timeout: 20000 }, found.hex);
  await new Promise((r) => setTimeout(r, 900));
  const panel = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("#spb .cell, #idg .cell")].map((el) => ({
      k: (el.querySelector(".k") || {}).textContent || "",
      v: ((el.querySelector(".v") || el.querySelector("b") || {}).textContent || "").trim(),
    }));
    const id = (document.getElementById("spb").innerText.split("IDENTITY")[1] || document.getElementById("spb").innerText).split("POSITION")[0];
    const field = (label) => {
      const m = id.match(new RegExp(label.replace(/ /g, "\\s+") + "\\s+([^\\n]+)", "i"));
      return m ? m[1].trim() : null;
    };
    return {
      title: document.getElementById("spcs").textContent,
      kind: document.querySelector(".spk") && document.querySelector(".spk").textContent,
      callsign: field("Callsign"),
      flightNo: field("Flight number"),
      iataForm: field("IATA-prefix spelling") || field("IATA-form callsign"),
      identity: id.slice(0, 900),
      cells,
      route: (document.getElementById("spb").innerText.split("ROUTE")[1] || "").slice(0, 500),
    };
  });
  ui[cs] = panel;
  await page.screenshot({ path: `${OUT}/identity-${cs.toLowerCase()}.png` });
  ok(panel.title === cs, cs + " panel header is the ADS-B callsign");
  ok(/ADS-B callsign/i.test(panel.kind || ""), cs + " header labelled ADS-B callsign");
  ok(panel.flightNo === "Unavailable", cs + " Flight number is Unavailable");
  ok(!panel.iataForm, cs + " does not show IATA-prefix spelling as a number");
  ok(!/verified passenger flight number/i.test(panel.flightNo || ""), cs + " does not claim a verified marketed number");
}

const evidence = {
  sampledAt: live.now || live.at,
  liveN: ac.length,
  samples: samples.map((a) => ({ callsign: a.flight, hex: a.hex, reg: a.r, type: a.t, alt: a.alt_baro, lat: a.lat, lon: a.lon })),
  ui,
  sources: [
    {
      aircraft: "UAE229 / hex 89616a / A6-EWJ",
      date: "2026-11-08",
      adsB: "callsign UAE229, B77L near SEA at sample time",
      officialAirline: "https://www.emirates.com/us/english/manage-booking/flight-status/ is a form; no parseable first-party record retrieved without interacting with a booking flow.",
      publicTrackers: [
        "https://www.flightradar24.com/data/flights/ek229 — A6-EWJ listed EK229 DXB-SEA 08 Nov 2026",
        "https://www.flightstats.com/v2/flight-details/EK/229 — tail A6-EWJ on that listing",
      ],
      verdict: "Tracker-concordant marketed EK229 on this tail/date/route. Not first-party Emirates.com. Product still shows Flight number Unavailable.",
    },
    {
      aircraft: "UAE58 / hex 896306 / A6-END",
      date: "2026-11-08",
      adsB: "callsign UAE58, B77W ~46.0N 11.8E FL330 at sample time",
      officialAirline: "no parseable Emirates.com record",
      publicTrackers: ["https://www.flightradar24.com/data/flights/ek58/1000 — A6-END listed EK58 DUS-DXB 08 Nov 2026"],
      verdict: "Tracker-concordant marketed EK58. Not first-party. Product Unavailable.",
    },
    {
      aircraft: "UAE81W / hex 896175 / A6-EWC",
      date: "2026-11-08",
      adsB: "callsign UAE81W (alphanumeric radio callsign), B77L ~Mexico at sample time",
      officialAirline: "no parseable Emirates.com record",
      publicTrackers: [
        "https://www.flightradar24.com/data/aircraft/a6-ewc — A6-EWC EK255 BCN-MEX 08 Nov 2026 (Live)",
        "https://www.flightradar24.com/data/flights/ek255 — same tail on EK255 08 Nov BCN-MEX",
        "https://www.flightradar24.com/data/flights/ek81 — EK81 is DXB-LYS, not this flight",
      ],
      verdict: "Prefix conversion UAE81W -> EK81W is NOT the marketed number. Independent FR24 tail history lists EK255. Product must not display EK81/EK81W as the passenger flight number. Without a connected official feed, product shows Unavailable rather than EK255.",
    },
    {
      aircraft: "QTR1181 / hex 06a1b9 / A7-LAB",
      date: "2026-11-08",
      adsB: "callsign QTR1181, A320 near DOH at sample time",
      officialAirline: "https://fs.qatarairways.com timed out; no first-party record",
      publicTrackers: [
        "https://www.flightradar24.com/data/aircraft/a7-lab — A7-LAB QR1181 MED-DOH 08 Nov 2026",
        "https://www.flightradar24.com/data/flights/qr1181 — QR1181 is the MED-DOH service",
      ],
      verdict: "FR24 tail history concordant with QR1181 MED-DOH on 08 Nov. Official Qatar status not retrieved. Numeric callsign happening to match marketed digits is not used as a product rule. Product Unavailable.",
    },
    {
      aircraft: "QTR68M / hex 06a391 / A7-BTB",
      date: "2026-11-08",
      adsB: "callsign QTR68M (alphanumeric), B77L ~Gulf FL370 at sample time",
      officialAirline: "no first-party Qatar record retrieved",
      publicTrackers: [
        "adsbdb callsign_iata QR68M and DWC-DOH route are prefix/stale — not verification",
        "QR68 as a marketed FRA-DOH 787 does not match this type/callsign suffix",
      ],
      verdict: "Marketed passenger number not independently confirmed. QR68M is an operational radio callsign, not a ticket. Product Unavailable.",
    },
    {
      aircraft: "QTR2X / hex 06a0b4 / A7-BCP",
      date: "2026-11-08",
      adsB: "callsign QTR2X, B788 over Poland at sample time",
      officialAirline: "no first-party Qatar record retrieved",
      publicTrackers: [
        "adsbdb ATL-DFW is stale/wrong for this airframe",
        "FlightAware public page listed EDDB-OTHH for QTR2X — still not a marketed QR number",
      ],
      verdict: "Marketed number unknown. Product Unavailable. If adsbdb disagrees with local QTR history, remaining route is no longer drawn from the guessed pair.",
    },
  ],
};
fs.writeFileSync(`${OUT}/flight-identity-evidence.json`, JSON.stringify(evidence, null, 2));
console.log("wrote " + OUT + "/flight-identity-evidence.json");
await browser.close();
if (fail.length) {
  console.error("FAILED\n" + fail.join("\n"));
  process.exit(1);
}
console.log("OK");
