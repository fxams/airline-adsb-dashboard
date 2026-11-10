#!/usr/bin/env python3
"""Measure representative-path lateral offset vs OurAirports runway centreline.

Reports metres at the airport-end vertex (dep start / arr end) and the first
segment heading vs the pavement axis. Does not invent geometry. Run after
rebuilding data/hist tiles.
"""
from __future__ import annotations

import gzip
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from hist_lib import hdg_err, load_ourairports, observed_qtr_airports, rwy_frame

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.chdir(ROOT)

WANT = {
    "LHR": ["27L", "27R", "09L", "09R"],
    "DOH": ["34L", "34R", "16L", "16R"],
    "DXB": ["12L", "12R", "30L", "30R"],
    "AUH": ["13L", "13R", "31L", "31R"],
    "BOM": ["09", "27", "14", "32"],
    "SIN": ["02C", "02L", "02C", "20C", "20R"],
    "MCT": ["08L", "08R", "26L", "26R"],
    "KWI": ["15R", "15L", "33L", "33R"],
    "BAH": ["12L", "12R", "30L", "30R"],
    "FRA": ["07C", "07L", "07R", "25C", "25L", "25R"],
    "FCO": ["16L", "16R", "34L", "34R"],
    "NRT": ["16L", "16R", "34L", "34R"],
}


def bearing(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def main():
    h2h = json.load(open("data/h2h.json", encoding="utf-8"))
    qtr = observed_qtr_airports(h2h)
    apts = load_ourairports("/tmp/hist/airports.csv", "/tmp/hist/runways.csv", qtr.keys())
    rows = []
    for iata, ids in WANT.items():
        path = os.path.join("data/hist", f"{iata}.json.gz")
        if not os.path.exists(path):
            print("MISSING", path)
            continue
        tile = json.loads(gzip.open(path, "rt", encoding="utf-8").read())
        apt = apts[iata]
        rwy_by = {r["id"]: r for r in apt["rwys"]}
        print(f"\n{iata} ({tile.get('icao')}) n_assigned={tile.get('n_assigned')} rwys={[(r['id'], r['dir'], r['n']) for r in tile.get('rwys') or []]}")
        seen = set()
        for rid in ids:
            if rid in seen:
                continue
            seen.add(rid)
            rwy = rwy_by.get(rid)
            if not rwy:
                print(f"  {rid}: no OurAirports end")
                continue
            for rec in tile.get("rwys") or []:
                if rec["id"] != rid:
                    continue
                path = (rec.get("clusters") or [{}])[0].get("path") or []
                if len(path) < 2:
                    print(f"  {rid} {rec['dir']}: no path")
                    continue
                n_check = min(5, len(path))
                if rec["dir"] == "dep":
                    lon, lat = path[0]
                    lon2, lat2 = path[1]
                    pts = path[:n_check]
                    brg = bearing(lon, lat, lon2, lat2)
                else:
                    lon, lat = path[-1]
                    pts = path[-n_check:]
                    brg = bearing(path[-2][0], path[-2][1], path[-1][0], path[-1][1])
                along, cross = rwy_frame(rwy, lat, lon)
                herr = hdg_err(brg, rwy["hdg"])
                max_cross = 0.0
                for plon, plat in pts:
                    _a, c = rwy_frame(rwy, plat, plon)
                    max_cross = max(max_cross, abs(c) * 1852)
                row = {
                    "apt": iata, "rwy": rid, "dir": rec["dir"], "n": rec["n"],
                    "along_m": round(along * 1852, 1),
                    "cross_m": round(cross * 1852, 1),
                    "abs_cross_m": round(abs(cross) * 1852, 1),
                    "max_cross_m_first5": round(max_cross, 1),
                    "seg_hdg": round(brg, 1),
                    "rwy_hdg": rwy["hdg"],
                    "hdg_err_deg": round(herr, 1),
                    "n_pts": len(path),
                    "lon": lon, "lat": lat,
                    "rwy_lat": rwy["lat"], "rwy_lon": rwy["lon"], "hdg": rwy["hdg"],
                    "rwy_end_lat": rwy["end_lat"], "rwy_end_lon": rwy["end_lon"],
                }
                rows.append(row)
                print(
                    f"  {rid} {rec['dir']:3} n={rec['n']:4}  along={along*1852:8.1f} m  "
                    f"cross={cross*1852:7.1f} m  max5={max_cross:6.1f} m  "
                    f"hdg={brg:5.1f}/{rwy['hdg']:5.1f} err={herr:4.1f}°  pts={len(path)}"
                )
    outp = "/opt/cursor/artifacts/rwy-offset-measure.json"
    os.makedirs(os.path.dirname(outp), exist_ok=True)
    with open(outp, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2)
    print("wrote", outp)
    print("\nJSON")
    json.dump(rows, sys.stdout, indent=2)
    print()
    bad = [
        r for r in rows
        if r["abs_cross_m"] > 80
        or r["max_cross_m_first5"] > 120
        or (r["dir"] == "dep" and r["hdg_err_deg"] > 12)
    ]
    if bad:
        print("WARN offset/heading:", [{k: x[k] for k in ("apt", "rwy", "dir", "abs_cross_m", "max_cross_m_first5", "hdg_err_deg")} for x in bad])
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
