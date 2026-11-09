// Geographic plausibility for origin–destination pairs vs a displayed ADS-B position.
// Crowd-sourced callsign routes (adsbdb) and history-derived pairs can be stale or reused.
// Distances in nautical miles. Does not invent a replacement city pair.
(function (root) {
  const R = 3440.065;
  const D2R = Math.PI / 180;

  function hv(lat1, lon1, lat2, lon2) {
    const x = Math.sin((lat2 - lat1) * D2R / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin((lon2 - lon1) * D2R / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, x)));
  }
  function brg(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * D2R) * Math.cos(lat2 * D2R);
    const x = Math.cos(lat1 * D2R) * Math.sin(lat2 * D2R) - Math.sin(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.cos((lon2 - lon1) * D2R);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function angDiff(a, b) {
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
  }
  function hasCoords(od) {
    return !!(od && od.o && od.d && typeof od.o.lat === "number" && typeof od.o.lon === "number" && typeof od.d.lat === "number" && typeof od.d.lon === "number");
  }
  function nearNm(route) {
    return Math.max(70, Math.min(160, 0.10 * route + 50));
  }
  function xtdLimit(route) {
    // Long oceanic/polar legs routinely sit hundreds of nm off the GC (NAT tracks).
    // Short hops need enough room for SIDs, but not a continent.
    return Math.max(160, Math.min(780, 0.18 * route + 140));
  }
  function geom(od, lat, lon) {
    if (!hasCoords(od) || typeof lat !== "number" || typeof lon !== "number") return null;
    const oLat = od.o.lat, oLon = od.o.lon, dLat = od.d.lat, dLon = od.d.lon;
    const route = hv(oLat, oLon, dLat, dLon);
    const toO = hv(lat, lon, oLat, oLon);
    const toD = hv(lat, lon, dLat, dLon);
    if (!(route > 0.5)) return { route, toO, toD, along: 0, xtd: toO, brgD: brg(lat, lon, dLat, dLon), brgO: brg(lat, lon, oLat, oLon) };
    const alongNm = (route * route + toO * toO - toD * toD) / (2 * route);
    const along = alongNm / route;
    const xtd = Math.sqrt(Math.max(0, toO * toO - alongNm * alongNm));
    return { route, toO, toD, along, xtd, brgD: brg(lat, lon, dLat, dLon), brgO: brg(lat, lon, oLat, oLon) };
  }
  function corridorOk(g, near) {
    if (!g) return false;
    if (g.route < 20) return g.toO < 80 && g.toD < 80;
    if (near) return true;
    if (g.along < -0.18 || g.along > 1.18) return false;
    if (g.xtd > xtdLimit(g.route)) return false;
    return true;
  }
  function takeoffOk(od, takeoffLL) {
    if (!takeoffLL || takeoffLL.length < 2) return true;
    const lat = takeoffLL[0], lon = takeoffLL[1];
    if (typeof lat !== "number" || typeof lon !== "number") return true;
    const dO = hv(lat, lon, od.o.lat, od.o.lon);
    const dD = hv(lat, lon, od.d.lat, od.d.lon);
    if (dO > 100 && dD > 100) return true;
    return dO <= 100;
  }
  function historyOk(od, pts) {
    if (!pts || pts.length < 4) return true;
    const air = pts.filter((p) => p && p[6] !== 1 && (p[3] || 0) > 500).slice(-8);
    if (air.length < 3) return true;
    let bad = 0;
    for (const p of air) {
      const g = geom(od, p[2], p[1]);
      const near = g && (g.toO < nearNm(g.route) || g.toD < nearNm(g.route));
      if (!corridorOk(g, near)) bad++;
    }
    return bad <= air.length / 2;
  }
  function routePlausible(od, pos, opts) {
    opts = opts || {};
    if (!hasCoords(od) || !pos || typeof pos.lat !== "number" || typeof pos.lon !== "number") {
      return { ok: false, reason: "nocoords" };
    }
    const g = geom(od, pos.lat, pos.lon);
    if (!g) return { ok: false, reason: "nogeom" };
    const near = g.toO < nearNm(g.route) || g.toD < nearNm(g.route);
    if (!corridorOk(g, near)) return { ok: false, reason: "corridor", geom: g };
    const airborne = !opts.gnd && !opts.held && (opts.gs || 0) > 180;
    if (!near && airborne && typeof opts.trk === "number" && g.along > 0.12 && g.along < 0.88) {
      if (angDiff(opts.trk, g.brgD) > 110) return { ok: false, reason: "heading", geom: g };
    }
    if (!takeoffOk(od, opts.takeoffLL)) return { ok: false, reason: "takeoff", geom: g };
    if (!near && !historyOk(od, opts.pts)) return { ok: false, reason: "history", geom: g };
    return { ok: true, geom: g, near: !!near };
  }
  function labelOf(od) {
    return od ? ((od.oi || (od.o && (od.o.iata || od.o.icao)) || "?") + "→" + (od.di || (od.d && (od.d.iata || od.d.icao)) || "?")) : "";
  }
  function pickRoute(db, hi, pos, opts) {
    opts = opts || {};
    const dbChk = hasCoords(db) ? routePlausible(db, pos, opts) : { ok: false, reason: db ? "nocoords" : "none" };
    const hiChk = hasCoords(hi) ? routePlausible(hi, pos, opts) : { ok: false, reason: hi ? "nocoords" : "none" };
    const dbOk = !!dbChk.ok, hiOk = !!hiChk.ok;
    const same = !!(db && hi && db.oi === hi.oi && db.di === hi.di);
    const rejected = [];
    if (hasCoords(db) && !dbOk) rejected.push({ src: "adsbdb", pair: labelOf(db), reason: dbChk.reason, geom: dbChk.geom });
    if (hasCoords(hi) && !hiOk && !(same && hasCoords(db) && !dbOk)) rejected.push({ src: "history", pair: labelOf(hi), reason: hiChk.reason, geom: hiChk.geom });
    if (same) {
      if (dbOk || hiOk) return { db, hi, od: dbOk ? db : hi, src: dbOk && hiOk ? "both" : (dbOk ? "adsbdb" : "history"), conflict: false, unverified: false, rejected };
      return { db, hi, od: null, src: null, conflict: false, unverified: true, rejected };
    }
    if (dbOk && !hiOk) return { db, hi, od: db, src: "adsbdb", conflict: false, unverified: false, rejected };
    if (hiOk && !dbOk) return { db, hi, od: hi, src: "history", conflict: false, unverified: false, rejected };
    if (dbOk && hiOk) return { db, hi, od: null, src: null, conflict: true, unverified: false, rejected };
    if (hasCoords(db) || hasCoords(hi)) return { db, hi, od: null, src: null, conflict: false, unverified: true, rejected };
    return { db, hi, od: null, src: null, conflict: false, unverified: false, rejected };
  }

  const API = { hv, brg, angDiff, hasCoords, nearNm, xtdLimit, geom: geom, routeGeom: geom, routePlausible, pickRoute, labelOf };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  for (const k of Object.keys(API)) root[k === "geom" ? "routeGeom" : k] = API[k];
  root.RoutePlaus = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
