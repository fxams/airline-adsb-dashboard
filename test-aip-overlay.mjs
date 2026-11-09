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
ok(html.includes("id=\"aipp\""), "AIP panel");
ok(/Not for navigation/i.test(html), "disclaimer in page");
ok(/17 U\.S\.C\.|FAA CIFP/i.test(html), "FAA CIFP cited in method");
ok(/NATS UK AIS/i.test(html), "NATS cited in method");

const mapjs = fs.readFileSync("public/map.js", "utf8");
ok(mapjs.includes("aipLoad") && mapjs.includes("aip-sid"), "map overlay");

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

const lhr = await api("/api/aip?apt=EGLL");
ok(lhr.status === 200, "/api/aip?apt=EGLL");
const lf = JSON.parse(lhr.body);
ok(lf.mode === "link" && lf.icao === "EGLL", "EGLL alias is link-only");
ok(!(lf.procs && lf.procs.length), "EGLL has no redrawn procedures");
ok(/EG-AD-2\.EGLL/.test(lf.ad2_url || ""), "EGLL official AD 2");
ok(/redistribute/i.test(lf.terms || lf.why || ""), "NATS redistribute cited");

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
