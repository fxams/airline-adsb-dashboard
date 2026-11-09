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

const idxFile = JSON.parse(fs.readFileSync("data/hist/index.json", "utf8"));
ok(idxFile.n_airports >= 150, `index lists observed QTR airports (${idxFile.n_airports})`);
ok(idxFile.from === "2025-11-04" && idxFile.to === "2026-11-03", "UTC window matches 365-day aggregates");
ok(idxFile.not_sid_star === true, "index is not SID/STAR");
ok((idxFile.note || "").toLowerCase().includes("not published sid/star"), "note says not SID/STAR");
ok((idxFile.geom_days || []).length >= 1, "at least one geometry day");
const lhrMeta = idxFile.airports.find((a) => a.id === "LHR");
ok(lhrMeta && lhrMeta.icao === "EGLL" && lhrMeta.h2h_n > 1000, "LHR/EGLL from observed history");
ok(lhrMeta.tile === "LHR.json.gz", "LHR has a lazy-loaded tile");

const lhrTile = JSON.parse(zlib.gunzipSync(fs.readFileSync("data/hist/LHR.json.gz")));
ok((lhrTile.note || "").toLowerCase().includes("not published sid/star"), "LHR tile not SID/STAR");
ok(!/\bsid\/star\b/i.test(JSON.stringify(lhrTile).replace(/not published sid\/star/ig, "")), "no leftover SID/STAR claim");
const dirs = new Set((lhrTile.rwys || []).map((r) => r.id + ":" + r.dir));
ok(lhrTile.n_assigned > 0 && (lhrTile.rwys || []).length > 0, "LHR has assigned runway paths");
ok([...dirs].some((d) => d.endsWith(":arr")) && [...dirs].some((d) => d.endsWith(":dep")), `LHR has arr and dep, got ${[...dirs]}`);
ok((lhrTile.raw || []).length > 0, "smoothed tracks stored for the clutter toggle");
for (const r of lhrTile.rwys) {
  ok(r.clusters && r.clusters[0] && r.clusters[0].path.length > 5, `${r.id} ${r.dir} has a representative path`);
  ok(r.n > 0 && r.clusters[0].share > 0, `${r.id} ${r.dir} has honest share`);
}

const dohTile = JSON.parse(zlib.gunzipSync(fs.readFileSync("data/hist/DOH.json.gz")));
ok(dohTile.n_assigned > 0 && dohTile.icao === "OTHH", "DOH tile");

const idx = await api("/api/hist/index");
ok(idx.status === 200, "/api/hist/index 200");
const j = JSON.parse(idx.body);
ok(j.n_airports === idxFile.n_airports, "API index matches file");
ok(A.resolveApt("EGLL").id === "LHR", "catalog still resolves EGLL");

const liveLhr = await api("/api/hist?apt=EGLL");
ok(liveLhr.status === 200, "/api/hist?apt=EGLL");
const liveJ = JSON.parse(liveLhr.body);
ok(liveJ.apt === "LHR" && liveJ.icao === "EGLL", "EGLL alias serves LHR tile");
ok((liveJ.note || "").toLowerCase().includes("not published sid/star"), "API note not SID/STAR");

const unknown = await api("/api/hist?apt=XXXX");
ok(unknown.status === 400, "unknown hist apt is 400");

const ap = await api("/api/airports");
const apj = JSON.parse(ap.body);
ok(apj.hist && apj.hist.n_airports >= 150, "/api/airports includes hist coverage");
ok(apj.hubs.some((h) => h.id === "PEN" || h.iata === "PEN") || A.resolveApt("PEN"), "observed QTR airport PEN is resolvable after merge");

const groundPen = await api("/api/ground?apt=PEN");
ok(groundPen.status === 200 || groundPen.status === 400, "PEN ground is accepted if merged");
if (apj.hubs.some((h) => h.id === "PEN")) ok(groundPen.status === 200, "PEN is a zoom-in hub");

if (fail.length) {
  console.error("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("PASS", {
  n_airports: j.n_airports,
  n_with_geom: j.n_with_geom,
  geom_days: j.geom_days,
  lhr: { n: lhrTile.n_assigned, rwys: [...dirs], days: lhrTile.geom_days },
  doh: { n: dohTile.n_assigned, rwys: dohTile.rwys.map((r) => r.id + ":" + r.dir) }
});
