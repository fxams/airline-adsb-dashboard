// Per-aircraft dead reckoning between live ADS-B snapshots. Not a tracker.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof root === "object" && root) root.LiveMotion = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const R2 = Math.PI / 180;
  const BLEND_MS = 1600;
  const STALE_S = 1200;
  const MAX_EXTRAP_S = 900;
  const MAX_EXTRAP_NM = 120;
  const LOW_ALT_FT = 1000;
  const R_EARTH_NM = 3440.065;
  const ALPHA = 0.55;
  const BETA = 0.35;
  const BEHIND_KEEP_NM = 15;
  const BEHIND_EPS_NM = 0.12;

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
  function hv(lat1, lon1, lat2, lon2) {
    const x = Math.sin((lat2 - lat1) * R2 / 2) ** 2 + Math.cos(lat1 * R2) * Math.cos(lat2 * R2) * Math.sin((lon2 - lon1) * R2 / 2) ** 2;
    return 2 * R_EARTH_NM * Math.asin(Math.sqrt(Math.min(1, x)));
  }
  function alongNm(lat0, lon0, lat1, lon1, trk) {
    const nm = hv(lat0, lon0, lat1, lon1);
    if (!(nm > 0) || trk == null || !Number.isFinite(+trk)) return 0;
    const dLat = lat1 - lat0;
    const dLon = (lon1 - lon0) * Math.cos(((lat0 + lat1) / 2) * R2);
    const brg = (Math.atan2(dLon, dLat) / R2 + 360) % 360;
    const d = ((((brg - +trk) % 360) + 540) % 360) - 180;
    return nm * Math.cos(d * R2);
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
  function heading(trk, rate, dt) {
    if (trk == null || !Number.isFinite(+trk)) return trk;
    if (!Number.isFinite(+rate) || !(dt > 0)) return +trk;
    return (((+trk + +rate * dt) % 360) + 360) % 360;
  }
  function canExtrap(gs, trk, onG, alt, stale) {
    if (onG) return false;
    if (stale >= STALE_S) return false;
    if (gs == null || !Number.isFinite(+gs) || !(+gs > 0.5)) return false;
    if (trk == null || !Number.isFinite(+trk)) return false;
    if (alt != null && Number.isFinite(+alt) && +alt < LOW_ALT_FT) return false;
    return true;
  }
  function posTimeOf(snapAt, age) {
    return snapAt - Math.max(0, +age || 0) * 1000;
  }
  function staleS(fixAt, posAge, now) {
    const ageSinceSnap = Math.max(0, (now - fixAt) / 1000);
    return ageSinceSnap + Math.max(0, +posAge || 0);
  }
  function target(m, now) {
    const posTime = m.posTime != null ? m.posTime : m.fixAt - Math.max(0, +m.fixAge || 0) * 1000;
    const stale = Math.max(0, (now - posTime) / 1000);
    const gs = m.vGs != null ? m.vGs : m.fixGs;
    const trk0 = m.vTrk != null ? m.vTrk : m.fixTrk;
    const sinceSnap = m.fixAt != null ? Math.max(0, (now - m.fixAt) / 1000) : stale;
    const trk = (sinceSnap > 2 && m.vTrkRate) ? heading(trk0, m.vTrkRate, sinceSnap) : trk0;
    if (!canExtrap(gs, trk, m.fixOnG, m.fixAlt, stale)) {
      if (m.holdLon != null) return { lon: m.holdLon, lat: m.holdLat, trk: m.holdTrk };
      return { lon: m.fixLon, lat: m.fixLat, trk: m.fixTrk };
    }
    const dt = Math.min(MAX_EXTRAP_S, stale);
    const ll = dest(m.fixLat, m.fixLon, gs, trk, dt);
    m.holdLon = ll[0];
    m.holdLat = ll[1];
    m.holdTrk = trk;
    return { lon: ll[0], lat: ll[1], trk };
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
    const incomingPosTime = posTimeOf(snapAt, row.age);
    const m = store[hex];
    if (m && !row.onG && incomingPosTime <= (m.posTime != null ? m.posTime : m.fixAt) + 80) {
      if (!(m.vGs > 0.5) && row.gs > 0.5) m.vGs = row.gs;
      if (!(Number.isFinite(m.vTrk)) && row.trk != null && Number.isFinite(+row.trk)) m.vTrk = +row.trk;
      return m;
    }
    if (m && sameFix(m, lat, lon, row.gs, row.trk, row.onG) && Math.abs(incomingPosTime - (m.posTime || 0)) < 250) return m;

    const gs = (row.gs > 0.5) ? row.gs : (m && m.vGs);
    const trk = (row.trk != null && Number.isFinite(+row.trk)) ? +row.trk : (m && m.vTrk);
    let trkRate = (m && m.vTrkRate) || 0;
    if (m && Number.isFinite(m.vTrk) && Number.isFinite(+trk) && incomingPosTime > (m.posTime || m.fixAt)) {
      const dt = (incomingPosTime - (m.posTime || m.fixAt)) / 1000;
      if (dt > 0.4 && dt < 180) {
        const d = ((((+trk - m.vTrk) % 360) + 540) % 360) - 180;
        trkRate = Math.max(-3, Math.min(3, d / dt));
      }
    }

    let useLat = lat, useLon = lon, useGs = gs, useTrk = trk;
    if (m && !row.onG && canExtrap(m.vGs, m.vTrk, m.fixOnG, m.fixAlt, 1)) {
      const dt = Math.max(0, (incomingPosTime - (m.posTime || m.fixAt)) / 1000);
      const predTrk = heading(m.vTrk, m.vTrkRate || 0, dt);
      const pred = dest(m.fixLat, m.fixLon, m.vGs, predTrk, dt);
      const resid = hv(pred[1], pred[0], lat, lon);
      if (resid < 8) {
        useLon = lerpLon(pred[0], lon, ALPHA);
        useLat = lerp(pred[1], lat, ALPHA);
        if (gs > 0.5 && m.vGs > 0.5) useGs = lerp(m.vGs, gs, BETA);
        if (Number.isFinite(+trk) && Number.isFinite(m.vTrk)) useTrk = lerpAng(m.vTrk, trk, BETA);
      }
    }

    const shown = m ? display(m, now) : [lon, lat, trk];
    if (m && !row.onG) {
      const refTrk = (m.vTrk != null) ? m.vTrk : shown[2];
      const rawAlong = alongNm(shown[1], shown[0], lat, lon, refTrk);
      if (rawAlong < -BEHIND_EPS_NM) {
        const behind = -rawAlong;
        if (behind < BEHIND_KEEP_NM) return m;
      }
    }

    store[hex] = {
      fixLat: useLat,
      fixLon: useLon,
      fixGs: useGs,
      fixTrk: useTrk,
      fixOnG: !!row.onG,
      fixAlt: row.alt,
      fixAge: row.age == null ? 0 : +row.age,
      fixAt: snapAt,
      posTime: incomingPosTime,
      vGs: useGs,
      vTrk: useTrk,
      vTrkRate: trkRate,
      bLon: shown[0],
      bLat: shown[1],
      bTrk: shown[2],
      b0: now,
      bDur: m ? BLEND_MS : 0
    };
    return store[hex];
  }
  function prune(store, seen) {
    for (const h of Object.keys(store)) if (!seen.has(h)) delete store[h];
  }
  return {
    BLEND_MS, STALE_S, MAX_EXTRAP_S, MAX_EXTRAP_NM, LOW_ALT_FT, ALPHA, BETA,
    wrapLon, dest, lerp, lerpLon, lerpAng, ease, canExtrap, staleS, target, display, upsert, prune, sameFix,
    hv, alongNm, posTimeOf, heading
  };
});
