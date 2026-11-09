// Zero-dependency Node server: serves the dashboard and a cached live adsb.lol snapshot.
const http = require("http");
const fs = require("fs");
const path = require("path");

const { LiveFeed, parseTypes, feedBanner } = require("./live-feed");
const airports = require("./public/airports.js");
const PORT = process.env.PORT || 10000;
const REFRESH_MS = Number(process.env.REFRESH_SECONDS || 90) * 1000;
// Public hub points (airports), 250 nm radius each.
// Global feed: adsb.lol has no "whole world" endpoint, so we query every common airliner type globally (/v2/type).
const TYPES = parseTypes(process.env.TYPES);
const liveFeed = new LiveFeed({ types: TYPES });
const lastT = liveFeed.lastT;
const traced = JSON.parse(fs.readFileSync(path.join(__dirname, "data/traced.json"), "utf8"));
const map = JSON.parse(fs.readFileSync(path.join(__dirname, "data/map.json"), "utf8"));
const h2h = fs.readFileSync(path.join(__dirname, "data/h2h.json"), "utf8");
const fin = fs.readFileSync(path.join(__dirname, "data/fin.json"), "utf8");
const finCsv = (() => { const j = JSON.parse(fin); const k = Object.keys(j.m.QTR[0]); return "# Estimates/proxies derived from open ADS-B data (adsb.lol, ODbL). Not reported financials. Not investment advice. Months UTC.\nairline," + k.join(",") + "\n" + Object.entries(j.m).flatMap(([a, r]) => r.map((x) => a + "," + k.map((c) => x[c] ?? "").join(","))).join("\n") + "\n"; })();
const globalAgg = fs.readFileSync(path.join(__dirname, "data/global.json"), "utf8");
const names = JSON.parse(fs.readFileSync(path.join(__dirname, "data/airlines.json"), "utf8"));
const { inspectSources } = require("./public/flightno.js");
let snapshot = { at: null, error: "warming up", airlines: [], total: 0 };
let live = { at: null, fields: ["hex","callsign","airline","type","lat","lon","alt_ft","gs_kt","track","reg","on_ground","pos_age_s","vrate_fpm"], ac: [], nm: {} };
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
    const lookup = inspectSources({
      callsign: cs,
      records: f ? [{ source: "adsbdb.com", payload: f, origin: f.origin, destination: f.destination }] : []
    });
    if (f && f.origin && f.destination) v = {
      callsign: cs,
      found: true,
      source: "adsbdb.com",
      callsign_icao: f.callsign_icao || null,
      callsign_iata: f.callsign_iata || null,
      airline: f.airline && f.airline.name,
      airline_icao: (f.airline && f.airline.icao) || null,
      airline_iata: (f.airline && f.airline.iata) || null,
      origin: ap(f.origin),
      destination: ap(f.destination),
      flight_number: null,
      flight_number_lookup: lookup,
      note: "adsbdb lookup is by ADS-B callsign. callsign_iata is the IATA spelling of that same callsign (airline IATA prefix + remainder), including alphanumeric suffixes. It is not a marketed/ticketed passenger flight number. Routes are crowd-sourced and can be stale or reused; codeshares are not resolved."
    };
    else v = { ...v, flight_number: null, flight_number_lookup: lookup };
  } catch (e) { v.error = "lookup failed"; return v; }
  rc.set(cs, { t: Date.now(), v }); if (rc.size > 20000) rc.clear();
  return v;
} // [iso, total aircraft] last 60 refreshes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ground / local view: surface + nearby airborne from adsb.lol /v2/point at any catalog hub.
const GHOLD_PATH = path.join(__dirname, "data", "ground-hold.json");
const GHOLD_MAX_MS = 24 * 3600e3; // expire held markers that never reappear within 24 h
let ghold = new Map(); // hex -> { apt, cs, al, t, lat, lon, tr, gs, st, seen_utc, held_utc }
try { for (const r of JSON.parse(fs.readFileSync(GHOLD_PATH, "utf8"))) if (r && r.hex) ghold.set(r.hex, r); } catch (_) {}
let gholdDirty = false, gholdWriteAt = 0;
function gholdSave() {
  if (!gholdDirty || Date.now() - gholdWriteAt < 5000) return;
  gholdDirty = false; gholdWriteAt = Date.now();
  try { fs.writeFileSync(GHOLD_PATH, JSON.stringify([...ghold.values()])); } catch (e) { console.error("ghold save", e.message); }
}
function gholdClearSeen(seenHexes) {
  let n = 0;
  for (const h of seenHexes) if (ghold.delete(h)) { n++; gholdDirty = true; }
  const cut = Date.now() - GHOLD_MAX_MS;
  for (const [h, r] of ghold) if (Date.parse(r.held_utc || r.seen_utc) < cut) { ghold.delete(h); n++; gholdDirty = true; }
  if (n) gholdSave();
}
const gcache = new Map();
function trailPush(hex, lon, lat, alt, gs, vrate, onG) {
  const now = Date.now();
  const t = trails.get(hex) || [];
  const p = t[t.length - 1];
  if (!p || p[1] !== lon || p[2] !== lat) t.push([now, lon, lat, alt, gs, vrate, onG]);
  if (t.length > 360) t.shift();
  trails.set(hex, t);
}
async function ground(id) {
  const hub = airports.resolveApt(id);
  if (!hub) return { error: "unknown airport" };
  const c = gcache.get(hub.id); if (c && Date.now() - c.t < 30000) return c.v;
  const la = hub.lat, lo = hub.lon, name = hub.name;
  const pointNm = airports.POINT_NM, gndNm = airports.GND_NM;
  let ac = [], err = null, src = "adsb.lol /v2/point";
  for (let i = 0; i < 2 && !ac.length; i++) {
    try { const r = await fetch(`https://api.adsb.lol/v2/point/${la}/${lo}/${pointNm}`, { headers: { "User-Agent": "airline-adsb-dashboard (github.com/fxams/airline-adsb-dashboard)" }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error("HTTP " + r.status); ac = (await r.json()).ac || []; err = null; break; } catch (e) { err = String(e.message || e); await sleep(1500); }
  }
  if (err) {
    src = "global type feed (fallback, airliner types only, up to ~90 s old)";
    const d2 = (a) => ((a.lat - la) * 60) ** 2 + ((a.lon - lo) * 60 * Math.cos((la * Math.PI) / 180)) ** 2;
    const m = new Map(); for (const { ac: l } of lastT.values()) for (const a of l) if (typeof a.lat === "number" && d2(a) < pointNm * pointNm) m.set(a.hex, a); ac = [...m.values()];
  }
  // Drop held markers for any hex currently in the worldwide live feed (airborne or on ground, any airport).
  const liveHex = new Set((live.ac || []).map((r) => r[0]));
  gholdClearSeen(liveHex);
  const nowIso = new Date().toISOString(), liveRows = [], airRows = [], liveHexHere = new Set();
  const nmAt = (a) => airports.hv(la, lo, a.lat, a.lon);
  for (const a of ac) {
    if (typeof a.lat !== "number" || typeof a.lon !== "number" || !a.hex) continue;
    const onG = a.alt_baro === "ground", gs = a.gs ?? 0, alt = typeof a.alt_baro === "number" ? a.alt_baro : 0;
    const dist = nmAt(a);
    const lat5 = +a.lat.toFixed(5), lon5 = +a.lon.toFixed(5);
    const vrate = Math.round(a.baro_rate ?? a.geom_rate ?? 0);
    trailPush(a.hex, lon5, lat5, alt, Math.round(gs), vrate, onG ? 1 : 0);
    const cs = (a.flight || "").trim();
    if (airports.isSurface(onG, alt, gs, dist)) {
      const st = gs < 1.5 ? "parked" : gs <= 35 ? "taxi" : "runway";
      const reg = (a.r || "").trim();
      const row = [a.hex, cs, cs.slice(0, 3), a.t || "", lat5, lon5, Math.round(a.track ?? a.true_heading ?? 0), Math.round(gs), st, Math.round(a.seen_pos ?? a.seen ?? 0), onG ? 1 : 0, "live", null, null, reg, hub.id];
      liveRows.push(row); liveHexHere.add(a.hex);
      ghold.set(a.hex, { hex: a.hex, apt: hub.id, cs, al: cs.slice(0, 3), t: a.t || "", lat: lat5, lon: lon5, tr: row[6], gs: row[7], st, seen_utc: nowIso, held_utc: nowIso, reg });
      gholdDirty = true;
    } else if (/^[A-Z]{3}\d/.test(cs) && dist <= pointNm) {
      airRows.push([a.hex, cs, cs.slice(0, 3), a.t || "", lat5, lon5, alt, Math.round(gs), Math.round(a.track ?? a.true_heading ?? a.mag_heading ?? 0), a.r || "", onG ? 1 : 0, Math.round(a.seen_pos ?? a.seen ?? 0), vrate]);
    }
  }
  // Keep last ground position for aircraft that dropped out of the ground feed at this airport (usually ADS-B off at the gate), until the same hex reappears in the live feed or 24 h pass.
  const heldRows = [];
  for (const r of ghold.values()) {
    if (r.apt !== hub.id || liveHexHere.has(r.hex) || liveHex.has(r.hex)) continue;
    const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(r.held_utc || r.seen_utc)) / 60000));
    heldRows.push([r.hex, r.cs, r.al, r.t, r.lat, r.lon, r.tr, r.gs, r.st, ageMin * 60, 1, "held", ageMin, r.held_utc || r.seen_utc, r.reg || "", r.apt]);
  }
  gholdSave();
  const v = { airport: hub.id, icao: hub.icao, iata: hub.iata, name, center: [lo, la], radius_nm: gndNm, air_radius_nm: pointNm, time_utc: nowIso, fields: ["hex", "callsign", "airline", "type", "lat", "lon", "track_deg", "gs_kt", "status", "seen_s", "ground_flag", "mode", "held_min", "held_utc", "reg", "apt"], note: "Observed ADS-B from adsb.lol /v2/point, not published SID/STAR procedures. Surface = on-ground flag, or under 300 ft and under 60 kt, within 8 nm. Air = airline-callsign airborne samples within 40 nm (arrivals/departures). Held = last known ground position kept after the aircraft dropped out of the feed (common when ADS-B is switched off at the gate); removed when the same hex reappears anywhere in the live feed, or after 24 h with no reappearance. Status parked/taxi/runway is estimated from ground speed. No gate or stand assignment. Hold store persists across restarts in data/ground-hold.json.", live: liveRows.length, held: heldRows.length, air: airRows, ac: liveRows.concat(heldRows), source: src, error: err };
  gcache.set(hub.id, { t: Date.now(), v }); return v;
}
const T0 = Date.now();
const cov = new Map(); // "lat2,lon2" 2-degree cells with at least one position, last seen ms
let busy = false;
async function refresh() {
  if (busy) return; busy = true;
  const t0 = Date.now();
  try {
    const { seen, feed: f } = await liveFeed.refresh();
    const nowc = Date.now();
    for (const a of seen.values()) if (typeof a.lat === "number" && (a.seen_pos ?? 0) <= 60) cov.set(`${Math.floor(a.lat / 2) * 2},${Math.floor(a.lon / 2) * 2}`, nowc);
    for (const [k, t] of cov) if (nowc - t > 24 * 3600e3) cov.delete(k);
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
    const banner = feedBanner(f);
    // Publish whatever groups succeeded or are still within the stale window. Do not
    // drop the whole snapshot because some type fetches failed.
    if (seen.size) {
      const at = new Date().toISOString();
      snapshot = { at, error: (f.n_ok || f.n_stale) ? null : (banner || null), airlines, total: seen.size, feed: f };
      gholdClearSeen([...seen.keys()]);
      const ac = [...seen.values()].filter((a) => typeof a.lat === "number" && typeof a.lon === "number" && (a.seen_pos ?? 0) <= 60 && /^[A-Z]{3}\d/.test((a.flight || "").trim()))
        .map((a) => [a.hex, a.flight.trim(), a.flight.trim().slice(0, 3), a.t || "", +a.lat.toFixed(5), +a.lon.toFixed(5), typeof a.alt_baro === "number" ? a.alt_baro : 0, Math.round(a.gs || 0), Math.round(a.track ?? a.true_heading ?? a.mag_heading ?? 0), a.r || "", a.alt_baro === "ground" ? 1 : 0, Math.round(a.seen_pos ?? 0), Math.round(a.baro_rate ?? a.geom_rate ?? 0)]);
      const nm = {};
      for (const r of ac) { const c = r[2]; if (c && names[c] && !nm[c]) nm[c] = names[c]; }
      live = { at, fields: live.fields, ac, nm, feed: f };
      const now = Date.now();
      for (const r of live.ac) { const t = trails.get(r[0]) || []; const p = t[t.length - 1]; if (!p || p[1] !== r[5] || p[2] !== r[4]) t.push([now, r[5], r[4], r[6], r[7], r[12], r[10]]); if (t.length > 360) t.shift(); trails.set(r[0], t); }
      for (const [h, t] of trails) if (now - t[t.length - 1][0] > 20 * 60000) trails.delete(h);
      hist.push([at, seen.size, live.ac.length]); if (hist.length > 60) hist.shift();
    } else {
      snapshot = { ...snapshot, error: banner || snapshot.error || "no type groups loaded", feed: f };
      live = { ...live, feed: f };
    }
    console.log("refresh", "n=" + seen.size, "ok=" + f.n_ok, "stale=" + f.n_stale, "failed=" + f.n_failed, "ms=" + (Date.now() - t0), banner || "all type groups ok");
  } catch (e) { snapshot.error = e.message; console.error("refresh", e.message); }
  busy = false;
}
function scheduleRefresh() {
  const elapsed = liveFeed.lastCycleMs || 0;
  const wait = Math.max(8000, REFRESH_MS - elapsed);
  setTimeout(() => { refresh().finally(scheduleRefresh); }, wait);
}
refresh().finally(scheduleRefresh);

const wx = require("./wx");
const zlib = require("zlib");
const send = (res, code, type, body, cache) => {
  const h = { "Content-Type": type, "Cache-Control": cache || "no-store, no-cache, must-revalidate, max-age=0", "Access-Control-Allow-Origin": "*", "Vary": "Accept-Encoding" };
  if (res.req && /gzip/.test(res.req.headers["accept-encoding"] || "") && body && body.length > 2048) { h["Content-Encoding"] = "gzip"; body = zlib.gzipSync(body); }
  res.writeHead(code, h); res.end(body);
};
http.createServer(async (req, res) => {
  const u = req.url.split("?")[0]; const q = new URL(req.url, "http://x").searchParams;
  if (u === "/api/ground") {
    const id = (q.get("apt") || "").toUpperCase();
    const hub = airports.resolveApt(id);
    if (!hub) return send(res, 400, "application/json", JSON.stringify({ error: "unknown airport", hint: "apt is IATA or ICAO from /api/airports (e.g. LHR or EGLL)" }));
    return ground(hub.id).then((v) => send(res, 200, "application/json", JSON.stringify(v), "public, max-age=30"));
  }
  if (u === "/api/airports") return send(res, 200, "application/json", JSON.stringify({ presets: airports.PRESETS, hubs: airports.HUBS, point_nm: airports.POINT_NM, gnd_nm: airports.GND_NM, auto_zoom: airports.AUTO_ZOOM, auto_nm: airports.AUTO_NM, note: "Public ARP coordinates (OurAirports, public domain). Local ADS-B via adsb.lol /v2/point when the map is at a hub. Not SID/STAR procedures." }), "public, max-age=3600");
  if (u === "/airports.js") return send(res, 200, "application/javascript; charset=utf-8", fs.readFileSync(path.join(__dirname, "public/airports.js")));
  if (u === "/api/snapshot") return send(res, 200, "application/json", JSON.stringify(snapshot));
  if (u === "/api/tracks") return send(res, 200, "application/json", tracks, "public, max-age=300");
  if (u === "/api/trails") { const o = {}; for (const [h, t] of trails) o[h] = t.slice(-12).map((p) => [p[1], p[2]]); return send(res, 200, "application/json", JSON.stringify(o)); }
  if (u === "/api/track") { const h = (q.get("hex") || "").toLowerCase(); return send(res, 200, "application/json", JSON.stringify({ hex: h, fields: ["t_ms", "lon", "lat", "alt_ft", "gs_kt", "vrate_fpm", "on_ground"], note: "Positions collected by this server every refresh since it last restarted (max ~3 h). on_ground is 1 when the ADS-B snapshot reported ground. First stored point is when this server began tracking the hex, not a departure time.", points: trails.get(h) || [] })); }
  if (u === "/api/coverage") return send(res, 200, "application/json", JSON.stringify({ cell_deg: 2, window_h: 24, since_utc: new Date(T0).toISOString(), note: "2-degree cells where at least one airliner position was received in the last 24 h (accumulated since server start, UTC). Estimated from observed traffic, not an official receiver map. Areas outside = no receiver data in the window.", cells: [...cov.keys()].map((k) => k.split(",").map(Number)) }));
  if (u === "/api/route") {
    const cs = (q.get("cs") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!cs) return send(res, 400, "application/json", "{}");
    return send(res, 200, "application/json", JSON.stringify(await adsbdb(cs)));
  }
  if (u === "/api/csroute") return send(res, 200, "application/json", csroute, "public, max-age=300");
  if (u === "/api/traced") return send(res, 200, "application/json", JSON.stringify(traced));
  if (u === "/api/fin") return send(res, 200, "application/json", fin, "public, max-age=300");
  if (u === "/api/fin.csv") { res.setHeader("Content-Disposition", "attachment; filename=qtr_uae_monthly_metrics.csv"); return send(res, 200, "text/csv", finCsv, "public, max-age=300"); }
  if (u === "/api/h2h") return send(res, 200, "application/json", h2h, "public, max-age=300");
  if (u === "/api/global") return send(res, 200, "application/json", globalAgg, "public, max-age=300");
  if (u === "/api/wx/hazards") return send(res, 200, "application/json", JSON.stringify(await wx.hazards()), "public, max-age=60");
  if (u === "/api/wx/stations") return send(res, 200, "application/json", JSON.stringify(await wx.stations(q.get("ids") || "")), "public, max-age=60");
  if (u === "/api/wx/winds") return send(res, 200, "application/json", JSON.stringify(await wx.winds()), "public, max-age=120");
  if (u === "/api/live") return send(res, 200, "application/json", JSON.stringify({ ...live, history: hist, refreshSeconds: REFRESH_MS / 1000 }));
  if (u === "/api/feed") return send(res, 200, "application/json", JSON.stringify(liveFeed.summary()));
  if (u === "/api/map") return send(res, 200, "application/json", JSON.stringify(map));
  if (u === "/healthz") return send(res, 200, "text/plain", "ok");
  if (u === "/map.js") return send(res, 200, "application/javascript; charset=utf-8", fs.readFileSync(path.join(__dirname, "public/map.js")));
  if (u === "/route-plaus.js") return send(res, 200, "application/javascript; charset=utf-8", fs.readFileSync(path.join(__dirname, "public/route-plaus.js")));
  if (u === "/flightno.js") return send(res, 200, "application/javascript; charset=utf-8", fs.readFileSync(path.join(__dirname, "public/flightno.js")));
  if (u === "/" || u === "/index.html") return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(__dirname, "public/index.html")));
  send(res, 404, "text/plain", "not found");
}).listen(PORT, () => console.log(`listening on ${PORT}`));
