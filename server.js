// Zero-dependency Node server: serves the dashboard and a cached live adsb.lol snapshot.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;
const REFRESH_MS = Number(process.env.REFRESH_SECONDS || 30) * 1000;
// Public hub points (airports), 250 nm radius each.
const HUBS = [
  ["New York", 40.64, -73.78], ["London", 51.47, -0.45], ["Los Angeles", 33.94, -118.41],
  ["Frankfurt", 50.03, 8.57], ["Doha", 25.27, 51.61], ["Singapore", 1.36, 103.99],
];
const traced = JSON.parse(fs.readFileSync(path.join(__dirname, "data/traced.json"), "utf8"));
const map = JSON.parse(fs.readFileSync(path.join(__dirname, "data/map.json"), "utf8"));
const h2h = fs.readFileSync(path.join(__dirname, "data/h2h.json"), "utf8");
const globalAgg = fs.readFileSync(path.join(__dirname, "data/global.json"), "utf8");
const names = JSON.parse(fs.readFileSync(path.join(__dirname, "data/airlines.json"), "utf8"));
let snapshot = { at: null, error: "warming up", airlines: [], total: 0 };
let live = { at: null, fields: ["hex","callsign","airline","type","lat","lon","alt_ft","gs_kt","track","reg","on_ground","pos_age_s","vrate_fpm"], ac: [] };
const trails = new Map(); 
const tracks = fs.readFileSync(path.join(__dirname, "data/tracks.json"), "utf8");
const csroute = fs.readFileSync(path.join(__dirname, "data/csroute.json"), "utf8");
const hist = []; // [iso, total aircraft] last 60 refreshes

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
      try { for (const a of await fetchHub(hub)) { const p = seen.get(a.hex); if (!p || (a.seen_pos ?? 99) < (p.seen_pos ?? 99)) seen.set(a.hex, a); } } catch (e) { console.error(hub[0], e.message); }
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
    if (seen.size) {
      const at = new Date().toISOString();
      snapshot = { at, error: null, airlines, total: seen.size };
      live = { at, fields: live.fields, ac: [...seen.values()].filter((a) => typeof a.lat === "number" && typeof a.lon === "number" && (a.seen_pos ?? 0) <= 60 && /^[A-Z]{3}\d/.test((a.flight || "").trim()))
        .map((a) => [a.hex, a.flight.trim(), a.flight.trim().slice(0, 3), a.t || "", +a.lat.toFixed(3), +a.lon.toFixed(3), typeof a.alt_baro === "number" ? a.alt_baro : 0, Math.round(a.gs || 0), Math.round(a.track ?? a.true_heading ?? a.mag_heading ?? 0), a.r || "", a.alt_baro === "ground" ? 1 : 0, Math.round(a.seen_pos ?? 0), Math.round(a.baro_rate ?? a.geom_rate ?? 0)]) };
      const now = Date.now();
      for (const r of live.ac) { const t = trails.get(r[0]) || []; const p = t[t.length - 1]; if (!p || p[1] !== r[5] || p[2] !== r[4]) t.push([now, r[5], r[4], r[6], r[7], r[12]]); if (t.length > 360) t.shift(); trails.set(r[0], t); }
      for (const [h, t] of trails) if (now - t[t.length - 1][0] > 20 * 60000) trails.delete(h);
      hist.push([at, seen.size, live.ac.length]); if (hist.length > 60) hist.shift();
    }
  } catch (e) { snapshot.error = e.message; }
}
refresh();
setInterval(refresh, REFRESH_MS);

const send = (res, code, type, body, cache) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": cache || "no-store, no-cache, must-revalidate, max-age=0", "Access-Control-Allow-Origin": "*" }); res.end(body); };
http.createServer(async (req, res) => {
  const u = req.url.split("?")[0]; const q = new URL(req.url, "http://x").searchParams;
  if (u === "/api/snapshot") return send(res, 200, "application/json", JSON.stringify(snapshot));
  if (u === "/api/tracks") return send(res, 200, "application/json", tracks, "public, max-age=300");
  if (u === "/api/trails") { const o = {}; for (const [h, t] of trails) o[h] = t.slice(-12).map((p) => [p[1], p[2]]); return send(res, 200, "application/json", JSON.stringify(o)); }
  if (u === "/api/track") { const h = (q.get("hex") || "").toLowerCase(); return send(res, 200, "application/json", JSON.stringify({ hex: h, fields: ["t_ms", "lon", "lat", "alt_ft", "gs_kt", "vrate_fpm"], note: "Positions collected by this server every refresh since it last restarted (max ~3 h)", points: trails.get(h) || [] })); }
  if (u === "/api/csroute") return send(res, 200, "application/json", csroute, "public, max-age=300");
  if (u === "/api/traced") return send(res, 200, "application/json", JSON.stringify(traced));
  if (u === "/api/h2h") return send(res, 200, "application/json", h2h, "public, max-age=300");
  if (u === "/api/global") return send(res, 200, "application/json", globalAgg, "public, max-age=300");
  if (u === "/api/live") return send(res, 200, "application/json", JSON.stringify({ ...live, history: hist, refreshSeconds: REFRESH_MS / 1000 }));
  if (u === "/api/map") return send(res, 200, "application/json", JSON.stringify(map));
  if (u === "/healthz") return send(res, 200, "text/plain", "ok");
  if (u === "/map.js") return send(res, 200, "application/javascript; charset=utf-8", fs.readFileSync(path.join(__dirname, "public/map.js")));
  if (u === "/" || u === "/index.html") return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(__dirname, "public/index.html")));
  send(res, 404, "text/plain", "not found");
}).listen(PORT, () => console.log(`listening on ${PORT}`));
