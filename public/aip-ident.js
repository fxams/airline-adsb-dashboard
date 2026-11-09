// Per-flight SID/STAR identification vs licence-safe CIFP paths.
// Estimated from the ADS-B track, not the ATC clearance. Never invents names.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof root === "object" && root) root.AipIdent = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CLIP_NM = 40, FIX_TOL_NM = 2, RESAMPLE_N = 20;
  const FRECHET_SCALE_NM = 5, DTW_SCALE_NM = 4, CONF_THRESHOLD = 58, MIN_HITS_NAMED = 2;
  const SID_RWY_RT = new Set(["1", "4"]), STAR_RWY_RT = new Set(["3", "6"]);
  const R2 = Math.PI / 180;

  function hv(lat1, lon1, lat2, lon2) {
    const x = Math.sin((lat2 - lat1) * R2 / 2) ** 2 + Math.cos(lat1 * R2) * Math.cos(lat2 * R2) * Math.sin((lon2 - lon1) * R2 / 2) ** 2;
    return 2 * 3440.065 * Math.asin(Math.sqrt(Math.min(1, x)));
  }
  function rr(x, n) { return +(+x).toFixed(n == null ? 5 : n); }
  function normRwy(s) {
    s = String(s || "").toUpperCase().replace(/^RW/, "");
    const m = s.match(/^0?(\d{1,2})([LCRWB]?)$/);
    return m ? m[1].padStart(2, "0") + m[2] : s;
  }
  function sameRwy(want, prwy) {
    want = normRwy(want); prwy = normRwy(prwy);
    if (!want || !prwy) return false;
    if (prwy.endsWith("B") && prwy.slice(0, 2) === want.slice(0, 2)) return true;
    return prwy === want;
  }
  function clipPath(path, lat0, lon0, nm) {
    if (!path || path.length < 2) return [];
    const out = [];
    for (const p of path) {
      if (hv(lat0, lon0, p[1], p[0]) <= nm) out.push(p);
      else { if (out.length) out.push(p); break; }
    }
    return out.length >= 2 ? out : [];
  }
  function resample(path, n) {
    n = n || RESAMPLE_N;
    if (!path || !path.length) return [];
    if (path.length <= n) return path.map((p) => p.slice());
    const dist = [0];
    for (let i = 1; i < path.length; i++) dist.push(dist[i - 1] + hv(path[i - 1][1], path[i - 1][0], path[i][1], path[i][0]));
    const total = dist[dist.length - 1] || 1;
    const out = [path[0].slice()];
    let t = 1;
    for (let k = 1; k < n - 1; k++) {
      const target = total * k / (n - 1);
      while (t < dist.length && dist[t] < target) t++;
      if (t >= path.length) { out.push(path[path.length - 1].slice()); continue; }
      const span = dist[t] - dist[t - 1] || 1e-9, f = (target - dist[t - 1]) / span;
      const a = path[t - 1], b = path[t];
      out.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
    }
    out.push(path[path.length - 1].slice());
    return out;
  }
  function xy(path, lat0, lon0) {
    const klat = 60, klon = 60 * Math.cos((lat0 || 0) * R2);
    return path.map((p) => [(p[0] - lon0) * klon, (p[1] - lat0) * klat]);
  }
  function discreteFrechet(P, Q) {
    const n = P.length, m = Q.length;
    if (!n || !m) return 1e9;
    let prev = new Array(m);
    prev[0] = Math.hypot(P[0][0] - Q[0][0], P[0][1] - Q[0][1]);
    for (let j = 1; j < m; j++) prev[j] = Math.max(prev[j - 1], Math.hypot(P[0][0] - Q[j][0], P[0][1] - Q[j][1]));
    for (let i = 1; i < n; i++) {
      const cur = new Array(m);
      cur[0] = Math.max(prev[0], Math.hypot(P[i][0] - Q[0][0], P[i][1] - Q[0][1]));
      for (let j = 1; j < m; j++) {
        const d = Math.hypot(P[i][0] - Q[j][0], P[i][1] - Q[j][1]);
        cur[j] = Math.max(Math.min(prev[j], prev[j - 1], cur[j - 1]), d);
      }
      prev = cur;
    }
    return prev[m - 1];
  }
  function dtwMean(P, Q) {
    const n = P.length, m = Q.length;
    if (!n || !m) return 1e9;
    const inf = 1e12;
    let prev = new Array(m + 1).fill(inf); prev[0] = 0;
    for (let i = 1; i <= n; i++) {
      const cur = new Array(m + 1).fill(inf);
      const px = P[i - 1][0], py = P[i - 1][1];
      for (let j = 1; j <= m; j++) {
        const d = Math.hypot(px - Q[j - 1][0], py - Q[j - 1][1]);
        cur[j] = d + Math.min(prev[j], prev[j - 1], cur[j - 1]);
      }
      prev = cur;
    }
    return prev[m] / (n + m);
  }
  function orderedHits(track, fixLL, tol) {
    const hits = [];
    let i0 = 0;
    for (const f of fixLL) {
      let found = false;
      for (let i = i0; i < track.length; i++) {
        const d = hv(track[i][1], track[i][0], f.lat, f.lon);
        if (d <= (tol || FIX_TOL_NM)) { hits.push({ fix: f.name, nm: rr(d, 2), i }); i0 = i; found = true; break; }
      }
      if (!found) break;
    }
    return hits;
  }
  function nomatch() {
    return { status: "nomatch", proc: null, trans: "", kind: null, conf: 0, hits: [], n_hits: 0, n_fixes: 0, label: "No match / vectored", note: "Estimated from the ADS-B track, not the ATC clearance. Not for navigation." };
  }
  function scoreProc(track, proc, lat0, lon0) {
    const path = proc.path || [];
    const fixes = proc.fixes || [];
    if (!track || track.length < 4 || path.length < 2) return null;
    const tclip = clipPath(track, lat0, lon0, CLIP_NM).length >= 2 ? clipPath(track, lat0, lon0, CLIP_NM) : track;
    const pclip = clipPath(path, lat0, lon0, CLIP_NM).length >= 2 ? clipPath(path, lat0, lon0, CLIP_NM) : path;
    const fixLL = [];
    for (let i = 0; i < fixes.length && i < path.length; i++) fixLL.push({ name: fixes[i], lon: path[i][0], lat: path[i][1] });
    const hits = orderedHits(tclip, fixLL);
    const nfix = Math.max(fixLL.length, 1);
    const fixFrac = hits.length / nfix;
    let tCmp = tclip;
    if (hits.length) tCmp = tclip.slice(0, Math.min(tclip.length, hits[hits.length - 1].i + 7));
    else tCmp = clipPath(tclip, lat0, lon0, 12).length >= 2 ? clipPath(tclip, lat0, lon0, 12) : tclip.slice(0, Math.max(8, Math.floor(tclip.length / 4)));
    const Pt = xy(resample(tCmp.length >= 2 ? tCmp : tclip), lat0, lon0), Pp = xy(resample(pclip), lat0, lon0);
    const fr = discreteFrechet(Pt, Pp), dw = dtwMean(Pt, Pp);
    const frS = Math.max(0, 1 - fr / FRECHET_SCALE_NM), dwS = Math.max(0, 1 - dw / DTW_SCALE_NM);
    let conf = 100 * (0.50 * fixFrac + 0.35 * frS + 0.15 * dwS);
    if (hits.length === 0) conf = Math.min(conf, 38);
    else if (hits.length < MIN_HITS_NAMED && nfix >= 3) conf *= 0.65;
    if (fixFrac >= 1 && hits.length >= MIN_HITS_NAMED) conf = Math.max(conf, 78);
    else if (fixFrac >= 0.66 && hits.length >= MIN_HITS_NAMED) conf = Math.max(conf, 62);
    conf = Math.max(0, Math.min(100, conf));
    return { proc: proc.id, trans: proc.trans || "", rwy: proc.rwy || "", kind: proc.kind, rt: proc.rt || "", conf: rr(conf, 1), hits: hits.map((h) => h.fix), n_hits: hits.length, n_fixes: nfix, fix_frac: rr(fixFrac, 3), frechet_nm: rr(fr, 2), dtw_nm: rr(dw, 2) };
  }
  function identify(track, procs, lat0, lon0, kind, rwy, threshold) {
    if (!track || !procs || !procs.length) return nomatch();
    const wantKind = kind === "dep" ? "sid" : kind === "arr" ? "star" : kind;
    const thr = threshold == null ? CONF_THRESHOLD : threshold;
    let pool = procs.filter((p) => {
      if (wantKind && p.kind !== wantKind) return false;
      if (rwy && p.rwy && !sameRwy(rwy, p.rwy)) return false;
      return true;
    });
    if (!pool.length) pool = procs.filter((p) => !wantKind || p.kind === wantKind);
    const rwyRt = wantKind === "sid" ? SID_RWY_RT : STAR_RWY_RT;
    const ranked = [];
    for (const p of pool) {
      const sc = scoreProc(track, p, lat0, lon0);
      if (!sc) continue;
      ranked.push({ same: (rwy && sameRwy(rwy, p.rwy)) ? 0 : 1, rt: rwyRt.has(p.rt) ? 0 : 1, sc });
    }
    ranked.sort((a, b) => b.sc.conf - a.sc.conf || a.same - b.same || a.rt - b.rt);
    if (!ranked.length) return nomatch();
    const best = ranked[0].sc;
    if (best.conf < thr || (best.n_hits < MIN_HITS_NAMED && (best.fix_frac || 0) < 0.99)) {
      const out = nomatch();
      out.conf = best.conf;
      out.runner_up = { proc: best.proc, trans: best.trans, conf: best.conf };
      return out;
    }
    best.status = "match";
    best.label = `Likely ${String(best.kind).toUpperCase()}: ${best.proc}${best.trans ? " (" + best.trans + ")" : ""} · ${Math.round(best.conf)}% match · estimated from ADS-B track, not the ATC clearance`;
    best.note = "Estimated from the ADS-B track vs published CIFP fixes. Not the ATC clearance. Not for navigation.";
    return best;
  }
  function trackFromPoints(pts) {
    // SEL_T rows: [t, lon, lat, ...]
    const out = [];
    for (const p of pts || []) {
      if (!p) continue;
      if (Array.isArray(p) && p.length >= 3 && typeof p[1] === "number") out.push([p[1], p[2]]);
      else if (Array.isArray(p) && p.length >= 2) out.push([p[0], p[1]]);
    }
    return out;
  }
  return { identify, nomatch, scoreProc, orderedHits, discreteFrechet, dtwMean, resample, trackFromPoints, CONF_THRESHOLD, FIX_TOL_NM, hv, clipPath };
});
