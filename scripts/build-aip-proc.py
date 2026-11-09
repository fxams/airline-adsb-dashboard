#!/usr/bin/env python3
"""Build licence-aware SID/STAR tiles for observed QTR airports.

DRAW: FAA CIFP (US). LINK: official AIP AD 2 for every other state.
Does not fetch or parse NATS/DFS/Airservices/NAV CANADA/QCAA charts.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from aip_cifp import load_hist_tile, pack_tile, parse_cifp  # noqa: E402
from aip_policy import policy_for  # noqa: E402

DEFAULT_CIFP = os.environ.get("CIFP_FILE", "/tmp/cifp/FAACIFP18")
OUT_DIR = os.path.join(ROOT, "data", "aip")
HIST_DIR = os.path.join(ROOT, "data", "hist")
CYCLE_ID = "261029"  # zip name CIFP_261029; AIRAC 2611; 2026-10-29 to 2026-11-26
AIRAC = "2611"


def load_airports():
    idx = json.load(open(os.path.join(HIST_DIR, "index.json"), encoding="utf-8"))
    return idx, idx["airports"]


def write_gz(path, obj):
    raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    with gzip.open(path, "wb", compresslevel=9) as f:
        f.write(raw)
    return len(raw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cifp", default=DEFAULT_CIFP, help="Path to FAACIFP18")
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--cycle", default=CYCLE_ID)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    hist_idx, airports = load_airports()
    if not os.path.isfile(args.cifp):
        sys.exit(f"CIFP file not found: {args.cifp} (download FAA CIFP zip, unzip FAACIFP18)")

    parsed, header = parse_cifp(args.cifp, airports)
    header = dict(header)
    header["cycle_id"] = args.cycle
    header["airac"] = AIRAC

    index_apts = []
    n_draw = n_link = n_sid = n_star = n_match = 0
    bytes_raw = 0
    for apt in airports:
        pol = policy_for(apt["icao"], apt.get("iata") or apt.get("id"))
        hist_tile = load_hist_tile(HIST_DIR, apt["id"]) if pol["mode"] == "draw" else None
        slot = parsed.get(apt["icao"]) if pol["mode"] == "draw" else None
        tile = pack_tile(apt, slot, header, hist_tile)
        if tile["mode"] == "draw":
            tile["cycle"] = "CIFP " + args.cycle
            tile["airac"] = AIRAC
            n_draw += 1
            n_sid += tile["n_sid"]
            n_star += tile["n_star"]
            n_match += tile["n_match"]
            fp = os.path.join(args.out, apt["id"] + ".json.gz")
            bytes_raw += write_gz(fp, tile)
            tile_name = apt["id"] + ".json.gz"
        else:
            n_link += 1
            tile_name = None
            # drop empty procs from the index row; full tile is served from index fields
        index_apts.append({
            "id": apt["id"],
            "icao": apt["icao"],
            "iata": apt.get("iata") or apt["id"],
            "name": apt.get("name"),
            "lat": apt["lat"],
            "lon": apt["lon"],
            "mode": tile["mode"],
            "state": tile["state"],
            "aip": tile["source"],
            "aip_url": tile["source_url"],
            "ad2_url": tile["ad2_url"],
            "ad2_label": tile["ad2_label"],
            "terms_url": tile["terms_url"],
            "terms": tile["terms"],
            "why": tile["why"],
            "n_sid": tile["n_sid"],
            "n_star": tile["n_star"],
            "n_match": tile["n_match"],
            "ident_mode": tile.get("ident_mode") or pol.get("ident_mode"),
            "ident_terms": tile.get("ident_terms") or pol.get("ident_terms"),
            "ident_flights": (tile.get("ident") or {}).get("flights") or 0,
            "ident_named": (tile.get("ident") or {}).get("named") or 0,
            "tile": tile_name,
        })

    index = {
        "from": hist_idx.get("from"),
        "to": hist_idx.get("to"),
        "n_airports": len(index_apts),
        "n_draw": n_draw,
        "n_link": n_link,
        "n_sid": n_sid,
        "n_star": n_star,
        "n_match": n_match,
        "airac": AIRAC,
        "cycle": "CIFP " + args.cycle,
        "effective_utc": "2026-10-29",
        "until_utc": "2026-11-26",
        "source": "FAA CIFP ARINC 424-18 for US DRAW airports; official national AIP/eAIP AD 2 links otherwise.",
        "license": (
            "US procedure geometry: FAA CIFP, U.S. government work (17 U.S.C. § 105), "
            "cycle CIFP " + args.cycle + ". Not for navigation. "
            "Non-US: no procedure geometry; official AIP AD 2 links only. "
            "Not Navigraph, not Jeppesen, not EUROCONTROL EAD geometry."
        ),
        "disclaimer": "Not for navigation. Not for operational flight planning.",
        "ident_policy": (
            "Per-flight SID/STAR names are assigned only from FAA CIFP (US public domain). "
            "Matching uses published CIFP fix sequences plus Fréchet/DTW on Kalman-smoothed ADS-B; "
            "below threshold the label is No match / vectored. Estimated from the track, not the ATC clearance. "
            "Non-US AIP coding tables are not ingested (NATS redistribution ban and other state terms are "
            "unclear or forbid reuse). OurAirports navaids have coordinates but no SID/STAR association; "
            "OpenAIP is unused (CC BY-NC). Name-only identification is therefore off behind a labelled toggle "
            "that shows this assessment only — names and fixes are never fabricated."
        ),
        "note": (
            "Airport list = observed QTR origins/destinations in the 365-day ADS-B aggregates. "
            "DRAW only where AIP terms explicitly allow public-website reuse (FAA CIFP). "
            "UK NATS, DFS, Airservices Australia, NAV CANADA, QCAA and other state AIPs "
            "are link-only. Nearest-published-procedure match runs only on DRAW airports "
            "against Kalman runway representatives."
        ),
        "airports": index_apts,
    }
    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)
        f.write("\n")
    print(json.dumps({
        "n_airports": len(index_apts),
        "n_draw": n_draw,
        "n_link": n_link,
        "n_sid": n_sid,
        "n_star": n_star,
        "n_match": n_match,
        "bytes_raw": bytes_raw,
        "out": args.out,
        "cycle": index["cycle"],
    }))


if __name__ == "__main__":
    main()
