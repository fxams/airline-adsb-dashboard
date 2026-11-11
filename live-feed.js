// Live ADS-B: tiled 250 nm point queries across free providers, not a per-type loop.
// Verified 2026-11-10 UTC:
//   adsb.lol /v2/point/{lat}/{lon}/{r} — public, ODbL, radius capped at 250 nm in their API
//     (github.com/adsblol/api api_v2.py). Rate limits are dynamic; 429s were common on /v2/type.
//   adsb.fi /api/v3/lat/{lat}/lon/{lon}/dist/{r} — public, 1 req/s, max 250 NM, personal
//     non-commercial, must cite https://adsb.fi (github.com/adsbfi/opendata).
//   airplanes.live /v2/point/{lat}/{lon}/{r} — documented 1 req/s and 250 nm, but this host
//     received HTTP 403 (feeder-IP / contact-first). Kept as a circuit-broken failover.

const UA = "airline-adsb-dashboard (github.com/fxams/airline-adsb-dashboard)";
const TYPE_URL = (t) => `https://api.adsb.lol/v2/type/${encodeURIComponent(t)}`;
const MAX_RADIUS_NM = 250;
const R_EARTH_NM = 3440.065;

const DEFAULT_TYPES = "A35K,A359,A388,B77W,B77L,B772,B789,B788,B78X,A333,A332,A339,A338,A343,A346,A306,B764,B763,B744,B748,MD11,A21N,A20N,A321,A320,A319,A318,BCS3,BCS1,B38M,B39M,B3XM,B738,B739,B737,B753,B752,E195,E190,E290,E295,E75S,E75L,E170,CRJ9,CRJ7,CRJX,AT76,AT75,DH8D,B712,C919";

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

const DUE_MS = { hot: 12000, hub: 50000, corridor: 90000, global: 180000 };

const PROVIDERS = [
  {
    id: "lol",
    name: "adsb.lol",
    home: "https://www.adsb.lol",
    license: "ODbL 1.0",
    minIntervalMs: 1500,
    circuit403Ms: 5 * 60e3,
    url: (lat, lon, r) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`
  },
  {
    id: "fi",
    name: "adsb.fi",
    home: "https://adsb.fi",
    license: "personal non-commercial; attribution required",
    minIntervalMs: 1100,
    circuit403Ms: 5 * 60e3,
    url: (lat, lon, r) => `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${r}`
  },
  {
    id: "apl",
    name: "airplanes.live",
    home: "https://airplanes.live",
    license: "community ADS-B; contact required when 403",
    minIntervalMs: 1100,
    circuit403Ms: 15 * 60e3,
    url: (lat, lon, r) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`
  }
];

const HOT_TILES = [
  { id: "doh", lat: 25.2731, lon: 51.6081, r: 250, pri: "hot" },
  { id: "dxb", lat: 25.2528, lon: 55.3644, r: 250, pri: "hot" },
  { id: "lhr", lat: 51.4706, lon: -0.46194, r: 250, pri: "hot" },
  { id: "jfk", lat: 40.6399, lon: -73.7787, r: 250, pri: "hot" },
  { id: "fra", lat: 50.0379, lon: 8.5622, r: 250, pri: "hot" },
  { id: "sin", lat: 1.35019, lon: 103.994, r: 250, pri: "hot" }
];

const CORRIDOR_TILES = [
  { id: "nat-e", lat: 51, lon: -20, r: 250 },
  { id: "nat-m", lat: 48, lon: -40, r: 250 },
  { id: "nat-w", lat: 45, lon: -58, r: 250 },
  { id: "pac-e", lat: 35, lon: -150, r: 250 },
  { id: "pac-m", lat: 32, lon: 180, r: 250 },
  { id: "pac-w", lat: 25, lon: 155, r: 250 },
  { id: "sib", lat: 55, lon: 70, r: 250 },
  { id: "caf", lat: 5, lon: 20, r: 250 },
  { id: "saf", lat: -15, lon: 25, r: 250 },
  { id: "sam-e", lat: -23, lon: -46, r: 250 },
  { id: "sam-w", lat: -33, lon: -71, r: 250 },
  { id: "ind", lat: 10, lon: 75, r: 250 },
  { id: "chn", lat: 31, lon: 121, r: 250 },
  { id: "sea", lat: 4, lon: 114, r: 250 }
];

// Sparse remainder, not an 8° mesh (that was ~540 tiles and would recreate the 429 loop).
const GLOBAL_TILES = [
  { id: "g-ncan", lat: 53, lon: -100, r: 250 },
  { id: "g-alaska", lat: 61, lon: -150, r: 250 },
  { id: "g-mex", lat: 20, lon: -100, r: 250 },
  { id: "g-carib", lat: 15, lon: -70, r: 250 },
  { id: "g-satl", lat: -10, lon: -20, r: 250 },
  { id: "g-waf", lat: 8, lon: -5, r: 250 },
  { id: "g-eaf", lat: 0, lon: 38, r: 250 },
  { id: "g-cas", lat: 45, lon: 65, r: 250 },
  { id: "g-chnw", lat: 36, lon: 103, r: 250 },
  { id: "g-indoc", lat: -8, lon: 115, r: 250 },
  { id: "g-tas", lat: -40, lon: 145, r: 250 },
  { id: "g-sio", lat: -30, lon: 70, r: 250 },
  { id: "g-npac", lat: 50, lon: 170, r: 250 },
  { id: "g-rus", lat: 60, lon: 100, r: 250 },
  { id: "g-arg", lat: -35, lon: -60, r: 250 },
  { id: "g-indn", lat: 20, lon: 78, r: 250 }
];

function parseTypes(s) {
  const raw = String(s == null || s === "" ? DEFAULT_TYPES : s);
  return [...new Set(raw.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))];
}

function parseRetryAfter(h, now) {
  if (h == null || h === "") return null;
  const s = String(h).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(60_000, Math.max(0, Number(s) * 1000));
  const ms = Date.parse(s) - (now || Date.now());
  if (Number.isFinite(ms)) return Math.min(60_000, Math.max(0, ms));
  return null;
}

function backoffMs(attempt, retryAfterMs, base, cap, rnd) {
  const b = base == null ? 1500 : base;
  const c = cap == null ? 20000 : cap;
  if (retryAfterMs != null && Number.isFinite(retryAfterMs)) return Math.min(c, Math.max(400, retryAfterMs));
  const exp = Math.min(c, b * (2 ** Math.max(0, attempt)));
  const jitter = Math.round(exp * 0.15 * (typeof rnd === "function" ? rnd() : Math.random()));
  return Math.min(c, exp + jitter);
}

function headerGet(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function hv(lat1, lon1, lat2, lon2) {
  const d2r = Math.PI / 180;
  const x = Math.sin((lat2 - lat1) * d2r / 2) ** 2 + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin((lon2 - lon1) * d2r / 2) ** 2;
  return 2 * R_EARTH_NM * Math.asin(Math.sqrt(Math.min(1, x)));
}

function seenPosS(a) {
  if (!a) return 99;
  const v = a.seen_pos;
  if (v == null || !Number.isFinite(+v)) return 99;
  return Math.max(0, +v);
}

function posTimeMs(fetchedTs, seenPos) {
  const sp = seenPos == null || !Number.isFinite(+seenPos) ? 99 : Math.max(0, +seenPos);
  return fetchedTs - sp * 1000;
}

function alongNm(lat0, lon0, lat1, lon1, trk) {
  const nm = hv(lat0, lon0, lat1, lon1);
  if (!(nm > 0) || trk == null || !Number.isFinite(+trk)) return 0;
  const dLat = lat1 - lat0;
  const dLon = (lon1 - lon0) * Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
  const brg = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
  const d = ((((brg - +trk) % 360) + 540) % 360) - 180;
  return nm * Math.cos(d * Math.PI / 180);
}

function pickFresher(prev, incoming) {
  if (!prev) return incoming;
  if (!incoming) return prev;
  const dt = incoming._posTime - prev._posTime;
  if (dt < -80) return prev;
  if (dt <= 80) {
    const prevGs = prev.gs > 0.5, incGs = incoming.gs > 0.5;
    if (!prevGs && incGs) return incoming;
    return prev;
  }
  if (typeof prev.lat === "number" && typeof incoming.lat === "number" && Number.isFinite(+prev.track)) {
    const along = alongNm(prev.lat, prev.lon, incoming.lat, incoming.lon, prev.track);
    if (along < -0.2 && dt < 60000) return prev;
  }
  const gs = incoming.gs > 0.5 ? incoming.gs : prev.gs;
  const track = Number.isFinite(+incoming.track) ? incoming.track : prev.track;
  const true_heading = incoming.true_heading != null ? incoming.true_heading : prev.true_heading;
  return { ...incoming, gs, track, true_heading };
}

function parseAc(j) {
  if (!j || typeof j !== "object") return [];
  const ac = j.ac || j.aircraft;
  return Array.isArray(ac) ? ac : [];
}

function generateTiles(hubs, opts) {
  const o = opts || {};
  const globalDue = o.globalDueMs == null ? DUE_MS.global : o.globalDueMs;
  const tiles = [];
  const placed = [];
  const add = (t) => {
    const r = Math.min(MAX_RADIUS_NM, Math.max(1, +t.r || MAX_RADIUS_NM));
    const pri = t.pri || "global";
    const dueMs = t.dueMs || DUE_MS[pri] || globalDue;
    const tile = { id: String(t.id), lat: +t.lat, lon: +t.lon, r, pri, dueMs, rank: tiles.length };
    tiles.push(tile);
    placed.push(tile);
    return tile;
  };
  if (Array.isArray(o.tiles) && o.tiles.length) {
    for (const t of o.tiles) add(t);
    return tiles;
  }
  for (const t of HOT_TILES) add({ ...t, pri: "hot" });
  const maxHub = o.maxHubTiles == null ? 36 : o.maxHubTiles;
  for (const h of hubs || []) {
    if (h == null || typeof h.lat !== "number" || typeof h.lon !== "number") continue;
    if (placed.some((s) => hv(s.lat, s.lon, h.lat, h.lon) < 180)) continue;
    if (tiles.filter((t) => t.pri === "hub").length >= maxHub) break;
    add({ id: "hub-" + String(h.id || h.icao || tiles.length).toLowerCase(), lat: h.lat, lon: h.lon, r: 250, pri: "hub" });
  }
  for (const t of CORRIDOR_TILES) {
    if (placed.some((s) => hv(s.lat, s.lon, t.lat, t.lon) < 200)) continue;
    add({ ...t, pri: "corridor" });
  }
  if (o.globalFill !== false) {
    const due = Math.max(globalDue, DUE_MS.global);
    for (const t of GLOBAL_TILES) {
      if (placed.some((s) => hv(s.lat, s.lon, t.lat, t.lon) < 280)) continue;
      add({ ...t, pri: "global", dueMs: due });
    }
  }
  return tiles;
}

function feedBanner(feed) {
  if (!feed) return "";
  const fail = feed.failed || [];
  const stale = feed.stale || [];
  const kind = feed.kind === "type" ? "type group" : "tile";
  if (fail.length) {
    const names = fail.map((x) => x.t || x).slice(0, 8).join(", ");
    return `${fail.length} ${kind}${fail.length === 1 ? "" : "s"} unavailable (${names}${fail.length > 8 ? "…" : ""})`;
  }
  if (stale.length) {
    const names = stale.map((x) => x.t || x).slice(0, 6).join(", ");
    return `${stale.length} ${kind}${stale.length === 1 ? "" : "s"} stale (${names}${stale.length > 6 ? "…" : ""})`;
  }
  return "";
}

function errText(e) {
  if (!e) return "unknown";
  if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
  return String(e.message || e);
}

function sourceList(providers) {
  return (providers || PROVIDERS).map((p) => ({
    id: p.id, name: p.name, home: p.home, license: p.license
  }));
}

class ProviderState {
  constructor(spec) {
    this.id = spec.id;
    this.name = spec.name;
    this.home = spec.home;
    this.license = spec.license;
    this.minIntervalMs = spec.minIntervalMs;
    this.circuit403Ms = spec.circuit403Ms || 5 * 60e3;
    this.url = spec.url;
    this.nextAt = 0;
    this.openUntil = 0;
    this.consecutive = 0;
    this.recent = [];
    this.stats = { req: 0, ok: 0, r429: 0, r403: 0, r5xx: 0, lastMs: 0, lastErr: null };
  }
  ready(now) { return now >= this.nextAt && now >= this.openUntil; }
  waitMs(now) { return Math.max(0, Math.max(this.nextAt, this.openUntil) - now); }
  rpm(now) {
    const cut = now - 60e3;
    this.recent = this.recent.filter((t) => t >= cut);
    return this.recent.length;
  }
  stamp(now) {
    this.recent.push(now);
    this.rpm(now);
  }
}

class LiveFeed {
  constructor(opts) {
    const o = opts || {};
    this.types = parseTypes(Array.isArray(o.types) ? o.types.join(",") : o.types);
    this.fetchImpl = o.fetchImpl || fetch;
    this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now || (() => Date.now());
    this.timeoutMs = o.timeoutMs == null ? 12000 : o.timeoutMs;
    this.staleMs = o.staleMs == null ? 20 * 60e3 : o.staleMs;
    this.attempts = o.attempts == null ? 4 : o.attempts;
    this.baseBackoffMs = o.baseBackoffMs == null ? 1500 : o.baseBackoffMs;
    this.random = o.random || Math.random;
    this.tickMs = o.tickMs == null ? 8000 : o.tickMs;
    this.globalDueMs = o.globalDueMs == null ? DUE_MS.global : o.globalDueMs;
    this.onProgress = o.onProgress || null;
    this.baseGapMs = o.gapMs == null ? 400 : o.gapMs;
    this.gapMs = this.baseGapMs;
    this.lastT = new Map();
    this.cooldownUntil = 0;
    this.lastCycleMs = 0;
    this.viewBoostUntil = 0;
    this.viewBoostId = "";
    this.viewHits = [];
    this.heldBest = new Map();
    const specs = Array.isArray(o.providers) && o.providers.length
      ? o.providers
      : PROVIDERS;
    this.providers = specs.map((p) => (p instanceof ProviderState ? p : new ProviderState({ ...PROVIDERS.find((x) => x.id === p.id) || PROVIDERS[0], ...p })));
    let hubs = o.hubs;
    if (!hubs) {
      try { hubs = require("./public/airports.js").HUBS; } catch (_) { hubs = []; }
    }
    this.tiles = generateTiles(hubs, { tiles: o.tiles, globalDueMs: this.globalDueMs, globalFill: o.globalFill });
    this.lastFeed = this._emptyFeed(null, 0);
  }

  _emptyFeed(at, cycleMs) {
    return {
      at,
      cycle_ms: cycleMs,
      kind: "tile",
      ok: [],
      stale: [],
      failed: [],
      pending: [],
      n_ok: 0,
      n_stale: 0,
      n_failed: 0,
      n_pending: 0,
      n_tiles: this.tiles.length,
      n_types: this.tiles.length,
      loading: true,
      providers: this._providerStats(),
      sources: sourceList(this.providers),
      note: "Live positions from free 250 nm point queries (adsb.lol /v2/point, adsb.fi /api/v3 lat/lon/dist; airplanes.live /v2/point is a failover). Doha / Gulf / busy hubs refresh first; a slower sweep covers the rest. Each tile is published as it arrives. pos_age is seen_pos plus seconds since that tile was fetched. Last good sample is kept up to 20 min. Not a paid ADS-B product."
    };
  }

  summary() {
    return this.lastFeed;
  }

  _providerStats() {
    const now = this.now();
    const out = {};
    for (const p of this.providers) {
      out[p.id] = {
        name: p.name,
        home: p.home,
        req: p.stats.req,
        ok: p.stats.ok,
        r429: p.stats.r429,
        r403: p.stats.r403,
        r5xx: p.stats.r5xx,
        rpm: p.rpm(now),
        open: now < p.openUntil,
        open_s: now < p.openUntil ? Math.round((p.openUntil - now) / 1000) : 0,
        last_err: p.stats.lastErr,
        last_ms: p.stats.lastMs
      };
    }
    return out;
  }

  nextWaitMs() {
    const now = this.now();
    const tile = this._nextTile(true);
    let wait = 1500;
    if (tile) {
      const o = this.lastT.get(tile.id);
      const age = o ? now - o.ts : 1e12;
      wait = Math.max(0, tile.dueMs - age);
    }
    const pWait = Math.min(...this.providers.map((p) => p.waitMs(now)));
    return Math.max(150, Math.min(2000, Math.max(wait, pWait)));
  }

  noteViewport(lat, lon) {
    const now = this.now();
    this.viewHits = this.viewHits.filter((t) => now - t < 20000);
    if (this.viewHits.length) return false;
    if (typeof lat !== "number" || typeof lon !== "number") return false;
    let best = null, bestD = 1e9;
    for (const t of this.tiles) {
      const d = hv(t.lat, t.lon, lat, lon);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (!best || bestD > 400) return false;
    this.viewHits.push(now);
    this.viewBoostId = best.id;
    this.viewBoostUntil = now + Math.min(best.dueMs, 20000);
    return true;
  }

  _nextTile(includeSoon) {
    const now = this.now();
    let best = null, bestS = -1;
    for (const t of this.tiles) {
      const o = this.lastT.get(t.id);
      const never = !o;
      const age = never ? 1e12 : now - o.ts;
      let due = t.dueMs;
      if (t.id === this.viewBoostId && now < this.viewBoostUntil) due = Math.min(due, 8000);
      const s = never ? (10000 - t.rank) : age / due;
      if (!includeSoon && !never && s < 1) continue;
      if (s > bestS) { best = t; bestS = s; }
    }
    return best;
  }

  _providerOrder(tile) {
    const n = this.providers.length;
    const start = n ? Math.abs(hashId(tile.id)) % n : 0;
    const now = this.now();
    const ordered = [];
    for (let i = 0; i < n; i++) ordered.push(this.providers[(start + i) % n]);
    ordered.sort((a, b) => {
      const ar = a.ready(now) ? 0 : 1, br = b.ready(now) ? 0 : 1;
      if (ar !== br) return ar - br;
      const ao = now < a.openUntil ? 1 : 0, bo = now < b.openUntil ? 1 : 0;
      if (ao !== bo) return ao - bo;
      return a.waitMs(now) - b.waitMs(now);
    });
    return ordered;
  }

  async _waitCooldown() {
    const wait = this.cooldownUntil - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  _setCooldown(ms) {
    const until = this.now() + Math.max(0, ms);
    if (until > this.cooldownUntil) this.cooldownUntil = until;
  }

  async _getProvider(p, lat, lon, r) {
    const now0 = this.now();
    const wait = p.waitMs(now0);
    if (wait > 0) await this.sleep(wait);
    p.stamp(this.now());
    p.stats.req++;
    const radius = Math.min(MAX_RADIUS_NM, Math.max(1, Math.round(r)));
    const url = p.url(+lat, +lon, radius);
    const t0 = this.now();
    let res;
    try {
      res = await this.fetchImpl(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (e) {
      p.consecutive++;
      const waitMs = backoffMs(p.consecutive, null, this.baseBackoffMs, 20000, this.random);
      p.nextAt = this.now() + waitMs;
      const err = new Error(`${p.id} ${errText(e)}`);
      err.status = 0; err.retryable = true; err.provider = p.id;
      p.stats.lastErr = err.message;
      p.stats.lastMs = this.now() - t0;
      throw err;
    }
    p.stats.lastMs = this.now() - t0;
    const ra = parseRetryAfter(headerGet(res.headers, "retry-after"), this.now());
    if (res.status === 429) {
      p.stats.r429++;
      p.consecutive++;
      const waitMs = backoffMs(p.consecutive, ra, this.baseBackoffMs, 20000, this.random);
      p.nextAt = this.now() + waitMs;
      p.openUntil = Math.max(p.openUntil, p.nextAt);
      this._setCooldown(Math.min(waitMs, 4000));
      const err = new Error(`${p.id} 429`);
      err.status = 429; err.retryable = true; err.retryAfterMs = waitMs; err.provider = p.id;
      p.stats.lastErr = err.message;
      throw err;
    }
    if (res.status === 403) {
      p.stats.r403++;
      p.consecutive++;
      p.openUntil = this.now() + p.circuit403Ms;
      p.nextAt = this.now() + p.minIntervalMs;
      const err = new Error(`${p.id} 403`);
      err.status = 403; err.retryable = true; err.provider = p.id;
      p.stats.lastErr = err.message;
      throw err;
    }
    if (!res.ok) {
      if (res.status >= 500) p.stats.r5xx++;
      p.consecutive++;
      const retryable = RETRYABLE.has(res.status);
      if (retryable) {
        const waitMs = backoffMs(p.consecutive, ra, this.baseBackoffMs, 20000, this.random);
        p.nextAt = this.now() + waitMs;
      } else {
        p.nextAt = this.now() + p.minIntervalMs;
      }
      const err = new Error(`${p.id} ${res.status}`);
      err.status = res.status; err.retryable = retryable; err.provider = p.id;
      p.stats.lastErr = err.message;
      throw err;
    }
    p.consecutive = 0;
    p.nextAt = this.now() + p.minIntervalMs;
    p.stats.ok++;
    p.stats.lastErr = null;
    const j = await res.json();
    return parseAc(j);
  }

  async fetchTile(tile) {
    const order = this._providerOrder(tile).filter((p) => !(this.now() < p.openUntil && p.openUntil - this.now() > 8000));
    if (!order.length) return { t: tile.id, ac: null, err: "all providers cooling", provider: null, skipped: true };
    let lastErr = null;
    for (const p of order) {
      try {
        const ac = await this._getProvider(p, tile.lat, tile.lon, tile.r);
        return { t: tile.id, ac, err: null, provider: p.id };
      } catch (e) {
        lastErr = e;
        if (e && e.status === 404) break;
        if (e && e.retryable === false && e.status && e.status < 500) continue;
      }
    }
    return { t: tile.id, ac: null, err: errText(lastErr), provider: lastErr && lastErr.provider };
  }

  async fetchPoint(lat, lon, r) {
    const tile = { id: "point", lat, lon, r: Math.min(MAX_RADIUS_NM, r || 40), pri: "hot", dueMs: 1, rank: 0 };
    return this.fetchTile(tile);
  }

  applyResult(t, result) {
    const now = this.now();
    if (result.ac) {
      this.lastT.set(t, { ts: now, ac: result.ac, err: null, provider: result.provider || null });
      return { t, status: "ok", n: result.ac.length, err: null, age_s: 0, last_ok_utc: new Date(now).toISOString(), provider: result.provider || null };
    }
    if (!this.lastT.has(t)) this.lastT.set(t, { ts: now, ac: [], err: result.err, provider: result.provider || null });
    const o = this.lastT.get(t);
    const lastOk = o ? new Date(o.ts).toISOString() : null;
    if (o && now - o.ts < this.staleMs) {
      return { t, status: "stale", n: o.ac.length, err: result.err, age_s: Math.round((now - o.ts) / 1000), last_ok_utc: lastOk, provider: o.provider || null };
    }
    return { t, status: "failed", n: 0, err: result.err, age_s: o ? Math.round((now - o.ts) / 1000) : null, last_ok_utc: lastOk, provider: result.provider || null };
  }

  _pack(cycleMs, pendingIds) {
    const now = this.now();
    const ok = [], stale = [], failed = [];
    const pend = [];
    for (const tile of this.tiles) {
      const o = this.lastT.get(tile.id);
      if (!o) { pend.push(tile.id); continue; }
      const age = now - o.ts;
      if (o.err && !(o.ac && o.ac.length)) failed.push({ t: tile.id, err: o.err, last_ok_utc: null });
      else if (age > tile.dueMs * 4 && age < this.staleMs) stale.push({ t: tile.id, age_s: Math.round(age / 1000), err: o.err, last_ok_utc: new Date(o.ts).toISOString() });
      else ok.push(tile.id);
    }
    const pending = Array.isArray(pendingIds) ? pendingIds.slice() : pend;
    return {
      at: new Date(now).toISOString(),
      cycle_ms: cycleMs,
      kind: "tile",
      ok,
      stale,
      failed,
      pending,
      n_ok: ok.length,
      n_stale: stale.length,
      n_failed: failed.length,
      n_pending: pending.length,
      n_tiles: this.tiles.length,
      n_types: this.tiles.length,
      loading: pending.length > 0 && ok.length + stale.length < this.tiles.length,
      providers: this._providerStats(),
      sources: sourceList(this.providers),
      note: this._emptyFeed(null, 0).note
    };
  }

  hydrateFromRows(rows, atMs) {
    const ts = Number.isFinite(atMs) ? atMs : this.now();
    const ac = [];
    for (const r of rows || []) {
      if (!r || !r[0]) continue;
      ac.push({
        hex: r[0],
        flight: r[1] || "",
        t: String(r[3] || "").trim().toUpperCase(),
        lat: r[4],
        lon: r[5],
        alt_baro: r[10] ? "ground" : r[6],
        gs: r[7],
        track: r[8],
        r: r[9] || "",
        seen_pos: r[11] ?? 0,
        baro_rate: r[12] ?? 0
      });
    }
    this.lastT.set("_warm", { ts, ac, err: null, provider: "warm" });
    this.heldBest.clear();
    const ok = this.tiles.filter((t) => this.lastT.has(t.id)).map((t) => t.id);
    if (!ok.includes("_warm")) ok.unshift("_warm");
    this.lastFeed = {
      ...this._emptyFeed(new Date(ts).toISOString(), 0),
      at: new Date(ts).toISOString(),
      ok,
      n_ok: ok.length,
      pending: this.tiles.map((t) => t.id),
      n_pending: this.tiles.length,
      loading: true,
      note: "Warm-started from last-good snapshot. Tiles refresh in the background."
    };
    return this.collectAircraft();
  }

  _emit(t0, pending, onProgress) {
    this.lastCycleMs = this.now() - t0;
    this.lastFeed = this._pack(this.lastCycleMs, pending);
    const seen = this.collectAircraft();
    const cb = onProgress || this.onProgress;
    if (cb) {
      try { cb({ seen, feed: this.lastFeed, partial: pending && pending.length > 0 }); }
      catch (e) { console.error("live progress", e && e.message); }
    }
    return seen;
  }

  collectAircraft() {
    const seen = new Map();
    const now = this.now();
    for (const [, o] of this.lastT) {
      if (!o || !o.ac) continue;
      if (now - o.ts >= this.staleMs) continue;
      for (const a of o.ac) {
        if (!a || !a.hex) continue;
        const pt = posTimeMs(o.ts, seenPosS(a));
        const age = Math.max(0, (now - pt) / 1000);
        const cand = { ...a, _age: age, _fetched: o.ts, _posTime: pt, _src: o.provider || null };
        seen.set(a.hex, pickFresher(seen.get(a.hex), cand));
      }
    }
    for (const [hex, p] of seen) {
      const held = this.heldBest.get(hex);
      const keep = pickFresher(held, p);
      const age = Math.max(0, (now - keep._posTime) / 1000);
      seen.set(hex, { ...keep, _age: age });
      this.heldBest.set(hex, seen.get(hex));
    }
    for (const [hex, h] of this.heldBest) {
      if (now - (h._posTime || 0) >= this.staleMs) this.heldBest.delete(hex);
    }
    return seen;
  }

  async refresh(onProgress) {
    const t0 = this.now();
    const deadline = t0 + this.tickMs;
    const fetched = [];
    while (this.now() < deadline) {
      const tile = this._nextTile(false) || (this.lastT.size === 0 || [...this.tiles].some((t) => !this.lastT.has(t.id)) ? this._nextTile(true) : null);
      if (!tile) break;
      const o = this.lastT.get(tile.id);
      if (o && this.now() - o.ts < tile.dueMs * 0.6 && fetched.length) break;
      const raw = await this.fetchTile(tile);
      if (raw.skipped) break;
      const result = this.applyResult(tile.id, raw);
      fetched.push(result);
      const pending = this.tiles.filter((t) => !this.lastT.has(t.id)).map((t) => t.id);
      this._emit(t0, pending, onProgress);
    }
    const seen = this._emit(t0, this.tiles.filter((t) => !this.lastT.has(t.id)).map((t) => t.id), onProgress);
    if (this.lastFeed.failed.length) {
      console.error("tiles failed", this.lastFeed.failed.map((x) => `${x.t}:${x.err}`).join("; "));
    }
    return { seen, feed: this.lastFeed, groups: fetched };
  }
}

function hashId(s) {
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return h;
}

function snapshotFresh(at, now, maxMs) {
  const t = Date.parse(at);
  const n = now == null ? Date.now() : now;
  const max = maxMs == null ? 20 * 60e3 : maxMs;
  return Number.isFinite(t) && n - t >= 0 && n - t < max;
}

function warmStartUrl(env) {
  const e = env || process.env;
  if (String(e.LIVE_WARM || "") === "0") return "";
  const u = String(e.LIVE_WARM_URL || e.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  if (!u || /localhost|127\.0\.0\.1/i.test(u)) return "";
  return u;
}

function loadLiveSnapshotFile(fsImpl, filePath, now, staleMs) {
  try {
    const j = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    if (!snapshotFresh(j && j.at, now, staleMs)) return null;
    if (!Array.isArray(j.ac) || !j.ac.length) return null;
    return j;
  } catch (_) {
    return null;
  }
}

function filterAcBbox(ac, west, south, east, north) {
  const w = +west, s = +south, e = +east, n = +north;
  if (![w, s, e, n].every(Number.isFinite)) return [];
  const wrap = e < w;
  return (ac || []).filter((r) => {
    const lat = r[4], lon = r[5];
    if (typeof lat !== "number" || typeof lon !== "number") return false;
    if (lat < s || lat > n) return false;
    if (!wrap) return lon >= w && lon <= e;
    return lon >= w || lon <= e;
  });
}

module.exports = {
  LiveFeed,
  parseTypes,
  parseRetryAfter,
  backoffMs,
  feedBanner,
  snapshotFresh,
  warmStartUrl,
  loadLiveSnapshotFile,
  generateTiles,
  hv,
  alongNm,
  posTimeMs,
  seenPosS,
  pickFresher,
  parseAc,
  filterAcBbox,
  sourceList,
  DEFAULT_TYPES,
  TYPE_URL,
  UA,
  RETRYABLE,
  PROVIDERS,
  HOT_TILES,
  CORRIDOR_TILES,
  GLOBAL_TILES,
  MAX_RADIUS_NM,
  DUE_MS
};
