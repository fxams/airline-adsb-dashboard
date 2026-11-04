// Zero-dependency Node server: serves the dashboard and a cached live adsb.lol snapshot.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;
const REFRESH_MS = Number(process.env.REFRESH_SECONDS || 90) * 1000;
// Public hub points (airports), 250 nm radius each.
// Global feed: adsb.lol has no "whole world" endpoint, so we query every common airliner type globally (/v2/type).
const TYPES = (process.env.TYPES || "A20N,A21N,A319,A320,A321,A318,BCS1,BCS3,B737,B738,B739,B38M,B39M,B3XM,B752,B753,B763,B764,B772,B77L,B77W,B788,B789,B78X,B744,B748,A306,A332,A333,A338,A339,A343,A346,A359,A35K,A388,E170,E75L,E75S,E190,E195,E290,E295,CRJ7,CRJ9,CRJX,AT75,AT76,DH8D,MD11,B712,C919,A21N").split(",");
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
const hist = [];
// adsbdb.com callsign -> route lookup; cached per callsign (24 h hit, 6 h miss), max 1 upstream request per second.
const rc = new Map(); let lastDb = 0;
async function adsbdb(cs) {
  const c = rc.get(cs); if (c && Date.now() - c.t < (c.v.found ? 24 : 6) * 3600e3) return { ...c.v, cached: true };
  const wait = Math.max(0, lastDb + 1000 - Date.now()); lastDb = Date.now() + wait; if (wait) await new Promise((r) => setTimeout(r, wait));
  let v = { callsign: cs, found: false, source: "adsbdb.com" };
  try {
    const r = await fetch(`https://api.adsbdb.com/v0/callsign/${cs}`, { headers: { "User-Agent": "airline-adsb-dashboard" }, signal: AbortSignal.timeout(8000) });
    const f = r.ok ? ((await r.json()).response || {}).flightroute : null;
    const ap = (x) => x && { iata: x.iata_code, icao: x.icao_code, name: x.name, city: x.municipality, lat: x.latitude, lon: x.longitude };
    if (f && f.origin && f.destination) v = { callsign: cs, found: true, source: "adsbdb.com", airline: f.airline && f.airline.name, origin: ap(f.origin), destination: ap(f.destination) };
  } catch (e) { v.error = "lookup failed"; return v; }
  rc.set(cs, { t: Date.now(), v }); if (rc.size > 20000) rc.clear();
  return v;
} // [iso, total aircraft] last 60 refreshes

async function fetchType(t) {
  const r = await fetch(`https://api.adsb.lol/v2/type/${t}`, { headers: { "User-Agent": "airline-adsb-dashboard (github.com/fxams/airline-adsb-dashboard)" }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`adsb.lol ${r.status}`);
  return (await r.json()).ac || [];
}
const lastT = new Map(); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cov = new Map(); // "lat2,lon2" 2-degree cells with at least one position, last seen ms
let busy = false;
async function refresh() {
  if (busy) return; busy = true;
  try {
    const seen = new Map();
    const T = [...new Set(TYPES)];
    for (const t of T) { // serial + spaced to stay under adsb.lol rate limits; reuse last good result (<5 min) on failure
      let ac = null;
      for (let k = 0; k < 2 && !ac; k++) { try { ac = await fetchType(t); } catch (e) { await sleep(3000); } }
      if (ac) lastT.set(t, { ts: Date.now(), ac }); else { const o = lastT.get(t); if (o && Date.now() - o.ts < 300e3) ac = o.ac; else console.error(t, "failed"); }
      for (const a of ac || []) { const p = seen.get(a.hex); if (!p || (a.seen_pos ?? 99) < (p.seen_pos ?? 99)) seen.set(a.hex, a); }
      await sleep(800);
    }
    const nowc = Date.now();
    for (const a of seen.values()) if (typeof a.lat === "number" && (a.seen_pos ?? 0) <= 60) cov.set(`${Math.floor(a.lat / 2) * 2},${Math.floor(a.lon / 2) * 2}`, nowc);
    for (const [k, t] of cov) if (nowc - t > 6 * 3600e3) cov.delete(k);
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
  busy = false;
}
refresh();
setInterval(refresh, REFRESH_MS);

const zlib = require("zlib");
const send = (res, code, type, body, cache) => {
  const h = { "Content-Type": type, "Cache-Control": cache || "no-store, no-cache, must-revalidate, max-age=0", "Access-Control-Allow-Origin": "*", "Vary": "Accept-Encoding" };
  if (res.req && /gzip/.test(res.req.headers["accept-encoding"] || "") && body && body.length > 2048) { h["Content-Encoding"] = "gzip"; body = zlib.gzipSync(body); }
  res.writeHead(code, h); res.end(body);
};
http.createServer(async (req, res) => {
  const u = req.url.split("?")[0]; const q = new URL(req.url, "http://x").searchParams;
  if (u === "/api/snapshot") return send(res, 200, "application/json", JSON.stringify(snapshot));
  if (u === "/api/tracks") return send(res, 200, "application/json", tracks, "public, max-age=300");
  if (u === "/api/trails") { const o = {}; for (const [h, t] of trails) o[h] = t.slice(-12).map((p) => [p[1], p[2]]); return send(res, 200, "application/json", JSON.stringify(o)); }
  if (u === "/api/track") { const h = (q.get("hex") || "").toLowerCase(); return send(res, 200, "application/json", JSON.stringify({ hex: h, fields: ["t_ms", "lon", "lat", "alt_ft", "gs_kt", "vrate_fpm"], note: "Positions collected by this server every refresh since it last restarted (max ~3 h)", points: trails.get(h) || [] })); }
  if (u === "/api/coverage") return send(res, 200, "application/json", JSON.stringify({ cell_deg: 2, window_h: 6, note: "2-degree cells where at least one airliner position was received in the last 6 h (since server start). Empty areas = no receivers or no traffic.", cells: [...cov.keys()].map((k) => k.split(",").map(Number)) }));
  if (u === "/api/route") {
    const cs = (q.get("cs") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!cs) return send(res, 400, "application/json", "{}");
    return send(res, 200, "application/json", JSON.stringify(await adsbdb(cs)));
  }
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
