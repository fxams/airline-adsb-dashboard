// Per-aircraft dead reckoning between live ADS-B snapshots. Not a tracker.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof root === "object" && root) root.LiveMotion = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const R2 = Math.PI / 180;
  const BLEND_MS = 1600;
  // Match live-feed last-good window (~20 min). Do not freeze at 60 s: tile lag
  // can still be tens of seconds, while packed seen_pos stays ~0–1 s.
  const STALE_S = 1200;
  const MAX_EXTRAP_S = 900;
  const MAX_EXTRAP_NM = 120;
  const LOW_ALT_FT = 1000;

  function wrapLon(lo) {
    if (lo > 180) lo -= 360;
    else if (lo < -180) lo += 360;
    return lo;
  }
  function lerp(a, b, u) {
    return a + (b - a) * u;
  }
  function lerpLon(a, b, u) {
    const d = ((((+b - +a) % 360) + 540) % 360) - 180;
    return wrapLon(+a + d * u);
  }
  function lerpAng(a, b, u) {
    if (a == null || b == null || !Number.isFinite(+a) || !Number.isFinite(+b)) return b;
    const d = ((((+b - +a) % 360) + 540) % 360) - 180;
    return (((+a + d * u) % 360) + 360) % 360;
  }
  function ease(u) {
    if (!(u > 0)) return 0;
    if (u >= 1) return 1;
    return u * u * (3 - 2 * u);
  }
  function dest(lat, lon, gs, trk, dt) {
    if (!(dt > 0) || !(gs > 0.5) || trk == null || !Number.isFinite(+trk) || !Number.isFinite(+lat) || !Number.isFinite(+lon)) {
      return [lon, lat];
    }
    const nm = Math.min(+gs * dt / 3600, MAX_EXTRAP_NM);
    const t = +trk * R2;
    const c = Math.cos(+lat * R2);
    return [
      wrapLon(+lon + nm * Math.sin(t) / Math.max(Math.abs(c), 0.2) / 60),
      +lat + nm * Math.cos(t) / 60
    ];
  }
  function canExtrap(gs, trk, onG, alt, stale) {
    if (onG) return false;
    if (stale >= STALE_S) return false;
    if (gs == null || !Number.isFinite(+gs) || !(+gs > 0.5)) return false;
    if (trk == null || !Number.isFinite(+trk)) return false;
    if (alt != null && Number.isFinite(+alt) && +alt < LOW_ALT_FT) return false;
    return true;
  }
  function staleS(fixAt, posAge, now) {
    const ageSinceSnap = Math.max(0, (now - fixAt) / 1000);
    return ageSinceSnap + Math.max(0, +posAge || 0);
  }
  function target(m, now) {
    // dt includes packed pos_age (seen_pos + seconds since that tile was
    // fetched). L.at is the last progressive publish, not this hex's fetch time.
    const sincePub = Math.max(0, (now - m.fixAt) / 1000);
    const age = (+m.fixAge || 0) + sincePub;
    if (!canExtrap(m.fixGs, m.fixTrk, m.fixOnG, m.fixAlt, age)) {
      if (m.holdLon != null) return { lon: m.holdLon, lat: m.holdLat, trk: m.holdTrk };
      return { lon: m.fixLon, lat: m.fixLat, trk: m.fixTrk };
    }
    const dt = Math.min(MAX_EXTRAP_S, Math.max(0, age));
    const ll = dest(m.fixLat, m.fixLon, m.fixGs, m.fixTrk, dt);
    m.holdLon = ll[0];
    m.holdLat = ll[1];
    m.holdTrk = m.fixTrk;
    return { lon: ll[0], lat: ll[1], trk: m.fixTrk };
  }
  function display(m, now) {
    const t = target(m, now);
    const u = m.bDur > 0 ? ease((now - m.b0) / m.bDur) : 1;
    if (u >= 1) return [t.lon, t.lat, t.trk];
    return [lerpLon(m.bLon, t.lon, u), lerp(m.bLat, t.lat, u), lerpAng(m.bTrk, t.trk, u)];
  }
  function sameFix(m, lat, lon, gs, trk, onG) {
    return m && m.fixLat === lat && m.fixLon === lon && m.fixGs === gs && m.fixTrk === trk && !!m.fixOnG === !!onG;
  }
  function upsert(store, hex, row, now, snapAt) {
    const lat = +row.lat, lon = +row.lon;
    const m = store[hex];
    if (sameFix(m, lat, lon, row.gs, row.trk, row.onG)) return m;
    let fromLon = lon, fromLat = lat, fromTrk = row.trk, dur = 0;
    if (m) {
      const shown = display(m, now);
      fromLon = shown[0];
      fromLat = shown[1];
      fromTrk = shown[2];
      dur = BLEND_MS;
    }
    store[hex] = {
      fixLat: lat,
      fixLon: lon,
      fixGs: row.gs,
      fixTrk: row.trk,
      fixOnG: !!row.onG,
      fixAlt: row.alt,
      fixAge: row.age == null ? 0 : +row.age,
      fixAt: snapAt,
      bLon: fromLon,
      bLat: fromLat,
      bTrk: fromTrk,
      b0: now,
      bDur: dur
    };
    return store[hex];
  }
  function prune(store, seen) {
    for (const h of Object.keys(store)) if (!seen.has(h)) delete store[h];
  }
  return {
    BLEND_MS, STALE_S, MAX_EXTRAP_S, MAX_EXTRAP_NM, LOW_ALT_FT,
    wrapLon, dest, lerp, lerpLon, lerpAng, ease, canExtrap, staleS, target, display, upsert, prune, sameFix
  };
});
