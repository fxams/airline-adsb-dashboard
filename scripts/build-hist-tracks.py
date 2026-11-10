#!/usr/bin/env python3
"""Build compressed per-airport 365-day terminal-area track tiles.

Airport list is derived from observed QTR ends in data/h2h.json (adsb.lol
globe_history aggregates). Geometry is clipped from readsb traces in
adsblol/globe_history_* daily tars (ODbL 1.0). Runway ends are OurAirports
(public domain).

Free-plan limits:
  Render free cannot run this job (ephemeral disk, ~512 MB RAM, 3.5 GB/day).
  This script is the incremental builder: run locally (or any machine with
  disk) for one or more UTC days, then commit the small data/hist/*.json.gz
  tiles. Do not add a paid Render cron or Blueprint service.

Usage:
  python3 scripts/build-hist-tracks.py --day 2026-11-03 --tar aa --tar ab
  python3 scripts/build-hist-tracks.py --day 2026-11-03 --fetch
  python3 scripts/build-hist-tracks.py --fixture test  # synthetic EGLL/DOH/JFK
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import io
import json
import os
import re
import sys
import tarfile
import time
import urllib.request
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from hist_lib import (
    HEX_QTR_UAE,
    assign_runway,
    clip_to_airport,
    kalman_rts,
    load_ourairports,
    observed_qtr_airports,
    pack_tile,
    parse_trace,
    reassign_buckets,
    split_legs,
)

UA = "airline-adsb-dashboard hist-builder (ODbL; fxams/airline-adsb-dashboard)"
OA_AIR = "https://davidmegginson.github.io/ourairports-data/airports.csv"
OA_RWY = "https://davidmegginson.github.io/ourairports-data/runways.csv"
WINDOW = ("2025-11-04", "2026-11-03")
MISSING_DUMPS = ["2026-05-06"]


class ChainReader(io.RawIOBase):
    def __init__(self, paths):
        self.paths = list(paths)
        self.i = 0
        self.fp = None
        self.n = 0

    def readable(self):
        return True

    def readinto(self, b):
        got = 0
        want = len(b)
        while got < want:
            if self.fp is None:
                if self.i >= len(self.paths):
                    break
                p = self.paths[self.i]
                self.i += 1
                self.fp = open(p, "rb")
            chunk = self.fp.read(want - got)
            if not chunk:
                self.fp.close()
                self.fp = None
                continue
            b[got:got + len(chunk)] = chunk
            got += len(chunk)
            self.n += len(chunk)
        return got


def fetch(url, dest):
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        while True:
            c = r.read(1 << 20)
            if not c:
                break
            f.write(c)
    return dest


def release_assets(day):
    y, m, d = day.split("-")
    repo = f"adsblol/globe_history_{y}"
    tag = f"v{y}.{m}.{d}-planes-readsb-prod-0"
    url = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.load(r)
    assets = sorted(j.get("assets") or [], key=lambda a: a["name"])
    tars = [a["browser_download_url"] for a in assets if ".tar." in a["name"] or a["name"].endswith(".tar")]
    return tag, tars


def download_day(day, cache):
    tag, urls = release_assets(day)
    paths = []
    for u in urls:
        name = os.path.basename(u)
        dest = os.path.join(cache, name)
        if not os.path.exists(dest) or os.path.getsize(dest) < 1000:
            print("fetch", u, flush=True)
            fetch(u, dest)
        paths.append(dest)
    return tag, paths


def ingest_aircraft(parsed, apts, buckets, nearby_index):
    if not parsed:
        return 0
    n = 0
    for leg in split_legs(parsed["pts"]):
        cands = airports_near_bbox(leg, nearby_index, apts)
        for apt_id in cands:
            apt = apts[apt_id]
            for clip in clip_to_airport(leg, apt):
                sm = kalman_rts(clip, apt["lat"], apt["lon"])
                body = [p for p in sm if p]
                if len(body) < 8:
                    continue
                asg = assign_runway(sm, apt)
                if not asg:
                    buckets[(apt_id, None, None)].append({
                        "al": parsed["al"], "cs": parsed["cs"], "reg": parsed["reg"],
                        "t": parsed["t"], "pts": sm, "t0": body[0]["t"],
                    })
                    continue
                kind, rid = asg
                buckets[(apt_id, kind, rid)].append({
                    "al": parsed["al"], "cs": parsed["cs"], "reg": parsed["reg"],
                    "t": parsed["t"], "pts": sm, "t0": body[0]["t"],
                })
                n += 1
    return n


def airports_near_bbox(pts, index, apts):
    lat = [p["lat"] for p in pts]
    lon = [p["lon"] for p in pts]
    la0, la1 = min(lat), max(lat)
    lo0, lo1 = min(lon), max(lon)
    out = []
    for apt_id, (lat, lon) in index:
        if lat < la0 - 1.1 or lat > la1 + 1.1 or lon < lo0 - 1.4 or lon > lo1 + 1.4:
            continue
        out.append(apt_id)
    return out


def process_tar(paths, apts, buckets):
    index = [(k, (v["lat"], v["lon"])) for k, v in apts.items()]
    n_tr = n_ok = 0
    t0 = time.time()
    reader = io.BufferedReader(ChainReader(paths), buffer_size=1 << 20)
    with tarfile.open(fileobj=reader, mode="r|") as tf:
        for m in tf:
            if not m.isfile():
                continue
            mm = HEX_QTR_UAE.search(m.name or "")
            if not mm:
                continue
            n_tr += 1
            f = tf.extractfile(m)
            if not f:
                continue
            raw = f.read()
            parsed = parse_trace(raw, mm.group(0).split("_")[-1].replace(".json", ""))
            n_ok += ingest_aircraft(parsed, apts, buckets, index)
            if n_tr % 50 == 0:
                print(f"  traces {n_tr} assigned {n_ok} bytes {reader.raw.n/1e9:.2f}G {time.time()-t0:.0f}s", flush=True)
    print(f"  done traces={n_tr} assigned={n_ok} {time.time()-t0:.0f}s", flush=True)
    return n_tr, n_ok


def write_tiles(out_dir, apts, qtr_counts, buckets, geom_days, window):
    os.makedirs(out_dir, exist_ok=True)
    # group buckets by airport
    by_apt = defaultdict(lambda: defaultdict(list))
    for (apt_id, kind, rid), fls in buckets.items():
        if kind is None:
            continue
        by_apt[apt_id][(kind, rid)].extend(fls)
    airports_idx = []
    n_geom = 0
    for iata, apt in sorted(apts.items()):
        h = qtr_counts.get(iata, {"n": 0, "inf": 0})
        fl_map = by_apt.get(iata, {})
        tile = pack_tile(apt, fl_map, geom_days, h["n"], h["inf"], window)
        has = tile["n_assigned"] > 0
        if has:
            n_geom += 1
            path = os.path.join(out_dir, f"{iata}.json.gz")
            with gzip.open(path, "wt", encoding="utf-8") as f:
                json.dump(tile, f, separators=(",", ":"))
        airports_idx.append({
            "id": iata,
            "icao": apt["icao"],
            "iata": apt["iata"],
            "lat": round(apt["lat"], 6),
            "lon": round(apt["lon"], 6),
            "name": apt["name"],
            "h2h_n": h["n"],
            "h2h_inf": h["inf"],
            "geom_flights": tile["n_assigned"],
            "geom_days": len(tile.get("geom_days") or []) if has else 0,
            "n_rwys": len(tile["rwys"]),
            "tile": f"{iata}.json.gz" if has else None,
        })
    index = {
        "from": window[0],
        "to": window[1],
        "h2h_window": window,
        "geom_days": geom_days,
        "n_airports": len(airports_idx),
        "n_with_geom": n_geom,
        "missing_dump_days": MISSING_DUMPS,
        "license": "ADS-B traces © adsb.lol contributors, ODbL 1.0. Airport/runway coordinates: OurAirports, public domain.",
        "not_sid_star": True,
        "note": (
            "Airport list = IATA codes that appear as a QTR origin or destination in the 365-day "
            "adsb.lol globe_history aggregates (h2h.json). Geometry is terminal-area clips from "
            f"{len(geom_days)} sampled UTC day(s) of globe_history traces. Ground-roll samples are "
            "not Kalman-smoothed. Each clip is assigned to one OurAirports runway end by heading "
            "and lateral offset (parallel runways are not mixed). Representative paths are the "
            "medoid of the dominant cluster, anchored at an observed on-runway ADS-B sample — not "
            "snapped to the published threshold and not published SID/STAR. Gaps: dumps with no "
            "file, thin receiver coverage, and tracks that could not be assigned a runway are "
            "omitted rather than invented."
        ),
        "airports": airports_idx,
    }
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)
    with open(os.path.join(out_dir, "airports.json"), "w", encoding="utf-8") as f:
        json.dump([{k: a[k] for k in ("id", "icao", "iata", "lat", "lon", "name")} for a in airports_idx], f)
    keep = {f"{a['id']}.json.gz" for a in airports_idx if a.get("tile")}
    for name in os.listdir(out_dir):
        if name.endswith(".json.gz") and name not in keep:
            os.remove(os.path.join(out_dir, name))
            print("removed stale tile", name, flush=True)
    print("wrote", out_dir, "airports", len(airports_idx), "with_geom", n_geom, flush=True)
    return index


def _synth_track(rwy, kind, i, n, alts, hdg, npts=16):
    import math
    from hist_lib import enu_ll
    pts = []
    jitter = (i - n / 2) * 0.004  # nm far-field; ~a few metres on the strip
    rad = math.radians(rwy["hdg"])
    t0 = 1_700_000_000 + i * 80
    L = rwy["length_nm"]
    k = 0

    def add(along, cross, alt, gs, trk, gnd):
        nonlocal k
        e = (along * math.sin(rad) + cross * math.cos(rad)) * 1852.0
        n_m = (along * math.cos(rad) - cross * math.sin(rad)) * 1852.0
        lat, lon = enu_ll(rwy["lat"], rwy["lon"], e, n_m)
        pts.append({
            "t": t0 + k * 4, "lat": lat, "lon": lon, "alt": alt, "gs": gs, "trk": trk,
            "gnd": gnd, "leg": False, "stale": False, "flight": "QTR17",
        })
        k += 1

    on_cross = jitter * 0.2
    if kind == "dep":
        for j in range(3):
            add(-0.12 + j * 0.02, 0.14, 0, 8, (hdg + 40) % 360, True)
        for j, gs in enumerate((45, 70, 100, 130, 155)):
            add(0.12 + j * 0.28, on_cross, 0, gs, hdg, True)
        for m in range(npts):
            frac = m / (npts - 1)
            along = 1.24 + frac * 12.0
            u = frac * (len(alts) - 1)
            j0 = min(len(alts) - 2, int(u))
            t = u - j0
            alt = alts[j0] * (1 - t) + alts[j0 + 1] * t
            cross = jitter * (0.2 + 0.8 * min(1.0, abs(along) / 10.0))
            add(along, cross, max(alt, 80), 180, hdg, False)
    else:
        for m in range(npts):
            frac = m / (npts - 1)
            along = -12.0 + frac * 12.0
            u = frac * (len(alts) - 1)
            j0 = min(len(alts) - 2, int(u))
            t = u - j0
            alt = alts[j0] * (1 - t) + alts[j0 + 1] * t
            cross = jitter * (0.2 + 0.8 * min(1.0, abs(along) / 10.0))
            add(along, cross, alt, 180, hdg, False)
        for j, gs in enumerate((140, 110, 80, 55, 42)):
            add(0.15 + j * 0.28, on_cross, 0, gs, hdg, True)
        for j in range(3):
            add(L + 0.08 + j * 0.03, 0.14, 0, 8, (hdg + 50) % 360, True)
    return pts


def synthetic_fixture(apts):
    """Deterministic EGLL/DOH/JFK tracks so unit tests do not need a 3.5 GB dump."""
    buckets = defaultdict(list)

    def mk(apt_id, kind, rid, n, hdg, alts):
        apt = apts[apt_id]
        rwy = next(r for r in apt["rwys"] if r["id"] == rid)
        for i in range(n):
            pts = _synth_track(rwy, kind, i, n, alts, hdg)
            sm = kalman_rts(pts, apt["lat"], apt["lon"])
            buckets[(apt_id, kind, rid)].append({
                "al": "QTR", "cs": f"QTR{i}", "reg": "A7-ALH", "t": "A359",
                "pts": sm, "t0": pts[0]["t"],
            })

    mk("LHR", "arr", "27L", 24, 270, [8000, 5000, 3000, 1500, 800, 200, 20])
    mk("LHR", "arr", "27R", 18, 270, [8000, 5000, 3000, 1500, 800, 200, 20])
    mk("LHR", "dep", "27L", 20, 270, [20, 400, 1200, 2500, 5000, 8000, 12000])
    mk("LHR", "dep", "09R", 16, 90, [20, 400, 1200, 2500, 5000, 8000, 12000])
    doh_r = apts["DOH"]["rwys"][0]
    mk("DOH", "arr", doh_r["id"], 30, doh_r["hdg"], [7000, 4000, 2000, 800, 200, 20])
    mk("DOH", "dep", doh_r["id"], 22, doh_r["hdg"], [20, 500, 1500, 4000, 8000, 12000])
    if apts.get("JFK", {}).get("rwys"):
        r = apts["JFK"]["rwys"][0]
        mk("JFK", "arr", r["id"], 12, r["hdg"], [6000, 3000, 1200, 400, 20])
        mk("JFK", "dep", r["id"], 10, r["hdg"], [20, 800, 2500, 6000, 10000])
    return buckets


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--h2h", default="data/h2h.json")
    p.add_argument("--out", default="data/hist")
    p.add_argument("--airports-csv", default="/tmp/hist/airports.csv")
    p.add_argument("--runways-csv", default="/tmp/hist/runways.csv")
    p.add_argument("--day", action="append", default=[], help="UTC day YYYY-MM-DD (repeatable)")
    p.add_argument("--tar", action="append", default=[], help="Local split-tar parts for the last --day")
    p.add_argument("--fetch", action="store_true", help="Download globe_history prod tar for each --day")
    p.add_argument("--cache", default="/tmp/hist/days")
    p.add_argument("--fixture", action="store_true", help="Write synthetic tiles (tests / layout)")
    p.add_argument("--incremental", action="store_true", help="Merge with existing index geom_days")
    p.add_argument("--from-cache", action="store_true", help="Re-assign cached clips with current runway logic and rewrite tiles (no tar ingest)")
    args = p.parse_args()
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    os.chdir(root)
    if not os.path.exists(args.airports_csv):
        print("download OurAirports airports.csv", flush=True)
        fetch(OA_AIR, args.airports_csv)
    if not os.path.exists(args.runways_csv):
        print("download OurAirports runways.csv", flush=True)
        fetch(OA_RWY, args.runways_csv)
    h2h = json.load(open(args.h2h, encoding="utf-8"))
    qtr = observed_qtr_airports(h2h)
    print("observed QTR airports", len(qtr), flush=True)
    apts = load_ourairports(args.airports_csv, args.runways_csv, qtr.keys())
    print("OurAirports matched", len(apts), "with runways", sum(1 for a in apts.values() if a["rwys"]), flush=True)
    buckets = defaultdict(list)
    geom_days = []
    cache_flights = os.path.join(args.cache, "buckets.json.gz")
    if args.incremental:
        idx_path = os.path.join(args.out, "index.json")
        if os.path.exists(idx_path):
            prev = json.load(open(idx_path, encoding="utf-8"))
            geom_days = list(prev.get("geom_days") or [])
            print("incremental: existing geom_days", geom_days, flush=True)
        if os.path.exists(cache_flights):
            prev_b = json.loads(gzip.open(cache_flights, "rt", encoding="utf-8").read())
            for k, fls in prev_b.items():
                kind, rid = k.split("|")[1], k.split("|")[2]
                apt_id = k.split("|")[0]
                kk = (apt_id, None if kind == "" else kind, None if rid == "" else rid)
                buckets[kk].extend(fls)
            print("incremental: loaded", sum(len(v) for v in buckets.values()), "cached flights", flush=True)
    if args.from_cache:
        if not os.path.exists(cache_flights):
            sys.exit("no cached flights at " + cache_flights)
        if not buckets:
            prev_b = json.loads(gzip.open(cache_flights, "rt", encoding="utf-8").read())
            for k, fls in prev_b.items():
                apt_id, kind, rid = (k.split("|") + ["", ""])[:3]
                kk = (apt_id, None if kind == "" else kind, None if rid == "" else rid)
                buckets[kk].extend(fls)
            print("from-cache: loaded", sum(len(v) for v in buckets.values()), "cached flights", flush=True)
        buckets, n_ok, n_drop = reassign_buckets(buckets, apts)
        print("from-cache: reassigned", n_ok, "dropped", n_drop, flush=True)
        idx_path = os.path.join(args.out, "index.json")
        if os.path.exists(idx_path) and not geom_days:
            prev = json.load(open(idx_path, encoding="utf-8"))
            geom_days = list(prev.get("geom_days") or [])
    if args.fixture:
        buckets = synthetic_fixture(apts)
        if "fixture" not in geom_days:
            geom_days.append("fixture")
    for day in args.day:
        if day in MISSING_DUMPS:
            print("skip missing dump", day, flush=True)
            continue
        paths = list(args.tar) if args.tar and day == args.day[-1] else []
        if args.fetch or not paths:
            _, paths = download_day(day, args.cache)
        print("process", day, "parts", len(paths), flush=True)
        process_tar(paths, apts, buckets)
        if day not in geom_days:
            geom_days.append(day)
        args.tar = []  # only apply explicit --tar to the last listed day once
        os.makedirs(args.cache, exist_ok=True)
        dump = {"|".join([a or "", k or "", r or ""]): fls for (a, k, r), fls in buckets.items()}
        with gzip.open(cache_flights, "wt", encoding="utf-8") as f:
            json.dump(dump, f)
        print("cached flights", sum(len(v) for v in buckets.values()), "->", cache_flights, flush=True)
    if not geom_days:
        print("no geometry days; writing airport index only", flush=True)
        geom_days = []
    write_tiles(args.out, apts, qtr, buckets, geom_days, WINDOW)


if __name__ == "__main__":
    main()
