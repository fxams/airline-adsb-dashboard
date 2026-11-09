"""Terminal-area flown-track pipeline: Kalman/RTS, runway assign, cluster.

Pure functions. Input is observed ADS-B traces (adsb.lol / readsb, ODbL) and
OurAirports runway ends (public domain). Output is representative paths per
runway and direction. These are not published SID/STAR procedures.
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import math
import re
from collections import defaultdict

import numpy as np

NM_M = 1852.0
DEG_LAT_M = 110540.0
CLIP_NM = 55.0
CORE_NM = 8.0
CORRIDOR_NM = 14.0
HALF_W_NM = 0.55
ON_RWY_NM = 0.05  # ~93 m: tighter than EGLL 27L/27R spacing (~350 m)
HDG_TOL = 22.0
ROLL_GS = 40.0
ROLL_ALT_FT = 400.0
GAP_SPLIT_S = 180.0
MIN_PTS = 8
RESAMPLE_N = 28
NEAR_M = 4500.0
NEAR_STATIONS = 12
RAW_CAP = 16
CLUSTER_EPS_NM = 1.35
HEX_QTR_UAE = re.compile(r"trace_full_(06a|896)([0-9a-f]*)\.json", re.I)
RWY_ID = re.compile(r"^\d{1,2}[LCRW]?$")


def hv_nm(lat1, lon1, lat2, lon2):
    r = math.pi / 180.0
    x = math.sin((lat2 - lat1) * r / 2) ** 2 + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2
    return 2 * 3440.065 * math.asin(math.sqrt(min(1.0, x)))


def enu_m(lat0, lon0, lat, lon):
    e = (lon - lon0) * math.cos(math.radians(lat0)) * 111320.0
    n = (lat - lat0) * DEG_LAT_M
    return e, n


def enu_ll(lat0, lon0, e, n):
    lat = lat0 + n / DEG_LAT_M
    lon = lon0 + e / (math.cos(math.radians(lat0)) * 111320.0)
    return lat, lon


def wrap180(d):
    return (d + 180.0) % 360.0 - 180.0


def hdg_err(a, b):
    return abs(wrap180((a or 0) - (b or 0)))


def rr(x, n=5):
    return round(float(x), n)


def rr_near(lon, lat, apt, n_near=6, n_far=5, near_nm=8.0):
    """Keep ~0.1 m precision near the airport; 5 dp (~1 m) farther out."""
    n = n_near if hv_nm(lat, lon, apt["lat"], apt["lon"]) <= near_nm else n_far
    return [rr(lon, n), rr(lat, n)]


# --- Kalman CV + RTS ---------------------------------------------------------

def kalman_rts(pts, lat0, lon0):
    """pts: list of dicts t, lat, lon, alt, gs, trk, gnd. Returns smoothed copies.

    Constant-velocity in local metres. Large dt inflates Q; dt>GAP_SPLIT_S splits.
    Innovation gate drops outliers. Gaps stay as segment breaks (no interpolation).
    """
    if len(pts) < 3:
        return [dict(p) for p in pts]
    segs, cur = [], []
    for i, p in enumerate(pts):
        if cur and p["t"] - cur[-1]["t"] > GAP_SPLIT_S:
            if len(cur) >= 3:
                segs.append(cur)
            cur = []
        cur.append(p)
    if len(cur) >= 3:
        segs.append(cur)
    elif cur and len(cur) >= 1:
        # short leftover (often a ground-roll stub): keep observed, do not drop
        segs.append(cur)
    out = []
    for seg in segs:
        out.extend(_rts_maybe_split_surface(seg, lat0, lon0))
        out.append(None)
    if out and out[-1] is None:
        out.pop()
    return out


def _is_surface(p):
    """Taxi / ground-roll / flare: constant-velocity RTS cuts corners here."""
    if p.get("gnd"):
        return True
    gs = p.get("gs")
    if _alt(p) <= 50 and (gs is None or gs < 80):
        return True
    return False


def _rts_maybe_split_surface(seg, lat0, lon0):
    """Do not RTS through the ground roll. Surface samples stay as observed."""
    if len(seg) < 3:
        return [dict(p) for p in seg]
    runs, cur, flag = [], [], _is_surface(seg[0])
    for p in seg:
        f = _is_surface(p)
        if cur and f != flag:
            runs.append((flag, cur))
            cur = []
            flag = f
        cur.append(p)
    if cur:
        runs.append((flag, cur))
    out = []
    for surface, run in runs:
        if surface or len(run) < 3:
            out.extend(dict(p) for p in run)
        else:
            out.extend(_rts_seg(run, lat0, lon0))
    return out


def _rts_seg(seg, lat0, lon0):
    n = len(seg)
    x_f = [None] * n
    P_f = [None] * n
    x_p = [None] * n
    P_p = [None] * n
    e0, n0 = enu_m(lat0, lon0, seg[0]["lat"], seg[0]["lon"])
    dt0 = max(0.5, (seg[1]["t"] - seg[0]["t"]) if n > 1 else 1.0)
    ve = (enu_m(lat0, lon0, seg[1]["lat"], seg[1]["lon"])[0] - e0) / dt0 if n > 1 else 0.0
    vn = (enu_m(lat0, lon0, seg[1]["lat"], seg[1]["lon"])[1] - n0) / dt0 if n > 1 else 0.0
    x = np.array([e0, n0, ve, vn], dtype=float)
    P = np.diag([80.0 ** 2, 80.0 ** 2, 40.0 ** 2, 40.0 ** 2])
    I = np.eye(4)
    H = np.array([[1.0, 0, 0, 0], [0, 1.0, 0, 0]])
    R = np.diag([55.0 ** 2, 55.0 ** 2])
    q_pos, q_vel = 4.0, 2.5
    for i, p in enumerate(seg):
        dt = 1.0 if i == 0 else max(0.4, min(GAP_SPLIT_S, p["t"] - seg[i - 1]["t"]))
        F = np.array([[1, 0, dt, 0], [0, 1, 0, dt], [0, 0, 1, 0], [0, 0, 0, 1]], dtype=float)
        qscale = 1.0 + (dt / 8.0) ** 2
        Q = np.diag([(q_pos * dt * qscale) ** 2, (q_pos * dt * qscale) ** 2, (q_vel * qscale) ** 2, (q_vel * qscale) ** 2])
        xp = F @ x
        Pp = F @ P @ F.T + Q
        x_p[i], P_p[i] = xp, Pp
        z = np.array(enu_m(lat0, lon0, p["lat"], p["lon"]))
        S = H @ Pp @ H.T + R
        innov = z - H @ xp
        try:
            Sinv = np.linalg.inv(S)
        except np.linalg.LinAlgError:
            Sinv = np.linalg.pinv(S)
        maha = float(innov @ Sinv @ innov)
        if maha > 16.0:  # ~4-sigma outlier: predict only
            x, P = xp, Pp
        else:
            K = Pp @ H.T @ Sinv
            x = xp + K @ innov
            P = (I - K @ H) @ Pp
        x_f[i], P_f[i] = x, P
    x_s = [None] * n
    P_s = [None] * n
    x_s[-1], P_s[-1] = x_f[-1], P_f[-1]
    for i in range(n - 2, -1, -1):
        dt = max(0.4, min(GAP_SPLIT_S, seg[i + 1]["t"] - seg[i]["t"]))
        F = np.array([[1, 0, dt, 0], [0, 1, 0, dt], [0, 0, 1, 0], [0, 0, 0, 1]], dtype=float)
        try:
            C = P_f[i] @ F.T @ np.linalg.inv(P_p[i + 1])
        except np.linalg.LinAlgError:
            C = P_f[i] @ F.T @ np.linalg.pinv(P_p[i + 1])
        x_s[i] = x_f[i] + C @ (x_s[i + 1] - x_p[i + 1])
        P_s[i] = P_f[i] + C @ (P_s[i + 1] - P_p[i + 1]) @ C.T
    out = []
    for i, p in enumerate(seg):
        lat, lon = enu_ll(lat0, lon0, float(x_s[i][0]), float(x_s[i][1]))
        q = dict(p)
        q["lat"], q["lon"] = lat, lon
        ve, vn = float(x_s[i][2]), float(x_s[i][3])
        if ve * ve + vn * vn > 1.0:
            q["trk"] = (math.degrees(math.atan2(ve, vn)) + 360.0) % 360.0
        out.append(q)
    return out


# --- Runways -----------------------------------------------------------------

def load_ourairports(airports_csv, runways_csv, iata_wanted):
    """Map IATA -> airport rec + runway ends. Coordinates from OurAirports only."""
    import csv
    wanted = {c.upper() for c in iata_wanted}
    by_iata = {}
    with open(airports_csv, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            iata = (row.get("iata_code") or "").upper()
            if iata not in wanted:
                continue
            try:
                lat, lon = float(row["latitude_deg"]), float(row["longitude_deg"])
            except (TypeError, ValueError):
                continue
            ident = (row.get("ident") or row.get("gps_code") or iata).upper()
            by_iata[iata] = {
                "id": iata,
                "iata": iata,
                "icao": ident,
                "lat": lat,
                "lon": lon,
                "name": row.get("name") or iata,
                "ident": ident,
                "rwys": [],
            }
    ident_to_iata = {v["ident"]: k for k, v in by_iata.items()}
    with open(runways_csv, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            ident = (row.get("airport_ident") or "").upper()
            iata = ident_to_iata.get(ident)
            if not iata or row.get("closed") == "1":
                continue
            ends = []
            for prefix, other in (("le", "he"), ("he", "le")):
                rid = (row.get(f"{prefix}_ident") or "").strip().upper()
                if not rid:
                    continue
                try:
                    lat = float(row[f"{prefix}_latitude_deg"])
                    lon = float(row[f"{prefix}_longitude_deg"])
                    hdg = float(row[f"{prefix}_heading_degT"])
                    olat = float(row[f"{other}_latitude_deg"])
                    olon = float(row[f"{other}_longitude_deg"])
                    length_ft = float(row.get("length_ft") or 0)
                except (TypeError, ValueError):
                    continue
                try:
                    width_ft = float(row.get("width_ft") or 0)
                except (TypeError, ValueError):
                    width_ft = 0.0
                width_m = max(30.0, width_ft * 0.3048) if width_ft else 45.0
                ends.append({
                    "id": rid,
                    "lat": lat,
                    "lon": lon,
                    "hdg": hdg,
                    "end_lat": olat,
                    "end_lon": olon,
                    "length_nm": max(0.5, length_ft * 0.3048 / NM_M),
                    "width_m": width_m,
                })
            by_iata[iata]["rwys"].extend(ends)
    return by_iata


def reassign_buckets(buckets, apts):
    """Re-run assign_runway on cached clips. Does not invent tracks or snap to thresholds."""
    new = defaultdict(list)
    n_ok = n_drop = 0
    for (apt_id, _kind, _rid), fls in buckets.items():
        apt = apts.get(apt_id)
        if not apt:
            continue
        for fl in fls:
            asg = assign_runway(fl.get("pts") or [], apt)
            if not asg:
                new[(apt_id, None, None)].append(fl)
                n_drop += 1
                continue
            new[(apt_id, asg[0], asg[1])].append(fl)
            n_ok += 1
        if (n_ok + n_drop) and (n_ok + n_drop) % 400 == 0:
            print("  reassign", n_ok, "drop", n_drop, apt_id, flush=True)
    return new, n_ok, n_drop


def rwy_frame(rwy, lat, lon):
    """Along (nm, + toward the far end) and cross (nm, + right of the pavement).

    Lateral offset uses the OurAirports threshold→far-end vector, not the
    rounded published heading, so a 2° heading residual cannot look like 60 m
    of cross-track at mid-runway.
    """
    e, n = enu_m(rwy["lat"], rwy["lon"], lat, lon)
    ee, nn = enu_m(rwy["lat"], rwy["lon"], rwy["end_lat"], rwy["end_lon"])
    axis = math.hypot(ee, nn)
    if axis >= 200.0:
        ue, un = ee / axis, nn / axis
    else:
        rad = math.radians(rwy["hdg"])
        ue, un = math.sin(rad), math.cos(rad)
    along = (e * ue + n * un) / NM_M
    cross = (e * un - n * ue) / NM_M
    return along, cross


def _max_cross_nm(rwy):
    """Lateral gate: inside ~one runway width plus ADS-B noise, below half parallel spacing."""
    w = float(rwy.get("width_m") or 45.0)
    return min(ON_RWY_NM, max(0.035, (0.5 * w + 40.0) / NM_M))


def on_runway_hits(pts, rwy):
    """Observed samples on this exact runway end: heading + lateral offset, not taxi.

    Ground-roll (gs ≥ 40 kt on the pavement) preferred; low airborne over the
    strip is accepted when the takeoff/landing roll itself was not received.
    Taxi (slow, parked) is ignored.
    """
    hits = []
    max_c = _max_cross_nm(rwy)
    L = rwy["length_nm"]
    for p in pts:
        if not p:
            continue
        gs = p.get("gs")
        if gs is None:
            gs = 0.0
        alt = _alt(p)
        airborne_low = (not p.get("gnd")) and alt <= ROLL_ALT_FT and gs >= 80
        rolling = gs >= ROLL_GS and (p.get("gnd") or alt <= ROLL_ALT_FT)
        if not (rolling or airborne_low):
            continue
        trk = p.get("trk")
        if trk is None or hdg_err(trk, rwy["hdg"]) > HDG_TOL:
            continue
        along, cross = rwy_frame(rwy, p["lat"], p["lon"])
        if along < -0.08 or along > L + 0.12:
            continue
        if abs(cross) > max_c:
            continue
        hits.append({"p": p, "along": along, "cross": cross, "gs": gs, "alt": alt})
    return hits


def _kind_from_body(body, hits):
    """Climb after the roll = dep; descend into the roll = arr. Along-track
    increases on the same runway heading for both, so it is not used here.
    """
    alt0, alt1 = _alt(body[0]), _alt(body[-1])
    if hits:
        try:
            i0 = body.index(hits[0]["p"])
            i1 = body.index(hits[-1]["p"])
        except ValueError:
            i0, i1 = 0, len(body) - 1
        pre = [_alt(p) for p in body[max(0, i0 - 12):i0]]
        post = [_alt(p) for p in body[i1 + 1:i1 + 16]]
        pre_m = sum(pre) / len(pre) if pre else _alt(hits[0]["p"])
        post_m = sum(post) / len(post) if post else _alt(hits[-1]["p"])
        if post_m - pre_m > 300:
            return "dep"
        if pre_m - post_m > 300:
            return "arr"
        g0, g1 = hits[0]["gs"], hits[-1]["gs"]
        if g1 - g0 > 25:
            return "dep"
        if g0 - g1 > 25:
            return "arr"
    if alt1 - alt0 > 400:
        return "dep"
    if alt0 - alt1 > 400:
        return "arr"
    return None


def assign_runway(pts, apt):
    """Return (dir, rwy_id) or None. dir is 'arr' or 'dep'.

    Assign from ground-roll heading and lateral offset to an OurAirports
    runway end. Parallel runways (27L vs 27R) must be uniquely closer.
    Tracks with no on-runway evidence are discarded, not guessed.
    """
    if not apt.get("rwys") or len(pts) < MIN_PTS:
        return None
    body = [p for p in pts if p]
    if len(body) < MIN_PTS:
        return None
    lat0, lon0 = apt["lat"], apt["lon"]
    near = [p for p in body if hv_nm(p["lat"], p["lon"], lat0, lon0) <= CORE_NM + 6]
    if len(near) < 3:
        return None
    scored = []
    for rwy in apt["rwys"]:
        hits = on_runway_hits(body, rwy)
        if len(hits) < 1:
            continue
        med_c = sorted(abs(h["cross"]) for h in hits)[len(hits) // 2]
        hdg = sum(hdg_err(h["p"].get("trk"), rwy["hdg"]) for h in hits) / len(hits)
        scored.append((med_c + hdg / 800.0, med_c, rwy, hits))
    if not scored:
        return None
    scored.sort(key=lambda x: x[0])
    best_s, best_c, best, hits = scored[0]
    if best_c > ON_RWY_NM:
        return None
    if len(scored) > 1 and (scored[1][1] - best_c) < 0.02:
        # Next runway is within ~37 m of being as close: ambiguous parallel.
        return None
    kind = _kind_from_body(body, hits)
    if not kind:
        return None
    return kind, best["id"]


def roll_and_airborne(pts, rwy, kind):
    """Drop taxi. Keep observed on-runway roll + the airborne continuation.

    Does not snap to the published threshold. If there is no roll, the first
    (dep) or last (arr) low airborne sample over the strip is the anchor.
    """
    body = [p for p in pts if p]
    if not body or not rwy:
        return body
    hits = on_runway_hits(body, rwy)
    if hits:
        i0 = body.index(hits[0]["p"])
        i1 = body.index(hits[-1]["p"])
        if kind == "dep":
            return body[i0:]
        return body[: i1 + 1]
    # No roll received: still drop slow taxi at the ends.
    lo, hi = 0, len(body)
    while lo < hi and _is_surface(body[lo]) and (body[lo].get("gs") or 0) < ROLL_GS:
        lo += 1
    while hi > lo and _is_surface(body[hi - 1]) and (body[hi - 1].get("gs") or 0) < ROLL_GS:
        hi -= 1
    return body[lo:hi] if hi - lo >= 3 else body


def _alt(p):
    a = p.get("alt")
    if a is None or a == "ground":
        return 0.0
    return float(a)


def _corridor_score(probe, rwy, kind):
    xs, hs = [], []
    for p in probe:
        along, cross = rwy_frame(rwy, p["lat"], p["lon"])
        if kind == "arr":
            if along > 0.8 or along < -CORRIDOR_NM:
                continue
        else:
            if along < -0.6 or along > CORRIDOR_NM + rwy["length_nm"]:
                continue
        max_cross = 0.35 + 0.07 * abs(along)  # ~0.35 nm at the threshold, ~1.2 nm at 12 nm
        if abs(cross) > min(HALF_W_NM * 2.2, max_cross):
            continue
        xs.append(abs(cross))
        trk = p.get("trk")
        if trk is not None:
            hs.append(hdg_err(trk, rwy["hdg"]))
    if len(xs) < 2:
        return None
    h = sum(hs) / len(hs) if hs else 90.0
    if h > HDG_TOL:
        return None
    return (sum(xs) / len(xs)) + h / 40.0


# --- Clustering --------------------------------------------------------------

def _stations(total, n=RESAMPLE_N, near=NEAR_M, n_near=NEAR_STATIONS):
    """More samples in the first `near` metres (runway / rotation), then the rest."""
    if n < 4:
        return [total * k / max(1, n - 1) for k in range(n)]
    n_near = min(n - 3, max(4, n_near))
    n_far = n - n_near
    near = min(near, total * 0.45)
    out = [near * k / (n_near - 1) for k in range(n_near)]
    rest = total - near
    for k in range(1, n_far + 1):
        out.append(near + rest * k / n_far)
    return out


def resample_xy(pts, apt, kind, n=RESAMPLE_N, rwy=None):
    body = roll_and_airborne(pts, rwy, kind) if rwy else [p for p in pts if p]
    body = [p for p in body if p]
    if len(body) < 3:
        return None
    lat0, lon0 = apt["lat"], apt["lon"]
    xy = [enu_m(lat0, lon0, p["lat"], p["lon"]) for p in body]
    if kind == "arr":
        xy = list(reversed(xy))  # start near airport
    dist = [0.0]
    for i in range(1, len(xy)):
        de, dn = xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]
        dist.append(dist[-1] + math.hypot(de, dn))
    total = dist[-1]
    if total < 2500:
        return None
    out = []
    j = 0
    for t in _stations(total, n):
        while j + 1 < len(dist) and dist[j + 1] < t:
            j += 1
        if j + 1 >= len(dist):
            out.extend(xy[-1])
        else:
            u = 0 if dist[j + 1] == dist[j] else (t - dist[j]) / (dist[j + 1] - dist[j])
            out.append(xy[j][0] + u * (xy[j + 1][0] - xy[j][0]))
            out.append(xy[j][1] + u * (xy[j + 1][1] - xy[j][1]))
    return np.array(out, dtype=float)


def dbscan(X, eps, min_samples):
    n = len(X)
    labels = np.full(n, -1, dtype=int)
    visited = np.zeros(n, dtype=bool)
    cid = 0

    def neigh(i):
        d = np.sqrt(((X - X[i]) ** 2).sum(axis=1))
        return np.where(d <= eps)[0]

    for i in range(n):
        if visited[i]:
            continue
        visited[i] = True
        nb = neigh(i)
        if len(nb) < min_samples:
            continue
        labels[i] = cid
        seeds = list(nb)
        k = 0
        while k < len(seeds):
            j = seeds[k]
            if not visited[j]:
                visited[j] = True
                nbj = neigh(j)
                if len(nbj) >= min_samples:
                    for q in nbj:
                        if q not in seeds:
                            seeds.append(q)
            if labels[j] == -1:
                labels[j] = cid
            k += 1
        cid += 1
    return labels


def cluster_group(flights, apt, kind, rwy=None):
    """flights: list of {pts, ...}. Returns clusters with path, p25, p75, n, share."""
    vecs, keep = [], []
    for i, fl in enumerate(flights):
        v = resample_xy(fl["pts"], apt, kind, rwy=rwy)
        if v is None:
            continue
        vecs.append(v)
        keep.append(i)
    if not vecs:
        return []
    X = np.vstack(vecs)
    n = len(X)
    if n < 4:
        labels = np.zeros(n, dtype=int)
    else:
        # eps in metres across RESAMPLE_N stations
        eps = CLUSTER_EPS_NM * NM_M * math.sqrt(RESAMPLE_N)
        min_s = 3 if n < 12 else max(3, n // 8)
        labels = dbscan(X, eps, min_s)
        if (labels >= 0).sum() < max(3, n // 5):
            labels = np.zeros(n, dtype=int)
    counts = defaultdict(int)
    for lab in labels:
        if lab >= 0:
            counts[int(lab)] += 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    clusters = []
    for rank, (lab, cnt) in enumerate(ranked):
        share = cnt / n
        if rank > 0 and (share < 0.15 or cnt < 4):
            continue
        idx = [i for i, lab_i in enumerate(labels) if lab_i == lab]
        sub = X[idx]
        # medoid
        dsum = ((sub[:, None, :] - sub[None, :, :]) ** 2).sum(axis=2).sum(axis=1)
        med = sub[int(np.argmin(dsum))]
        mean = sub.mean(axis=0)
        p25, p75 = (med, med) if len(sub) < 4 else _cross_track_band(med, sub)
        path = _vec_to_ll(med, apt, kind)
        members = [keep[i] for i in idx]
        path = _anchor_observed(path, [flights[i] for i in members], apt, kind, rwy)
        clusters.append({
            "n": int(cnt),
            "share": round(cnt / len(flights), 3),
            "path": path,
            "mean": _vec_to_ll(mean, apt, kind),
            "p25": _vec_to_ll(p25, apt, kind),
            "p75": _vec_to_ll(p75, apt, kind),
            "members": members,
        })
        if len(clusters) >= 2:
            break
    return clusters


def _cross_track_band(med, sub):
    """p25/p75 of signed cross-track offset at each station, relative to the medoid."""
    n_pts = len(med) // 2
    M = med.reshape(n_pts, 2)
    S = sub.reshape(len(sub), n_pts, 2)
    lo = np.array(M, copy=True)
    hi = np.array(M, copy=True)
    for i in range(n_pts):
        j = i + 1 if i + 1 < n_pts else i - 1
        de, dn = M[j, 0] - M[i, 0], M[j, 1] - M[i, 1]
        if i + 1 >= n_pts:
            de, dn = -de, -dn
        L = math.hypot(de, dn) or 1.0
        px, py = -dn / L, de / L
        cross = (S[:, i, 0] - M[i, 0]) * px + (S[:, i, 1] - M[i, 1]) * py
        cap = 0.4 * NM_M
        a, b = np.percentile(cross, 25), np.percentile(cross, 75)
        a, b = float(np.clip(a, -cap, cap)), float(np.clip(b, -cap, cap))
        lo[i] = M[i] + a * np.array([px, py])
        hi[i] = M[i] + b * np.array([px, py])
    return lo.reshape(-1), hi.reshape(-1)


def _vec_to_ll(vec, apt, kind):
    pts = []
    for i in range(0, len(vec), 2):
        lat, lon = enu_ll(apt["lat"], apt["lon"], float(vec[i]), float(vec[i + 1]))
        pts.append(rr_near(lon, lat, apt))
    if kind == "arr":
        pts.reverse()
    return pts


def _anchor_observed(path, flights, apt, kind, rwy):
    """Replace the airport-end vertex with the median of observed roll positions.

    True ADS-B samples, not a synthetic snap to the OurAirports threshold.
    """
    if not path or not flights:
        return path
    pts = []
    for fl in flights:
        body = roll_and_airborne(fl["pts"], rwy, kind) if rwy else [p for p in fl["pts"] if p]
        body = [p for p in body if p]
        if not body:
            continue
        p = body[0] if kind == "dep" else body[-1]
        pts.append((p["lat"], p["lon"]))
    if not pts:
        return path
    slat = sorted(p[0] for p in pts)
    slon = sorted(p[1] for p in pts)
    mlat, mlon = slat[len(pts) // 2], slon[len(pts) // 2]
    # Medoid of observed samples — an actual ADS-B point, not a mean or snap.
    best = min(pts, key=lambda p: (p[0] - mlat) ** 2 + ((p[1] - mlon) * math.cos(math.radians(mlat))) ** 2)
    vertex = rr_near(best[1], best[0], apt)
    out = [list(x) for x in path]
    if kind == "dep":
        out[0] = vertex
    else:
        out[-1] = vertex
    return out


# --- Trace parsing -----------------------------------------------------------

def maybe_gunzip(raw: bytes) -> bytes:
    if raw[:2] == b"\x1f\x8b":
        return gzip.decompress(raw)
    return raw


def airline_of(reg, flight, hexid):
    r = (reg or "").upper().replace(" ", "")
    f = (flight or "").upper().replace(" ", "")
    h = (hexid or "").lower()
    if f.startswith("QTR") or r.startswith("A7-"):
        return "QTR"
    if f.startswith("UAE") or r.startswith("A6-E"):
        return "UAE"
    if h.startswith("06a"):
        return "QTR"
    if h.startswith("896"):
        return "UAE"
    return None


def parse_trace(raw, hex_from_name=None):
    try:
        j = json.loads(maybe_gunzip(raw))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    icao = (j.get("icao") or hex_from_name or "").lower()
    reg = j.get("r") or ""
    typ = j.get("t") or ""
    t0 = float(j.get("timestamp") or 0)
    trace = j.get("trace") or []
    flight = ""
    pts = []
    for row in trace:
        if not isinstance(row, (list, tuple)) or len(row) < 6:
            continue
        flags = int(row[6] or 0) if len(row) > 6 else 0
        extra = row[8] if len(row) > 8 and isinstance(row[8], dict) else None
        if extra and extra.get("flight"):
            flight = extra["flight"]
        lat, lon = row[1], row[2]
        if lat is None or lon is None:
            continue
        alt = row[3]
        gnd = alt == "ground"
        if gnd:
            alt = 0
        pts.append({
            "t": t0 + float(row[0] or 0),
            "lat": float(lat),
            "lon": float(lon),
            "alt": None if alt is None else (0 if gnd else float(alt)),
            "gs": None if row[4] is None else float(row[4]),
            "trk": None if row[5] is None else float(row[5]),
            "gnd": gnd,
            "leg": bool(flags & 2),
            "stale": bool(flags & 1),
            "flight": flight,
        })
    al = airline_of(reg, flight, icao)
    if not al or len(pts) < MIN_PTS:
        return None
    return {"hex": icao, "reg": reg, "t": typ, "al": al, "pts": pts, "t0": t0, "cs": (flight or "").strip()}


def split_legs(pts):
    segs, cur = [], []
    for p in pts:
        if p.get("leg") and cur:
            segs.append(cur)
            cur = []
        if cur and p["t"] - cur[-1]["t"] > GAP_SPLIT_S:
            segs.append(cur)
            cur = []
        if p.get("stale") and cur and p["t"] - cur[-1]["t"] > 40:
            continue
        cur.append(p)
    if cur:
        segs.append(cur)
    return [s for s in segs if len(s) >= MIN_PTS]


def clip_to_airport(pts, apt, nm=CLIP_NM):
    lat0, lon0 = apt["lat"], apt["lon"]
    box = nm / 60.0 + 0.15
    hits = []
    cur = []
    for p in pts:
        if abs(p["lat"] - lat0) > box or abs(p["lon"] - lon0) > box / max(0.2, math.cos(math.radians(lat0))):
            if cur:
                hits.append(cur)
                cur = []
            continue
        if hv_nm(p["lat"], p["lon"], lat0, lon0) <= nm:
            cur.append(p)
        elif cur:
            hits.append(cur)
            cur = []
    if cur:
        hits.append(cur)
    out = []
    for h in hits:
        if len(h) < MIN_PTS:
            continue
        if min(hv_nm(p["lat"], p["lon"], lat0, lon0) for p in h) > CORE_NM:
            continue
        out.append(h)
    return out


def observed_qtr_airports(h2h):
    """IATA codes QTR actually served in the 365-day aggregates (both ends of map rows)."""
    ap = defaultdict(lambda: {"n": 0, "inf": 0})
    for row in h2h.get("map") or []:
        if not row or row[0] != "QTR":
            continue
        _, o, d, n, inf = row[0], row[1], row[2], row[3], row[4] if len(row) > 4 else 0
        for x in (o, d):
            ap[x]["n"] += n
            ap[x]["inf"] += inf
    return dict(ap)


def pack_tile(apt, flights_by_key, geom_days, h2h_n, h2h_inf, window):
    rwys = []
    raw = []
    discarded = {"ambiguous": 0, "too_short": 0}
    n_ok = 0
    dayset = set()
    for (kind, rid), fls in sorted(flights_by_key.items(), key=lambda kv: (-len(kv[1]), kv[0][1], kv[0][0])):
        if not RWY_ID.match(str(rid or "")):
            continue
        usable = []
        for fl in fls:
            body = [p for p in fl["pts"] if p]
            if len(body) < MIN_PTS:
                discarded["too_short"] += 1
                continue
            usable.append(fl)
            if fl.get("t0"):
                dayset.add(dt.datetime.utcfromtimestamp(fl["t0"]).strftime("%Y-%m-%d"))
        if not usable:
            continue
        rwy = next((r for r in apt.get("rwys") or [] if r["id"] == rid), None)
        clusters = cluster_group(usable, apt, kind, rwy=rwy)
        if not clusters:
            continue
        n_ok += len(usable)
        rwys.append({
            "id": rid,
            "dir": kind,
            "n": len(usable),
            "clusters": [{k: v for k, v in c.items() if k != "members"} for c in clusters],
        })
        # subsample smoothed tracks for the clutter toggle
        take = usable[:RAW_CAP]
        for fl in take:
            seg, cur = [], []
            for p in fl["pts"]:
                if p is None:
                    if len(cur) >= 2:
                        seg.append([rr_near(x["lon"], x["lat"], apt) for x in cur])
                    cur = []
                    continue
                cur.append(p)
            if len(cur) >= 2:
                seg.append([rr_near(x["lon"], x["lat"], apt) for x in cur])
            if seg:
                raw.append({"a": fl.get("al") or "QTR", "dir": kind, "rwy": rid, "seg": seg})
    return {
        "apt": apt["id"],
        "icao": apt["icao"],
        "iata": apt["iata"],
        "name": apt["name"],
        "lat": rr(apt["lat"], 6),
        "lon": rr(apt["lon"], 6),
        "from": window[0],
        "to": window[1],
        "geom_days": sorted(dayset) or geom_days,
        "h2h_n": h2h_n,
        "h2h_inf": h2h_inf,
        "n_assigned": n_ok,
        "discarded": discarded,
        "rwys": rwys,
        "raw": raw,
        "note": "Observed ADS-B terminal-area tracks (adsb.lol, ODbL). Ground-roll samples are not Kalman-smoothed. Assigned by heading and lateral offset to one OurAirports runway end (parallels are not merged). Representative paths are the medoid of the dominant cluster, anchored at the median observed on-runway position — not snapped to the published threshold. Not published SID/STAR procedures.",
    }
