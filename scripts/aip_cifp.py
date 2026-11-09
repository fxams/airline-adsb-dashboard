"""Parse FAA CIFP ARINC 424-18 SID/STAR records (licence-safe US data only).

Straight lines between published fixes. Heading-only legs (VA/CA/VM/…) without
a fix are omitted rather than invented. Not for navigation.
"""
from __future__ import annotations

import gzip
import json
import math
import os
import re
from collections import defaultdict

from aip_policy import is_draw, policy_for

NM = 3440.065
CLIP_NM = 40.0
MATCH_MEAN_NM = 4.2
MATCH_MAX_NM = 14.0
MATCH_CLIP_NM = 18.0
MAX_FIXES = 24

# ARINC 424 route types we treat as runway-related (prefer these for matching).
SID_RWY_RT = set("14")
STAR_RWY_RT = set("36")
SID_COMMON_RT = set("25")
STAR_COMMON_RT = set("25")

LATLON_RE = re.compile(r"([NS])(\d{2})(\d{2})(\d{4})([EW])(\d{3})(\d{2})(\d{4})")
RWY_RE = re.compile(r"^RW?(\d{1,2})([LCRWB]?)$")


def rr(x, n=5):
    return round(float(x), n)


def decode_latlon(s):
    m = LATLON_RE.search(s or "")
    if not m:
        return None
    ns, d, mn, sec, ew, D, MN, SEC = m.groups()
    lat = int(d) + int(mn) / 60.0 + int(sec) / 100.0 / 3600.0
    lon = int(D) + int(MN) / 60.0 + int(SEC) / 100.0 / 3600.0
    if ns == "S":
        lat = -lat
    if ew == "W":
        lon = -lon
    if abs(lat) > 90 or abs(lon) > 180:
        return None
    return lat, lon


def hv_nm(lat1, lon1, lat2, lon2):
    r = math.pi / 180.0
    x = math.sin((lat2 - lat1) * r / 2) ** 2 + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2
    return 2 * NM * math.asin(math.sqrt(min(1.0, x)))


def dist_point_seg_nm(lat, lon, a, b):
    """a,b are [lon,lat]. Approximate local metres."""
    lat0 = (a[1] + b[1] + lat) / 3.0
    klat = 60.0
    klon = 60.0 * math.cos(math.radians(lat0))
    x, y = (lon - a[0]) * klon, (lat - a[1]) * klat
    x2, y2 = (b[0] - a[0]) * klon, (b[1] - a[1]) * klat
    L2 = x2 * x2 + y2 * y2
    t = 0.0 if L2 < 1e-12 else max(0.0, min(1.0, (x * x2 + y * y2) / L2))
    dx, dy = x - t * x2, y - t * y2
    return math.hypot(dx, dy)


def path_stats(hist, proc):
    """Mean/max nm of hist points to nearest proc segment (and reverse)."""
    if not hist or not proc or len(hist) < 2 or len(proc) < 2:
        return None
    def mean_to(src, dst):
        acc = []
        for p in src:
            lat, lon = p[1], p[0]
            best = 1e9
            for i in range(len(dst) - 1):
                d = dist_point_seg_nm(lat, lon, dst[i], dst[i + 1])
                if d < best:
                    best = d
            acc.append(best)
        return sum(acc) / len(acc), max(acc)
    m1, x1 = mean_to(hist, proc)
    m2, x2 = mean_to(proc, hist)
    return (m1 + m2) / 2.0, max(x1, x2)


def norm_rwy(s):
    s = re.sub(r"^RW", "", (s or "").upper())
    m = re.match(r"^0?(\d{1,2})([LCRWB]?)$", s)
    if not m:
        return s
    return m.group(1).zfill(2) + m.group(2)


def rwy_from_trans(trans):
    t = (trans or "").upper()
    m = RWY_RE.match(t) or RWY_RE.match(t.replace("RWY", "RW"))
    if not m:
        if t.startswith("RW"):
            m = RWY_RE.match("RW" + t[2:])
        if not m:
            return ""
    return m.group(1).zfill(2) + m.group(2)


def parse_header(line):
    """CIFP HDR record: cycle YYMM and production date."""
    cycle = (line[32:36] if len(line) > 36 else "").strip()
    prod = (line[37:48] if len(line) > 48 else "").strip()
    return {"cycle": cycle or "2611", "produced": prod}


def index_fixes(path):
    """Build ident -> (lat,lon) from PC/PN/PA/PG/EA/D/DB."""
    by_key = {}
    by_id = {}

    def add(ident, region, kind, lat, lon):
        ident = (ident or "").strip()
        if not ident or lat is None:
            return
        key = (ident, (region or "").strip(), kind)
        by_key[key] = (lat, lon)
        by_id.setdefault(ident, (lat, lon))

    with open(path, encoding="latin-1") as f:
        for line in f:
            if len(line) < 50:
                continue
            ss = line[4:6]  # section+subsection: EA, D , DB, or P + col13 sub
            ll = decode_latlon(line)
            if not ll:
                continue
            lat, lon = ll
            if ss[0] == "P":
                sub = line[12]
                ident = line[13:18].strip()
                add(ident, line[10:12], "P" + sub, lat, lon)
                if sub == "G":
                    add(ident, line[6:10], "PG", lat, lon)
            elif ss == "EA":
                ident = line[13:18].strip()
                region = line[19:21].strip() or line[10:12]
                add(ident, region, "EA", lat, lon)
            elif ss[0] == "D":
                ident = line[13:17].strip()
                add(ident, line[19:21].strip() or line[10:12], "D" + ss[1].strip(), lat, lon)
    return by_key, by_id


def lookup_fix(ident, region, kind, by_key, by_id):
    ident = (ident or "").strip()
    if not ident:
        return None
    region = (region or "").strip()
    kind = (kind or "").strip()
    for k in (
        (ident, region, kind),
        (ident, region, "PC"),
        (ident, region, "EA"),
        (ident, region, "PA"),
        (ident, region, "PG"),
        (ident, region, "PN"),
        (ident, region, "D"),
        (ident, region, "DB"),
    ):
        if k in by_key:
            return by_key[k]
    return by_id.get(ident)


def parse_proc_records(path, want_icao):
    """Collect PD/PE legs for a set of airport ICAO ids."""
    want = set(want_icao)
    legs = defaultdict(list)
    with open(path, encoding="latin-1") as f:
        for line in f:
            if len(line) < 50:
                continue
            if line[4] != "P" or line[12] not in "DE":
                continue
            apt = line[6:10]
            if apt not in want:
                continue
            # skip continuation records (col 39 1-indexed = 38 0-indexed)
            cont = line[38] if len(line) > 38 else "0"
            if cont not in "0 ":
                continue
            kind = "sid" if line[12] == "D" else "star"
            # ARINC 424-18 1-indexed: ident 14-19, route type 20, trans 21-25,
            # seq 27-29, fix 30-34, ICAO 35-36, sec/sub 37-38, cont 39, path term 48-49.
            proc = line[13:19].strip()
            rt = line[19]
            trans = line[20:25].strip()
            try:
                seq = int(line[26:29])
            except ValueError:
                continue
            fix = line[29:34].strip()
            region = line[34:36].strip()
            fsec = (line[36] + line[37]).strip() if len(line) > 37 else ""
            path_term = line[47:49].strip() if len(line) > 49 else ""
            legs[(apt, kind, proc, rt, trans)].append(
                {"seq": seq, "fix": fix, "region": region, "fsec": fsec, "term": path_term}
            )
    return legs


def trim_to_clip(coords, fixes, lat0, lon0, nm=CLIP_NM):
    """Keep terminal-area fixes plus one neighbour outside the clip."""
    if len(coords) < 2:
        return None, []
    inside = [hv_nm(lat0, lon0, c[1], c[0]) <= nm for c in coords]
    if not any(inside):
        near = [(hv_nm(lat0, lon0, c[1], c[0]), i) for i, c in enumerate(coords)]
        near.sort()
        if near[0][0] > nm * 1.6:
            return None, []
        pick = sorted({near[0][1], near[1][1]})
        return [coords[i] for i in pick], [fixes[i] for i in pick]
    keep = [False] * len(coords)
    for i, inn in enumerate(inside):
        if not inn:
            continue
        keep[i] = True
        if i:
            keep[i - 1] = True
        if i + 1 < len(coords):
            keep[i + 1] = True
    out_c = [c for c, k in zip(coords, keep) if k]
    out_f = [f for f, k in zip(fixes, keep) if k]
    # cap length but keep airport-near end
    if len(out_c) > MAX_FIXES:
        out_c, out_f = out_c[:MAX_FIXES], out_f[:MAX_FIXES]
    return (out_c, out_f) if len(out_c) >= 2 else (None, [])


def runway_start(apt, trans, by_key, by_id):
    """Published runway-end coordinate from CIFP PG, if the transition is RWYxx."""
    rwy = rwy_from_trans(trans)
    if not rwy:
        return None, None
    ident = "RW" + rwy
    key = (ident, apt, "PG")
    if key in by_key:
        lat, lon = by_key[key]
        return [rr(lon), rr(lat)], ident
    # RW31B → try 31L / 31R
    if rwy.endswith("B") and len(rwy) >= 3:
        for sfx in "LR":
            ident = "RW" + rwy[:-1] + sfx
            key = (ident, apt, "PG")
            if key in by_key:
                lat, lon = by_key[key]
                return [rr(lon), rr(lat)], ident
    return None, None


def legs_to_path(items, apt, lat0, lon0, by_key, by_id, trans=""):
    items = sorted(items, key=lambda x: x["seq"])
    coords, fixes = [], []
    last = None
    region_fallback = apt[1:3] if len(apt) == 4 else ""
    rw_pt, rw_id = runway_start(apt, trans, by_key, by_id)
    if rw_pt:
        coords.append(rw_pt)
        fixes.append(rw_id)
        last = rw_pt
    for it in items:
        if not it["fix"]:
            continue
        ll = lookup_fix(it["fix"], it["region"] or region_fallback, it["fsec"], by_key, by_id)
        if not ll:
            ll = lookup_fix(it["fix"], it["region"], "", by_key, by_id)
        if not ll:
            continue
        lat, lon = ll
        pt = [rr(lon), rr(lat)]
        if last == pt:
            continue
        coords.append(pt)
        fixes.append(it["fix"])
        last = pt
    return trim_to_clip(coords, fixes, lat0, lon0, CLIP_NM)


def clip_path(path, lat0, lon0, nm=CLIP_NM):
    out = []
    for pt in path:
        if hv_nm(lat0, lon0, pt[1], pt[0]) <= nm:
            out.append(pt)
        else:
            if out:
                out.append(pt)
            break
    return out if len(out) >= 2 else []


def parse_cifp(path, airports):
    """airports: list of dicts with icao, iata, lat, lon, id/name.

    Returns {icao: {meta, procs}} for DRAW airports present in CIFP.
    """
    header = {"cycle": "2611", "produced": ""}
    with open(path, encoding="latin-1") as f:
        first = f.readline()
        if first.startswith("HDR"):
            header = parse_header(first)
    draw = [a for a in airports if is_draw(a.get("icao"), a.get("iata") or a.get("id"))]
    want = {a["icao"] for a in draw if a.get("icao")}
    by_key, by_id = index_fixes(path)
    legs = parse_proc_records(path, want)
    by_apt = {a["icao"]: a for a in draw}
    out = {}
    for (apt, kind, proc, rt, trans), items in legs.items():
        meta = by_apt.get(apt)
        if not meta:
            continue
        path_ll, fixes = legs_to_path(items, apt, meta["lat"], meta["lon"], by_key, by_id, trans)
        if not path_ll:
            continue
        rec = {
            "id": proc,
            "kind": kind,
            "rt": rt,
            "trans": trans,
            "rwy": rwy_from_trans(trans),
            "path": path_ll,
            "fixes": fixes,
        }
        slot = out.setdefault(apt, {"procs": []})
        slot["procs"].append(rec)
    for apt, slot in out.items():
        slot["header"] = header
        slot["n_sid"] = sum(1 for p in slot["procs"] if p["kind"] == "sid")
        slot["n_star"] = sum(1 for p in slot["procs"] if p["kind"] == "star")
    return out, header


def match_hist(procs, hist_tile, lat0, lon0):
    """Nearest published SID/STAR vs each observed runway representative.

    Only called for licence-safe (DRAW) airports. Returns a list of matches
    or an empty list when nothing is close enough — never invents a name.
    """
    if not hist_tile or not procs:
        return []
    sids = [p for p in procs if p["kind"] == "sid"]
    stars = [p for p in procs if p["kind"] == "star"]
    matches = []
    for r in hist_tile.get("rwys") or []:
        cluster = (r.get("clusters") or [None])[0]
        if not cluster or not cluster.get("path") or len(cluster["path"]) < 2:
            continue
        hist_path = clip_path(cluster["path"], lat0, lon0, MATCH_CLIP_NM) or clip_path(cluster["path"], lat0, lon0, CLIP_NM) or cluster["path"]
        pool = sids if r.get("dir") == "dep" else stars
        if not pool:
            continue
        want = norm_rwy(r.get("id"))
        rwy_rt = SID_RWY_RT if r.get("dir") == "dep" else STAR_RWY_RT
        ranked = []
        for p in pool:
            pr = clip_path(p["path"], lat0, lon0, MATCH_CLIP_NM) or p["path"]
            st = path_stats(hist_path, pr)
            if not st:
                continue
            mean_nm, max_nm = st
            same = False
            prwy = norm_rwy(p.get("rwy"))
            if want and prwy:
                if prwy.endswith("B") and prwy[:2] == want[:2]:
                    same = True
                elif prwy == want:
                    same = True
            # Do not pin a different runway's transition onto this observed path.
            if want and prwy and not same:
                continue
            rt_rank = 0 if p.get("rt") in rwy_rt else 1
            ranked.append((0 if same else 1, rt_rank, mean_nm, max_nm, p["id"], p.get("trans") or "", p))
        if not ranked:
            continue
        ranked.sort(key=lambda x: (x[0], x[1], x[2], x[3], x[4], x[5]))
        # prefer same-runway if it is within threshold; else best overall
        pick = None
        for samei, _rt, mean_nm, max_nm, _pid, _tr, p in ranked:
            if mean_nm <= MATCH_MEAN_NM and max_nm <= MATCH_MAX_NM:
                pick = (mean_nm, max_nm, p)
                break
        if not pick:
            continue
        mean_nm, max_nm, p = pick
        matches.append({
            "hist_rwy": r.get("id"),
            "hist_dir": r.get("dir"),
            "hist_n": r.get("n"),
            "proc": p["id"],
            "trans": p.get("trans") or "",
            "rwy": p.get("rwy") or "",
            "kind": p["kind"],
            "mean_nm": rr(mean_nm, 2),
            "max_nm": rr(max_nm, 2),
            "note": "Nearest licence-safe published procedure to the observed representative path. Not a clearance and not for navigation.",
        })
    return matches


def load_hist_tile(hist_dir, iata):
    fp = os.path.join(hist_dir, iata + ".json.gz")
    if not os.path.isfile(fp):
        return None
    with gzip.open(fp, "rt", encoding="utf-8") as f:
        return json.load(f)


def pack_tile(apt, parsed, header, hist_tile):
    pol = policy_for(apt["icao"], apt.get("iata") or apt.get("id"))
    procs = (parsed or {}).get("procs") or []
    matches = []
    if pol["mode"] == "draw" and procs:
        matches = match_hist(procs, hist_tile, apt["lat"], apt["lon"])
    return {
        "apt": apt.get("id") or apt.get("iata"),
        "icao": apt["icao"],
        "iata": apt.get("iata") or apt.get("id"),
        "name": apt.get("name"),
        "lat": apt["lat"],
        "lon": apt["lon"],
        "mode": pol["mode"],
        "state": pol["state"],
        "source": pol["aip"],
        "source_url": pol["aip_url"],
        "ad2_url": pol["ad2_url"],
        "ad2_label": pol["ad2_label"],
        "terms_url": pol["terms_url"],
        "terms": pol["terms"],
        "why": pol["why"],
        "airac": (header.get("airac") or "2611") if pol["mode"] == "draw" else None,
        "cycle": (("CIFP " + header["cycle_id"]) if header.get("cycle_id") else ("CIFP " + (header.get("cycle") or ""))) if pol["mode"] == "draw" else None,
        "effective_utc": "2026-10-29" if pol["mode"] == "draw" else None,
        "until_utc": "2026-11-26" if pol["mode"] == "draw" else None,
        "disclaimer": "Not for navigation. Not for operational flight planning. Straight lines between published fixes; heading-only legs omitted.",
        "n_sid": sum(1 for p in procs if p["kind"] == "sid"),
        "n_star": sum(1 for p in procs if p["kind"] == "star"),
        "n_match": len(matches),
        "procs": procs if pol["mode"] == "draw" else [],
        "match": matches,
        "note": (
            "FAA CIFP ARINC 424-18 cycle 2611 (CIFP 261029, effective 2026-10-29 to 2026-11-26 UTC). "
            "US government work, 17 U.S.C. § 105. Drawn SID/STAR are published fixes only. "
            "Nearest-procedure labels compare observed Kalman runway representatives to CIFP paths "
            "and are omitted when no procedure is close enough. Not Navigraph/Jeppesen."
            if pol["mode"] == "draw"
            else (
                "SID/STAR geometry is not redrawn. Open the official AIP AD 2 page. "
                + pol["why"]
            )
        ),
    }
