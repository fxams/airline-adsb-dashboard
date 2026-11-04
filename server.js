// Zero-dependency Node server: serves the dashboard and a cached live adsb.lol snapshot.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;
const REFRESH_MS = Number(process.env.REFRESH_MINUTES || 10) * 60 * 1000;
// Public hub points (airports), 250 nm radius each.
const HUBS = [
  ["New York", 40.64, -73.78], ["London", 51.47, -0.45], ["Los Angeles", 33.94, -118.41],
  ["Frankfurt", 50.03, 8.57], ["Doha", 25.27, 51.61], ["Singapore", 1.36, 103.99],
];
const traced = JSON.parse(fs.readFileSync(path.join(__dirname, "data/traced.json"), "utf8"));
const map = JSON.parse(fs.readFileSync(path.join(__dirname, "data/map.json"), "utf8"));
const h2h = fs.readFileSync(path.join(__dirname, "data/h2h.json"), "utf8");
const names = JSON.parse(fs.readFileSync(path.join(__dirname, "data/airlines.json"), "utf8"));
let snapshot = { at: null, error: "warming up", airlines: [], total: 0 };

async function fetchHub([region, lat, lon]) {
  const r = await fetch(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/250`, {
    headers: { "User-Agent": "airline-adsb-dashboard (github.com/fxams/airline-adsb-dashboard)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`adsb.lol ${r.status}`);
  const j = await r.json();
  return (j.ac || []).map((a) => ({ ...a, region }));
}

async function refresh() {
  try {
    const seen = new Map();
    for (const hub of HUBS) {
      try { for (const a of await fetchHub(hub)) if (!seen.has(a.hex)) seen.set(a.hex, a); } catch (e) { console.error(hub[0], e.message); }
    }
    const by = {};
    for (const a of seen.values()) {
      const cs = (a.flight || "").trim();
      if (!/^[A-Z]{3}\d/.test(cs)) continue;
      const code = cs.slice(0, 3);
      const air = typeof a.alt_baro === "number";
      const s = (by[code] ||= { code, name: names[code] || code, n: 0, air: 0, altSum: 0, gsSum: 0, gsN: 0, types: {} });
      s.n++;
      if (air) { s.air++; s.altSum += a.alt_baro; }
      if (air && typeof a.gs === "number") { s.gsSum += a.gs; s.gsN++; }
      const t = a.t || "Unknown"; s.types[t] = (s.types[t] || 0) + 1;
    }
    const airlines = Object.values(by).filter((s) => s.n >= 5).map((s) => ({
      code: s.code, name: s.name, n: s.n, air: s.air,
      avgAlt: s.air ? Math.round(s.altSum / s.air) : null, avgGs: s.gsN ? Math.round(s.gsSum / s.gsN) : null,
      types: Object.entries(s.types).sort((a, b) => b[1] - a[1]).slice(0, 5),
    })).sort((a, b) => b.n - a.n);
    if (seen.size) snapshot = { at: new Date().toISOString(), error: null, airlines, total: seen.size };
  } catch (e) { snapshot.error = e.message; }
}
refresh();
setInterval(refresh, REFRESH_MS);

const send = (res, code, type, body) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "public, max-age=60" }); res.end(body); };
http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (u === "/api/snapshot") return send(res, 200, "application/json", JSON.stringify(snapshot));
  if (u === "/api/traced") return send(res, 200, "application/json", JSON.stringify(traced));
  if (u === "/api/h2h") return send(res, 200, "application/json", h2h);
  if (u === "/api/map") return send(res, 200, "application/json", JSON.stringify(map));
  if (u === "/healthz") return send(res, 200, "text/plain", "ok");
  if (u === "/" || u === "/index.html") return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(__dirname, "public/index.html")));
  send(res, 404, "text/plain", "not found");
}).listen(PORT, () => console.log(`listening on ${PORT}`));
