// Server-side aviation weather: NOAA/NWS Aviation Weather Center, cached, polite.
// Zero extra deps. Not for operational flight planning.
const UA = "airline-adsb-dashboard (github.com/fxams/airline-adsb-dashboard)";
const AWC = "https://aviationweather.gov";
const NOTE = "Not for operational flight planning. Data from NOAA/NWS Aviation Weather Center and origin meteorological authorities. SIGMETs and G-AIRMETs are advisories, not live turbulence or icing. METARs are measured observations; TAFs are terminal forecasts. Expired products are not current. Upstream errors are not 'no hazards'.";

const HUB_ICAO = "OTHH,OMDB,OMAA,OMAL,OMSJ,OERK,OEJN,OKBK,OBBI,OOMS,HECA,HLLT,HKJK,FACT,FAOR,EGLL,EGKK,EGCC,LFPG,EDDF,EDDM,EHAM,LIRF,LEMD,LEBL,LSZH,LTBA,LTFM,LGAV,KJFK,KEWR,KIAD,KORD,KLAX,KIAH,KATL,KMIA,KSFO,WSSS,WMKK,VTBS,VHHH,VABB,VIDP,RJTT,RJAA,YSSY,YMML,NZAA".split(",");

let lastAwc = 0;
async function awcFetch(path) {
  const wait = Math.max(0, lastAwc + 1200 - Date.now());
  lastAwc = Date.now() + wait;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const r = await fetch(AWC + path, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(18000) });
  return r;
}

function ms(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
function iso(t) { return t == null ? null : new Date(t).toISOString(); }

function normHz(h) {
  const x = String(h || "").toUpperCase();
  if (x === "CONVECTIVE" || x === "TS") return "TS";
  if (x.startsWith("TURB")) return x === "TURB-LO" ? "TURB-LO" : "TURB";
  return x || "OTHER";
}

function asFeat(geom, p) {
  if (!geom || !geom.type) return null;
  if (!["Polygon", "MultiPolygon", "LineString", "MultiLineString"].includes(geom.type)) return null;
  return { type: "Feature", geometry: geom, properties: p };
}

function fromIsigmet(f, now) {
  const r = f.properties || {};
  const from = ms(r.validTimeFrom), to = ms(r.validTimeTo);
  const expired = !!(to && to < now);
  return asFeat(f.geometry, {
    product: "isigmet", class: "advisory", coverage: "worldwide",
    hazard: r.hazard || "", hz: normHz(r.hazard), qualifier: r.qualifier || "",
    fir: r.firId || "", firName: r.firName || "", icaoId: r.icaoId || "", seriesId: r.seriesId || "",
    origLabel: [r.seriesId, r.hazard, r.qualifier].filter(Boolean).join(" "),
    rawHeader: String(r.rawSigmet || "").split("\n")[0] || "",
    validFrom: iso(from), validTo: iso(to), issueTime: bulletinIssue(r.rawSigmet, iso(from)),
    base: r.base ?? null, top: r.top ?? null, raw: r.rawSigmet || "",
    expired, source: "NOAA/NWS Aviation Weather Center · international SIGMET (origin MET authority)"
  });
}
function fromAirsigmet(f, now) {
  const r = f.properties || {};
  const from = ms(r.validTimeFrom), to = ms(r.validTimeTo);
  const expired = !!(to && to < now);
  return asFeat(f.geometry, {
    product: "airsigmet", class: "advisory", coverage: "United States",
    hazard: r.hazard || "", hz: normHz(r.hazard), qualifier: r.airSigmetType || "",
    fir: "", firName: "", icaoId: r.icaoId || "", seriesId: r.seriesId || "",
    origLabel: [r.airSigmetType, r.seriesId, r.hazard].filter(Boolean).join(" "),
    rawHeader: String(r.rawAirSigmet || "").split("\n")[0] || "",
    validFrom: iso(from), validTo: iso(to), issueTime: bulletinIssue(r.rawAirSigmet, iso(from)),
    base: r.altitudeLow1 ?? null, top: r.altitudeHi1 ?? null, raw: r.rawAirSigmet || "",
    expired, source: "NOAA/NWS Aviation Weather Center · US SIGMET"
  });
}
function fromGairmet(f, now) {
  const r = f.properties || {};
  const snap = ms(r.validTime), issued = ms(r.issueTime);
  const from = snap, to = snap ? snap + 3 * 3600e3 : null;
  const expired = !!(to && to < now);
  return asFeat(f.geometry, {
    product: "gairmet", class: "advisory", coverage: "contiguous 48 United States only",
    hazard: r.hazard || "", hz: normHz(r.hazard), qualifier: r.product || "",
    fir: "", firName: "", icaoId: "", seriesId: r.tag || "",
    origLabel: ["G-AIRMET", r.product, r.tag, r.hazard].filter(Boolean).join(" "),
    rawHeader: [r.product, r.tag, r.hazard, r.dueTo].filter(Boolean).join(" "),
    validFrom: iso(from), validTo: iso(to), issueTime: iso(issued),
    base: null, top: null, raw: r.dueTo || "", forecastHr: r.forecast ?? null,
    expired, source: "NOAA/NWS Aviation Weather Center · US G-AIRMET (CONUS; not a SIGMET)"
  });
}

async function readFc(path) {
  const r = await awcFetch(path);
  if (r.status === 204) return { ok: true, fc: { type: "FeatureCollection", features: [] }, status: 204 };
  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}`, body: text.slice(0, 200) };
  try {
    const j = JSON.parse(text);
    const fc = j && j.type === "FeatureCollection" ? j : { type: "FeatureCollection", features: Array.isArray(j) ? [] : [] };
    if (!Array.isArray(fc.features)) fc.features = [];
    return { ok: true, fc, status: r.status };
  } catch (e) {
    return { ok: false, status: r.status, error: "invalid JSON from AviationWeather.gov" };
  }
}

let hazCache = null;
async function hazards() {
  const now = Date.now();
  if (hazCache && now - hazCache.t < 180000 && !hazCache.error) return { ...hazCache.v, cached: true };
  const errors = [];
  const feats = [];
  const pulls = [
    ["/api/data/isigmet?format=geojson", fromIsigmet, "international SIGMET"],
    ["/api/data/airsigmet?format=geojson", fromAirsigmet, "US SIGMET"],
    ["/api/data/gairmet?format=geojson", fromGairmet, "US G-AIRMET"]
  ];
  for (const [path, conv, label] of pulls) {
    try {
      const r = await readFc(path);
      if (!r.ok) errors.push({ product: label, error: r.error || "upstream error", status: r.status });
      else {
        for (const f of r.fc.features) {
          const x = conv(f, now);
          if (x) feats.push(x);
        }
      }
    } catch (e) {
      errors.push({ product: label, error: String(e.message || e) });
    }
  }
  const current = feats.filter((f) => !f.properties.expired);
  const expiredN = feats.length - current.length;
  const failAll = errors.length === pulls.length;
  const v = {
    at: new Date().toISOString(),
    kind: "advisories",
    source: "NOAA/NWS Aviation Weather Center https://aviationweather.gov/data/api/",
    note: NOTE,
    gairmet: "US G-AIRMETs are CONUS-only advisories (not worldwide, not SIGMETs). Included when hazards are on, labelled as such.",
    winds: "Forecast winds aloft are not in this payload.",
    error: failAll ? "Hazard overlay unavailable: AviationWeather.gov did not return SIGMET/AIRMET data." : (errors.length ? "Partial upstream error" : null),
    errors: errors.length ? errors : null,
    stale: false,
    counts: { current: current.length, expired: expiredN, fetched: feats.length },
    expiredOmitted: expiredN,
    features: { type: "FeatureCollection", features: current }
  };
  if (failAll && hazCache && hazCache.v && hazCache.v.features && hazCache.v.features.features.length) {
    const old = { ...hazCache.v, stale: true, error: v.error, errors: v.errors, at: hazCache.v.at, servedAt: v.at };
    return old;
  }
  hazCache = { t: now, v, error: failAll };
  return v;
}

function pressureFromMetar(altim, raw) {
  const n = Number(altim);
  if (Number.isFinite(n) && n > 800 && n < 1100) {
    return { pa: Math.round(n * 100), via: "hPa", ref: "QNH " + n + " hPa" };
  }
  if (Number.isFinite(n) && n >= 26 && n <= 33) {
    const pa = Math.round(n * 3386.389);
    return { pa, via: "inHg", ref: "altimeter " + n.toFixed(2) + " inHg" };
  }
  const q = String(raw || "").match(/\bQ(\d{4})\b/);
  if (q) {
    const hpa = +q[1];
    return { pa: hpa * 100, via: "hPa", ref: "QNH " + hpa + " hPa" };
  }
  const a = String(raw || "").match(/\bA(\d{4})\b/);
  if (a) {
    const inhg = +a[1] / 100;
    return { pa: Math.round(inhg * 3386.389), via: "inHg", ref: "altimeter " + inhg.toFixed(2) + " inHg" };
  }
  return { pa: null, via: null, ref: null };
}

function padMet(n, w) {
  return String(Math.round(Math.abs(n))).padStart(w, "0");
}
function metarTimeZ(obsTime, raw) {
  const t = Date.parse(obsTime);
  if (Number.isFinite(t)) {
    const d = new Date(t);
    return padMet(d.getUTCDate(), 2) + padMet(d.getUTCHours(), 2) + padMet(d.getUTCMinutes(), 2) + "Z";
  }
  const m = String(raw || "").match(/\b(\d{6}Z)\b/);
  return m ? m[1] : "time n/a";
}
function metarWindGroup(wdir, wspd, wgst, raw) {
  const w = windFromMetar(wdir, wspd, wgst, raw);
  if (w.calm) return "00000KT";
  if (w.kt == null) return "wind n/a";
  const sw = w.kt >= 100 ? 3 : 2, gw = (w.gst || 0) >= 100 ? 3 : 2;
  const spd = padMet(w.kt, sw) + (w.gst != null ? "G" + padMet(w.gst, gw) : "") + "KT";
  if (w.vrb) return "VRB" + spd;
  if (w.dir == null) return "///" + spd;
  return padMet(w.dir, 3) + spd;
}
function metarTempDew(tempC, dewpC, raw) {
  const fmt = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const r = Math.round(n);
    return (r < 0 ? "M" : "") + padMet(r, 2);
  };
  let t = fmt(tempC), d = fmt(dewpC);
  if (!t || !d) {
    const m = String(raw || "").match(/(?:^|\s)(M?\d{2})\/(M?\d{2})(?=\s|$)/);
    if (m) { if (!t) t = m[1]; if (!d) d = m[2]; }
  }
  if (t && d) return t + "/" + d;
  if (t && !d) return t + "/n/a";
  if (!t && d) return "n/a/" + d;
  return "temp n/a";
}
function metarAltimGroup(altim, raw) {
  const qs = String(raw || "").match(/\bQ(\d{4})\b/);
  if (qs) return "Q" + qs[1];
  const as = String(raw || "").match(/\bA(\d{4})\b/);
  if (as) return "A" + as[1];
  const n = Number(altim);
  if (Number.isFinite(n) && n > 800 && n < 1100) return "Q" + padMet(n, 4);
  if (Number.isFinite(n) && n >= 26 && n <= 33) return "A" + padMet(n * 100, 4);
  return "Q n/a";
}
function metarAvn(m) {
  const raw = m.raw || m.rawOb || "";
  const timeZ = metarTimeZ(m.obsTime || m.reportTime, raw);
  const wind = metarWindGroup(m.wdir, m.wspdKt != null ? m.wspdKt : m.wspd, m.wgstKt != null ? m.wgstKt : m.wgst, raw);
  const tempDew = metarTempDew(m.tempC != null ? m.tempC : m.temp, m.dewpC != null ? m.dewpC : m.dewp, raw);
  const altim = metarAltimGroup(m.altim, raw);
  const icao = m.icao || m.icaoId || "";
  const line = [icao, timeZ, wind, tempDew, altim].filter(Boolean).join(" ");
  return { timeZ, wind, tempDew, altim, line, subset: true };
}
function windFromMetar(wdir, wspd, wgst, raw) {
  let dir = wdir, spd = wspd, gst = wgst;
  if ((dir == null || spd == null) && raw) {
    const w = String(raw).match(/\b(VRB|\d{3})(\d{2,3})(G(\d{2,3}))?KT\b/);
    if (w) {
      if (dir == null) dir = w[1] === "VRB" ? "VRB" : +w[1];
      if (spd == null) spd = +w[2];
      if (gst == null && w[4]) gst = +w[4];
    }
  }
  const s = spd == null || spd === "" ? NaN : Number(spd);
  const g = gst == null || gst === "" ? NaN : Number(gst);
  const hasG = Number.isFinite(g) && Number.isFinite(s) && g > s;
  if (!Number.isFinite(s) && (dir == null || dir === "")) {
    return { text: "wind n/a", group: "wind n/a", calm: false, vrb: false, dir: null, kt: null, gst: null };
  }
  if (Number.isFinite(s) && s === 0) {
    return { text: "calm", group: "00000KT", calm: true, vrb: false, dir: 0, kt: 0, gst: null };
  }
  if (dir === "VRB" || dir === "variable") {
    const group = "VRB" + padMet(s, s >= 100 ? 3 : 2) + (hasG ? "G" + padMet(g, g >= 100 ? 3 : 2) : "") + "KT";
    return { text: "VRB " + s + "kt" + (hasG ? " G" + g + "kt" : ""), group, calm: false, vrb: true, dir: "VRB", kt: s, gst: hasG ? g : null };
  }
  const d = dir == null || dir === "" ? NaN : Number(dir);
  if (!Number.isFinite(d)) {
    const group = Number.isFinite(s) ? "///" + padMet(s, s >= 100 ? 3 : 2) + (hasG ? "G" + padMet(g, g >= 100 ? 3 : 2) : "") + "KT" : "wind n/a";
    return { text: Number.isFinite(s) ? "dir n/a " + s + "kt" : "wind n/a", group, calm: false, vrb: false, dir: null, kt: Number.isFinite(s) ? s : null, gst: hasG ? g : null };
  }
  const deg = padMet(d, 3);
  const group = deg + padMet(s, s >= 100 ? 3 : 2) + (hasG ? "G" + padMet(g, g >= 100 ? 3 : 2) : "") + "KT";
  return { text: deg + "°T " + s + "kt" + (hasG ? " G" + g + "kt" : ""), group, calm: false, vrb: false, dir: d, kt: s, gst: hasG ? g : null };
}

function metarRow(m) {
  const raw = m.rawOb || "";
  const press = pressureFromMetar(m.altim, raw);
  const wind = windFromMetar(m.wdir, m.wspd, m.wgst, raw);
  const tempC = m.temp ?? null;
  const row = {
    kind: "observation",
    icao: m.icaoId, name: m.name || "", lat: m.lat, lon: m.lon,
    obsTime: m.reportTime || iso(ms(m.obsTime)), receiptTime: m.receiptTime || null,
    fltCat: m.fltCat || null, tempC, dewpC: m.dewp ?? null,
    wdir: m.wdir ?? null, wspdKt: m.wspd ?? null, wgstKt: m.wgst ?? null,
    visib: m.visib ?? null, cover: m.cover || null, altim: m.altim ?? null,
    pressPa: press.pa, pressVia: press.via, pressRef: press.ref,
    windText: wind.text, windGroup: wind.group, windCalm: wind.calm, windVrb: wind.vrb,
    raw, source: "NOAA/NWS Aviation Weather Center · METAR (measured observation)"
  };
  row.avn = metarAvn(row);
  return row;
}
function tafRow(t) {
  return {
    kind: "forecast",
    icao: t.icaoId, name: t.name || "", lat: t.lat, lon: t.lon,
    issueTime: t.issueTime || null,
    validFrom: iso(ms(t.validTimeFrom)), validTo: iso(ms(t.validTimeTo)),
    raw: t.rawTAF || "",
    source: "NOAA/NWS Aviation Weather Center · TAF (terminal forecast)"
  };
}

async function readJsonList(path) {
  const r = await awcFetch(path);
  if (r.status === 204) return { ok: true, list: [], status: 204 };
  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
  try {
    const j = JSON.parse(text);
    return { ok: true, list: Array.isArray(j) ? j : [], status: r.status };
  } catch (e) {
    return { ok: false, status: r.status, error: "invalid JSON from AviationWeather.gov" };
  }
}

const stCache = new Map();
async function pullStations(ids) {
  const key = ids.slice().sort().join(",");
  const hit = stCache.get(key);
  if (hit && Date.now() - hit.t < 300000 && !hit.error) return { ...hit.v, cached: true };
  const q = encodeURIComponent(ids.join(","));
  const errors = [];
  let metar = [], taf = [];
  try {
    const r = await readJsonList("/api/data/metar?ids=" + q + "&format=json");
    if (!r.ok) errors.push({ product: "METAR", error: r.error, status: r.status });
    else metar = r.list.map(metarRow);
  } catch (e) { errors.push({ product: "METAR", error: String(e.message || e) }); }
  try {
    const r = await readJsonList("/api/data/taf?ids=" + q + "&format=json");
    if (!r.ok) errors.push({ product: "TAF", error: r.error, status: r.status });
    else taf = r.list.map(tafRow);
  } catch (e) { errors.push({ product: "TAF", error: String(e.message || e) }); }
  const fail = !metar.length && !taf.length && errors.length;
  const v = {
    at: new Date().toISOString(),
    source: "NOAA/NWS Aviation Weather Center https://aviationweather.gov/data/api/",
    note: NOTE,
    ids,
    error: fail ? "METAR/TAF unavailable: AviationWeather.gov error." : (errors.length ? "Partial upstream error" : null),
    errors: errors.length ? errors : null,
    stale: false,
    metar, taf
  };
  if (fail && hit && hit.v) return { ...hit.v, stale: true, error: v.error, errors: v.errors, servedAt: v.at };
  stCache.set(key, { t: Date.now(), v, error: fail });
  if (stCache.size > 40) stCache.clear();
  return v;
}

function cleanIds(raw) {
  const extra = String(raw || "").toUpperCase().split(/[^A-Z0-9]+/).filter((x) => x.length === 4).slice(0, 20);
  const seen = new Set();
  const out = [];
  for (const id of HUB_ICAO.concat(extra)) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

async function stations(rawIds) {
  return pullStations(cleanIds(rawIds));
}

function windsBlocked(reason, extra) {
  return {
    available: false, status: "unavailable", product: "forecast_winds_aloft",
    model: "NOAA GFS 1.0° pressure-level (NOMADS grib filter)",
    source: "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl",
    at: new Date().toISOString(), note: NOTE, reason,
    levels: [], times: [], step_deg: null, bbox: null, fields: {},
    ...extra
  };
}

function i16(buf, o) { const v = buf.readUInt16BE(o); return v & 0x8000 ? v - 65536 : v; }
function i32(buf, o) { const v = buf.readUInt32BE(o); return v >= 0x80000000 ? v - 0x100000000 : v; }
// NOMADS grib-filter subsets encode southern latitudes with a GRIB1 sign bit
// (0x80000000 | microdegrees) rather than two's complement. Positive values
// match. If the magnitude is not a plausible lat/lon, fall back to int32.
function coord32(buf, o, maxAbs) {
  const v = buf.readUInt32BE(o);
  const mag = v & 0x7fffffff;
  const cap = (maxAbs == null ? 360 : maxAbs) * 1e6;
  if (mag <= cap) return ((v & 0x80000000) ? -mag : mag) / 1e6;
  return i32(buf, o) / 1e6;
}
function bulletinIssue(raw, fromIso) {
  const line = String(raw || "").split("\n")[0] || "";
  const m = line.match(/\b(\d{2})(\d{2})(\d{2})\s*$/);
  const from = ms(fromIso);
  if (!m || from == null) return iso(from);
  const day = +m[1], hh = +m[2], mm = +m[3];
  if (day < 1 || day > 31 || hh > 23 || mm > 59) return iso(from);
  const d = new Date(from);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day, hh, mm);
  if (t - from > 20 * 864e5) t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, day, hh, mm);
  else if (from - t > 20 * 864e5) t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, day, hh, mm);
  return iso(t);
}
function bitU(buf, bitpos, nbits) {
  let v = 0;
  for (let k = 0; k < nbits; k++) {
    const byte = buf[(bitpos + k) >> 3];
    if (byte === undefined) return 0;
    v = (v << 1) | ((byte >> (7 - ((bitpos + k) & 7))) & 1);
  }
  return v;
}

function decodeGrib2Simple(buf) {
  const out = [];
  let off = 0;
  while (off + 16 <= buf.length && buf.toString("ascii", off, off + 4) === "GRIB") {
    if (buf[off + 7] !== 2) throw new Error("not GRIB2");
    const disc = buf[off + 6], msglen = Number(buf.readBigUInt64BE(off + 8));
    const secs = {};
    let p = off + 16;
    while (p + 5 <= off + msglen - 4) {
      const seclen = buf.readUInt32BE(p), sect = buf[p + 4];
      if (seclen < 5) break;
      secs[sect] = buf.subarray(p, p + seclen);
      p += seclen;
    }
    const s1 = secs[1], s3 = secs[3], s4 = secs[4], s5 = secs[5], s7 = secs[7];
    if (!s1 || !s3 || !s4 || !s5 || !s7) { off += msglen; continue; }
    const pack = s5.readUInt16BE(9);
    if (pack !== 0) throw new Error("GRIB2 packing template " + pack + " (need simple packing 0)");
    const gdt = s3.readUInt16BE(12);
    if (gdt !== 0) throw new Error("grid template " + gdt);
    const t = 14, Ni = s3.readUInt32BE(t + 16), Nj = s3.readUInt32BE(t + 20);
    const lat1 = coord32(s3, t + 32, 90), lon1 = coord32(s3, t + 36, 360);
    const lat2 = coord32(s3, t + 41, 90), lon2 = coord32(s3, t + 45, 360);
    const Di = s3.readUInt32BE(t + 49) / 1e6, Dj = s3.readUInt32BE(t + 53) / 1e6;
    const cat = s4[9], num = s4[10], ft = s4.readUInt32BE(18);
    const levtyp = s4[22], levsc = s4[23], levRaw = s4.readUInt32BE(24);
    const levPa = levsc ? levRaw / 10 ** levsc : levRaw;
    const hpa = levtyp === 100 ? Math.round(levPa / 100) : Math.round(levPa);
    const nd = s5.readUInt32BE(5), R = s5.readFloatBE(11), E = i16(s5, 15), D = i16(s5, 17), nbits = s5[19];
    const packed = s7.subarray(5);
    const vals = new Float32Array(nd);
    const fE = 2 ** E, fD = 10 ** (-D);
    if (nbits === 0) for (let i = 0; i < nd; i++) vals[i] = R * fD;
    else for (let i = 0; i < nd; i++) vals[i] = (R + bitU(packed, i * nbits, nbits) * fE) * fD;
    const year = s1.readUInt16BE(12), month = s1[14], day = s1[15], hour = s1[16];
    const cycle = new Date(Date.UTC(year, month - 1, day, hour)).toISOString();
    let name = "UNK";
    if (disc === 0 && cat === 0 && num === 0) name = "TMP";
    else if (disc === 0 && cat === 2 && num === 2) name = "UGRD";
    else if (disc === 0 && cat === 2 && num === 3) name = "VGRD";
    out.push({ name, hpa, ft, Ni, Nj, lat1, lon1, lat2, lon2, Di, Dj, vals, cycle, nd });
    off += msglen;
  }
  if (!out.length) throw new Error("no GRIB2 messages decoded");
  return out;
}

function subsampleWind(msgs, step) {
  const by = {};
  for (const m of msgs) {
    const k = m.ft + ":" + m.hpa;
    if (!by[k]) by[k] = { fh: m.ft, hpa: m.hpa, cycle: m.cycle, Ni: m.Ni, Nj: m.Nj, lat1: m.lat1, lon1: m.lon1, lat2: m.lat2, lon2: m.lon2, Di: m.Di, Dj: m.Dj };
    by[k][m.name] = m.vals;
  }
  const times = [], levels = new Set(), fields = {}, lats = [], lons = [];
  const first = Object.values(by)[0];
  const dLat = first.Nj > 1 ? (first.lat2 - first.lat1) / (first.Nj - 1) : first.Dj;
  const dLon = first.Ni > 1 ? (first.lon2 - first.lon1) / (first.Ni - 1) : first.Di;
  for (let j = 0; j < first.Nj; j += step) lats.push(+(first.lat1 + j * dLat).toFixed(3));
  for (let i = 0; i < first.Ni; i += step) {
    let lo = first.lon1 + i * dLon; if (lo > 180) lo -= 360;
    lons.push(+lo.toFixed(3));
  }
  for (const rec of Object.values(by)) {
    if (!rec.UGRD || !rec.VGRD) continue;
    levels.add(rec.hpa);
    const u = [], v = [], tmp = [];
    for (let j = 0; j < rec.Nj; j += step) for (let i = 0; i < rec.Ni; i += step) {
      const idx = j * rec.Ni + i;
      u.push(+rec.UGRD[idx].toFixed(2));
      v.push(+rec.VGRD[idx].toFixed(2));
      tmp.push(rec.TMP != null ? +(rec.TMP[idx] - 273.15).toFixed(1) : null);
    }
    const valid = new Date(Date.parse(rec.cycle) + rec.fh * 3600e3).toISOString();
    fields[rec.fh + ":" + rec.hpa] = { u, v, tC: tmp, valid_utc: valid, cycle_utc: rec.cycle, fh: rec.fh, hpa: rec.hpa };
  }
  const fhs = [...new Set(Object.values(fields).map((f) => f.fh))].sort((a, b) => a - b);
  for (const fh of fhs) {
    const s = Object.values(fields).find((f) => f.fh === fh);
    times.push({ fh, valid_utc: s.valid_utc, cycle_utc: s.cycle_utc });
  }
  return { lats, lons, levels: [...levels].sort((a, b) => b - a), times, fields };
}

const GFS_FHS = [6, 12], GFS_STEP = 3;
const GFS_BOX = { leftlon: 0, rightlon: 110, toplat: 60, bottomlat: -35 };
let lastNomads = 0, windCache = null;

function gfsUrl(ymd, hh, fh) {
  const fff = String(fh).padStart(3, "0");
  const q = new URLSearchParams({
    dir: `/gfs.${ymd}/${hh}/atmos`,
    file: `gfs.t${hh}z.pgrb2.1p00.f${fff}`,
    lev_850_mb: "on", lev_500_mb: "on", lev_300_mb: "on", lev_200_mb: "on",
    var_UGRD: "on", var_VGRD: "on", var_TMP: "on",
    subregion: "", leftlon: String(GFS_BOX.leftlon), rightlon: String(GFS_BOX.rightlon),
    toplat: String(GFS_BOX.toplat), bottomlat: String(GFS_BOX.bottomlat)
  });
  return "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl?" + q.toString();
}

async function nomadsGet(url) {
  const wait = Math.max(0, lastNomads + 1500 - Date.now());
  lastNomads = Date.now() + wait;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("NOMADS HTTP " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 16 || buf.toString("ascii", 0, 4) !== "GRIB") throw new Error("NOMADS did not return GRIB2");
  return buf;
}

function gfsCycles() {
  const out = [];
  const now = Date.now();
  for (let back = 4; back <= 30; back += 1) {
    const t = new Date(now - back * 3600e3);
    const cyc = Math.floor(t.getUTCHours() / 6) * 6;
    const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), cyc));
    const k = d.toISOString();
    if (!out.some((x) => x.iso === k)) out.push({ iso: k, ymd: d.toISOString().slice(0, 10).replace(/-/g, ""), hh: String(d.getUTCHours()).padStart(2, "0") });
  }
  return out.slice(0, 6);
}

async function winds() {
  const now = Date.now();
  if (windCache && now - windCache.t < 3600000 && windCache.v.available) return { ...windCache.v, cached: true };
  let lastErr = "";
  for (const cyc of gfsCycles()) {
    try {
      const msgs = [];
      for (const fh of GFS_FHS) {
        const buf = await nomadsGet(gfsUrl(cyc.ymd, cyc.hh, fh));
        msgs.push(...decodeGrib2Simple(buf));
      }
      const grid = subsampleWind(msgs, GFS_STEP);
      if (!grid.times.length || !Object.keys(grid.fields).length) throw new Error("decoded GRIB2 had no U/V fields");
      const v = {
        available: true, status: "ok", product: "forecast_winds_aloft", kind: "forecast",
        model: "NOAA GFS 1.0° pressure-level",
        source: "NOMADS grib filter https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl",
        at: new Date().toISOString(), note: NOTE,
        cycle_utc: grid.times[0].cycle_utc,
        bbox: GFS_BOX, step_deg: GFS_STEP, packing: "GRIB2 template 5.0 simple packing",
        coverage: "Subset 1° GFS, then every " + GFS_STEP + "° for display (Europe / Africa / Middle East / South Asia). Not global. Not WAFS. Not live turbulence.",
        lats: grid.lats, lons: grid.lons, levels: grid.levels, times: grid.times, fields: grid.fields
      };
      windCache = { t: now, v };
      return v;
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  if (windCache && windCache.v && windCache.v.available) return { ...windCache.v, stale: true, error: lastErr, servedAt: new Date().toISOString() };
  return windsBlocked("GFS winds unavailable after trying NOMADS GRIB2 1.0° subsets (simple packing). Last error: " + lastErr + " OpenDAP is retired (SCN 25-81); this path uses the grib filter instead. No substitute winds are invented.", { error: lastErr });
}

module.exports = { hazards, stations, winds, NOTE, HUB_ICAO, coord32, decodeGrib2Simple, bulletinIssue, pressureFromMetar, windFromMetar, metarRow, metarTimeZ, metarWindGroup, metarTempDew, metarAltimGroup, metarAvn };
