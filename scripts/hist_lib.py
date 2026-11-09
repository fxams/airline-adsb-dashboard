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
ON_RWY_NM = 0.22
HDG_TOL = 28.0
GAP_SPLIT_S = 180.0
MIN_PTS = 8
RESAMPLE_N = 28
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
    out = []
    for seg in segs:
        out.extend(_rts_seg(seg, lat0, lon0))
        out.append(None)
    if out and out[-1] is None:
        out.pop()
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
                ends.append({
                    "id": rid,
                    "lat": lat,
                    "lon": lon,
                    "hdg": hdg,
                    "end_lat": olat,
                    "end_lon": olon,
                    "length_nm": max(0.5, length_ft * 0.3048 / NM_M),
                })
            by_iata[iata]["rwys"].extend(ends)
    return by_iata


def rwy_frame(rwy, lat, lon):
    """Along (nm, + along heading from threshold) and cross (nm, + right)."""
    e, n = enu_m(rwy["lat"], rwy["lon"], lat, lon)
    rad = math.radians(rwy["hdg"])
    along = (n * math.cos(rad) + e * math.sin(rad)) / NM_M
    cross = (e * math.cos(rad) - n * math.sin(rad)) / NM_M
    return along, cross


def assign_runway(pts, apt):
    """Return (dir, rwy_id) or None. dir is 'arr' or 'dep'.

    Uses first/last low samples vs OurAirports runway ends: heading + position
    in a departure/arrival corridor. Ambiguous tracks are discarded.
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
    alts = [p["alt"] for p in body if p.get("alt") is not None and p["alt"] != "ground"]
    if not alts:
        return None
    first, last = body[0], body[-1]
    d0 = hv_nm(first["lat"], first["lon"], lat0, lon0)
    d1 = hv_nm(last["lat"], last["lon"], lat0, lon0)
    alt0 = _alt(first)
    alt1 = _alt(last)
    climbing = alt1 - alt0 > 400 or (d1 - d0 > 4 and alt1 > alt0)
    descending = alt0 - alt1 > 400 or (d0 - d1 > 4 and alt0 > alt1)
    if climbing and not descending:
        kind = "dep"
        probe = body[: max(4, len(body) // 5)]
    elif descending and not climbing:
        kind = "arr"
        probe = body[-max(4, len(body) // 5) :]
    else:
        if d1 + 1.5 < d0:
            kind, probe = "arr", body[-max(4, len(body) // 5) :]
        elif d0 + 1.5 < d1:
            kind, probe = "dep", body[: max(4, len(body) // 5)]
        else:
            return None
    best, best_s = None, None
    for rwy in apt["rwys"]:
        score = _corridor_score(probe, rwy, kind)
        if score is None:
            continue
        if best_s is None or score < best_s:
            best, best_s = rwy, score
    if best is None or best_s > 2.4:
        return None
    second = None
    for rwy in apt["rwys"]:
        if rwy is best:
            continue
        s = _corridor_score(probe, rwy, kind)
        if s is not None and (second is None or s < second):
            second = s
    if second is not None and abs(best_s - second) < 0.06:
        return None  # parallel runways, not closer to either centreline
    return kind, best["id"]


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

def resample_xy(pts, apt, kind, n=RESAMPLE_N):
    body = [p for p in pts if p]
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
    for k in range(n):
        t = total * k / (n - 1)
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


def cluster_group(flights, apt, kind):
    """flights: list of {pts, ...}. Returns clusters with path, p25, p75, n, share."""
    vecs, keep = [], []
    for i, fl in enumerate(flights):
        v = resample_xy(fl["pts"], apt, kind)
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
        clusters.append({
            "n": int(cnt),
            "share": round(cnt / len(flights), 3),
            "path": _vec_to_ll(med, apt, kind),
            "mean": _vec_to_ll(mean, apt, kind),
            "p25": _vec_to_ll(p25, apt, kind),
            "p75": _vec_to_ll(p75, apt, kind),
            "members": [keep[i] for i in idx],
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
        pts.append([rr(lon), rr(lat)])
    if kind == "arr":
        pts.reverse()
    return pts


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
        clusters = cluster_group(usable, apt, kind)
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
                        seg.append([[rr(x["lon"]), rr(x["lat"])] for x in cur])
                    cur = []
                    continue
                cur.append(p)
            if len(cur) >= 2:
                seg.append([[rr(x["lon"]), rr(x["lat"])] for x in cur])
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
        "note": "Observed ADS-B terminal-area tracks (adsb.lol, ODbL), Kalman/RTS-smoothed, clustered per runway and direction. Representative paths are the medoid of the dominant cluster. Not published SID/STAR procedures.",
    }
