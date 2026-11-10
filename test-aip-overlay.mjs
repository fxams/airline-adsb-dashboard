import assert from "assert";
import fs from "fs";
import http from "http";
import zlib from "zlib";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const A = require("./public/airports.js");

const BASE = "http://127.0.0.1:10000";
const fail = [];
function ok(cond, msg) { if (!cond) fail.push(msg); }

function api(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const body = res.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    }).on("error", reject);
  });
}

const idxFile = JSON.parse(fs.readFileSync("data/aip/index.json", "utf8"));
ok(idxFile.n_airports === 193 && idxFile.n_draw === 30 && idxFile.n_link === 163, "index split");
ok(/not navigraph/i.test(JSON.stringify(idxFile)) && /not jeppesen/i.test(JSON.stringify(idxFile)), "index denies commercial chart vendors");

const html = fs.readFileSync("public/index.html", "utf8");
ok(html.includes("id=\"aipsid\""), "SID/STAR toggle");
ok(html.includes("id=\"aipsidf\"") && html.includes("id=\"depf\"") && html.includes("id=\"arrf\""), "filter-sheet Departures, Arrivals and SID/STAR toggles");
ok(html.includes("id=\"depb\"") && html.includes("id=\"arrb\""), "map toolbar Dep/Arr pills");
ok(html.includes("id=\"sidnote\"") && html.includes("id=\"sidnotef\""), "short SID/STAR licence note near Dep/Arr");
ok(html.includes("pathleg") && html.includes("365-day departures"), "filter-sheet path colour legend");
ok(html.includes("id=\"aipp\""), "AIP panel");
ok(html.includes("id=\"aipname\""), "name-only licence-restricted toggle");
ok(/licence-restricted/i.test(html), "toggle labelled licence-restricted");
ok(/Not for navigation/i.test(html), "disclaimer in page");
ok(/17 U\.S\.C\.|FAA CIFP/i.test(html), "FAA CIFP cited in method");
ok(/NATS UK AIS/i.test(html), "NATS cited in method");
ok(/estimated from ADS-B track, not the ATC clearance/i.test(html), "ident disclaimer in page");
ok(/aip-ident\.js/.test(html), "aip-ident.js loaded");

const mapjs = fs.readFileSync("public/map.js", "utf8");
ok(mapjs.includes("aipLoad") && mapjs.includes("aip-sid"), "map overlay");
ok(mapjs.includes("sidNoteText") && mapjs.includes("Doha SID/STAR charts: official links only (licence)"), "Doha short licence note");
ok(/addSource\("hist".*tolerance:0/.test(mapjs.replace(/\s+/g, "")), "hist GeoJSON not simplified");
ok(mapjs.includes("COL_DEP") && mapjs.includes("COL_ARR") && mapjs.includes("#3D8BFF") && mapjs.includes("#FF4B6B"), "distinct dep/arr colours");
ok(!mapjs.includes("#4ee0ff") && !mapjs.includes("#ff9f43"), "old hist colours retired");
ok(mapjs.includes("COL_SID") && mapjs.includes("line-dasharray"), "SID/STAR dashed in direction family");
ok(mapjs.includes("identLive") && mapjs.includes("sidStarPanelHtml") && mapjs.includes("histIdentPopup"), "ident UI wired");
ok(mapjs.includes("Name-only SID/STAR ID") || html.includes("Name-only SID/STAR ID"), "name-only copy");

const idx = await api("/api/aip/index");
ok(idx.status === 200, "/api/aip/index 200");
const j = JSON.parse(idx.body);
ok(j.n_draw === 30 && j.cycle === "CIFP 261029", "API index cycle");

const jfk = await api("/api/aip?apt=JFK");
ok(jfk.status === 200, "/api/aip?apt=JFK");
const jf = JSON.parse(jfk.body);
ok(jf.mode === "draw" && jf.icao === "KJFK", "JFK draw");
ok((jf.procs || []).some((p) => p.kind === "sid" && p.path.length >= 2), "JFK SID geometry");
ok((jf.procs || []).some((p) => p.kind === "star"), "JFK STAR geometry");
ok(/not for navigation/i.test(jf.disclaimer || jf.note || ""), "JFK not for navigation");
ok(jf.airac === "2611" && jf.cycle === "CIFP 261029", "AIRAC cycle on tile");
ok(jf.ident_mode === "cifp" && jf.ident && jf.ident.flights >= 1, "JFK ident blob");
ok((jf.ident.raw || []).filter((r) => r.proc).every((r) => (jf.procs || []).some((p) => p.id === r.proc)), "JFK named procs are CIFP ids");
ok((jf.ident.by_rwy || []).some((b) => b.id === "04L" && b.dir === "dep" && (b.share || []).some((s) => s.proc === "DEEZZ6")), "JFK 04L dep DEEZZ6 share");

const lhr = await api("/api/aip?apt=EGLL");
ok(lhr.status === 200, "/api/aip?apt=EGLL");
const lf = JSON.parse(lhr.body);
ok(lf.mode === "link" && lf.icao === "EGLL", "EGLL alias is link-only");
ok(!(lf.procs && lf.procs.length), "EGLL has no redrawn procedures");
ok(/EG-AD-2\.EGLL/.test(lf.ad2_url || ""), "EGLL official AD 2");
ok(/redistribute/i.test(lf.terms || lf.why || ""), "NATS redistribute cited");
ok(lf.ident_mode === "none" && !(lf.ident && lf.ident.named), "EGLL ident_mode none");
ok(/OurAirports/.test(lf.ident_terms || "") && /OpenAIP/.test(lf.ident_terms || ""), "EGLL ident terms");

const doh = await api("/api/aip?apt=DOH");
const df = JSON.parse(doh.body);
ok(df.mode === "link" && /caa\.gov\.qa/.test(df.ad2_url || ""), "DOH QCAA link");
ok(!(df.procs && df.procs.length), "DOH no geometry");

const unknown = await api("/api/aip?apt=XXXX");
ok(unknown.status === 400, "unknown aip apt is 400");

const ap = await api("/api/airports");
const apj = JSON.parse(ap.body);
ok(apj.aip && apj.aip.n_draw === 30, "/api/airports includes aip coverage");
ok(A.resolveApt("EGLL").id === "LHR", "catalog still resolves EGLL");

const identJs = await api("/aip-ident.js");
ok(identJs.status === 200 && /function identify/.test(identJs.body), "/aip-ident.js served");
const Ident = require("./public/aip-ident.js");
const deez = (jf.procs || []).find((p) => p.id === "DEEZZ6" && p.trans === "RW04L");
ok(deez && deez.path.length >= 2, "DEEZZ6 RW04L in API");
{
  const dense = [deez.path[0].slice()];
  for (let i = 0; i < deez.path.length - 1; i++) {
    const a = deez.path[i], b = deez.path[i + 1];
    for (let t = 1; t <= 8; t++) { const f = t / 8; dense.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]); }
  }
  const ident = Ident.identify(dense, jf.procs, jf.lat, jf.lon, "sid", "04L");
  ok(ident.status === "match" && ident.proc === "DEEZZ6", `JS identify DEEZZ6 ${ident.status} ${ident.proc}`);
  ok(/estimated from ADS-B track, not the ATC clearance/i.test(ident.label || ""), `label copy ${ident.label}`);
}

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS", {
  cycle: j.cycle,
  jfk: { n_sid: jf.n_sid, n_star: jf.n_star, n_match: jf.n_match },
  lhr_ad2: lf.ad2_url,
  doh_ad2: df.ad2_url
});
