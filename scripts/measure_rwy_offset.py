#!/usr/bin/env python3
"""Measure representative-path lateral offset vs OurAirports runway centreline.

Reports metres at the airport-end vertex (dep start / arr end). Does not
invent geometry. Run after rebuilding data/hist tiles.
"""
from __future__ import annotations

import gzip
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from hist_lib import load_ourairports, observed_qtr_airports, rwy_frame

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.chdir(ROOT)

WANT = {
    "LHR": ["27L", "27R", "09L", "09R"],
    "DOH": ["34L", "34R", "16L", "16R"],
}


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
        for rid in ids:
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
                lon, lat = (path[0] if rec["dir"] == "dep" else path[-1])
                along, cross = rwy_frame(rwy, lat, lon)
                rows.append({
                    "apt": iata, "rwy": rid, "dir": rec["dir"], "n": rec["n"],
                    "along_m": round(along * 1852, 1),
                    "cross_m": round(cross * 1852, 1),
                    "abs_cross_m": round(abs(cross) * 1852, 1),
                    "lon": lon, "lat": lat,
                    "rwy_lat": rwy["lat"], "rwy_lon": rwy["lon"], "hdg": rwy["hdg"],
                    "rwy_end_lat": rwy["end_lat"], "rwy_end_lon": rwy["end_lon"],
                })
                print(f"  {rid} {rec['dir']:3} n={rec['n']:4}  along={along*1852:8.1f} m  cross={cross*1852:7.1f} m")
    outp = "/opt/cursor/artifacts/rwy-offset-measure.json"
    os.makedirs(os.path.dirname(outp), exist_ok=True)
    with open(outp, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2)
    print("wrote", outp)
    print("\nJSON")
    json.dump(rows, sys.stdout, indent=2)
    print()
    bad = [r for r in rows if r["abs_cross_m"] > 80]
    if bad:
        print("WARN |cross| > 80 m:", bad)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
