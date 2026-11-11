// Zero-dependency Node server: serves the dashboard and a cached live adsb.lol snapshot.
const http = require("http");
const fs = require("fs");
const path = require("path");

const { LiveFeed, parseTypes, feedBanner, snapshotFresh, warmStartUrl, loadLiveSnapshotFile, filterAcBbox, UA } = require("./live-feed");
const airports = require("./public/airports.js");
const HIST_DIR = path.join(__dirname, "data", "hist");
const AIP_DIR = path.join(__dirname, "data", "aip");
function loadHistIndex() {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(HIST_DIR, "index.json"), "utf8"));
    if (Array.isArray(idx.airports)) airports.merge(idx.airports);
    return idx;
  } catch (_) {
    return { airports: [], n_airports: 0, n_with_geom: 0, geom_days: [], note: "No terminal-area tiles in this build." };
  }
}
function loadAipIndex() {
  try {
    return JSON.parse(fs.readFileSync(path.join(AIP_DIR, "index.json"), "utf8"));
  } catch (_) {
    return { airports: [], n_airports: 0, n_draw: 0, n_link: 0, note: "No AIP SID/STAR index in this build." };
  }
}
const TILE_HUBS = airports.HUBS.slice();
const histIndex = loadHistIndex();
const aipIndex = loadAipIndex();
function aipMeta(id) {
  return (aipIndex.airports || []).find((a) => a.id === id) || null;
}
const PORT = process.env.PORT || 10000;
const REFRESH_MS = Number(process.env.REFRESH_SECONDS || 90) * 1000;
// Live feed: 250 nm point tiles across free providers (adsb.lol, adsb.fi; airplanes.live failover).
// REFRESH_SECONDS is the global-tile freshness target, not a per-type loop. Hot hubs are faster.
const TYPES = parseTypes(process.env.TYPES);
const liveFeed = new LiveFeed({ types: TYPES, hubs: TILE_HUBS, globalDueMs: REFRESH_MS });
const lastT = liveFeed.lastT;
const traced = JSON.parse(fs.readFileSync(path.join(__dirname, "data/traced.json"), "utf8"));
const map = JSON.parse(fs.readFileSync(path.join(__dirname, "data/map.json"), "utf8"));
const h2h = fs.readFileSync(path.join(__dirname, "data/h2h.json"), "utf8");
const fin = fs.readFileSync(path.join(__dirname, "data/fin.json"), "utf8");
const finCsv = (() => { const j = JSON.parse(fin); const k = Object.keys(j.m.QTR[0]); return "# Estimates/proxies derived from open ADS-B data (adsb.lol, ODbL). Not reported financials. Not investment advice. Months UTC.\nairline," + k.join(",") + "\n" + Object.entries(j.m).flatMap(([a, r]) => r.map((x) => a + "," + k.map((c) => x[c] ?? "").join(","))).join("\n") + "\n"; })();
const globalAgg = fs.readFileSync(path.join(__dirname, "data/global.json"), "utf8");
const names = JSON.parse(fs.readFileSync(path.join(__dirname, "data/airlines.json"), "utf8"));
const { inspectSources } = require("./public/flightno.js");
const LIVE_SNAP_PATH = path.join(__dirname, "data", "live-snapshot.json");
let snapshot = { at: null, error: "warming up", airlines: [], total: 0 };
let live = { at: null, fields: ["hex","callsign","airline","type","lat","lon","alt_ft","gs_kt","track","reg","on_ground","pos_age_s","vrate_fpm"], ac: [], nm: {}, feed: liveFeed.summary() };
const trails = new Map(); 
const tracks = fs.readFileSync(path.join(__dirname, "data/tracks.json"), "utf8");
const csroute = fs.readFileSync(path.join(__dirname, "data/csroute.json"), "utf8");
const hist = [];
let liveVer = 0; // bumped whenever `live` is republished (keys the /api/live body cache)
let lastClientAt = Date.now(), lastProgressPublish = 0;
const IDLE_AFTER_MS = Number(process.env.IDLE_AFTER_SECONDS || 300) * 1000;
const IDLE_REFRESH_MS = Number(process.env.IDLE_REFRESH_SECONDS || 15) * 1000;
const PROGRESS_PUBLISH_MS = Number(process.env.PROGRESS_PUBLISH_MS || 3000);
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
  let ac = [], err = null, src = "adsb.lol / adsb.fi 250 nm point";
  try {
    const got = await liveFeed.fetchPoint(la, lo, pointNm);
    if (got && got.ac) { ac = got.ac; err = got.err || null; src = (got.provider || "point") + " 250 nm cap, requested " + pointNm + " nm"; }
  } catch (e) { err = String(e.message || e); }
  if (err) {
    src = "tiled live feed fallback (airline callsigns already on the map, up to ~20 min old)";
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
let snapWriteAt = 0, snapTimer = null;
function saveLiveSnapshot(force) {
  if (!live.at || !(live.ac || []).length) return;
  const now = Date.now();
  if (!force && now - snapWriteAt < 2000) {
    if (!snapTimer) snapTimer = setTimeout(() => { snapTimer = null; saveLiveSnapshot(true); }, 2000 - (now - snapWriteAt));
    return;
  }
  if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; }
  snapWriteAt = now;
  try {
    fs.writeFileSync(LIVE_SNAP_PATH, JSON.stringify({ at: live.at, ac: live.ac, nm: live.nm, fields: live.fields, feed: live.feed }));
  } catch (e) { console.error("live snapshot save", e.message); }
}
function publishFromSeen(seen, f) {
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
      .map((a) => [a.hex, a.flight.trim(), a.flight.trim().slice(0, 3), a.t || "", +a.lat.toFixed(5), +a.lon.toFixed(5), typeof a.alt_baro === "number" ? a.alt_baro : 0, Math.round(a.gs || 0), Math.round(a.track ?? a.true_heading ?? a.mag_heading ?? 0), a.r || "", a.alt_baro === "ground" ? 1 : 0, Math.round(a._age != null ? a._age : (a.seen_pos ?? 0)), Math.round(a.baro_rate ?? a.geom_rate ?? 0)]);
    const nm = {};
    for (const r of ac) { const c = r[2]; if (c && names[c] && !nm[c]) nm[c] = names[c]; }
    const ages = ac.filter((r) => !r[10]).map((r) => r[11]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const pct = (p) => ages.length ? ages[Math.min(ages.length - 1, Math.floor(p / 100 * (ages.length - 1)))] : null;
    f.age_air = { n: ages.length, p50: pct(50), p90: pct(90), max: ages.length ? ages[ages.length - 1] : null };
    live = { at, fields: live.fields, ac, nm, feed: f, sources: f.sources || [], server_ms: Date.now() };
    liveVer++;
    warmLiveBody();
    const now = Date.now();
    for (const r of live.ac) { const t = trails.get(r[0]) || []; const p = t[t.length - 1]; if (!p || p[1] !== r[5] || p[2] !== r[4]) t.push([now, r[5], r[4], r[6], r[7], r[12], r[10]]); if (t.length > 360) t.shift(); trails.set(r[0], t); }
    for (const [h, t] of trails) if (now - t[t.length - 1][0] > 20 * 60000) trails.delete(h);
    if (!f.loading) { hist.push([at, seen.size, live.ac.length]); if (hist.length > 60) hist.shift(); }
    saveLiveSnapshot();
  } else {
    snapshot = { ...snapshot, error: banner || snapshot.error || "no tiles loaded", feed: f };
    live = { ...live, feed: f };
    liveVer++;
    warmLiveBody();
  }
}
function applyLivePayload(j, source) {
  if (!j || !Array.isArray(j.ac) || !j.ac.length) return false;
  if (!snapshotFresh(j.at, Date.now(), liveFeed.staleMs)) return false;
  const atMs = Date.parse(j.at);
  liveFeed.hydrateFromRows(j.ac, atMs);
  const f = liveFeed.summary();
  f.note = `Warm-started from ${source}. Tiles refresh in the background. Render free disk does not survive deploy/spin-down.`;
  liveFeed.lastFeed = f;
  publishFromSeen(liveFeed.collectAircraft(), f);
  return !!(live.ac && live.ac.length);
}
function loadDiskSnapshot() {
  const j = loadLiveSnapshotFile(fs, LIVE_SNAP_PATH, Date.now(), liveFeed.staleMs);
  if (!j) return false;
  return applyLivePayload(j, "disk snapshot");
}
async function warmStartFromUrl() {
  const base = warmStartUrl(process.env);
  if (!base) return false;
  try {
    const r = await fetch(base + "/api/live", {
      headers: { "User-Agent": UA + " warm-start" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return applyLivePayload(j, "previous instance");
  } catch (e) {
    console.error("warm-start url", e.message);
    return false;
  }
}
async function warmStart() {
  if (loadDiskSnapshot()) {
    console.log("warm-start disk", "n=" + live.ac.length, live.at);
    return "disk";
  }
  if (await warmStartFromUrl()) {
    console.log("warm-start url", "n=" + live.ac.length, live.at);
    return "url";
  }
  return null;
}
async function refresh() {
  if (busy) return; busy = true;
  const t0 = Date.now();
  try {
    const { seen, feed: f } = await liveFeed.refresh(({ seen: s, feed: pf }) => {
      // Mid-refresh progress used to republish (rebuild every row, trails, stats,
      // snapshot JSON) per tile. Publish at most every PROGRESS_PUBLISH_MS.
      if (Date.now() - lastProgressPublish < PROGRESS_PUBLISH_MS) return;
      lastProgressPublish = Date.now();
      publishFromSeen(s, pf);
      const last = (pf.ok && pf.ok[pf.ok.length - 1]) || (pf.stale && pf.stale[0] && pf.stale[0].t) || "";
      console.log("live +", last, "n=" + s.size, "ok=" + pf.n_ok, "pending=" + pf.n_pending);
    });
    publishFromSeen(seen, f);
    const banner = feedBanner(f);
    console.log("refresh", "n=" + seen.size, "ok=" + f.n_ok, "stale=" + f.n_stale, "failed=" + f.n_failed, "pending=" + f.n_pending, "ms=" + (Date.now() - t0), banner || "tiles ok");
  } catch (e) { snapshot.error = e.message; console.error("refresh", e.message); }
  busy = false;
}
function scheduleRefresh() {
  let wait = Math.max(150, liveFeed.nextWaitMs ? liveFeed.nextWaitMs() : 400);
  // Nobody has loaded the dashboard/API recently (only /healthz pings): keep the
  // feed warm but poll tiles far less often, so idle time doesn't burn the CPU cap.
  if (Date.now() - lastClientAt > IDLE_AFTER_MS) wait = Math.max(wait, IDLE_REFRESH_MS);
  setTimeout(() => { refresh().finally(scheduleRefresh); }, wait);
}

const wx = require("./wx");
const zlib = require("zlib");
const send = (res, code, type, body, cache) => {
  const h = { "Content-Type": type, "Cache-Control": cache || "no-store, no-cache, must-revalidate, max-age=0", "Access-Control-Allow-Origin": "*", "Vary": "Accept-Encoding" };
  if (res.req && /gzip/.test(res.req.headers["accept-encoding"] || "") && body && body.length > 2048) { h["Content-Encoding"] = "gzip"; body = zlib.gzipSync(body); }
  res.writeHead(code, h); res.end(body);
};
// Render free tier caps this service at 0.15 CPU. Re-serializing and gzipping
// the multi-MB live snapshot, static JS and history tiles on every request (and
// gunzip -> gzip for the .json.gz tiles) was most of the per-request cost, so
// each body is serialized/compressed once per version and then reused.
const bodyCache = new Map(); // key -> { ver, raw, gz }
function cachedBody(key, ver, make) {
  let e = bodyCache.get(key);
  if (!e || e.ver !== ver) {
    const raw = make();
    e = { ver, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw), gz: null };
    bodyCache.set(key, e);
  }
  return e;
}
function warmLiveBody() {
  try {
    const raw = Buffer.from(JSON.stringify({ ...live, refreshSeconds: REFRESH_MS / 1000 }));
    const e = { ver: liveVer, raw, gz: null };
    bodyCache.set("/api/live", e);
    zlib.gzip(raw, { level: 4 }, (err, gz) => { if (!err && bodyCache.get("/api/live") === e) e.gz = gz; });
  } catch (e) { console.error("warm live body", e.message); }
}
const sendCached = (res, code, type, key, ver, make, cache) => {
  const e = cachedBody(key, ver, make);
  const h = { "Content-Type": type, "Cache-Control": cache || "no-store, no-cache, must-revalidate, max-age=0", "Access-Control-Allow-Origin": "*", "Vary": "Accept-Encoding" };
  let body = e.raw;
  if (res.req && /gzip/.test(res.req.headers["accept-encoding"] || "") && body.length > 2048) {
    if (e.gz) { h["Content-Encoding"] = "gzip"; body = e.gz; }
    else zlib.gzip(body, { level: 4 }, (err, gz) => { if (!err && e.ver === ver) e.gz = gz; });
  }
  res.writeHead(code, h); res.end(body);
};
// Pre-gzipped .json.gz tiles: pass the stored bytes straight through to gzip clients.
const gzFileCache = new Map(); // path -> { gz, raw }
const sendGzFile = (res, fp, cache) => {
  let e = gzFileCache.get(fp);
  if (!e) { e = { gz: fs.readFileSync(fp), raw: null }; if (gzFileCache.size > 400) gzFileCache.clear(); gzFileCache.set(fp, e); }
  const h = { "Content-Type": "application/json", "Cache-Control": cache || "public, max-age=300", "Access-Control-Allow-Origin": "*", "Vary": "Accept-Encoding" };
  if (res.req && /gzip/.test(res.req.headers["accept-encoding"] || "")) { h["Content-Encoding"] = "gzip"; res.writeHead(200, h); return res.end(e.gz); }
  if (!e.raw) e.raw = zlib.gunzipSync(e.gz);
  res.writeHead(200, h); res.end(e.raw);
};
const BOOT_VER = String(Date.now());
const staticFile = (rel) => () => fs.readFileSync(path.join(__dirname, rel));
const JS_CACHE = "public, max-age=60, must-revalidate";
function indexHtml() {
  const html = fs.readFileSync(path.join(__dirname, "public/index.html"), "utf8");
  return html.replace(/src="(\/[^"]+\.js)"/g, `src="$1?v=${BOOT_VER}"`);
}
const server = http.createServer(async (req, res) => {
  const u = req.url.split("?")[0]; const q = new URL(req.url, "http://x").searchParams;
  if (u !== "/healthz") lastClientAt = Date.now();
  if (u === "/api/ground") {
    const id = (q.get("apt") || "").toUpperCase();
    const hub = airports.resolveApt(id);
    if (!hub) return send(res, 400, "application/json", JSON.stringify({ error: "unknown airport", hint: "apt is IATA or ICAO from /api/airports (e.g. LHR or EGLL)" }));
    return ground(hub.id).then((v) => send(res, 200, "application/json", JSON.stringify(v), "public, max-age=30"));
  }
  if (u === "/api/airports") return send(res, 200, "application/json", JSON.stringify({ presets: airports.PRESETS, hubs: airports.HUBS, point_nm: airports.POINT_NM, gnd_nm: airports.GND_NM, auto_zoom: airports.AUTO_ZOOM, auto_nm: airports.AUTO_NM, hist: { n_airports: histIndex.n_airports, n_with_geom: histIndex.n_with_geom, from: histIndex.from, to: histIndex.to, geom_days: histIndex.geom_days }, aip: { n_airports: aipIndex.n_airports, n_draw: aipIndex.n_draw, n_link: aipIndex.n_link, cycle: aipIndex.cycle, airac: aipIndex.airac }, note: "Public ARP coordinates (OurAirports, public domain). Local ADS-B via adsb.lol /v2/point when the map is at a hub. Observed QTR airports from 365-day ADS-B history are merged for zoom-in overlay. SID/STAR geometry only where AIP terms allow (FAA CIFP); otherwise an official AD 2 link." }), "public, max-age=3600");
  if (u === "/api/hist/index") return send(res, 200, "application/json", JSON.stringify(histIndex), "public, max-age=300");
  if (u === "/api/hist") {
    const hub = airports.resolveApt((q.get("apt") || "").toUpperCase());
    if (!hub) return send(res, 400, "application/json", JSON.stringify({ error: "unknown airport" }));
    const fp = path.join(HIST_DIR, hub.id + ".json.gz");
    const meta = (histIndex.airports || []).find((a) => a.id === hub.id) || { id: hub.id };
    if (!fs.existsSync(fp)) {
      return send(res, 200, "application/json", JSON.stringify({
        apt: hub.id, icao: hub.icao, error: "no_geometry",
        h2h_n: meta.h2h_n || 0, h2h_inf: meta.h2h_inf || 0,
        from: histIndex.from, to: histIndex.to, geom_days: histIndex.geom_days || [],
        note: "No terminal-area QTR/UAE traces could be assigned to a runway in the sampled UTC days (no receiver coverage, too few points, or ambiguous runway). 365-day city-pair counts still come from the full aggregate. Observed ADS-B, not published SID/STAR."
      }), "public, max-age=300");
    }
    return sendGzFile(res, fp, "public, max-age=300");
  }
  if (u === "/api/aip/index") return send(res, 200, "application/json", JSON.stringify(aipIndex), "public, max-age=300");
  if (u === "/api/aip") {
    const hub = airports.resolveApt((q.get("apt") || "").toUpperCase());
    if (!hub) return send(res, 400, "application/json", JSON.stringify({ error: "unknown airport" }));
    const meta = aipMeta(hub.id);
    if (!meta) {
      return send(res, 200, "application/json", JSON.stringify({ apt: hub.id, icao: hub.icao, mode: "link", error: "no_aip", note: "No AIP policy row for this airport." }), "public, max-age=300");
    }
    if (meta.tile) {
      const fp = path.join(AIP_DIR, meta.tile);
      if (fs.existsSync(fp)) return sendGzFile(res, fp, "public, max-age=300");
    }
    return send(res, 200, "application/json", JSON.stringify({
      apt: meta.id, icao: meta.icao, iata: meta.iata, name: meta.name, lat: meta.lat, lon: meta.lon,
      mode: meta.mode, state: meta.state, source: meta.aip, source_url: meta.aip_url,
      ad2_url: meta.ad2_url, ad2_label: meta.ad2_label, terms_url: meta.terms_url, terms: meta.terms, why: meta.why,
      n_sid: 0, n_star: 0, n_match: 0, procs: [], match: [],
      ident_mode: meta.ident_mode || "none",
      ident_terms: meta.ident_terms || "",
      ident: { source: null, mode: "none", flights: 0, named: 0, by_rwy: [], rep: [], raw: [], disclaimer: "No licence-safe SID/STAR coding table for this state. Procedure names are not assigned." },
      disclaimer: aipIndex.disclaimer || "Not for navigation. Not for operational flight planning.",
      note: meta.why
    }), "public, max-age=300");
  }
  if (u === "/airports.js") return sendCached(res, 200, "application/javascript; charset=utf-8", u, BOOT_VER, staticFile("public/airports.js"), JS_CACHE);
  if (u === "/api/snapshot") return send(res, 200, "application/json", JSON.stringify(snapshot));
  if (u === "/api/tracks") return sendCached(res, 200, "application/json", u, BOOT_VER, () => tracks, "public, max-age=300");
  if (u === "/api/trails") { const o = {}; for (const [h, t] of trails) o[h] = t.slice(-12).map((p) => [p[1], p[2]]); return send(res, 200, "application/json", JSON.stringify(o)); }
  if (u === "/api/track") { const h = (q.get("hex") || "").toLowerCase(); return send(res, 200, "application/json", JSON.stringify({ hex: h, fields: ["t_ms", "lon", "lat", "alt_ft", "gs_kt", "vrate_fpm", "on_ground"], note: "Positions collected by this server every refresh since it last restarted (max ~3 h). on_ground is 1 when the ADS-B snapshot reported ground. First stored point is when this server began tracking the hex, not a departure time.", points: trails.get(h) || [] })); }
  if (u === "/api/coverage") return send(res, 200, "application/json", JSON.stringify({ cell_deg: 2, window_h: 24, since_utc: new Date(T0).toISOString(), note: "2-degree cells where at least one airliner position was received in the last 24 h (accumulated since server start, UTC). Estimated from observed traffic, not an official receiver map. Areas outside = no receiver data in the window.", cells: [...cov.keys()].map((k) => k.split(",").map(Number)) }));
  if (u === "/api/route") {
    const cs = (q.get("cs") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!cs) return send(res, 400, "application/json", "{}");
    return send(res, 200, "application/json", JSON.stringify(await adsbdb(cs)));
  }
  if (u === "/api/csroute") return sendCached(res, 200, "application/json", u, BOOT_VER, () => csroute, "public, max-age=300");
  if (u === "/api/traced") return sendCached(res, 200, "application/json", u, BOOT_VER, () => JSON.stringify(traced));
  if (u === "/api/fin") return sendCached(res, 200, "application/json", u, BOOT_VER, () => fin, "public, max-age=300");
  if (u === "/api/fin.csv") { res.setHeader("Content-Disposition", "attachment; filename=qtr_uae_monthly_metrics.csv"); return send(res, 200, "text/csv", finCsv, "public, max-age=300"); }
  if (u === "/api/h2h") return sendCached(res, 200, "application/json", u, BOOT_VER, () => h2h, "public, max-age=300");
  if (u === "/api/global") return sendCached(res, 200, "application/json", u, BOOT_VER, () => globalAgg, "public, max-age=300");
  if (u === "/api/wx/hazards") return send(res, 200, "application/json", JSON.stringify(await wx.hazards()), "public, max-age=60");
  if (u === "/api/wx/stations") return send(res, 200, "application/json", JSON.stringify(await wx.stations(q.get("ids") || "")), "public, max-age=60");
  if (u === "/api/wx/winds") return send(res, 200, "application/json", JSON.stringify(await wx.winds()), "public, max-age=120");
  if (u === "/api/live") return sendCached(res, 200, "application/json", u, liveVer, () => JSON.stringify({ ...live, refreshSeconds: REFRESH_MS / 1000 }), "public, max-age=3");
  if (u === "/api/livehist") return sendCached(res, 200, "application/json", u, liveVer, () => JSON.stringify(hist), "public, max-age=5");
  if (u === "/api/live/view") {
    const west = q.get("west"), south = q.get("south"), east = q.get("east"), north = q.get("north");
    const w = +west, s = +south, e = +east, n = +north;
    if (![w, s, e, n].every(Number.isFinite)) return send(res, 400, "application/json", JSON.stringify({ error: "west,south,east,north required" }));
    const lat = (s + n) / 2;
    let lon = (w + e) / 2;
    if (e < w) lon = ((w + e + 360) / 2);
    if (lon > 180) lon -= 360;
    liveFeed.noteViewport(lat, lon);
    const ac = filterAcBbox(live.ac || [], w, s, e, n);
    return send(res, 200, "application/json", JSON.stringify({
      at: live.at, fields: live.fields, ac, n: ac.length, feed: live.feed, sources: live.sources || [],
      note: "Filtered from the server live snapshot. Does not issue an upstream request. At most one already-scheduled tile is boosted every 20 s. Times UTC."
    }), "public, max-age=5");
  }
  if (u === "/api/feed") return send(res, 200, "application/json", JSON.stringify(liveFeed.summary()));
  if (u === "/api/map") return sendCached(res, 200, "application/json", u, BOOT_VER, () => JSON.stringify(map));
  if (u === "/healthz") return send(res, 200, "text/plain", "ok");
  if (u === "/aip-ident.js") return sendCached(res, 200, "application/javascript; charset=utf-8", u, BOOT_VER, staticFile("public/aip-ident.js"), JS_CACHE);
  if (u === "/motion.js") return sendCached(res, 200, "application/javascript; charset=utf-8", u, BOOT_VER, staticFile("public/motion.js"), JS_CACHE);
  if (u === "/map.js") return sendCached(res, 200, "application/javascript; charset=utf-8", u, BOOT_VER, staticFile("public/map.js"), JS_CACHE);
  if (u === "/route-plaus.js") return sendCached(res, 200, "application/javascript; charset=utf-8", u, BOOT_VER, staticFile("public/route-plaus.js"), JS_CACHE);
  if (u === "/flightno.js") return sendCached(res, 200, "application/javascript; charset=utf-8", u, BOOT_VER, staticFile("public/flightno.js"), JS_CACHE);
  if (u === "/" || u === "/index.html") return sendCached(res, 200, "text/html; charset=utf-8", "/", BOOT_VER, indexHtml, "no-store, no-cache, must-revalidate, max-age=0");
  send(res, 404, "text/plain", "not found");
});
async function boot() {
  try { await warmStart(); } catch (e) { console.error("warm-start", e.message); }
  server.listen(PORT, "0.0.0.0", () => console.log(`listening on ${PORT}`));
  refresh().finally(scheduleRefresh);
}
boot();
