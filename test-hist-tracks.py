#!/usr/bin/env python3
"""Unit tests for Kalman/RTS, runway assign, clustering, observed-QTR airport list."""
import importlib.util
import json
import math
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
from hist_lib import (  # noqa: E402
    airline_of,
    assign_runway,
    cluster_group,
    enu_ll,
    hdg_err,
    hv_nm,
    kalman_rts,
    load_ourairports,
    observed_qtr_airports,
    parse_trace,
    roll_and_airborne,
    rwy_frame,
    _splice_observed_roll,
)

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
spec = importlib.util.spec_from_file_location(
    "build_hist_tracks", os.path.join(ROOT, "scripts", "build-hist-tracks.py")
)
bht = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bht)

fail = []
def ok(cond, msg):
    if not cond:
        fail.append(msg)

h2h = json.load(open("data/h2h.json", encoding="utf-8"))
qtr = observed_qtr_airports(h2h)
ok(len(qtr) >= 150, f"observed QTR airports from h2h, got {len(qtr)}")
ok("LHR" in qtr and qtr["LHR"]["n"] > 1000, "LHR is an observed QTR end, not a hardcoded route")
ok("DOH" in qtr, "DOH present")
ok("XXXX" not in qtr, "invented airport not in observed list")
# city-pair evidence, not a marketed QR001-QR012 table
ok(any(r[0] == "QTR" and {r[1], r[2]} == {"DOH", "LHR"} for r in h2h["map"]), "DOH-LHR appears in observed map")

apts = load_ourairports("/tmp/hist/airports.csv", "/tmp/hist/runways.csv", qtr.keys())
ok(len(apts) == len(qtr), "every observed IATA has OurAirports ARP")
ok(apts["LHR"]["icao"] == "EGLL", "LHR ICAO EGLL")
ids = {r["id"] for r in apts["LHR"]["rwys"]}
ok(ids >= {"09L", "09R", "27L", "27R"}, f"EGLL runway ends {ids}")

# Kalman reduces a 1 km outlier
apt = apts["LHR"]
rwy = next(r for r in apt["rwys"] if r["id"] == "27L")
raw = []
for k in range(20):
    frac = k / 19
    along = -10 + frac * 10.5
    rad = math.radians(270)
    e = along * math.sin(rad) * 1852
    n = along * math.cos(rad) * 1852
    lat, lon = enu_ll(rwy["lat"], rwy["lon"], e, n)
    if k == 10:
        lat += 0.02  # ~2 km north spike
    raw.append({"t": 1000 + k * 4, "lat": lat, "lon": lon, "alt": 4000 - k * 180, "gs": 200, "trk": 270, "gnd": False, "leg": False, "stale": False})
for k in range(5):
    along = 0.6 + k * 0.25
    rad = math.radians(270)
    e = along * math.sin(rad) * 1852
    n = along * math.cos(rad) * 1852
    lat, lon = enu_ll(rwy["lat"], rwy["lon"], e, n)
    raw.append({"t": 1080 + k * 2, "lat": lat, "lon": lon, "alt": 0, "gs": 120 - k * 15, "trk": 270, "gnd": True, "leg": False, "stale": False})
sm = [p for p in kalman_rts(raw, apt["lat"], apt["lon"]) if p]
ok(len(sm) == 25, f"RTS keeps airborne samples and copies the roll ({len(sm)})")
# spike should be pulled toward the line
ok(abs(sm[10]["lat"] - rwy["lat"]) < abs(raw[10]["lat"] - rwy["lat"]) * 0.6, "Kalman pulls outlier toward the track")

asg = assign_runway(sm, apt)
ok(asg and asg[0] == "arr" and asg[1] in ("27L", "27R"), f"smoothed arrival assigns a 27-end, got {asg}")

# Ground-roll samples stay as observed (constant-velocity RTS is not applied on the pavement).
gnd_raw = []
for k in range(8):
    along = 0.15 + k * 0.22
    rad = math.radians(270)
    e = along * math.sin(rad) * 1852
    n = along * math.cos(rad) * 1852
    lat, lon = enu_ll(rwy["lat"], rwy["lon"], e, n)
    gnd_raw.append({"t": 2000 + k * 2, "lat": lat, "lon": lon, "alt": 0, "gs": 50 + k * 14, "trk": 270, "gnd": True, "leg": False, "stale": False})
air_raw = []
for k in range(12):
    along = 1.9 + k * 0.9
    rad = math.radians(270)
    e = along * math.sin(rad) * 1852
    n = along * math.cos(rad) * 1852
    lat, lon = enu_ll(rwy["lat"], rwy["lon"], e, n)
    air_raw.append({"t": 2020 + k * 4, "lat": lat, "lon": lon, "alt": 200 + k * 400, "gs": 170, "trk": 270, "gnd": False, "leg": False, "stale": False})
sm_roll = kalman_rts(gnd_raw + air_raw, apt["lat"], apt["lon"])
sm_body = [p for p in sm_roll if p]
ok(len(sm_body) == 20, f"surface+air keeps samples, got {len(sm_body)}")
for i, p in enumerate(gnd_raw):
    ok(abs(sm_body[i]["lat"] - p["lat"]) < 1e-12 and abs(sm_body[i]["lon"] - p["lon"]) < 1e-12, f"ground sample {i} not RTS'd")
asg_roll = assign_runway(sm_roll, apt)
ok(asg_roll == ("dep", "27L"), f"ground-roll heading+offset assigns 27L dep, got {asg_roll}")

# Parallel uniqueness: a 27L-centreline roll is not 27R.
rwy_r = next(r for r in apt["rwys"] if r["id"] == "27R")
asg_rwy = assign_runway(sm_roll, apt)
ok(asg_rwy[1] != "27R", "27L roll is not labelled 27R")
# A 27R-centreline track assigns 27R, not 27L.
rwy_pts = []
for k in range(8):
    along = 0.15 + k * 0.22
    rad = math.radians(rwy_r["hdg"])
    e = along * math.sin(rad) * 1852
    n = along * math.cos(rad) * 1852
    lat, lon = enu_ll(rwy_r["lat"], rwy_r["lon"], e, n)
    rwy_pts.append({"t": 3000 + k * 2, "lat": lat, "lon": lon, "alt": 0, "gs": 55 + k * 12, "trk": rwy_r["hdg"], "gnd": True, "leg": False, "stale": False})
for k in range(12):
    along = 1.9 + k * 0.9
    rad = math.radians(rwy_r["hdg"])
    e = along * math.sin(rad) * 1852
    n = along * math.cos(rad) * 1852
    lat, lon = enu_ll(rwy_r["lat"], rwy_r["lon"], e, n)
    rwy_pts.append({"t": 3020 + k * 4, "lat": lat, "lon": lon, "alt": 200 + k * 400, "gs": 170, "trk": rwy_r["hdg"], "gnd": False, "leg": False, "stale": False})
ok(assign_runway(rwy_pts, apt) == ("dep", "27R"), f"27R centreline assigns 27R, got {assign_runway(rwy_pts, apt)}")
# A single unique on-runway sample is enough (many clips only have one airborne-over-strip point).
one = [rwy_pts[3]] + rwy_pts[8:]
ok(assign_runway(one, apt) == ("dep", "27R"), f"single 27R hit still assigns, got {assign_runway(one, apt)}")

# Taxi is not used as the representative start.
taxi = []
for k in range(5):
    along, cross = -0.1, 0.14
    rad = math.radians(270)
    e = (along * math.sin(rad) + cross * math.cos(rad)) * 1852
    n = (along * math.cos(rad) - cross * math.sin(rad)) * 1852
    lat, lon = enu_ll(rwy["lat"], rwy["lon"], e, n)
    taxi.append({"t": 1990 + k, "lat": lat, "lon": lon, "alt": 0, "gs": 6, "trk": 311, "gnd": True, "leg": False, "stale": False})
body_drop = roll_and_airborne(taxi + gnd_raw + air_raw, rwy, "dep")
ok(body_drop[0]["gs"] >= 40, "representative starts at the roll, not taxi")
_, x0 = rwy_frame(rwy, body_drop[0]["lat"], body_drop[0]["lon"])
ok(abs(x0) * 1852 < 40, f"roll start |cross| {abs(x0)*1852:.1f} m")

ok(airline_of("A7-ALH", "QTR17", "06a123") == "QTR", "A7- / QTR")
ok(airline_of("A6-EEA", "UAE12", "896abc") == "UAE", "A6-E / UAE")
ok(airline_of("N12345", "BAW12", "400123") is None, "other airline dropped")

trace = {
    "icao": "06a111",
    "r": "A7-ALH",
    "t": "A359",
    "timestamp": 1000,
    "trace": [
        [0, 51.47, -0.3, 4000, 220, 270, 0, -800, {"flight": "QTR17  "}],
        [5, 51.47, -0.32, 3500, 210, 270, 0, -800, None],
    ],
}
import gzip
ok(parse_trace(json.dumps(trace).encode(), "06a111") is None, "short trace below MIN_PTS is dropped")
trace["trace"] = [
    [i * 4, 51.47, -0.30 - i * 0.01, 5000 - i * 200, 220, 270, 0, -800, {"flight": "QTR17  "} if i == 0 else None]
    for i in range(12)
]
parsed = parse_trace(json.dumps(trace).encode(), "06a111")
ok(parsed and parsed["al"] == "QTR" and parsed["cs"].startswith("QTR17"), f"parse_trace callsign {parsed}")

buckets = bht.synthetic_fixture(apts)
ok(("LHR", "arr", "27L") in buckets and len(buckets[("LHR", "arr", "27L")]) >= 20, "fixture 27L arrivals")
ok(("LHR", "dep", "27L") in buckets, "fixture 27L departures")
ok(("LHR", "dep", "09R") in buckets, "fixture 09R departures")
# assign on a fixture track
fl = buckets[("LHR", "arr", "27L")][0]
got = assign_runway(fl["pts"], apt)
ok(got and got[0] == "arr" and got[1] == "27L", f"fixture 27L arr still assigns 27L after Kalman, got {got}")

cls = cluster_group(buckets[("LHR", "arr", "27L")], apt, "arr", rwy=rwy)
ok(cls and cls[0]["n"] >= 10, f"dominant 27L arr cluster {cls[:1]}")
ok(cls[0]["path"] and len(cls[0]["path"][0]) == 2, "path is lon,lat pairs")
# path should approach EGLL
last = cls[0]["path"][-1]
ok(hv_nm(last[1], last[0], apt["lat"], apt["lon"]) < 6, "arrival representative ends near EGLL")
_, x_arr = rwy_frame(rwy, last[1], last[0])
ok(abs(x_arr) * 1852 < 80, f"27L arr end |cross| {abs(x_arr)*1852:.1f} m vs centreline")

cls_dep = cluster_group(buckets[("LHR", "dep", "27L")], apt, "dep", rwy=rwy)
ok(cls_dep and cls_dep[0]["path"], "27L dep cluster")
first = cls_dep[0]["path"][0]
_, x_dep = rwy_frame(rwy, first[1], first[0])
ok(abs(x_dep) * 1852 < 80, f"27L dep start |cross| {abs(x_dep)*1852:.1f} m vs centreline")
# Anchor is an observed sample, not the OurAirports threshold snapped.
ok(hv_nm(first[1], first[0], rwy["lat"], rwy["lon"]) > 0.02, "dep start is observed on the roll, not snapped to the threshold")

# Late first-hit + off-axis airborne medoid (OTHH 34R class): splice must keep
# the ground-roll on the centreline instead of a chord across the terminal.
def _rwy_pt(rwy, along_nm, cross_nm, **kw):
    rad = math.radians(rwy["hdg"])
    e = (along_nm * math.sin(rad) + cross_nm * math.cos(rad)) * 1852
    n = (along_nm * math.cos(rad) - cross_nm * math.sin(rad)) * 1852
    lat, lon = enu_ll(rwy["lat"], rwy["lon"], e, n)
    return {
        "lat": lat, "lon": lon,
        "alt": kw.get("alt", 0), "gs": kw.get("gs", 80),
        "trk": kw.get("trk", rwy["hdg"]), "gnd": kw.get("gnd", True),
        "t": kw.get("t", 0), "leg": False, "stale": False,
    }

late = []
for i in range(12):
    pts = []
    t0 = 1000
    for k, along in enumerate((0.15, 0.45, 0.85, 1.25, 1.7, 2.15)):
        pts.append(_rwy_pt(rwy, along, 0.002 * (i % 3 - 1), alt=0, gs=50 + k * 18, gnd=True, t=t0 + k * 3))
    for k in range(8):
        pts.append(_rwy_pt(
            rwy, 2.5 + k * 0.55, 0.12 + k * 0.08,
            alt=400 + k * 220, gs=160 + k * 8, gnd=False,
            trk=(rwy["hdg"] + 35) % 360, t=t0 + 30 + k * 4,
        ))
    late.append({"pts": pts, "al": "QTR"})
# Synthetic medoid that already left the pavement at vertex 1 (the production bug).
fake_path = [
    [_rwy_pt(rwy, 1.60, 0.002)["lon"], _rwy_pt(rwy, 1.60, 0.002)["lat"]],
    [_rwy_pt(rwy, 2.35, 0.09)["lon"], _rwy_pt(rwy, 2.35, 0.09)["lat"]],
    [_rwy_pt(rwy, 4.2, 0.35)["lon"], _rwy_pt(rwy, 4.2, 0.35)["lat"]],
]
spliced = _splice_observed_roll(fake_path, late, apt, "dep", rwy)
ok(len(spliced) >= 4, f"spliced roll has body {len(spliced)}")
a0, x0 = rwy_frame(rwy, spliced[0][1], spliced[0][0])
a1, x1 = rwy_frame(rwy, spliced[1][1], spliced[1][0])
ok(abs(x0) * 1852 < 80, f"spliced dep start |cross| {abs(x0)*1852:.1f} m")
ok(abs(x1) * 1852 < 80, f"spliced dep second |cross| {abs(x1)*1852:.1f} m")
ok(a1 > a0, "spliced roll advances along the runway")
brg = math.degrees(math.atan2(
    math.sin(math.radians(spliced[1][0] - spliced[0][0])) * math.cos(math.radians(spliced[1][1])),
    math.cos(math.radians(spliced[0][1])) * math.sin(math.radians(spliced[1][1]))
    - math.sin(math.radians(spliced[0][1])) * math.cos(math.radians(spliced[1][1])) * math.cos(math.radians(spliced[1][0] - spliced[0][0])),
))
brg = (brg + 360) % 360
ok(hdg_err(brg, rwy["hdg"]) < 12, f"spliced first-segment heading {brg:.1f} vs rwy {rwy['hdg']} err {hdg_err(brg, rwy['hdg']):.1f}")
ok(hv_nm(spliced[0][1], spliced[0][0], rwy["lat"], rwy["lon"]) > 0.02, "splice does not snap to the threshold")

with tempfile.TemporaryDirectory() as td:
    idx = bht.write_tiles(td, apts, qtr, buckets, ["fixture"], ("2025-11-04", "2026-11-03"))
    ok(idx["n_airports"] == len(qtr), "index lists every observed QTR airport")
    ok(idx["not_sid_star"] is True, "tiles are not labelled SID/STAR")
    ok(idx["from"] == "2025-11-04" and idx["to"] == "2026-11-03", "UTC window")
    lhr = next(a for a in idx["airports"] if a["id"] == "LHR")
    ok(lhr["tile"] == "LHR.json.gz" and lhr["geom_flights"] > 0, "LHR has a tile")
    ok(os.path.exists(os.path.join(td, "LHR.json.gz")), "gzip tile written")
    import gzip as gz
    tile = json.loads(gz.open(os.path.join(td, "LHR.json.gz"), "rt").read())
    ok("not published sid/star" in tile["note"].lower(), "honest not-SID note")
    dirs = {(r["id"], r["dir"]) for r in tile["rwys"]}
    ok(("27L", "arr") in dirs and ("27L", "dep") in dirs, f"EGLL both dirs on 27L {dirs}")
    ok(("27R", "arr") in dirs or ("09L", "arr") in dirs, "northern runway also represented")
    lab = tile["rwys"][0]
    ok(lab["n"] > 0 and lab["clusters"][0]["share"] > 0.3, "share is of assigned flights")

if fail:
    print("FAIL")
    print("\n".join(fail))
    sys.exit(1)
print("PASS", {"qtr_airports": len(qtr), "lhr_h2h": qtr["LHR"], "egll_rwys": sorted(ids)})
